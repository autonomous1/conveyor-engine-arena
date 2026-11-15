/**
 * CLI mission text. Patrol is a loop of `reach` goals; there is no patrol goal in the planner.
 */
import type { Goal } from "../../../src/shared/bots/goap.js";
import { idle, reach, retrieve, standAt } from "../../../src/shared/bots/goals.js";
import type { StandTarget } from "../../../src/shared/nav/stand.js";

export type Mission =
  | { kind: "goal"; goal: Goal }
  | { kind: "patrol"; places: string[] }
  | { kind: "stand"; target: StandTarget };

/** `retrieve:<pickup>@<place>`, `reach:<place>`, `patrol:<place,place,…>`, `stand:…`, or `idle`. */
export function parseMission(text: string): Mission | undefined {
  if (text === "idle") return { kind: "goal", goal: idle() };
  if (text.startsWith("stand:door:")) {
    const body = text.slice("stand:door:".length);
    let doorId = body;
    let side: "in" | "out" | undefined;
    const cut = body.lastIndexOf(":");
    if (cut > 0) {
      const last = body.slice(cut + 1);
      if (last === "in" || last === "out") {
        side = last;
        doorId = body.slice(0, cut);
      }
    }
    if (!token(doorId)) return undefined;
    return { kind: "stand", target: side ? { kind: "door", doorId, side } : { kind: "door", doorId } };
  }
  if (text.startsWith("stand:")) {
    const parts = text.slice("stand:".length).split(",").map((part) => Number(part));
    if ((parts.length !== 3 && parts.length !== 4) || parts.some((value) => !Number.isFinite(value))) return undefined;
    const [x, y, z, yaw] = parts as [number, number, number, number?, ...number[]];
    return { kind: "stand", target: yaw === undefined ? { kind: "point", x, y, z } : { kind: "point", x, y, z, yaw } };
  }
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
