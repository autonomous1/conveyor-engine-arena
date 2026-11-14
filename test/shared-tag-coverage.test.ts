import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";
import ts from "typescript";
import { extractTags } from "../scripts/codemap.ts";

const ROOT = "src/shared";
/** Documented top-level exports that carry a rendered contract tag. Wave 2a floor. */
const BREADTH_FLOOR = 80;

type Export = {
  file: string;
  name: string;
  documented: boolean;
  tags: string[];
  jsdocTags: string[];
};

/** Top-level files only. `bots/` and `nav/` are wave 2b. */
function files(): string[] {
  return readdirSync(ROOT, { withFileTypes: true })
    .filter((ent) => ent.isFile() && ent.name.endsWith(".ts"))
    .map((ent) => join(ROOT, ent.name))
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

/** A variable's JSDoc may attach to the statement or to the declaration. Check both. */
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

/** @internal is extracted but never rendered, so it cannot satisfy coverage. */
const rendered = (e: Export): boolean => e.tags.some((t) => t !== "internal");
const key = (e: { file: string; name: string }): string => `${e.file}:${e.name}`;

const FLOOR: ReadonlyArray<{ file: string; name: string; tag: string }> = [
  { file: "src/shared/movements.ts", name: "PAWN_YAW_STEP", tag: "why" },
  { file: "src/shared/movements.ts", name: "approachYaw", tag: "post" },
  { file: "src/shared/movements.ts", name: "markDynamicObstacle", tag: "why" },
  { file: "src/shared/hitscan.ts", name: "MIN_HIT_DISTANCE", tag: "why" },
  { file: "src/shared/hitscan.ts", name: "admitFire", tag: "post" },
  { file: "src/shared/hitscan.ts", name: "hasLineOfSight", tag: "why" },
  { file: "src/shared/grenade.ts", name: "GRENADE_ARMING_S", tag: "why" },
  { file: "src/shared/grenade.ts", name: "stepGrenade", tag: "why" },
  { file: "src/shared/anim-speed.ts", name: "noteGroundSpeed", tag: "when" },
  { file: "src/shared/anim-speed.ts", name: "WALK_MAX_TIME_SCALE", tag: "why" },
  { file: "src/shared/elevators.ts", name: "stepStop", tag: "post" },
  { file: "src/shared/bot-protocol.ts", name: "parseArenaFrame", tag: "post" },
  { file: "src/shared/health.ts", name: "PawnHealth", tag: "invariant" },
  { file: "src/shared/health.ts", name: "pickRespawnSpawn", tag: "post" },
  { file: "src/shared/doors.ts", name: "pickDoorForUse", tag: "invariant" },
  { file: "src/shared/scene-graph.ts", name: "canonicalJson", tag: "invariant" },
];

/** Documented exports whose prose is a summary with no contract to carry. One reason per line in the report. */
const SUMMARY_ONLY: readonly string[] = [
  "src/shared/anim-speed.ts:DEFAULT_MIN_TIME_SCALE",
  "src/shared/anim-speed.ts:GAIT_HYSTERESIS",
  "src/shared/arena-view.ts:ArenaElevator",
  "src/shared/arena-view.ts:ArenaExplosionSheet",
  "src/shared/arena-view.ts:ArenaLight",
  "src/shared/arena-view.ts:ArenaSoundEffect",
  "src/shared/audit.ts:Audit",
  "src/shared/bot-label.ts:botLabelText",
  "src/shared/bot-label.ts:parseBotLabel",
  "src/shared/bot-protocol.ts:ArenaFrame",
  "src/shared/bot-protocol.ts:RegionsFrame",
  "src/shared/bot-protocol.ts:SceneGraphFrame",
  "src/shared/bot-protocol.ts:SnapshotFollow",
  "src/shared/bot-protocol.ts:SnapshotLookFrom",
  "src/shared/bot-protocol.ts:SnapshotResultFrame",
  "src/shared/building-profile.ts:profilesFromPlanSvg",
  "src/shared/building-profile.ts:svgRingsToModel",
  "src/shared/building-profile.ts:yawOfSvgMatrix",
  "src/shared/doors.ts:DOOR_USE_OUTWARD_M",
  "src/shared/doors.ts:parseDoorSet",
  "src/shared/elevators.ts:elevatorDoorSide",
  "src/shared/elevators.ts:inCab",
  "src/shared/elevators.ts:landingAt",
  "src/shared/elevators.ts:nextStopUp",
  "src/shared/grenade.ts:advanceGrenadeClock",
  "src/shared/grenade.ts:GRENADE_GRAVITY",
  "src/shared/grenade.ts:GrenadeImpact",
  "src/shared/grenade.ts:GRENADE_LIFE_S",
  "src/shared/grenade.ts:GrenadePose",
  "src/shared/grenade.ts:GrenadeSurfaceNormal",
  "src/shared/health.ts:DamageNote",
  "src/shared/hitscan.ts:TraceCapsule",
  "src/shared/info-probe.ts:InfoCandidate",
  "src/shared/look.ts:aimDirection",
  "src/shared/look.ts:axesFromStick",
  "src/shared/look.ts:GAMEPAD_PROFILE_STORAGE_KEY",
  "src/shared/look.ts:JUMPER_MOVE_X",
  "src/shared/look.ts:lookFromMouse",
  "src/shared/map-frame.ts:MAP_BAKE_META_URL",
  "src/shared/map-frame.ts:MAP_BAKE_URL",
  "src/shared/map-frame.ts:MAP_DESIGN_SVG",
  "src/shared/movements.ts:DEFAULT_MOVEMENT_SPEED",
  "src/shared/movements.ts:floorIndexCell",
  "src/shared/movements.ts:FLOOR_INDEX_CELL",
  "src/shared/movements.ts:floorIndexFor",
  "src/shared/movements.ts:gaitForSpeed",
  "src/shared/movements.ts:MOVE_IDLE",
  "src/shared/movements.ts:MOVEMENTS",
  "src/shared/movements.ts:MOVE_SPEED",
  "src/shared/movements.ts:MOVE_TICKS",
  "src/shared/movements.ts:yawQuaternion",
  "src/shared/pickups.ts:PawnKit",
  "src/shared/pickups.ts:pickupBoxSource",
  "src/shared/pickups.ts:PickupHost",
  "src/shared/scene-graph.ts:ElevatorPlace",
  "src/shared/scene-graph.ts:ScenePlace",
  "src/shared/scene-graph.ts:StairsPlace",
  "src/shared/shadows.ts:SHADOW_QUALITIES",
  "src/shared/svg-bounds.ts:Affine",
  "src/shared/svg-bounds.ts:svgMapBounds",
];

test("shared_floor_tags_present", () => {
  const byKey = new Map(scan().map((e) => [key(e), e]));
  const missing = FLOOR.filter((f) => !byKey.get(`${f.file}:${f.name}`)?.tags.includes(f.tag)).map(
    (f) => `${f.file}:${f.name} needs @${f.tag}`,
  );
  assert.deepEqual(missing, []);
});

test("shared_documented_exports_are_tagged_or_listed", () => {
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

test("shared_has_no_param_or_returns_tags", () => {
  const bad = scan().flatMap((e) =>
    e.jsdocTags.some((t) => t === "param" || t === "returns") ? [key(e)] : [],
  );
  assert.deepEqual(bad, []);
});
