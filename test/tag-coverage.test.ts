import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";
import ts from "typescript";
import { extractTags } from "../scripts/codemap.ts";

const ROOT = "src/server";
/** Documented exports that carry a rendered contract tag. Wave 1 floor. */
const BREADTH_FLOOR = 40;

type Export = {
  file: string;
  name: string;
  documented: boolean;
  tags: string[];
  jsdocTags: string[];
};

function* walk(dir: string): Generator<string> {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, ent.name);
    if (ent.isDirectory()) yield* walk(path);
    else if (ent.name.endsWith(".ts")) yield path;
  }
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

/** A variable's JSDoc may attach to the statement or to the declaration. Check both. */
function nodesOf(st: ts.Statement): ts.Node[] {
  return ts.isVariableStatement(st) ? [st, ...st.declarationList.declarations] : [st];
}

function scan(): Export[] {
  const out: Export[] = [];
  for (const file of [...walk(ROOT)].sort()) {
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

/** @internal is extracted but never rendered, so it cannot satisfy coverage. */
const rendered = (e: Export): boolean => e.tags.some((t) => t !== "internal");
const key = (e: { file: string; name: string }): string => `${e.file}:${e.name}`;

const FLOOR: ReadonlyArray<{ file: string; name: string; tag: string }> = [
  { file: "src/server/arena-host.ts", name: "HostClaims", tag: "why" },
  { file: "src/server/arena-host.ts", name: "HostConn", tag: "why" },
  { file: "src/server/game.ts", name: "TICK_MS", tag: "why" },
  { file: "src/server/game.ts", name: "ARENA_INTEREST_RADIUS", tag: "why" },
  { file: "src/server/game.ts", name: "splitMix", tag: "why" },
  { file: "src/server/doors.ts", name: "ObstacleWorld", tag: "why" },
  { file: "src/server/doors.ts", name: "DoorBlockers", tag: "invariant" },
  { file: "src/server/pickups.ts", name: "releasePickupObstacle", tag: "why" },
  { file: "src/server/host-path.ts", name: "isArenaFrame", tag: "why" },
  { file: "src/server/grenade.ts", name: "createArenaGrenades", tag: "why" },
  { file: "src/server/load-game.ts", name: "readPlacementFiles", tag: "post" },
  { file: "src/server/placements-file.ts", name: "PLACEMENT_ID_START", tag: "why" },
  { file: "src/server/placements-file.ts", name: "interpretPlacements", tag: "pre" },
  { file: "src/server/auth/tokens.ts", name: "resolvedScopes", tag: "invariant" },
];

/** Documented exports whose prose is a summary with no contract to carry. One reason per line in the report. */
const SUMMARY_ONLY: readonly string[] = [
  "src/server/arena-host.ts:createArenaHost",
  "src/server/auth/gate.ts:authMode",
  "src/server/auth/gate.ts:checkHelloAuth",
  "src/server/auth/tokens.ts:REVOCATION_RELOAD_MS",
  "src/server/bot-brain.ts:DOOR_GIVE_UP_MS",
  "src/server/bot-brain.ts:DOOR_MAX_OPENS",
  "src/server/bot-brain.ts:DOOR_PRESS_MS",
  "src/server/bot-brain.ts:ESCAPE_REPLAN_MS",
  "src/server/bot-brain.ts:HostBotBrain",
  "src/server/bot-label.ts:deliverBotLabelFrames",
  "src/server/doors.ts:ArenaDoors",
  "src/server/doors.ts:DoorUseResult",
  "src/server/elevators.ts:ArenaElevators",
  "src/server/elevators.ts:ElevatorDoors",
  "src/server/fire.ts:ArenaFire",
  "src/server/game-files-node.ts:nodeGameFiles",
  "src/server/game.ts:applyPawnModel",
  "src/server/game.ts:doorsOnRoute",
  "src/server/game.ts:HeldInputs",
  "src/server/game.ts:stepUnownedWander",
  "src/server/grenade.ts:ArenaGrenades",
  "src/server/health.ts:sentFor",
  "src/server/host-path.ts:createHostSocketPaths",
];

test("server_floor_tags_present", () => {
  const byKey = new Map(scan().map((e) => [key(e), e]));
  const missing = FLOOR.filter((f) => !byKey.get(`${f.file}:${f.name}`)?.tags.includes(f.tag)).map(
    (f) => `${f.file}:${f.name} needs @${f.tag}`,
  );
  assert.deepEqual(missing, []);
});

test("server_documented_exports_are_tagged_or_listed", () => {
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

test("server_has_no_param_or_returns_tags", () => {
  const bad = scan().flatMap((e) =>
    e.jsdocTags.some((t) => t === "param" || t === "returns") ? [key(e)] : [],
  );
  assert.deepEqual(bad, []);
});
