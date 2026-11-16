// Scratch: one-shot bring-up probe. Seat the bot, print world/brain prerequisites, close.
// Run: node --import ./scripts/ts-ext-register.mjs packages/bot-client/tests/probe-seat.ts
import { readFileSync } from "node:fs";
import { connectBot } from "../../../packages/bot-client/src/connection.ts";
import { openNodeSocket } from "../../../packages/bot-client/src/node-socket.ts";
import { placeAt } from "../../../src/shared/scene-graph.ts";

const url = "ws://127.0.0.1:4173";
const token = readFileSync("packages/bot-client/tests/.ce-auth/bot-1.token", "utf8").trim();
const sceneGraph = JSON.parse(readFileSync("web/game/scene-graph.json", "utf8")) as unknown;
const regions = JSON.parse(readFileSync("web/game/regions.json", "utf8")) as unknown;

const session = await connectBot({
  url,
  token,
  name: "dev-probe",
  role: "bot",
  sceneGraph,
  regions,
  openSocket: openNodeSocket,
  onLog: (line) => console.error(line),
});
try {
  const started = Date.now();
  while (!session.world.self() && Date.now() - started < 5000) await new Promise((r) => setTimeout(r, 40));
  const self = session.world.self();
  const graph = session.world.sceneGraph();
  console.log(session.world.summary());
  console.log("role", session.world.role(), "scope", session.world.scope()?.join(",") ?? "none");
  console.log("self", self);
  console.log("health", session.world.health());
  console.log("others", session.world.others());
  console.log("doors", session.world.doors().length, "pickups", session.world.pickups().length,
    "graphHash", session.world.sceneGraphHash() ?? "none", "regionsHash", session.world.regionsHash() ?? "none");
  console.log("graph places", graph?.places.length ?? 0, "portals", graph?.portals.length ?? 0);
  if (self) {
    const place = placeAt(graph!, self.x, self.y, self.z);
    console.log("place", place.id, place.kind, "y", place.y);
    const near = graph!.places
      .filter((p) => p.kind !== "elevator")
      .map((p) => ({ id: p.id, kind: p.kind, d: Math.hypot((p.bounds?.centreX ?? 0) - self.x, (p.bounds?.centreZ ?? 0) - self.z) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, 5);
    console.log("nearest places", near);
  }
} finally {
  session.close();
}
