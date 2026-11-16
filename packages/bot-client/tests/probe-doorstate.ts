import { readFileSync } from "node:fs";
import { connectBot } from "../../../packages/bot-client/src/connection.ts";
import { openNodeSocket } from "../../../packages/bot-client/src/node-socket.ts";
const token = readFileSync("/home/tim/.config/ce-arena/qa-token.pem", "utf8").trim();
const session = await connectBot({ url: "ws://127.0.0.1:4173", token, name: "dev-probe", role: "qa", openSocket: openNodeSocket, onLog: () => {} });
const world = session.world;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const start = Date.now();
while ((!world.self() || !world.sceneGraph()) && Date.now() - start < 5000) await sleep(50);
const door = world.door("brutalist-building-2-cbake.door-1-1-9");
console.log("door open", door?.open, "locked", door?.locked);
const self = world.self()!;
console.log("self", self.x.toFixed(2), self.z.toFixed(2), "place", world.placeOf(self)?.id);
for (const p of world.others()) {
  const d = Math.hypot(p.x - self.x, p.z - self.z);
  if (d < 5) console.log("near id", p.id, p.x.toFixed(2), p.z.toFixed(2), "d", d.toFixed(2));
}
session.close();
