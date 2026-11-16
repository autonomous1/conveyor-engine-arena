// Scratch: does a fresh seat accept input at all?
import { readFileSync } from "node:fs";
import { connectBot } from "../../../packages/bot-client/src/connection.ts";
import { openNodeSocket } from "../../../packages/bot-client/src/node-socket.ts";
const token = readFileSync("plan/dsh-tasks/live/.ce-auth/bot-1.token", "utf8").trim();
const sceneGraph = JSON.parse(readFileSync("web/game/scene-graph.json", "utf8")) as unknown;
const session = await connectBot({ url: "ws://127.0.0.1:4173", token, name: "dev-1", role: "bot", sceneGraph, openSocket: openNodeSocket, onLog: (l) => console.error(l) });
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const start = Date.now();
while (!session.world.self() && Date.now() - start < 5000) await sleep(40);
const p0 = session.world.self()!;
console.log("start", p0.x.toFixed(3), p0.y.toFixed(3), p0.z.toFixed(3), "id", p0.id, "place", session.world.placeOf(p0)?.id);
for (const dir of [{ moveX: 0, moveZ: -1 }, { moveX: 0, moveZ: 1 }, { moveX: 1, moveZ: 0 }, { moveX: -1, moveZ: 0 }]) {
  const a = session.world.self()!;
  const until = Date.now() + 1200;
  while (Date.now() < until) { session.input.sendInput({ ...dir, yaw: 0 }); await sleep(50); }
  await sleep(200);
  const b = session.world.self()!;
  console.log("dir", JSON.stringify(dir), "moved", (b.x - a.x).toFixed(3), (b.z - a.z).toFixed(3), "now", b.x.toFixed(2), b.z.toFixed(2));
}
console.log("others", session.world.others().length, "health", session.world.health());
session.close();
