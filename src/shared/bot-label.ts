/**
 * Debug label over an unowned host bot. The host sends one only while
 * `ARENA_BOT_DEBUG=1`, and only when the text for that client changed.
 */

/** A label is a short line. Longer text is rejected, not clipped on the client. */
export const BOT_LABEL_MAX = 24;

export type BotLabelFrame = {
  t: "botLabel";
  id: number;
  text: string;
};

/**
 * Capitalised goal and the rounded hp, for example `Wander 100`.
 * Evade adds `·seen` while the threat can see the bot.
 * A dead pawn, or an hp that is not positive, is the text `Dead`.
 */
export function botLabelText(goal: string, hp: number, dead = false, seen = false): string {
  if (dead || !(hp > 0)) return "Dead";
  const name = goal.length === 0 ? goal : goal.charAt(0).toUpperCase() + goal.slice(1);
  const line = `${name} ${Math.round(hp)}`;
  return seen && goal === "evade" ? `${line}·seen` : line;
}

/** Finite integer id and a string of at most {@link BOT_LABEL_MAX} characters. */
export function parseBotLabel(frame: unknown): BotLabelFrame | undefined {
  if (!frame || typeof frame !== "object" || Array.isArray(frame)) return undefined;
  const rec = frame as Record<string, unknown>;
  if (rec.t !== "botLabel") return undefined;
  if (typeof rec.id !== "number" || !Number.isInteger(rec.id)) return undefined;
  if (typeof rec.text !== "string" || rec.text.length > BOT_LABEL_MAX) return undefined;
  return { t: "botLabel", id: rec.id, text: rec.text };
}
