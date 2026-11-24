import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { plan } from "../src/shared/bots/goap.ts";

const BRAIN = readFileSync(new URL("../packages/bot-client/src/brain.ts", import.meta.url), "utf8");

test("plan_step_map_covers_every_kind", () => {
  const block = /const STEP_BINDERS = new Map<string, StepBinder>\(\[([\s\S]*?)\]\);/.exec(BRAIN);
  assert.ok(block, "STEP_BINDERS is missing");
  const kinds = [...block[1]!.matchAll(/\["([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(kinds, ["goTo", "standAt", "ride", "rideTo", "goToDoor", "unlock", "pickup", "seekHealth", "reload", "takeCover", "retreat", "returnFire"]);
  // The wrapper is one parse + one optional lookup: an unknown kind returns undefined.
  assert.match(BRAIN, /STEP_BINDERS\.get\(kind\)\?\.\(id, arg, pose\)/, "begin does not use the typed map");
  assert.ok(!/if \(kind === "/.test(BRAIN), "the begin if-chain is still present");
  assert.match(BRAIN, /exec\.kind === "pickup"/, "the pickup read is not kind-based");
  assert.match(BRAIN, /exec\.kind === "seekHealth"/, "the seekHealth kind is not read");
  assert.match(BRAIN, /exec\.kind === "reload"/, "the reload kind is not read");
  assert.ok(!/exec\.id\.startsWith\("pickup:"\)/.test(BRAIN), "the pickup id is still parsed");
});

test("warm_plan_budget_is_600ms", () => {
  assert.match(BRAIN, /const PLAN_BUDGET_MS = 600;/);
  assert.match(BRAIN, /const COLD_PLAN_BUDGET_MS = 4_000;/);
  // A 300 ms warm plan: 250 ms expires after h(start); 600 ms fits (the budget math).
  const run = (deadlineMs: number) => {
    let clock = 0;
    let calls = 0;
    const heuristic = () => {
      if (calls++ === 0) clock += 300;
      return 1;
    };
    return plan(
      { at: "a" },
      { id: "g", want: { at: "b" }, priority: () => 1 },
      [{ id: "go", pre: {}, eff: { at: "b" }, cost: 1 }],
      undefined,
      { minCost: 0.5, heuristic, deadlineMs, now: () => clock },
    );
  };
  assert.equal(run(250), undefined);
  assert.ok(run(600));
});
