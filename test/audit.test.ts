import assert from "node:assert/strict";
import test from "node:test";
import { AuthoritativeWorld } from "conveyor-engine-world";
import { createOptionsDialog } from "../src/client/options.ts";
import { createHud, localHealthLabel } from "../src/client/hud.ts";
import { createArenaFire } from "../dist/server/fire.js";
import { startArenaServer } from "../dist/server/main.js";
import {
  auditFrame,
  createAudit,
  emptyAudit,
  formatAudit,
  parseAudit,
  type AuditCounters,
} from "../src/shared/audit.ts";
import { createPawnHealth, HIT_DAMAGE, MAX_HP, type PawnHealth } from "../src/shared/health.ts";
import { FIRE_INTERVAL_MS } from "../src/shared/hitscan.ts";

const ZERO: AuditCounters = emptyAudit();

test("audit counts a new receive, and a repeated seq changes droppedDuplicate only", () => {
  const audit = createAudit();
  audit.gate("accept");
  audit.pawnHit(false);
  const before = audit.counts;
  audit.gate("repeat");
  const after = audit.counts;
  assert.equal(after.droppedDuplicate, before.droppedDuplicate + 1);
  assert.equal(after.fired, before.fired);
  assert.equal(after.accepted, before.accepted);
  assert.equal(after.droppedRate, before.droppedRate);
  assert.equal(after.hits, before.hits);
  assert.equal(after.kills, before.kills);

  audit.gate("fast");
  assert.equal(audit.counts.fired, 2);
  assert.equal(audit.counts.accepted, 1);
  assert.equal(audit.counts.droppedRate, 1);
  assert.equal(audit.counts.droppedDuplicate, 1);
  audit.pawnHit(true);
  assert.equal(audit.counts.hits, 2);
  assert.equal(audit.counts.kills, 1);

  const frame = audit.frame();
  assert.deepEqual(parseAudit(frame), frame);
  assert.equal(parseAudit({ t: "health", entity: 1, hp: 100, dead: false }), undefined);
  assert.equal(parseAudit({ t: "audit", ...frame, fired: 1.5 }), undefined);
  assert.equal(parseAudit({ t: "audit", ...ZERO, fired: -1 }), undefined);
  assert.equal(formatAudit(frame), [
    "fired 2",
    "accepted 1",
    "droppedDuplicate 1",
    "droppedRate 1",
    "hits 2",
    "kills 1",
  ].join("\n"));
});

test("local health stays on the HUD from 100 through death until respawn", () => {
  assert.equal(localHealthLabel(undefined), "");
  assert.equal(localHealthLabel({ hp: Number.NaN, dead: true }), "");
  assert.equal(localHealthLabel({ hp: MAX_HP, dead: false }), "hp 100");
  assert.equal(localHealthLabel({ hp: 140, dead: false }), "hp 100");
  assert.equal(localHealthLabel({ hp: 0, dead: true }), "hp 0 dead");
  assert.equal(localHealthLabel({ hp: -4, dead: true }), "hp 0 dead");
  assert.equal(localHealthLabel({ hp: MAX_HP, dead: false }), "hp 100");
  assert.equal(HIT_DAMAGE, 25);
});

test("the options panel shows the six counters and the crosshair HUD does not", () => {
  const rig = installDom();
  try {
    createHud();
    const dialog = createOptionsDialog(() => {});
    const panel = rig.get("options-dialog");
    const audit = rig.get("audit-counters");
    assert.equal(panel.hidden, true);
    assert.ok(panel.children.includes(audit));
    assert.equal(audit.textContent, formatAudit(ZERO));
    assert.equal(rig.get("fire-debug").textContent, "Fire debug: off");

    const next = auditFrame({
      fired: 1,
      accepted: 1,
      droppedDuplicate: 0,
      droppedRate: 0,
      hits: 0,
      kills: 0,
    });
    dialog.setAudit(next);
    assert.equal(audit.textContent, formatAudit(next));
    assert.equal(panel.hidden, true);
    dialog.setAudit(next);
    assert.equal(audit.textContent, formatAudit(next));

    const cross = rig.get("crosshair");
    assert.equal(cross.children.includes(audit), false);
    for (const id of ["status-text", "stats", "crosshair"]) {
      assert.equal(rig.get(id).textContent.includes("droppedDuplicate"), false, id);
      assert.equal(rig.get(id).textContent.includes("fired "), false, id);
    }
  } finally {
    rig.restore();
  }
});

test("a repeated seq increments droppedDuplicate only", () => {
  const { world, shooter, victim } = pawnWorld();
  const health = createPawnHealth();
  health.note(shooter);
  health.note(victim);
  const rig = hostFire(world, health, (clientId) => (clientId === 1 ? shooter : victim));
  const shot = { t: "fire", v: 1, seq: 1, yaw: 0, pitch: 0 };
  rig.fire.onFrame(1, shot);
  assert.equal(health.get(victim).hp, 75);
  assert.equal(rig.lasers.length, 2);
  const before = rig.fire.counters;
  assert.deepEqual(before, { ...ZERO, fired: 1, accepted: 1, hits: 1 });
  rig.fire.onFrame(1, shot);
  const after = rig.fire.counters;
  assert.equal(after.droppedDuplicate, before.droppedDuplicate + 1);
  assert.equal(after.fired, before.fired);
  assert.equal(after.accepted, before.accepted);
  assert.equal(after.droppedRate, before.droppedRate);
  assert.equal(after.hits, before.hits);
  assert.equal(after.kills, before.kills);
  assert.equal(health.get(victim).hp, 75);
  assert.equal(rig.lasers.length, 2);
  assert.deepEqual(parseAudit(rig.audits.at(-1)), auditFrame(after));
});

test("a newer seq inside the cadence window increments droppedRate and fired", () => {
  const { world, shooter, victim } = pawnWorld();
  const health = createPawnHealth();
  health.note(shooter);
  health.note(victim);
  const rig = hostFire(world, health, () => shooter);
  rig.fire.onFrame(1, { t: "fire", v: 1, seq: 1, yaw: 0, pitch: 0 });
  rig.fire.onFrame(1, { t: "fire", v: 1, seq: 2, yaw: 0, pitch: 0 });
  assert.deepEqual(rig.fire.counters, { ...ZERO, fired: 2, accepted: 1, droppedRate: 1, hits: 1 });
  assert.equal(health.get(victim).hp, 75);
  assert.equal(rig.lasers.length, 2);
});

test("an obstacle hit does not count as a pawn hit", () => {
  const { world, shooter, victim } = pawnWorld();
  world.addObstacle({ id: 188, minX: -1, maxX: 1, minY: 0, maxY: 2, minZ: 3, maxZ: 4 });
  const health = createPawnHealth();
  health.note(shooter);
  health.note(victim);
  const rig = hostFire(world, health, () => shooter);
  rig.fire.onFrame(1, { t: "fire", v: 1, seq: 1, yaw: 0, pitch: 0 });
  assert.equal(health.get(victim).hp, MAX_HP);
  assert.equal(health.get(shooter).hp, MAX_HP);
  assert.deepEqual(rig.fire.counters, { ...ZERO, fired: 1, accepted: 1 });
  assert.equal(rig.lasers.length, 2);
});

test("four pawn hits kill once, and a later hit on the corpse does not kill again", () => {
  const { world, shooter, victim } = pawnWorld();
  const health = createPawnHealth();
  health.note(shooter);
  health.note(victim);
  const rig = hostFire(world, health, (clientId) => (clientId === 1 ? shooter : victim));
  const hp: number[] = [];
  for (let seq = 1; seq <= 4; seq += 1) {
    if (seq > 1) rig.advance(FIRE_INTERVAL_MS + 10);
    rig.fire.onFrame(1, { t: "fire", v: 1, seq, yaw: 0, pitch: 0 });
    hp.push(health.get(victim).hp);
  }
  assert.deepEqual(hp, [75, 50, 25, 0]);
  assert.deepEqual(health.get(victim), { hp: 0, dead: true });
  assert.deepEqual(rig.fire.counters, { ...ZERO, fired: 4, accepted: 4, hits: 4, kills: 1 });

  rig.advance(FIRE_INTERVAL_MS + 10);
  rig.fire.onFrame(1, { t: "fire", v: 1, seq: 5, yaw: 0, pitch: 0 });
  assert.equal(health.get(victim).hp, 0);
  assert.equal(rig.fire.counters.hits, 5);
  assert.equal(rig.fire.counters.kills, 1);
  assert.equal(rig.fire.counters.fired, 5);
  assert.equal(rig.fire.counters.accepted, 5);

  const before = rig.fire.counters;
  const lasers = rig.lasers.length;
  rig.fire.onFrame(2, { t: "fire", v: 1, seq: 1, yaw: Math.PI, pitch: 0 });
  assert.equal(rig.lasers.length, lasers);
  assert.equal(rig.fire.counters.fired, before.fired + 1);
  assert.equal(rig.fire.counters.accepted, before.accepted + 1);
  assert.equal(rig.fire.counters.hits, before.hits);
  assert.equal(rig.fire.counters.kills, before.kills);
  assert.equal(rig.fire.counters.droppedDuplicate, before.droppedDuplicate);
  assert.equal(health.get(shooter).hp, MAX_HP);
});

test("one shot raises fired and accepted, and the other client still gets one laser", async () => {
  const host = await startArenaServer(0);
  let a: LiveClient | undefined;
  let b: LiveClient | undefined;
  try {
    const view = await (await fetch(host.url + "/arena.json")).json() as {
      world: string;
      bundleId: string;
      authoritativeHash: string;
    };
    a = openClient(host.url, view);
    b = openClient(host.url, view);
    const aw = await a.welcome;
    const bw = await b.welcome;
    assert.notEqual(aw.ownedEntityId, bw.ownedEntityId);
    await waitFor(2000, () => (a!.snaps > 0 && b!.snaps > 0 ? true : undefined));
    await delay(100);
    const send = (seq: number) => {
      a!.ws.send(JSON.stringify({ t: "fire", v: 1, seq, yaw: 0, pitch: 0 }));
    };
    send(1);
    const first = await waitFor(2000, () => {
      const row = a!.audits.at(-1);
      if (!row || row.fired < 1 || row.accepted < 1) return undefined;
      return row;
    });
    await waitFor(2000, () => (b!.lasers.includes(aw.ownedEntityId) ? true : undefined));
    const seen = b.lasers.filter((id) => id === aw.ownedEntityId).length;
    send(1);
    const next = await waitFor(2000, () => {
      const row = a!.audits.at(-1);
      if (!row || row.droppedDuplicate !== first.droppedDuplicate + 1) return undefined;
      return row;
    });
    assert.equal(next.fired, first.fired);
    assert.equal(next.accepted, first.accepted);
    assert.equal(next.droppedRate, first.droppedRate);
    assert.equal(next.hits, first.hits);
    assert.equal(next.kills, first.kills);
    await delay(80);
    assert.equal(b.lasers.filter((id) => id === aw.ownedEntityId).length, seen);
    const echoed = b.audits.at(-1);
    assert.ok(echoed);
    assert.equal(echoed.droppedDuplicate, next.droppedDuplicate);
    assert.equal(echoed.fired, next.fired);
    assert.equal(echoed.accepted, next.accepted);
  } finally {
    a?.ws.close();
    b?.ws.close();
    await host.close();
  }
});

function pawnWorld() {
  const world = new AuthoritativeWorld({ worldVersion: "audit-test" });
  world.pawnHeight = 1.8;
  const shooter = world.createEntity(0n, { type: "pawn", shape: "capsule" }, 1);
  const victim = world.createEntity(0n, { type: "pawn", shape: "capsule" }, 2);
  const place = (id: number, x: number, z: number) => {
    world.enqueue({
      kind: "setTransform",
      entity: id,
      position: { x, y: 0, z },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      scale: { x: 1, y: 1, z: 1 },
    });
    world.enqueue({ kind: "setBounds", entity: id, radius: 0.5 });
  };
  place(shooter, 0, 0);
  place(victim, 0, 6);
  world.commit(0n);
  return { world, shooter, victim };
}

function hostFire(world: AuthoritativeWorld, health: PawnHealth, ownedOf: (clientId: number) => number) {
  const lasers: Array<{ shooter: number }> = [];
  const audits: unknown[] = [];
  let nowMs = 0;
  const ids = new Set<number>();
  for (const entity of world.query()) ids.add(entity.id);
  const fire = createArenaFire({
    world,
    health,
    now: () => nowMs,
    server: {
      session: () => ({
        sessionId: 3,
        socket: {
          send(text: string) {
            const frame = JSON.parse(text) as { t?: string };
            if (frame.t === "audit") audits.push(frame);
          },
        },
      }),
      replicator: {
        get: (clientId: number) => ({
          ownedEntity: ownedOf(clientId),
          connected: true,
          known: ids,
        }),
      },
      connected: [1, 2],
    } as never,
    send(_id, frame) {
      lasers.push(frame);
    },
  });
  return {
    fire,
    lasers,
    audits,
    advance(ms: number) {
      nowMs += ms;
    },
  };
}

type LiveClient = {
  ws: WebSocket;
  welcome: Promise<{ ownedEntityId: number }>;
  audits: AuditCounters[];
  lasers: number[];
  snaps: number;
};

function openClient(url: string, view: { world: string; bundleId: string; authoritativeHash: string }): LiveClient {
  const audits: AuditCounters[] = [];
  const lasers: number[] = [];
  let snaps = 0;
  const ws = new WebSocket(url.replace(/^http/, "ws"));
  const welcome = new Promise<{ ownedEntityId: number }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no welcome")), 3000);
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(String(ev.data)) as {
        t?: string;
        type?: string;
        reason?: string;
        ownedEntityId?: number;
        shooter?: number;
        envelope?: { seq?: number };
        fired?: number;
        accepted?: number;
        droppedDuplicate?: number;
        droppedRate?: number;
        hits?: number;
        kills?: number;
      };
      const audit = parseAudit(msg);
      if (audit) {
        audits.push(audit);
        return;
      }
      if (msg.t === "laser" && msg.shooter !== undefined) {
        lasers.push(msg.shooter);
        return;
      }
      if (msg.type === "reject") {
        clearTimeout(timer);
        reject(new Error(msg.reason ?? "reject"));
      }
      if (msg.type === "welcome") {
        clearTimeout(timer);
        resolve({ ownedEntityId: Number(msg.ownedEntityId) });
      }
      if (msg.type === "snapshot") {
        snaps += 1;
        const seq = msg.envelope?.seq;
        if (typeof seq === "number" && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ v: 1, type: "ack", snapshotSeq: seq }));
        }
      }
    });
    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({
        v: 1,
        type: "hello",
        protocol: 1,
        world: view.world,
        bundleId: view.bundleId,
        authoritativeHash: view.authoritativeHash,
      }));
    });
  });
  return {
    ws,
    welcome,
    audits,
    lasers,
    get snaps() {
      return snaps;
    },
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitFor<T>(ms: number, read: () => T | undefined): Promise<T> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      const value = read();
      if (value !== undefined) {
        clearInterval(timer);
        resolve(value);
        return;
      }
      if (Date.now() - started >= ms) {
        clearInterval(timer);
        reject(new Error("timed out"));
      }
    }, 15);
  });
}

type FakeEl = {
  tag: string;
  id: string;
  hidden: boolean;
  textContent: string;
  type: string;
  title: string;
  style: { cssText: string; borderColor?: string };
  children: FakeEl[];
  append(...nodes: FakeEl[]): void;
  setAttribute(name: string, value: string): void;
  addEventListener(): void;
};

function installDom() {
  const ids = new Map<string, FakeEl>();
  const previous = { window: globalThis.window, document: globalThis.document };
  function createElement(tag: string): FakeEl {
    let idValue = "";
    const el = {
      tag,
      hidden: false,
      textContent: "",
      type: "",
      title: "",
      style: { cssText: "" },
      children: [] as FakeEl[],
      get id() {
        return idValue;
      },
      set id(value: string) {
        if (idValue) ids.delete(idValue);
        idValue = value;
        if (value) ids.set(value, el);
      },
      append(...nodes: FakeEl[]) {
        this.children.push(...nodes);
      },
      setAttribute() {},
      addEventListener() {},
    };
    return el;
  }
  const body = createElement("body");
  const document = {
    body,
    createElement,
    getElementById(id: string) {
      return ids.get(id) ?? null;
    },
  };
  globalThis.window = { addEventListener() {} } as unknown as Window & typeof globalThis;
  globalThis.document = document as unknown as Document;
  return {
    get(id: string) {
      const el = ids.get(id);
      assert.ok(el, id);
      return el;
    },
    restore() {
      globalThis.window = previous.window;
      globalThis.document = previous.document;
    },
  };
}
