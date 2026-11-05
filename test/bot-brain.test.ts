import assert from "node:assert/strict";
import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

register(
  "data:text/javascript," +
    encodeURIComponent(`
      import { existsSync } from "node:fs";
      import { fileURLToPath } from "node:url";
      export async function resolve(specifier, context, nextResolve) {
        const parent = context.parentURL ?? "";
        if ((specifier.startsWith("./") || specifier.startsWith("../")) && specifier.endsWith(".js") && parent.includes("/src/")) {
          const ts = specifier.slice(0, -3) + ".ts";
          if (existsSync(fileURLToPath(new URL(ts, parent)))) return nextResolve(ts, context);
        }
        return nextResolve(specifier, context);
      }
    `),
);

const { loadSigner, mint } = await import("../src/server/auth/tokens.ts");
const { startArenaServer } = await import("../src/server/main.ts");
const { connectBot } = await import("../packages/bot-client/src/connection.ts");
const { runCli } = await import("../packages/bot-client/src/cli.ts");
const { runMission } = await import("../packages/bot-client/src/brain.ts");
const { parseMission } = await import("../packages/bot-client/src/missions.ts");
const { moveIntent } = await import("../src/shared/look.ts");
const { wishTo } = await import("../src/shared/nav/follow.ts");

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");
const FIXTURE = path.join(here, "fixtures/goap-arena");
const HOUR_S = 60 * 60;
const NODE_FREE = [
  "packages/bot-client/src/brain.ts",
  "packages/bot-client/src/predict.ts",
  "packages/bot-client/src/missions.ts",
];

function exportPem(key: KeyObject, type: "pkcs8" | "spki"): string {
  const pem = key.export({ type, format: "pem" });
  if (typeof pem !== "string") throw new Error(`expected ${type} PEM text`);
  return pem;
}

async function withEnv<T>(values: Record<string, string | undefined>, run: () => Promise<T>): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function until<T>(read: () => T | undefined, ms: number, label: string): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() - started > ms) throw new Error(label);
    await delay(40);
  }
}

function openSocket(url: string) {
  return new WebSocket(url);
}

type Io = { log: string[]; error: string[]; logLine(line: string): void; errorLine(line: string): void };

function capture(): Io {
  const log: string[] = [];
  const error: string[] = [];
  return {
    log,
    error,
    logLine(line) { log.push(line); },
    errorLine(line) { error.push(line); },
  };
}

function ioOf(io: Io) {
  return { log: io.logLine, error: io.errorLine };
}

type Host = Awaited<ReturnType<typeof startArenaServer>>;

async function boot(gameRoot?: string): Promise<{ dir: string; host: Host; tokenFile: string; blindFile: string; close(): Promise<void> }> {
  const dir = mkdtempSync(path.join(tmpdir(), "arena-bot-brain-"));
  try {
    const keyFile = path.join(dir, "ed25519.key.pem");
    const pubFile = path.join(dir, "ed25519.pub.pem");
    const pair = generateKeyPairSync("ed25519");
    writeFileSync(keyFile, exportPem(pair.privateKey, "pkcs8"), { mode: 0o600 });
    writeFileSync(pubFile, exportPem(pair.publicKey, "spki"));
    const signer = await loadSigner(keyFile);
    const scoped = await mint(signer, { sub: "bot-1", role: "bot", scope: ["scene-graph"], ttlS: HOUR_S });
    const blind = await mint(signer, { sub: "bot-blind", role: "bot", ttlS: HOUR_S });
    const tokenFile = path.join(dir, "token");
    const blindFile = path.join(dir, "blind");
    writeFileSync(tokenFile, scoped.token);
    writeFileSync(blindFile, blind.token);
    const host = await withEnv({
      ARENA_AUTH: "required",
      ARENA_VERIFY_KEY_FILE: pubFile,
      ARENA_REVOKED_FILE: path.join(dir, "none.json"),
      ARENA_GAME_ROOT: undefined,
    }, () => startArenaServer(0, true, gameRoot ? { gameRoot } : undefined));
    return {
      dir,
      host,
      tokenFile,
      blindFile,
      async close() {
        await host.close();
        rmSync(dir, { recursive: true, force: true });
      },
    };
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    throw err;
  }
}

/** Copy the fixture and drop the key pickup. The door still asks for `key`. Asset link is absolute so a temp root can read the GLBs. */
function noKeyRoot(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "arena-goap-nokey-"));
  const game = path.join(dir, "web/game");
  mkdirSync(game, { recursive: true });
  const src = path.join(FIXTURE, "web/game");
  for (const name of ["arena.game.json", "scene-graph.json"]) {
    writeFileSync(path.join(game, name), readFileSync(path.join(src, name)));
  }
  const placements = JSON.parse(readFileSync(path.join(src, "goap.placements.json"), "utf8")) as {
    placements: Array<{ id: string }>;
    obstacles: Array<{ id: string }>;
  };
  placements.placements = placements.placements.filter((item) => item.id !== "key");
  placements.obstacles = placements.obstacles.filter((item) => item.id !== "key-box");
  writeFileSync(path.join(game, "goap.placements.json"), JSON.stringify(placements));
  symlinkSync(path.join(repo, "web/assets"), path.join(dir, "web/assets"));
  return dir;
}

let tail: Promise<void> = Promise.resolve();
function serial(name: string, fn: () => Promise<void>, timeout: number): void {
  const prev = tail;
  let release: () => void = () => {};
  tail = new Promise<void>((resolve) => { release = resolve; });
  test(name, { timeout }, async () => {
    await prev;
    try {
      await fn();
    } finally {
      release();
    }
  });
}

test("brain, predict, and missions stay free of node, ws, and the host", () => {
  for (const file of NODE_FREE) {
    const text = readFileSync(path.join(repo, file), "utf8");
    assert.equal(text.includes("node:"), false, file);
    assert.equal(/from ["']ws["']/.test(text), false, file);
    assert.equal(text.includes("readFileSync"), false, file);
    assert.equal(text.includes("require("), false, file);
    assert.equal(text.includes("src/server"), false, file);
  }
  assert.equal(parseMission("idle")?.kind, "goal");
  assert.equal(parseMission("patrol:room-a,hall")?.kind, "patrol");
  assert.equal(parseMission("nope"), undefined);
  assert.ok(moveIntent(Math.PI, 1, 0).moveZ < -0.9);
});

test("ce-bot usage exits", async () => {
  const help = capture();
  assert.equal(await runCli(["--help"], ioOf(help)), 0);
  assert.match(help.log.join("\n"), /ce-bot run/);
  const bad = capture();
  assert.equal(await runCli(["run", "--nope"], ioOf(bad)), 1);
  assert.match(bad.error.join("\n"), /unknown option/);
  assert.match(bad.log.join("\n"), /ce-bot connect/);
  const goal = capture();
  assert.equal(await runCli(["run", "--url", "ws://127.0.0.1", "--token-file", "x", "--goal", "fly"], ioOf(goal)), 1);
});

serial("goap fixture retrieve, idle, scope, and a full server", async () => {
  const arena = await boot(FIXTURE);
  try {
    const view = await (await fetch(`${arena.host.url}/arena.json`)).json() as {
      doors?: Array<{ id: string; locked?: boolean }>;
      pickups?: Array<{ id: string }>;
      playerSpawns?: unknown[];
    };
    assert.equal(view.doors?.some((door) => door.id === "door-b" && door.locked === true), true);
    assert.deepEqual((view.pickups ?? []).map((item) => item.id).sort(), ["key", "prize"]);
    assert.ok((view.playerSpawns ?? []).length >= 2);

    const idle = capture();
    assert.equal(await runCli([
      "run", "--url", arena.host.url, "--token-file", arena.tokenFile,
      "--goal", "idle", "--timeout-s", "10", "--name", "idler",
    ], ioOf(idle)), 0, idle.error.join("\n"));
    await delay(200);

    const io = capture();
    const started = Date.now();
    const code = await runCli([
      "run", "--url", arena.host.url, "--token-file", arena.tokenFile,
      "--goal", "retrieve:prize@room-b", "--timeout-s", "30", "--name", "fetcher",
    ], ioOf(io));
    const wall = Date.now() - started;
    const text = [...io.log, ...io.error].join("\n");
    assert.equal(code, 0, text);
    assert.ok(wall < 30_000, `wall ${wall}ms\n${text}`);
    const starts = io.log.filter((line) => line.startsWith("start ")).map((line) => line.split(" ")[1]);
    const keyAt = starts.indexOf("pickup:key");
    const unlockAt = starts.indexOf("unlock:door-b");
    const prizeAt = starts.indexOf("pickup:prize");
    assert.ok(keyAt >= 0 && unlockAt > keyAt && prizeAt > unlockAt, starts.join(","));
    await delay(200);

    const blind = capture();
    const blindCode = await runCli([
      "run", "--url", arena.host.url, "--token-file", arena.blindFile,
      "--goal", "retrieve:prize@room-b", "--timeout-s", "10", "--name", "blind",
    ], ioOf(blind));
    assert.equal(blindCode, 2, blind.error.join("\n"));
    assert.ok(blind.error.includes("no scene graph (token lacks scene-graph scope?)"), blind.error.join("\n"));
    await delay(200);

    const full = capture();
    const fullCode = await runCli([
      "run", "--url", arena.host.url, "--token-file", arena.tokenFile,
      "--goal", "idle", "--count", "4", "--timeout-s", "10",
    ], ioOf(full));
    assert.equal(fullCode, 4, full.error.join("\n"));
    assert.match(full.error.join("\n"), /SERVER_FULL/);
  } finally {
    await arena.close();
  }
}, 90_000);

serial("retrieve with the key removed exits 2", async () => {
  const root = noKeyRoot();
  const arena = await boot(root);
  try {
    const io = capture();
    const started = Date.now();
    const code = await runCli([
      "run", "--url", arena.host.url, "--token-file", arena.tokenFile,
      "--goal", "retrieve:prize@room-b", "--timeout-s", "10", "--name", "nokey",
    ], ioOf(io));
    const wall = Date.now() - started;
    assert.equal(code, 2, [...io.log, ...io.error].join("\n"));
    assert.ok(wall < 2_000, `wall ${wall}ms`);
  } finally {
    await arena.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);

serial("yaw pi and moveIntent(pi, 1, 0) travels at least 3 m in -Z", async () => {
  const arena = await boot(FIXTURE);
  try {
    const session = await connectBot({
      url: arena.host.url,
      token: readFileSync(arena.tokenFile, "utf8").trim(),
      name: "yaw",
      role: "bot",
      openSocket,
    });
    try {
      const pawn = await until(() => session.world.self(), 5_000, "yaw pawn");
      const z0 = pawn.z;
      let minZ = z0;
      const began = Date.now();
      while (Date.now() - began < 1_000) {
        const wish = moveIntent(Math.PI, 1, 0);
        session.input.sendInput({ moveX: wish.moveX, moveZ: wish.moveZ, yaw: Math.PI });
        const self = session.world.self();
        if (self && self.z < minZ) minZ = self.z;
        await delay(40);
      }
      await delay(250);
      const end = session.world.self();
      if (end && end.z < minZ) minZ = end.z;
      assert.ok(z0 - minZ >= 3, `moved ${z0 - minZ} m in -Z from z=${z0} to z=${minZ}`);
    } finally {
      session.close();
    }
  } finally {
    await arena.close();
  }
}, 20_000);

serial("a pawn in the opening still finishes or replans stuck", async () => {
  const arena = await boot(FIXTURE);
  let blocker: Awaited<ReturnType<typeof connectBot>> | undefined;
  let hold: ReturnType<typeof setInterval> | undefined;
  try {
    blocker = await connectBot({
      url: arena.host.url,
      token: readFileSync(arena.tokenFile, "utf8").trim(),
      name: "blocker",
      role: "bot",
      openSocket,
    });
    await until(() => blocker.world.self(), 5_000, "blocker pawn");
    const drive = Date.now();
    let parked = false;
    while (Date.now() - drive < 8_000) {
      const self = blocker.world.self();
      if (self && Math.hypot(self.x - 10, self.z - 4) < 0.45) {
        parked = true;
        break;
      }
      if (self) blocker.input.sendInput(wishTo({ x: self.x, y: self.y, z: self.z, vx: 0, vz: 0, yaw: self.yaw }, { x: 10, z: 4 }, 1));
      await delay(50);
    }
    assert.equal(parked, true, "blocker did not reach the opening");
    hold = setInterval(() => {
      const self = blocker.world.self();
      if (!self) return;
      blocker.input.sendInput({ moveX: 0, moveZ: 0, yaw: self.yaw });
    }, 50);
    const io = capture();
    const code = await runCli([
      "run", "--url", arena.host.url, "--token-file", arena.tokenFile,
      "--goal", "retrieve:prize@room-b", "--timeout-s", "20", "--name", "runner",
    ], ioOf(io));
    const text = [...io.log, ...io.error].join("\n");
    assert.ok(code === 0 || text.includes("replan stuck"), `code ${code}\n${text}`);
  } finally {
    if (hold) clearInterval(hold);
    blocker?.close();
    await arena.close();
  }
}, 45_000);

serial("two patrol bots do not overlap for more than a second", async () => {
  const arena = await boot(FIXTURE);
  let first: Awaited<ReturnType<typeof connectBot>> | undefined;
  let second: Awaited<ReturnType<typeof connectBot>> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  try {
    const token = readFileSync(arena.tokenFile, "utf8").trim();
    const open = { url: arena.host.url, token, role: "bot" as const, openSocket };
    first = await connectBot({ ...open, name: "bot-1" });
    second = await connectBot({ ...open, name: "bot-2" });
    await until(() => (first.world.self() && second.world.self() ? true : undefined), 5_000, "patrol pawns");
    let overlapSince: number | undefined;
    let maxOverlap = 0;
    timer = setInterval(() => {
      const a = first.world.self();
      const b = second.world.self();
      if (!a || !b) return;
      if (Math.hypot(a.x - b.x, a.z - b.z) < 1) {
        if (overlapSince === undefined) overlapSince = Date.now();
        maxOverlap = Math.max(maxOverlap, Date.now() - overlapSince);
      } else {
        overlapSince = undefined;
      }
    }, 50);
    const mission = parseMission("patrol:room-a,hall");
    assert.ok(mission && mission.kind === "patrol");
    const codes = await Promise.all([
      runMission(first, mission, { timeoutMs: 60_000 }),
      runMission(second, mission, { timeoutMs: 60_000 }),
    ]);
    assert.ok(maxOverlap <= 1_000, `overlap ${maxOverlap} ms`);
    assert.deepEqual(codes, [3, 3]);
  } finally {
    if (timer) clearInterval(timer);
    first?.close();
    second?.close();
    await arena.close();
  }
}, 90_000);

serial("omitting the game root still loads arena-1", async () => {
  const host = await withEnv({
    ARENA_GAME_ROOT: undefined,
    ARENA_AUTH: undefined,
    ARENA_VERIFY_KEY_FILE: undefined,
  }, () => startArenaServer(0, true));
  try {
    const view = await (await fetch(`${host.url}/arena.json`)).json() as {
      doors?: Array<{ id: string }>;
      playerSpawns?: unknown[];
    };
    const ids = (view.doors ?? []).map((door) => door.id);
    assert.equal(ids.includes("brutalist-building-2-cbake.door-1-1-9"), true);
    assert.equal(ids.includes("door-b"), false);
    assert.ok((view.playerSpawns ?? []).length >= 3);
  } finally {
    await host.close();
  }
}, 60_000);
