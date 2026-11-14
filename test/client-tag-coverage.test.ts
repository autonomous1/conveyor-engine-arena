import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";
import ts from "typescript";
import { extractTags } from "../scripts/codemap.ts";

const ROOT = "src/client";
/** Documented exports that carry a rendered contract tag. Wave 3 floor. */
const BREADTH_FLOOR = 40;

type Export = {
  file: string;
  name: string;
  documented: boolean;
  tags: string[];
  jsdocTags: string[];
};

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
  { file: "src/client/aabb-debug.ts", name: "AABB_DEBUG_RENDER_ORDER", tag: "why" },
  { file: "src/client/arena-scene.ts", name: "DOOR_OPEN_DEGREES", tag: "why" },
  { file: "src/client/explosion.ts", name: "EXPLOSION_MAX_DT", tag: "why" },
  { file: "src/client/explosion.ts", name: "SURFACE_BLAST_STANDOFF", tag: "why" },
  { file: "src/client/explosion.ts", name: "SURFACE_BLAST_DEGENERATE", tag: "why" },
  { file: "src/client/explosion.ts", name: "explosionFrameOffset", tag: "post" },
  { file: "src/client/explosion.ts", name: "resolveLaserImpactSheet", tag: "post" },
  { file: "src/client/pawn-feet.ts", name: "SKIN_PARENT_DROP", tag: "why" },
  { file: "src/client/pawn-feet.ts", name: "lowerRootToFeet", tag: "why" },
  { file: "src/client/hud.ts", name: "localHealthLabel", tag: "post" },
  { file: "src/client/map-marker.ts", name: "floorLabel", tag: "invariant" },
  { file: "src/client/options.ts", name: "loadModelChoice", tag: "post" },
  { file: "src/client/presentation.ts", name: "configureClip", tag: "post" },
  { file: "src/client/qa.ts", name: "isQaMode", tag: "why" },
  { file: "src/client/audio.ts", name: "EchoDedupe", tag: "invariant" },
  { file: "src/client/rates.ts", name: "RateWindow", tag: "invariant" },
];

/** Documented exports whose prose is how-only or a value summary. One reason per line in the report. */
const SUMMARY_ONLY: readonly string[] = [
  "src/client/arena-scene.ts:doorSwingRadians",
  "src/client/arena-scene.ts:InstancePose",
  "src/client/arena-scene.ts:placeBuildingModel",
  "src/client/arena-scene.ts:placeDoorModel",
  "src/client/arena-scene.ts:placeRoomLights",
  "src/client/arena-scene.ts:placeStaticDoorFrames",
  "src/client/arena-scene.ts:placeStaticInstances",
  "src/client/arena-scene.ts:propInstancePose",
  "src/client/arena-scene.ts:tickDoorSwing",
  "src/client/arena-scene.ts:wallAnchor",
  "src/client/audio.ts:Sfx",
  "src/client/audio.ts:SOUND_NAMES",
  "src/client/auth-key.ts:AUTH_MSG",
  "src/client/auth-key.ts:isArenaSolo",
  "src/client/bot-label.ts:LABEL_ABOVE_M",
  "src/client/bot-label.ts:LABEL_W",
  "src/client/character-fx.ts:Point",
  "src/client/diag.ts:reportFrameFault",
  "src/client/elevator-sound.ts:ElevatorSounds",
  "src/client/explosion.ts:EXPLOSION_COLUMNS",
  "src/client/explosion.ts:ExplosionSheet",
  "src/client/explosion.ts:LASER_IMPACT_FALLBACK_FPS",
  "src/client/explosion.ts:laserImpactPlaybackFps",
  "src/client/explosion.ts:LASER_IMPACT_SIZE",
  "src/client/explosion.ts:laserImpactWorldSize",
  "src/client/explosion.ts:lookFromCamera",
  "src/client/explosion.ts:surfaceBlastPose",
  "src/client/explosion.ts:surfaceExplosionPlaybackFps",
  "src/client/explosion.ts:surfaceExplosionWorldSize",
  "src/client/hud.ts:Hud",
  "src/client/input.ts:ascendFromKeys",
  "src/client/input.ts:PlaySample",
  "src/client/map-marker.ts:FLOOR_LIFT_REACH_M",
  "src/client/map-marker.ts:selfMoved",
  "src/client/net.ts:OpenSocket",
  "src/client/net.ts:WebSocketLike",
  "src/client/pawn-feet.ts:skinnedSoleGap",
  "src/client/pickup-sound.ts:DEFAULT_KIND_SOUND",
  "src/client/pickup-sound.ts:kindSoundsOf",
  "src/client/placements.ts:PlacementVisibility",
  "src/client/scene-map.ts:AUTHOR_PROFILE_COLOR",
  "src/client/scene-map.ts:collectInstanceSamples",
  "src/client/scene-map.ts:collectObjectSamples",
  "src/client/scene-map.ts:YAW_COLOR",
  "src/client/solo.ts:startSolo",
  "src/client/viewmodel.ts:mountWeaponMesh",
];

test("client_floor_tags_present", () => {
  const byKey = new Map(scan().map((e) => [key(e), e]));
  const missing = FLOOR.filter((f) => !byKey.get(`${f.file}:${f.name}`)?.tags.includes(f.tag)).map(
    (f) => `${f.file}:${f.name} needs @${f.tag}`,
  );
  assert.deepEqual(missing, []);
});

test("client_documented_exports_are_tagged_or_listed", () => {
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

test("client_has_no_param_or_returns_tags", () => {
  const bad = scan().flatMap((e) =>
    e.jsdocTags.some((t) => t === "param" || t === "returns") ? [key(e)] : [],
  );
  assert.deepEqual(bad, []);
});
