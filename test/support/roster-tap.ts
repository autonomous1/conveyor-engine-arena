// Test-only frame tap: the welcome's and every `players` frame's `teams` rows,
// verbatim from the host. The bot's BotWorld applies ids only, so the roster
// team rows have no other read path in a test.
import { openNodeSocket } from "../../packages/bot-client/src/node-socket.ts";
import { delay, type LiveArena } from "./live-arena.ts";

export type RosterRow = { id: number; team: string };

/** A welcome's or a `players` frame's roster. `teams` is [] when the frame omits it. */
export type RosterFrame = { ids: number[]; teams: RosterRow[]; text: string };

export type RosterTap = {
  welcome(): RosterFrame | undefined;
  /** Every `players` frame received, in order. */
  frames(): readonly RosterFrame[];
  /** The first frame (welcome or players) matching `want`, within `ms`. */
  waitFor(want: (frame: RosterFrame) => boolean, ms: number, label: string): Promise<RosterFrame>;
  close(): void;
};

function rows(value: unknown): RosterRow[] {
  if (!Array.isArray(value)) return [];
  const out: RosterRow[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const rec = item as { id?: unknown; team?: unknown };
    if (typeof rec.id === "number" && typeof rec.team === "string") out.push({ id: rec.id, team: rec.team });
  }
  return out;
}

function textOf(data: unknown): string | undefined {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) return new TextDecoder().decode(data as Uint8Array);
  return undefined;
}

/**
 * Join the live arena with a raw socket and record the roster rows.
 * @post `welcome` is the first welcome; `frames` are the later `players` frames.
 */
export async function openRosterTap(arena: LiveArena, name = "roster-tap", spectate = false): Promise<RosterTap> {
  const res = await fetch(new URL("/arena.json", arena.url));
  const view = (await res.json()) as { world?: unknown; bundleId?: unknown; authoritativeHash?: unknown };
  if (typeof view.world !== "string" || typeof view.bundleId !== "string" || typeof view.authoritativeHash !== "string") {
    throw new Error("arena.json missing world / bundleId / authoritativeHash");
  }
  const ws = openNodeSocket(arena.url);
  let welcome: RosterFrame | undefined;
  const frames: RosterFrame[] = [];
  ws.addEventListener("open", () => {
    ws.send(JSON.stringify({
      v: 1,
      type: "hello",
      protocol: 1,
      world: view.world,
      bundleId: view.bundleId,
      authoritativeHash: view.authoritativeHash,
      token: arena.token,
      auth: arena.token,
      name,
      ...(spectate ? { spectate: true } : {}),
    }));
  });
  ws.addEventListener("message", (ev) => {
    const text = textOf(ev.data);
    if (text === undefined) return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return;
    }
    if (msg.type === "welcome") {
      welcome = {
        ids: Array.isArray(msg.players) ? msg.players.map(Number) : [],
        teams: rows(msg.teams),
        text,
      };
      return;
    }
    if (msg.t === "players") {
      frames.push({
        ids: Array.isArray(msg.ids) ? msg.ids.map(Number) : [],
        teams: rows(msg.teams),
        text,
      });
    }
  });
  return {
    welcome: () => welcome,
    frames: () => frames,
    async waitFor(want, ms, label) {
      const started = Date.now();
      for (;;) {
        if (welcome && want(welcome)) return welcome;
        const hit = frames.find(want);
        if (hit) return hit;
        if (Date.now() - started > ms) throw new Error(label);
        await delay(20);
      }
    },
    close() {
      ws.close();
    },
  };
}
