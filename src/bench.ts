import { ExampleApp } from "./app.js";

export type BenchReport = {
  entities: number;
  ticks: number;
  clients: number;
  commitMs: number;
  publishMs: number;
  stepMs: number;
  envelopeBytes: number;
  lastHashPrefix: string;
};

export function runBench(opts: { entities?: number; ticks?: number } = {}): BenchReport {
  const entityTarget = opts.entities ?? 1000;
  const ticks = opts.ticks ?? 120;
  const app = new ExampleApp({ radius: 48 });
  const a = app.connectClient();
  const b = app.connectClient();
  const extra = Math.max(0, entityTarget - 2);
  for (let i = 0; i < extra; i++) {
    const x = (i % 40) * 2;
    const z = Math.floor(i / 40) * 2;
    app.addCrate(x, z);
  }
  app.step();

  let commitMs = 0;
  let publishMs = 0;
  let envelopeBytes = 0;
  const tAll = Date.now();
  for (let i = 0; i < ticks; i++) {
    const t0 = Date.now();
    app.tick += 1n;
    app.server.setTick(app.tick);
    const cmdA = a.pred.collectInput({ moveX: 1, moveZ: 0, yaw: 0, buttons: 0 });
    a.ws.sendInput({ seq: cmdA.seq, moveX: 1, moveZ: 0, yaw: 0, entity: a.pawn });
    const cmdB = b.pred.collectInput({ moveX: 0, moveZ: 1, yaw: 0, buttons: 0 });
    b.ws.sendInput({ seq: cmdB.seq, moveX: 0, moveZ: 1, yaw: 0, entity: b.pawn });
    const snap = app.world.commit(app.tick);
    commitMs += Date.now() - t0;
    const t1 = Date.now();
    const envs = app.replicator.publish(app.world, snap);
    publishMs += Date.now() - t1;
    for (const [id, env] of envs) {
      envelopeBytes += JSON.stringify(env, (_k, v) => (typeof v === "bigint" ? v.toString() : v)).length;
      app.server.sendSnapshot(id, env);
    }
  }
  return {
    entities: app.world.store.entityCount,
    ticks,
    clients: app.server.connected.length,
    commitMs,
    publishMs,
    stepMs: Date.now() - tAll,
    envelopeBytes,
    lastHashPrefix: app.world.canonicalJson().slice(0, 64),
  };
}
