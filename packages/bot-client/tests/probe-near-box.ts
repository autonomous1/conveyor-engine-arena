// Scratch: who is near the building-2 box, and where do they think they are?
import { readFileSync } from "node:fs";
import { connectBot } from "../../../packages/bot-client/src/connection.ts";
import { openNodeSocket } from "../../../packages/bot-client/src/node-socket.ts";
const token = readFileSync("/home/tim/.config/ce-arena/qa-token.pem", "utf8").trim();
const session = await connectBot({ url: "ws://127.0.0.1:4173", token, name: "dev-probe", role: "qa", openSocket: openNodeSocket, onLog: (l) => console.error(l) });
const world = session.world;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const start = Date.now();
while ((!world.self() || !world.sceneGraph()) && Date.now() - start < 5000) await sleep(50);
const box = { x: 29.915455, z: -5.50252 };
const rows = world.others().map((p) => ({ ...p, d: Math.hypot(p.x - box.x, p.z - box.z), place: world.placeOf(p)?.id ?? "?" }))
  .sort((a, b) => a.d - b.d);
console.log("others", rows.length, "nearest to box", rows[0]?.d.toFixed(1));
for (const row of rows.slice(0, 8)) console.log(`id=${row.id} d=${row.d.toFixed(2)} x=${row.x.toFixed(2)} z=${row.z.toFixed(2)} place=${row.place}`);
session.close();
