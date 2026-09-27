import { ExampleApp } from "./app.js";
import { runNamed, type RunnerName } from "./runners.js";

const arg = process.argv[2];

if (arg === "lossless" || arg === "lossy" || arg === "partition") {
  const result = await runNamed(arg as RunnerName);
  console.log(JSON.stringify({
    runner: result.name,
    ticks: result.hashes.length,
    deliveries: result.deliveries,
    sends: result.sends,
    rejects: result.rejects,
    mirrors: result.mirrorCounts,
    hash: result.worldHash.slice(0, 80),
  }, null, 2));
  process.exit(0);
}

const useArena = arg === "arena" || arg === "arena-miss";
const ticks = Math.max(1, Number.parseInt(process.argv[3] ?? "8", 10) || 8);
const app = useArena
  ? ExampleApp.arena({ presentation: arg === "arena-miss" ? "missing" : "ready" })
  : new ExampleApp();
const a = app.connectClient();
const b = app.connectClient();
if (!useArena) app.addCrate(3, 0);
for (let i = 0; i < ticks; i++) {
  app.step(new Map([
    [a.id, { moveX: 1, moveZ: 0 }],
    [b.id, { moveX: -1, moveZ: 0 }],
  ]));
}
const d = app.diagnostics();
const posA = app.world.store.view(a.pawn)?.position;
const posB = app.world.store.view(b.pawn)?.position;
console.log(JSON.stringify({
  mode: useArena ? arg : "open-plane",
  requestedTicks: ticks,
  tick: d.tick.toString(),
  entities: d.entityCount,
  clients: d.clientCount,
  inputs: d.inputs,
  invalidInputs: d.invalidInputs,
  snapshots: d.snapshots,
  bundleId: d.bundleId,
  authoritativeHash: d.authoritativeHash,
  spawnCount: d.spawnCount,
  aabbCount: d.aabbCount,
  presentation: d.presentation,
  hash: d.hash.slice(0, 80),
  clientA: {
    snapshots: a.snapshots.length,
    unacked: a.pred.metrics.unacked,
    last: a.snapshots.at(-1)?.kind,
    visual: a.pred.visualStatus,
    pos: posA,
  },
  clientB: {
    snapshots: b.snapshots.length,
    unacked: b.pred.metrics.unacked,
    last: b.snapshots.at(-1)?.kind,
    visual: b.pred.visualStatus,
    pos: posB,
  },
}, null, 2));
