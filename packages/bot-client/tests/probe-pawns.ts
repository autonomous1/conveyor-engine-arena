import { connectBot } from "../../../packages/bot-client/src/connection.ts";
import { openNodeSocket } from "../../../packages/bot-client/src/node-socket.ts";
const token = (process.env.CE_TOKEN ?? "").trim();
const session = await connectBot({ url: "wss://arena.tszakacs.com", token, name: "dev-probe", role: "qa", openSocket: openNodeSocket, onLog: () => {} });
const world = session.world;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const started = Date.now();
while ((!world.self() || !world.sceneGraph()) && Date.now() - started < 8000) await sleep(50);
const self = world.self()!;
const players = new Set([...(world.playerIds?.() ?? [])]);
console.log(`self=${self.id} at ${self.x.toFixed(1)},${self.z.toFixed(1)} weapon=${world.weapon() ?? "none"} ammo=${world.ammo()} pickups=${world.pickups().length} weaponOnMap=${[...world.pickups()].includes("alien-weapon-1")}`);
console.log(`players=${[...players].join(",")} others=${world.others().length}`);
const rows = world.others()
  .map((p) => ({ id: p.id, d: Math.hypot(p.x - self.x, p.z - self.z), x: p.x, z: p.z, player: players.has(p.id) }))
  .sort((a, b) => a.d - b.d);
for (const r of rows) console.log(`  id=${r.id} d=${r.d.toFixed(1)} at ${r.x.toFixed(1)},${r.z.toFixed(1)}${r.player ? " PLAYER" : " wander"}`);
session.close();
