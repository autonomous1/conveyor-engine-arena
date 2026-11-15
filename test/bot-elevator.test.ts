import assert from "node:assert/strict";
import { test } from "node:test";
import { runBrain } from "../packages/bot-client/src/brain.ts";
import { reach } from "../src/shared/bots/goals.ts";
import { planRoute } from "../src/shared/nav/route.ts";
import { stopOf } from "../src/shared/scene-graph.ts";
import { connectTestBot, startLiveArena, until } from "./support/live-arena.ts";

test("a bot rides an elevator to an upper stop", { timeout: 120_000 }, async (t) => {
  const arena = await startLiveArena();
  const session = await connectTestBot(arena, "elev-1");
  try {
    const self = await until(() => session.world.self(), 5_000, "no owned pawn");
    const graph = await until(() => session.world.sceneGraph(), 5_000, "no scene graph");
    const doors = new Map(session.world.doors().map((door) => [door.id, door]));
    const gate = (portal: Parameters<typeof planRoute>[3] extends (portal: infer P) => unknown ? P : never) => {
      if (portal.kind !== "door") return "open" as const;
      const door = doors.get(portal.door ?? portal.id);
      if (door?.open) return "open" as const;
      if (door?.locked) return "locked" as const;
      return "closed-unlocked" as const;
    };
    const portal = graph.portals
      .filter((item) => item.kind === "elevator")
      .find((item) => {
        const from = stopOf(item.a);
        const to = stopOf(item.b);
        if (!from || !to || from.shaft !== to.shaft || from.index === to.index) return false;
        return planRoute(graph, self, item.a, gate).ok;
      });
    if (!portal) {
      t.skip("no lower elevator stop is reachable on foot from the live spawn");
      return;
    }
    const from = stopOf(portal.a)!;
    const logs: string[] = [];
    const start = await runBrain(session, reach(portal.a), { timeoutMs: 60_000, log: (line) => logs.push(line) });
    assert.equal(start, 0, logs.join("\n"));
    const code = await runBrain(session, reach(portal.b), { timeoutMs: 120_000, log: (line) => logs.push(line) });
    assert.equal(code, 0, logs.join("\n"));
    assert.ok(logs.some((line) => line.includes("start ride:")), logs.join("\n"));
    assert.ok(!logs.some((line) => line.includes("finish ride:") && line.includes("failed")), logs.join("\n"));
    const end = session.world.self()!;
    const place = session.world.placeOf(end);
    assert.ok(place?.id === portal.b || Math.hypot(end.x - portal.at.b[0], end.z - portal.at.b[2]) <= 0.6, `${place?.id} ${end.x},${end.y},${end.z}`);
    assert.ok(end.y > self.y + 0.5, `y ${self.y} -> ${end.y}`);
    assert.notEqual(from.index, stopOf(portal.b)!.index);
  } finally {
    session.close();
    await arena.close();
  }
});
