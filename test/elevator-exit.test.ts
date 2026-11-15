import assert from "node:assert/strict";
import { test } from "node:test";
import { runBrain } from "../packages/bot-client/src/brain.ts";
import { reach } from "../src/shared/bots/goals.ts";
import { planRoute } from "../src/shared/nav/route.ts";
import { stopOf } from "../src/shared/scene-graph.ts";
import { connectTestBot, startLiveArena, until } from "./support/live-arena.ts";

const SHAFT = "brutalist-building-1-cbake-0.e1";

test("a rider at building-1-cbake-0 can leave the cab at floor 3", { timeout: 120_000 }, async (t) => {
  const arena = await startLiveArena();
  const session = await connectTestBot(arena, "exit-1");
  try {
    const self = await until(() => session.world.self(), 5_000, "no owned pawn");
    const graph = await until(() => session.world.sceneGraph(), 5_000, "no scene graph");
    const portal = graph.portals.find((item) => {
      if (item.kind !== "elevator") return false;
      const from = stopOf(item.a);
      const to = stopOf(item.b);
      return from?.shaft === SHAFT && to?.shaft === SHAFT && from.index !== to.index;
    });
    assert.ok(portal, "the installed graph must have the -0 shaft portal");
    const doors = new Map(session.world.doors().map((door) => [door.id, door]));
    const gate = (item: Parameters<typeof planRoute>[3] extends (portal: infer P) => unknown ? P : never) => {
      if (item.kind !== "door") return "open" as const;
      const door = doors.get(item.door ?? item.id);
      if (door?.open) return "open" as const;
      if (door?.locked) return "locked" as const;
      return "closed-unlocked" as const;
    };
    if (!planRoute(graph, self, portal.a, gate).ok) {
      t.skip("the -0 lower landing is not reachable on foot from the live spawn");
      return;
    }
    const logs: string[] = [];
    const toLanding = await runBrain(session, reach(portal.a), { timeoutMs: 60_000, log: (line) => logs.push(line) });
    assert.equal(toLanding, 0, logs.join("\n"));
    const hall = graph.placeById.get(SHAFT) as { joins?: Array<string | undefined> } | undefined;
    const target = hall?.joins?.find((id): id is string => typeof id === "string" && id.includes("floor-3"));
    assert.ok(target, "no floor-3 hall join");
    const code = await runBrain(session, reach(target), { timeoutMs: 120_000, log: (line) => logs.push(line) });
    assert.equal(code, 0, logs.join("\n"));
    assert.ok(logs.some((line) => line.includes("start ride:")), logs.join("\n"));
    const end = session.world.self()!;
    assert.notEqual(session.world.placeOf(end)?.id, portal.a);
  } finally {
    session.close();
    await arena.close();
  }
});
