import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";
import ts from "typescript";
import { extractTags } from "../scripts/codemap.ts";

const ROOT = "src/shared";
/** Byte-identical to task 09's appendix. Never edited, so never counted. */
const FROZEN = new Set(["src/shared/bots/goap.ts"]);
/** Documented in-scope exports that carry a rendered tag. Wave 2b floor. */
const BREADTH_FLOOR = 32;

type Export = {
  file: string;
  name: string;
  documented: boolean;
  tags: string[];
  jsdocTags: string[];
};

function* walk(dir: string): Generator<string> {
  for (const ent of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (ent.isFile() && ent.name.endsWith(".ts")) yield join(ent.parentPath, ent.name);
  }
}

function files(): string[] {
  return [...walk(ROOT)]
    .filter((f) => {
      const rel = relative(".", f);
      return (rel.startsWith("src/shared/bots/") || rel.startsWith("src/shared/nav/")) && !FROZEN.has(rel);
    })
    .sort();
}

function exportedName(st: ts.Statement): string | undefined {
  if (!ts.canHaveModifiers(st)) return undefined;
  if (!(ts.getModifiers(st) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) return undefined;
  if (ts.isVariableStatement(st)) {
    const first = st.declarationList.declarations[0];
    return first && ts.isIdentifier(first.name) ? first.name.text : undefined;
  }
  const named = st as ts.DeclarationStatement;
  return named.name && ts.isIdentifier(named.name) ? named.name.text : undefined;
}

function nodesOf(st: ts.Statement): ts.Node[] {
  return ts.isVariableStatement(st) ? [st, ...st.declarationList.declarations] : [st];
}

function scan(): Export[] {
  const out: Export[] = [];
  for (const file of files()) {
    const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    for (const st of sf.statements) {
      if (ts.isExportDeclaration(st) || ts.isExportAssignment(st)) continue;
      const name = exportedName(st);
      if (!name) continue;
      const nodes = nodesOf(st);
      const documented = nodes.some((n) => ts.getJSDocCommentsAndTags(n).some((d) => ts.isJSDoc(d)));
      const tags = [...new Set(nodes.flatMap((n) => extractTags(n).map((t) => t.name)))];
      const jsdocTags = nodes.flatMap((n) => ts.getJSDocTags(n).map((t) => t.tagName.text));
      out.push({ file: relative(".", file), name, documented, tags, jsdocTags });
    }
  }
  return out;
}

const rendered = (e: Export): boolean => e.tags.some((t) => t !== "internal");
const key = (e: { file: string; name: string }): string => `${e.file}:${e.name}`;

const FLOOR: ReadonlyArray<{ file: string; name: string; tag: string }> = [
  { file: "src/shared/bots/arbiter.ts", name: "EVADE_COOLDOWN_MS", tag: "post" },
  { file: "src/shared/bots/arbiter.ts", name: "SAFE_HOLD_MS", tag: "why" },
  { file: "src/shared/bots/arbiter.ts", name: "EVADE_DWELL_MS", tag: "why" },
  { file: "src/shared/bots/arbiter.ts", name: "SAFE_DISTANCE_M", tag: "why" },
  { file: "src/shared/bots/arbiter.ts", name: "FLEE_BELOW", tag: "why" },
  { file: "src/shared/bots/arbiter.ts", name: "judge", tag: "invariant" },
  { file: "src/shared/bots/flee.ts", name: "FleeVec", tag: "why" },
  { file: "src/shared/bots/aim.ts", name: "turnToward", tag: "post" },
  { file: "src/shared/bots/aim.ts", name: "burstScheduler", tag: "post" },
  { file: "src/shared/bots/sense.ts", name: "createExitIndex", tag: "why" },
  { file: "src/shared/bots/state.ts", name: "buildWorldState", tag: "invariant" },
  { file: "src/shared/nav/route.ts", name: "createRoadCache", tag: "invariant" },
  { file: "src/shared/nav/route.ts", name: "routePlaceCosts", tag: "post" },
  { file: "src/shared/nav/regions.ts", name: "overlayShutDoors", tag: "post" },
  { file: "src/shared/nav/grid.ts", name: "navBoxes", tag: "why" },
  { file: "src/shared/nav/follow.ts", name: "doorStand", tag: "post" },
];

/** Documented exports whose prose is a summary with no contract to carry. One reason per line in the report. */
const SUMMARY_ONLY: readonly string[] = [
  "src/shared/bots/aim.ts:aimSigma",
  "src/shared/bots/aim.ts:sampleAim",
  "src/shared/bots/arbiter.ts:DEFAULT_ARBITER_TUNING",
  "src/shared/bots/arbiter.ts:EVADE_HURT_PRIORITY",
  "src/shared/bots/arbiter.ts:EVADE_UNDER_FIRE_PRIORITY",
  "src/shared/bots/arbiter.ts:EXIT_PLACE",
  "src/shared/bots/arbiter.ts:FIGHT_PRIORITY",
  "src/shared/bots/arbiter.ts:HURT_MS",
  "src/shared/bots/arbiter.ts:SAFE_QUIET_MS",
  "src/shared/bots/flee.ts:FleeCentre",
  "src/shared/bots/sense.ts:DEFAULT_SENSE_TUNING",
  "src/shared/bots/sense.ts:SENSE_TICK_HZ",
  "src/shared/nav/funnel.ts:DoorAxis",
  "src/shared/nav/legs.ts:NavCache",
  "src/shared/nav/regions.ts:RegionCache",
  "src/shared/nav/route.ts:RoadCache",
  "src/shared/nav/route.ts:RoadNet",
];

test("bots_nav_floor_tags_present", () => {
  const byKey = new Map(scan().map((e) => [key(e), e]));
  const missing = FLOOR.filter((f) => !byKey.get(`${f.file}:${f.name}`)?.tags.includes(f.tag)).map(
    (f) => `${f.file}:${f.name} needs @${f.tag}`,
  );
  assert.deepEqual(missing, []);
});

test("bots_nav_documented_exports_are_tagged_or_listed", () => {
  const documented = scan().filter((e) => e.documented);
  const byKey = new Map(documented.map((e) => [key(e), e]));
  const listed = new Set(SUMMARY_ONLY);
  const unexplained = documented.filter((e) => !rendered(e) && !listed.has(key(e))).map(key);
  assert.deepEqual(unexplained, []);
  const bogus = SUMMARY_ONLY.filter((k) => !byKey.has(k) || rendered(byKey.get(k)!));
  assert.deepEqual(bogus, [], "SUMMARY_ONLY may only name documented, untagged exports");
  const floorKeys = new Set(FLOOR.map((f) => `${f.file}:${f.name}`));
  assert.deepEqual(SUMMARY_ONLY.filter((k) => floorKeys.has(k)), [], "a floor symbol cannot be summary-only");
  const tagged = documented.filter(rendered).length;
  assert.ok(tagged >= BREADTH_FLOOR, `only ${tagged} of ${documented.length} documented exports carry a tag`);
});

test("bots_nav_has_no_param_or_returns_tags", () => {
  const bad = scan().flatMap((e) =>
    e.jsdocTags.some((t) => t === "param" || t === "returns") ? [key(e)] : [],
  );
  assert.deepEqual(bad, []);
});
