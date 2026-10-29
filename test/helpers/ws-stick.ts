/**
 * Headless "joystick" over the arena websocket.
 * Same frames the browser client sends — no DOM, no Gamepad API.
 *
 * Stick axes match the browser pad convention used by `axesFromStick`:
 *   stickX = strafe (+right), stickY = screen Y (+down → forward is -stickY).
 */
import { WebSocket } from "ws";
import { axesFromStick, moveIntent } from "../../src/shared/look.ts";

export type ArenaHello = {
  world: string;
  bundleId: string;
  authoritativeHash: string;
};

export type Pose = { x: number; y: number; z: number };

export type StickAxes = {
  /** Left stick X: −1 left … +1 right. */
  stickX: number;
  /** Left stick Y: −1 up (forward) … +1 down (back). */
  stickY: number;
};

export type WsStickOptions = {
  /** `ws://` or `wss://`, or `http(s)://` (converted). */
  url: string;
  hello: ArenaHello;
  /** Input send rate while a stick is held (default 20). */
  hz?: number;
  /** Optional reconnect token (same role as sessionStorage on the browser). */
  token?: string;
  welcomeMs?: number;
};

export type WsStick = {
  ws: WebSocket;
  welcome: Promise<{ clientId: number; ownedEntityId: number }>;
  poses: Map<number, Pose>;
  getYaw(): number;
  setYaw(yaw: number): void;
  hold(axes: StickAxes, yaw?: number): void;
  tick(axes: StickAxes, yaw?: number): void;
  release(): void;
  close(): void;
};

function toWsUrl(url: string): string {
  if (url.startsWith("ws://") || url.startsWith("wss://")) return url;
  if (url.startsWith("https://")) return `wss://${url.slice("https://".length)}`;
  if (url.startsWith("http://")) return `ws://${url.slice("http://".length)}`;
  throw new Error(`bad url: ${url}`);
}

function clampAxis(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(-1, Math.min(1, v));
}

function absorb(
  poses: Map<number, Pose>,
  envelope: { spawns?: unknown[]; updates?: unknown[]; despawns?: unknown[] },
): void {
  const rows = [...(envelope.spawns ?? []), ...(envelope.updates ?? [])] as Array<{
    entity?: number;
    view?: { position?: Pose };
  }>;
  for (const row of rows) {
    const id = Number(row.entity);
    const position = row.view?.position;
    if (Number.isFinite(id) && position) poses.set(id, { x: position.x, y: position.y, z: position.z });
  }
  for (const raw of envelope.despawns ?? []) {
    const id = Number((raw as { entity?: number }).entity);
    if (Number.isFinite(id)) poses.delete(id);
  }
}

/** Open a stick session: hello → welcome → ack snapshots → stream input. */
export function openWsStick(opts: WsStickOptions): WsStick {
  const hz = opts.hz ?? 20;
  const intervalMs = Math.max(8, Math.floor(1000 / hz));
  const poses = new Map<number, Pose>();
  let yaw = 0;
  let ownedId: number | undefined;
  let seq = 0;
  let holdTimer: ReturnType<typeof setInterval> | undefined;
  let held: StickAxes | undefined;

  const ws = new WebSocket(toWsUrl(opts.url));

  const welcome = new Promise<{ clientId: number; ownedEntityId: number }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no welcome")), opts.welcomeMs ?? 5000);
    ws.addEventListener("message", (ev) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(String(ev.data)) as Record<string, unknown>;
      } catch {
        return;
      }
      if (msg.type === "reject" || msg.type === "error") {
        clearTimeout(timer);
        reject(new Error(String(msg.reason ?? msg.type)));
        return;
      }
      if (msg.type === "welcome") {
        const clientId = Number(msg.clientId);
        const ownedEntityId = Number(msg.ownedEntityId);
        ownedId = ownedEntityId;
        clearTimeout(timer);
        resolve({ clientId, ownedEntityId });
        return;
      }
      if (msg.type === "snapshot" && msg.envelope && typeof msg.envelope === "object") {
        const envelope = msg.envelope as {
          seq?: number;
          spawns?: unknown[];
          updates?: unknown[];
          despawns?: unknown[];
        };
        absorb(poses, envelope);
        if (typeof envelope.seq === "number" && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ v: 1, type: "ack", snapshotSeq: envelope.seq }));
        }
      }
    });
    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({
        v: 1,
        type: "hello",
        protocol: 1,
        world: opts.hello.world,
        bundleId: opts.hello.bundleId,
        authoritativeHash: opts.hello.authoritativeHash,
        token: opts.token,
      }));
    });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("socket error"));
    });
  });

  function sendAxes(axes: StickAxes, yawNow: number): void {
    if (ownedId === undefined || ws.readyState !== WebSocket.OPEN) return;
    const { strafe, forward } = axesFromStick(clampAxis(axes.stickX), clampAxis(axes.stickY));
    const intent = moveIntent(yawNow, forward, strafe);
    seq += 1;
    ws.send(JSON.stringify({
      v: 1,
      type: "input",
      seq,
      moveX: intent.moveX,
      moveZ: intent.moveZ,
      yaw: yawNow,
      buttons: 0,
      entity: ownedId,
    }));
  }

  function clearHold(): void {
    if (holdTimer !== undefined) clearInterval(holdTimer);
    holdTimer = undefined;
    held = undefined;
  }

  return {
    ws,
    welcome,
    poses,
    getYaw: () => yaw,
    setYaw(next) {
      yaw = next;
    },
    tick(axes, yawOverride) {
      if (yawOverride !== undefined) yaw = yawOverride;
      sendAxes(axes, yaw);
    },
    hold(axes, yawOverride) {
      if (yawOverride !== undefined) yaw = yawOverride;
      held = { stickX: clampAxis(axes.stickX), stickY: clampAxis(axes.stickY) };
      sendAxes(held, yaw);
      if (holdTimer !== undefined) clearInterval(holdTimer);
      holdTimer = setInterval(() => {
        if (!held) return;
        sendAxes(held, yaw);
      }, intervalMs);
    },
    release() {
      const zero = { stickX: 0, stickY: 0 };
      clearHold();
      sendAxes(zero, yaw);
    },
    close() {
      clearHold();
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
    },
  };
}

/** Fetch `/arena.json` from a running host (browser client’s hello source). */
export async function fetchArenaHello(httpBase: string): Promise<ArenaHello> {
  const base = httpBase.replace(/\/$/, "").replace(/^ws/i, "http");
  const res = await fetch(`${base}/arena.json`);
  if (!res.ok) throw new Error(`arena.json ${res.status}`);
  const view = (await res.json()) as Record<string, unknown>;
  const world = String(view.world ?? "");
  const bundleId = String(view.bundleId ?? "");
  const authoritativeHash = String(view.authoritativeHash ?? "");
  if (!world || !bundleId || !authoritativeHash) {
    throw new Error("arena.json missing world / bundleId / authoritativeHash");
  }
  return { world, bundleId, authoritativeHash };
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Resolve when `poses` has the entity (snapshots often land after welcome). */
export function waitForPose(
  poses: Map<number, Pose>,
  entityId: number,
  ms = 3000,
): Promise<Pose> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      const pose = poses.get(entityId);
      if (pose) {
        clearInterval(timer);
        resolve({ ...pose });
      } else if (Date.now() - started > ms) {
        clearInterval(timer);
        reject(new Error(`no pose for entity ${entityId} after ${ms}ms`));
      }
    }, 40);
  });
}
