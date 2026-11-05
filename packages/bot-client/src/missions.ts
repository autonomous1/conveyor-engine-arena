/**
 * CLI mission text. Patrol is a loop of `reach` goals; there is no patrol goal in the planner.
 */
import type { Goal } from "../../../src/shared/bots/goap.js";
import { idle, reach, retrieve } from "../../../src/shared/bots/goals.js";

export type Mission =
  | { kind: "goal"; goal: Goal }
  | { kind: "patrol"; places: string[] };

/** `retrieve:<pickup>@<place>`, `reach:<place>`, `patrol:<place,place,…>`, or `idle`. */
export function parseMission(text: string): Mission | undefined {
  if (text === "idle") return { kind: "goal", goal: idle() };
  if (text.startsWith("reach:")) {
    const place = text.slice("reach:".length);
    if (!token(place)) return undefined;
    return { kind: "goal", goal: reach(place) };
  }
  if (text.startsWith("retrieve:")) {
    const body = text.slice("retrieve:".length);
    const at = body.lastIndexOf("@");
    if (at <= 0) return undefined;
    const pickup = body.slice(0, at);
    const place = body.slice(at + 1);
    if (!token(pickup) || !token(place)) return undefined;
    return { kind: "goal", goal: retrieve(pickup, place) };
  }
  if (text.startsWith("patrol:")) {
    const places = text.slice("patrol:".length).split(",").map((part) => part.trim()).filter((part) => part.length > 0);
    if (places.length < 2 || places.some((place) => !token(place))) return undefined;
    return { kind: "patrol", places };
  }
  return undefined;
}

function token(value: string): boolean {
  return value.length > 0 && !/[\s,]/.test(value);
}
