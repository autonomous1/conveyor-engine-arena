/**
 * Host debug labels for unowned wander bots. Off unless the caller read
 * `ARENA_BOT_DEBUG=1` once at start. The off path returns before any string.
 * Text is built only when that bot's sensor tick changes (the brain's decision
 * rate). Delivery uses the same per-session cache as health.
 */
// ARCHITECTURE: Host debug labels: one text line per bot, built on the sensor
//   tick and delivered to watching clients.
// Wiring: arena-host.ts builds it (enabled by `ARENA_BOT_DEBUG=1`) and the tick
//   calls `update`; health.ts's `sentFor`/`clientSeesPawn` gate delivery.
// Invariants: The disabled path returns before building any string or frame.
import { encodeFrame, type EngineWsServer } from "conveyor-engine-transport-ws";
import { botLabelText, type BotLabelFrame } from "../shared/bot-label.js";
import { clientSeesPawn, sentFor } from "./health.js";

const sentLabels = new WeakMap<EngineWsServer, Map<number, { sessionId: number; rows: Map<number, string> }>>();

/** One label per bot this client can see, and only when that session has not seen the text. */
export function deliverBotLabelFrames(
  server: EngineWsServer,
  clientIds: Iterable<number>,
  frames: readonly BotLabelFrame[],
): void {
  if (frames.length === 0) return;
  const texts: (string | undefined)[] = [];
  for (const clientId of clientIds) {
    const socket = server.session(clientId)?.socket;
    const sent = socket && sentFor(sentLabels, server, clientId, () => ({ rows: new Map<number, string>() }));
    if (!socket || !sent) continue;
    for (let i = 0; i < frames.length; i++) {
      const frame = frames[i]!;
      if (!clientSeesPawn(server, clientId, frame.id)) continue;
      if (sent.rows.get(frame.id) === frame.text) continue;
      sent.rows.set(frame.id, frame.text);
      socket.send((texts[i] ??= encodeFrame(frame)));
    }
  }
}

export type BotLabelHost = {
  /** Once per host tick, after the brain. Flag off returns before any string. */
  update(): void;
};

export type BotLabelHostOptions = {
  /** False returns before any of the other fields are read. */
  enabled: boolean;
  server: EngineWsServer;
  /** Unowned wander bots. Fixed at start so a tick does not allocate the list. */
  ids: readonly number[];
  brain: { goalOf(id: number): string | undefined; seenOf?(id: number): boolean };
  health: { get(id: number): { hp: number; dead: boolean } };
  /** Per-bot sensor tick. Unchanged means the brain did not decide again. */
  sense: { get(id: number): { tick: number } | undefined };
};

const IDLE: BotLabelHost = { update() {} };

export function createBotLabelHost(opts: BotLabelHostOptions): BotLabelHost {
  if (opts.enabled !== true) return IDLE;
  const seenTick = new Map<number, number>();
  const textAt = new Map<number, string>();
  const frames: BotLabelFrame[] = [];
  const { server, ids, brain, health, sense } = opts;
  return {
    update() {
      let rebuild = false;
      for (let i = 0; i < ids.length; i++) {
        const id = ids[i]!;
        const row = sense.get(id);
        if (!row || seenTick.get(id) === row.tick) continue;
        seenTick.set(id, row.tick);
        const goal = brain.goalOf(id);
        if (goal === undefined) continue;
        const vital = health.get(id);
        const seen = goal === "evade" && brain.seenOf?.(id) === true;
        const text = botLabelText(goal, vital.hp, vital.dead, seen);
        if (textAt.get(id) === text) continue;
        textAt.set(id, text);
        rebuild = true;
      }
      if (rebuild) {
        frames.length = 0;
        for (const [id, text] of textAt) frames.push({ t: "botLabel", id, text });
      }
      if (frames.length === 0) return;
      deliverBotLabelFrames(server, server.connected, frames);
    },
  };
}
