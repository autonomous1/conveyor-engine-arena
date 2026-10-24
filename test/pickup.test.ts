import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { allowKtx2 } from "./ktx2-stub.ts";
import { createAabbDebug } from "../src/client/aabb-debug.ts";
import { createPlacementVisibility } from "../src/client/placements.ts";
import { createViewModel, mountWeaponMesh } from "../src/client/viewmodel.ts";
import { compileGame, GameManifestError, type CompileSources } from "../dist/server/game-manifest.js";
import { loadInstalledGame, projectRoot, readManifestSources } from "../dist/server/load-game.js";
import { startArenaServer } from "../dist/server/main.js";
import { releasePickupObstacle } from "../dist/server/pickups.js";
import { loadArena } from "../dist/server/world-loader.js";
import { createPawnHealth, MAX_HP } from "../src/shared/health.ts";
import { STEP_HEIGHT } from "../src/shared/movements.ts";
import {
  AMMO_PICKUP,
  capsuleOverlapsAabb,
  createPawnKit,
  createPickupHost,
  dropPickupAabb,
  HEALTH_PICKUP,
  parsePickup,
  parsePickupSet,
  type PickupPlacement,
} from "../src/shared/pickups.ts";

const WEAPON_BOX = {
  minX: -5.856956,
  maxX: -4.767261,
  minY: 0.980549,
  maxY: 1.442022,
  minZ: 2.000778,
  maxZ: 2.160477,
};

function rootDir(): string {
  return projectRoot();
}

function document(): Record<string, unknown> {
  return JSON.parse(readFileSync(`${rootDir()}/web/game/arena.game.json`, "utf8")) as Record<string, unknown>;
}

function filesFromDisk(): Map<string, Uint8Array> {
  const doc = document() as { assets?: Array<{ uri?: unknown }> };
  const out = new Map<string, Uint8Array>();
  for (const asset of doc.assets ?? []) {
    if (typeof asset.uri !== "string") continue;
    out.set(asset.uri, new Uint8Array(readFileSync(`${rootDir()}/web${asset.uri}`)));
  }
  return out;
}

function installedSources(): CompileSources {
  const sources = readManifestSources(rootDir(), document());
  if (!sources?.boundsFile || !sources.spawnPointsFile) throw new Error("installed bounds or spawns were not read");
  return sources;
}

function placement(id: string, kind: PickupPlacement["kind"], amount: number): PickupPlacement {
  return {
    id,
    kind,
    model: "/assets/models/ammo-box.glb",
    ...(kind === "weapon" ? { weapon: "alien-weapon-enh" } : {}),
    amount,
    minX: -1,
    maxX: 1,
    minY: 0,
    maxY: 1,
    minZ: -1,
    maxZ: 1,
  };
}

function pawn(id: number, alive = true) {
  return { id, x: 0, y: 0, z: 0, radius: 0.5, height: 1.8, alive };
}

test("a capsule parked on the weapon face counts, and a gap or a deck above it does not", () => {
  const radius = 0.5;
  const height = 1.8;
  const z = (WEAPON_BOX.minZ + WEAPON_BOX.maxZ) / 2;
  const x = (WEAPON_BOX.minX + WEAPON_BOX.maxX) / 2;
  // The resolver stops the center on the expanded face, so distance == radius.
  assert.equal(capsuleOverlapsAabb(WEAPON_BOX.maxX + radius, 0, z, radius, height, WEAPON_BOX), true);
  assert.equal(capsuleOverlapsAabb(WEAPON_BOX.maxX + radius + 0.01, 0, z, radius, height, WEAPON_BOX), false);
  assert.equal(capsuleOverlapsAabb(x, WEAPON_BOX.maxY, z, radius, height, WEAPON_BOX), false);
  assert.equal(capsuleOverlapsAabb(x, WEAPON_BOX.minY - height, z, radius, height, WEAPON_BOX), false);
  assert.equal(capsuleOverlapsAabb(x, 0, z, radius, height, WEAPON_BOX), true);
});

test("heal adds and clamps at 100, and a dead pawn is unchanged", () => {
  const health = createPawnHealth();
  health.note(1);
  assert.deepEqual(health.heal(1, HEALTH_PICKUP), { hp: MAX_HP, dead: false });
  assert.equal(health.get(1).hp, MAX_HP);
  health.wound(1);
  assert.equal(health.get(1).hp, 75);
  assert.deepEqual(health.heal(1, 50), { hp: MAX_HP, dead: false });
  assert.deepEqual(health.heal(1, 0), { hp: MAX_HP, dead: false });
  assert.deepEqual(health.heal(1, Number.NaN), { hp: MAX_HP, dead: false });
  for (let i = 0; i < 4; i++) health.wound(1);
  assert.equal(health.get(1).dead, true);
  assert.equal(health.heal(1, HEALTH_PICKUP), undefined);
  assert.deepEqual(health.get(1), { hp: 0, dead: true });
});

test("the host removes a string id and the first living pawn takes it", () => {
  const health = createPawnHealth();
  health.note(1);
  health.note(4);
  const kit = createPawnKit();
  const host = createPickupHost([
    placement("med", "health", HEALTH_PICKUP),
    placement("rounds", "ammo", AMMO_PICKUP),
    placement("alien-weapon-1", "weapon", 0),
  ]);
  assert.deepEqual(host.remainingIds(), ["alien-weapon-1", "med", "rounds"]);

  const full = host.take([pawn(1), pawn(4)], health, kit);
  assert.equal(full.length, 3);
  assert.deepEqual(full.map((grant) => grant.pawnId), [1, 1, 1]);
  assert.equal(health.get(1).hp, MAX_HP);
  assert.equal(full[0]?.loadout, undefined);
  assert.equal(typeof full[0]?.gone.id, "string");
  assert.deepEqual(full[0]?.gone, { t: "pickup", id: "med", gone: true });
  assert.deepEqual(full[1]?.loadout, { t: "loadout", ammo: AMMO_PICKUP });
  assert.deepEqual(full[2]?.loadout, { t: "loadout", ammo: AMMO_PICKUP, weapon: "alien-weapon-enh" });
  assert.equal(kit.weaponOf(1), "alien-weapon-enh");
  assert.deepEqual(host.remainingIds(), []);
  assert.deepEqual(host.take([pawn(4)], health, kit), []);

  const contested = createPickupHost([placement("med", "health", HEALTH_PICKUP)]);
  const race = contested.take([pawn(4), pawn(1)], health, kit);
  assert.equal(race.length, 1);
  assert.equal(race[0]?.pawnId, 4);

  const dead = createPawnHealth();
  dead.note(7);
  for (let i = 0; i < 4; i++) dead.wound(7);
  const left = createPickupHost([placement("med", "health", HEALTH_PICKUP)]);
  assert.deepEqual(left.take([pawn(7, false)], dead, createPawnKit()), []);
  assert.deepEqual(left.remainingIds(), ["med"]);

  assert.equal(parsePickup({ t: "pickup", id: 12, gone: true }), undefined);
  assert.deepEqual(parsePickup({ t: "pickup", id: "alien-weapon-1", gone: true }), {
    t: "pickup",
    id: "alien-weapon-1",
    gone: true,
  });
  assert.deepEqual(parsePickupSet(["alien-weapon-1", 3, ""]), ["alien-weapon-1"]);
});

test("picking up the key stores it and removes it from the world", () => {
  const health = createPawnHealth();
  health.note(1);
  const kit = createPawnKit();
  const ammoBox = placement("rounds", "ammo", AMMO_PICKUP);
  ammoBox.minX = 10;
  ammoBox.maxX = 12;
  const host = createPickupHost([placement("key", "key", 0), ammoBox]);
  assert.equal(host.hasKey(1), false);
  assert.equal(host.hasKey(2, "key"), false);
  assert.deepEqual(host.getHeldItems(1), []);

  const taken = host.take([pawn(1)], health, kit);
  assert.deepEqual(taken.map((grant) => grant.id), ["key"]);
  assert.equal(taken[0]?.kind, "key");
  assert.equal(taken[0]?.loadout, undefined);
  assert.deepEqual(taken[0]?.gone, { t: "pickup", id: "key", gone: true });
  assert.equal(host.hasKey(1), true);
  assert.equal(host.hasKey(1, "key"), true);
  assert.equal(host.hasKey(2, "key"), false);
  assert.deepEqual(host.getHeldItems(1), ["key"]);
  assert.deepEqual(host.getHeldItems(2), []);
  assert.deepEqual(host.remainingIds(), ["rounds"]);
  assert.equal(kit.ammoOf(1), 0);
  assert.equal(kit.weaponOf(1), undefined);
  assert.equal(health.get(1).hp, MAX_HP);

  assert.deepEqual(host.take([pawn(1)], health, kit), []);
  assert.equal(host.hasKey(1), true);
  assert.deepEqual(host.getHeldItems(1), ["key"]);
  assert.deepEqual(host.remainingIds(), ["rounds"]);

  const body = pawn(1);
  body.x = 11;
  const ammo = host.take([body], health, kit);
  assert.deepEqual(ammo.map((grant) => grant.id), ["rounds"]);
  assert.deepEqual(ammo[0]?.loadout, { t: "loadout", ammo: AMMO_PICKUP });
  assert.equal(host.hasKey(1), true);
  assert.equal(host.consumeKey(1, "key"), true);
  assert.equal(host.hasKey(1, "key"), false);
  assert.equal(host.consumeKey(1, "key"), false);
  assert.deepEqual(host.getHeldItems(1), []);
  assert.deepEqual(host.remainingIds(), []);
});

test("installed placements consume ammo, health, and weapon, and a crate type stays", () => {
  const game = loadInstalledGame();
  const pickups = game.view.pickups ?? [];
  const byId = new Map(pickups.map((item) => [item.id, item]));
  const weapon = byId.get("alien-weapon-1");
  assert.ok(weapon);
  assert.equal(weapon.kind, "weapon");
  assert.equal(weapon.weapon, "alien-weapon-enh");
  assert.equal(weapon.amount, 0);
  assert.equal(byId.get("cover-crate-2-1")?.kind, "ammo");
  assert.equal(byId.get("cover-crate-2-1")?.amount, AMMO_PICKUP);
  assert.equal(byId.get("cover-crate-2-6-1")?.kind, "health");
  assert.equal(byId.get("cover-crate-2-6-1")?.amount, HEALTH_PICKUP);
  assert.equal(byId.get("cover-crate-2-9")?.kind, "health");
  assert.equal(byId.has("alien-weapon-enh"), false);
  const drawn = game.view.props.find((prop) => prop.id === "alien-weapon-1");
  assert.equal(drawn?.type, "weapon");
  assert.equal(drawn?.weapon, "alien-weapon-enh");
  assert.equal("kind" in (drawn ?? {}), false);
  assert.equal(game.view.buildings.some((building) => building.id === "cover-crate-2-9"), true);
  const facade = game.view.buildings.find((building) => building.model.endsWith("/brutalist-building-2-cbake.glb"));
  assert.ok(facade);
  assert.equal(byId.has(facade.id), false);
  assert.equal(game.view.aabbs.some((box) => box.source === "cover-crate-2-6-1-box"), true);
  assert.equal(game.view.aabbs.some((box) => box.source === "cover-crate-2-1-box"), true);
  assert.equal(game.view.aabbs.some((box) => box.source === "cover-crate-2-9-box"), true);
  const catalog = new Map(
    ((document() as { assets?: Array<{ id?: string; type?: string }> }).assets ?? [])
      .flatMap((asset) => (asset.id ? [[asset.id, asset.type] as const] : [])),
  );
  for (const name of ["buildings.placements.json", "doors.placements.json", "props.placements.json"]) {
    const file = JSON.parse(readFileSync(path.join(rootDir(), "web/game", name), "utf8")) as {
      placements?: Array<{ id?: string; model?: string; type?: string }>;
    };
    for (const placement of file.placements ?? []) {
      assert.equal("kind" in placement, false, `${name} ${placement.id}`);
      const expected = typeof placement.model === "string" ? catalog.get(placement.model) : undefined;
      if (expected) assert.equal(placement.type, expected, `${name} ${placement.id}`);
      else assert.equal("type" in placement, false, `${name} ${placement.id}`);
    }
  }

  const read = (uri: string) => filesFromDisk().get(uri);
  const base = installedSources();
  const stayed = structuredClone(document()) as { scene: Record<string, unknown> };
  stayed.scene.placements = ["./types.json"];
  const typesFile = {
    formatVersion: 1,
    units: "meters",
    placements: [
      { id: "rounds", model: "ammo-box", type: "ammo", position: [20, 0, 20], yaw: 0, scale: 1 },
      { id: "box", model: "step", type: "crate", position: [24, 0, 20], yaw: 0, scale: 1 },
      { id: "facade", model: "brutalist-building-2-cbake", type: "building", position: [28, 0, 20], yaw: 0, scale: 1 },
      { id: "gate", model: "door-1", type: "door", position: [32, 0, 20], yaw: 0, hinge: "left", size: [1, 2.1, 0.08], open: false },
      { id: "pawn", model: "player-a", type: "character", position: [36, 0, 20], yaw: 0, scale: 1 },
      { id: "leftover", model: "med-kit", kind: "health", position: [40, 0, 20], yaw: 0, scale: 1 },
    ],
    obstacles: [
      { id: "rounds-box", kind: "aabb", min: [19.7, 0, 19.7], max: [20.3, 0.5, 20.3] },
      { id: "box-box", kind: "aabb", min: [23.7, 0, 19.7], max: [24.3, 0.5, 20.3] },
      { id: "facade-wall-0", kind: "aabb", min: [27, 0, 19], max: [29, 3, 21] },
      { id: "pawn-box", kind: "aabb", min: [35.7, 0, 19.7], max: [36.3, 1.8, 20.3] },
      { id: "leftover-box", kind: "aabb", min: [39.7, 0, 19.7], max: [40.3, 0.5, 20.3] },
    ],
  };
  const stayedGame = compileGame(stayed, read, {
    placementFiles: [{ path: "./types.json", text: JSON.stringify(typesFile) }],
    boundsFile: base.boundsFile,
    spawnPointsFile: base.spawnPointsFile,
    lightsFile: base.lightsFile,
  });
  const stayedIds = (stayedGame.view.pickups ?? []).map((item) => item.id);
  assert.deepEqual(stayedIds, ["rounds"]);
  assert.equal(stayedGame.view.pickups?.[0]?.kind, "ammo");

  const bareDoc = structuredClone(document()) as { scene: Record<string, unknown> };
  bareDoc.scene.placements = ["./no-box.json"];
  const bareFile = {
    formatVersion: 1,
    units: "meters",
    placements: [{ id: "crate", model: "ammo-box", type: "ammo", position: [20, 0, 20], yaw: 0, scale: 1 }],
    obstacles: [],
  };
  assert.throws(() => compileGame(bareDoc, read, {
    placementFiles: [{ path: "./no-box.json", text: JSON.stringify(bareFile) }],
    boundsFile: base.boundsFile,
    spawnPointsFile: base.spawnPointsFile,
    lightsFile: base.lightsFile,
  }), (err: unknown) => {
    assert.ok(err instanceof GameManifestError);
    assert.ok(err.issues.some((issue) => issue.message === "pickup needs an aabb"));
    return true;
  });
});

test("hiding one instanced placement leaves the other index, and a clone uses visible", () => {
  const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial(), 2);
  mesh.setMatrixAt(0, new THREE.Matrix4().makeTranslation(1, 0, 0));
  mesh.setMatrixAt(1, new THREE.Matrix4().makeTranslation(4, 0, 0));
  const visibility = createPlacementVisibility();
  visibility.addInstance("cover-crate-2-1", mesh, 0);
  visibility.setVisible("cover-crate-2-1", false);
  assert.equal(visibility.hidden("cover-crate-2-1"), true);
  const hidden = new THREE.Matrix4();
  const other = new THREE.Matrix4();
  const pos = new THREE.Vector3();
  mesh.getMatrixAt(0, hidden);
  mesh.getMatrixAt(1, other);
  hidden.decompose(pos, new THREE.Quaternion(), new THREE.Vector3());
  assert.equal(pos.x, 0);
  other.decompose(pos, new THREE.Quaternion(), new THREE.Vector3());
  assert.equal(pos.x, 4);
  visibility.setVisible("cover-crate-2-1", true);
  mesh.getMatrixAt(0, hidden);
  hidden.decompose(pos, new THREE.Quaternion(), new THREE.Vector3());
  assert.equal(pos.x, 1);
  assert.equal(mesh.count, 2);

  const clone = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
  visibility.addClone("alien-weapon-1", clone);
  assert.equal(clone.name, "alien-weapon-1");
  visibility.setVisible("alien-weapon-1", false);
  assert.equal(clone.visible, false);
  assert.equal(visibility.hidden("alien-weapon-1"), true);
  visibility.setVisible("missing", false);
  assert.equal(visibility.hidden("missing"), false);
});

test("the viewmodel turns the weapon's long axis toward the camera", async () => {
  const camera = new THREE.PerspectiveCamera();
  const scene = new THREE.Scene();
  const viewmodel = createViewModel(camera, scene);
  const box = new THREE.Mesh(new THREE.BoxGeometry(2, 0.2, 0.1));
  const mounted = mountWeaponMesh(viewmodel.root, box);
  mounted.updateWorldMatrix(true, true);
  const size = new THREE.Box3().setFromObject(mounted).getSize(new THREE.Vector3());
  assert.ok(size.z > size.x && size.z > size.y, `mounted box ${size.x} ${size.y} ${size.z}`);
  assert.equal(mounted.parent, viewmodel.root);
  assert.equal(viewmodel.root.parent, camera);
  const other = new THREE.PerspectiveCamera();
  assert.equal(other.children.some((child) => child.name === "viewmodel"), false);

  const gltf = await loadGlb("alien-weapon-enh.glb");
  const local = new THREE.Box3().setFromObject(gltf.scene).getSize(new THREE.Vector3());
  assert.ok(local.x > local.y && local.x > local.z, `asset long axis ${local.x} ${local.y} ${local.z}`);
  const mesh = mountWeaponMesh(viewmodel.root, gltf.scene);
  mesh.updateWorldMatrix(true, true);
  const turned = new THREE.Box3().setFromObject(mesh).getSize(new THREE.Vector3());
  assert.ok(turned.z > turned.x && turned.z > turned.y, `mounted glb ${turned.x} ${turned.y} ${turned.z}`);
  assert.equal(/AnimationMixer/.test(readFileSync(path.join(rootDir(), "src/client/viewmodel.ts"), "utf8")), false);
});

test("a full pawn still clears the next crate, and a building box stays", () => {
  const health = createPawnHealth();
  health.note(1);
  const kit = createPawnKit();
  kit.setWeapon(1, "alien-weapon-enh");
  const far = (id: string, kind: PickupPlacement["kind"], amount: number, z: number): PickupPlacement => ({
    ...placement(id, kind, amount),
    minZ: z - 1,
    maxZ: z + 1,
  });
  const host = createPickupHost([
    far("cover-crate-2-6-1", "health", HEALTH_PICKUP, 0),
    far("cover-crate-2-1", "ammo", 0, 20),
    far("alien-weapon-1", "weapon", 0, 40),
  ]);
  const body = pawn(1);
  const first = host.take([body], health, kit);
  assert.deepEqual(first.map((grant) => grant.id), ["cover-crate-2-6-1"]);
  assert.equal(health.get(1).hp, MAX_HP);
  assert.equal(first[0]?.loadout, undefined);
  assert.deepEqual(first[0]?.gone, { t: "pickup", id: "cover-crate-2-6-1", gone: true });

  body.z = 20;
  const second = host.take([body], health, kit);
  assert.deepEqual(second.map((grant) => grant.id), ["cover-crate-2-1"]);
  assert.equal(kit.ammoOf(1), 0);
  assert.deepEqual(second[0]?.gone, { t: "pickup", id: "cover-crate-2-1", gone: true });

  body.z = 40;
  const third = host.take([body], health, kit);
  assert.deepEqual(third.map((grant) => grant.id), ["alien-weapon-1"]);
  assert.equal(kit.weaponOf(1), "alien-weapon-enh");
  assert.equal(third[0]?.loadout?.weapon, "alien-weapon-enh");
  assert.deepEqual(host.remainingIds(), []);
  assert.deepEqual(host.take([body], health, kit), []);

  const loaded = loadArena();
  const clientBoxes = loaded.view.aabbs.map((box) => ({ ...box }));
  const healthBox = clientBoxes.find((box) => box.source === "cover-crate-2-6-1-box");
  const ammoBox = clientBoxes.find((box) => box.source === "cover-crate-2-1-box");
  const scenery = clientBoxes.find((box) => box.source?.includes("-wall-"));
  assert.ok(healthBox && ammoBox && scenery && scenery.source);
  const debug = createAabbDebug(clientBoxes);
  debug.setVisible(true);
  const wires = debug.group.children.length;
  const solids = loaded.world.listObstacles().length;
  for (const id of ["cover-crate-2-6-1", "cover-crate-2-1"] as const) {
    releasePickupObstacle(loaded.world, loaded.view.aabbs, id);
    dropPickupAabb(clientBoxes, id);
    debug.remove(id);
    debug.remove(id);
  }
  assert.equal(debug.group.children.length, wires - 2);
  assert.equal(loaded.world.listObstacles().length, solids - 2);
  assert.equal(clientBoxes.some((box) => box.source === scenery.source), true);
  assert.equal(clientBoxes.some((box) => box.source === "cover-crate-2-6-1-box"), false);
  assert.equal(clientBoxes.some((box) => box.source === "cover-crate-2-1-box"), false);
  assert.equal(debug.group.children.some((child) => child.name === scenery.source), true);
  assert.equal(debug.group.children.some((child) => child.name === "cover-crate-2-6-1-box"), false);
  assert.equal(loaded.world.listObstacles().some((box) => box.id === scenery.id), true);
  assert.equal(loaded.world.listObstacles().some((box) => box.id === healthBox.id), false);

  const pawnId = loaded.agents[0]!.id;
  const x = (healthBox.minX + healthBox.maxX) / 2;
  const z = (healthBox.minZ + healthBox.maxZ) / 2;
  loaded.world.enqueue({
    kind: "setTransform",
    entity: pawnId,
    position: { x, y: 0, z },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
    scale: { x: 1, y: 1, z: 1 },
  });
  loaded.world.commit(1n);
  const stood = loaded.world.store.view(pawnId)?.position;
  assert.ok(stood);
  assert.ok(Math.abs(stood.x - x) < 1e-4 && Math.abs(stood.z - z) < 1e-4, `${stood.x} ${stood.z}`);
});

test("pickup code does not enqueue a world entity", () => {
  const root = rootDir();
  for (const rel of ["src/server/main.ts", "src/server/pickups.ts", "src/shared/pickups.ts"]) {
    const text = readFileSync(path.join(root, rel), "utf8");
    assert.equal(/\bworldEnqueue\b|\.enqueue\(/.test(text), false, rel);
  }
  const main = readFileSync(path.join(root, "src/server/main.ts"), "utf8");
  assert.match(main, /JSON\.stringify\(\{ \.\.\.loaded\.view, propClips \}\)/);
  assert.match(main, /startPropAnimation\(loaded\.view\.props\)/);
});

type Pose = { x: number; y: number; z: number };
type Gone = { t: string; id: unknown; gone: unknown };
type Loadout = { t: string; ammo: unknown; weapon?: unknown };
type Welcome = {
  clientId: number;
  ownedEntityId: number;
  token: string;
  pickups: string[];
  weapon?: string;
  ammo?: number;
};

type LiveClient = {
  ws: WebSocket;
  welcome: Promise<Welcome>;
  poses: Map<number, Pose>;
  entities: Set<number>;
  despawns: number[];
  gone: Gone[];
  loadouts: Loadout[];
  health: number[];
};

function openClient(
  url: string,
  view: { world: string; bundleId: string; authoritativeHash: string },
  token?: string,
): LiveClient {
  const poses = new Map<number, Pose>();
  const entities = new Set<number>();
  const despawns: number[] = [];
  const gone: Gone[] = [];
  const loadouts: Loadout[] = [];
  const health: number[] = [];
  const ws = new WebSocket(url.replace(/^http/, "ws"));
  const welcome = new Promise<Welcome>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no welcome")), 3000);
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(String(ev.data)) as {
        t?: string;
        type?: string;
        reason?: string;
        clientId?: number;
        ownedEntityId?: number;
        reconnectToken?: string;
        pickups?: unknown;
        weapon?: unknown;
        ammo?: unknown;
        id?: unknown;
        gone?: unknown;
        envelope?: { seq?: number; spawns?: unknown[]; updates?: unknown[]; despawns?: unknown[] };
        entity?: unknown;
        hp?: unknown;
      };
      if (msg.t === "pickup") {
        gone.push({ t: String(msg.t), id: msg.id, gone: msg.gone });
        return;
      }
      if (msg.t === "loadout") {
        loadouts.push({ t: "loadout", ammo: msg.ammo, ...(msg.weapon !== undefined ? { weapon: msg.weapon } : {}) });
        return;
      }
      if (msg.t === "health" && typeof msg.hp === "number") {
        health.push(msg.hp);
        return;
      }
      if (msg.type === "reject") {
        clearTimeout(timer);
        reject(new Error(msg.reason ?? "reject"));
      }
      if (msg.type === "welcome") {
        clearTimeout(timer);
        const ids = parsePickupSet(msg.pickups) ?? [];
        resolve({
          clientId: Number(msg.clientId),
          ownedEntityId: Number(msg.ownedEntityId),
          token: String(msg.reconnectToken ?? ""),
          pickups: ids,
          ...(typeof msg.weapon === "string" ? { weapon: msg.weapon } : {}),
          ...(typeof msg.ammo === "number" ? { ammo: msg.ammo } : {}),
        });
      }
      if (msg.type === "snapshot" && msg.envelope) {
        const rows = [...(msg.envelope.spawns ?? []), ...(msg.envelope.updates ?? [])] as Array<{
          entity?: unknown;
          view?: { position?: Pose };
        }>;
        for (const row of rows) {
          assert.equal(typeof row.entity, "number");
          const id = row.entity as number;
          entities.add(id);
          const position = row.view?.position;
          if (position) poses.set(id, { x: position.x, y: position.y, z: position.z });
        }
        for (const row of msg.envelope.despawns ?? []) {
          const id = (row as { entity?: unknown }).entity;
          assert.equal(typeof id, "number");
          despawns.push(id as number);
        }
        if (typeof msg.envelope.seq === "number" && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ v: 1, type: "ack", snapshotSeq: msg.envelope.seq }));
        }
      }
    });
    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({
        v: 1,
        type: "hello",
        protocol: 1,
        world: view.world,
        bundleId: view.bundleId,
        authoritativeHash: view.authoritativeHash,
        ...(token ? { token } : {}),
      }));
    });
  });
  return { ws, welcome, poses, entities, despawns, gone, loadouts, health };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitFor<T>(ms: number, read: () => T | undefined): Promise<T> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      const value = read();
      if (value !== undefined) {
        clearInterval(timer);
        resolve(value);
      } else if (Date.now() - started > ms) {
        clearInterval(timer);
        reject(new Error("timed out"));
      }
    }, 15);
  });
}

function loadGlb(name: string): Promise<{ scene: THREE.Object3D }> {
  const selfHost = globalThis as { self?: unknown; createImageBitmap?: (blob: Blob) => Promise<unknown> };
  selfHost.self ??= globalThis;
  selfHost.createImageBitmap ??= async (blob: Blob) => {
    const data = new Uint8Array(await blob.arrayBuffer());
    return { width: 1, height: 1, data, close() {} };
  };
  const file = path.join(rootDir(), "web", "assets", "models", name);
  const bytes = readFileSync(file);
  const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const loader = new GLTFLoader();
  allowKtx2(loader);
  return new Promise((resolve, reject) => {
    loader.parse(
      data,
      "",
      (gltf) => resolve({ scene: gltf.scene }),
      (err) => reject(err instanceof Error ? err : new Error(String(err))),
    );
  });
}

type StairBox = { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number };

/** West-advancing treads whose top step is the one under the weapon. */
function westStairToward(
  weapon: { minX: number; maxX: number; minZ: number; maxZ: number },
  buildings: readonly { id: string; model: string }[],
  aabbs: readonly { source?: string; minX: number; maxX: number; minY?: number; maxY?: number; minZ: number; maxZ: number }[],
): StairBox[] {
  const stepIds = new Set(
    buildings.filter((building) => building.model.endsWith("/step.glb")).map((building) => `${building.id}-box`),
  );
  const steps: StairBox[] = [];
  for (const box of aabbs) {
    if (!box.source || !stepIds.has(box.source)) continue;
    if (typeof box.minY !== "number" || typeof box.maxY !== "number") continue;
    steps.push({ minX: box.minX, maxX: box.maxX, minY: box.minY, maxY: box.maxY, minZ: box.minZ, maxZ: box.maxZ });
  }
  const overlapsZ = (a: StairBox, b: StairBox) => a.maxZ > b.minZ && b.maxZ > a.minZ;
  const ground = steps.filter((step) => step.minY <= 1e-6 && step.maxY > 0 && step.maxY <= STEP_HEIGHT);
  const cx = (weapon.minX + weapon.maxX) / 2;
  const cz = (weapon.minZ + weapon.maxZ) / 2;
  let best: StairBox[] = [];
  for (const start of ground) {
    const run = [start];
    let current = start;
    for (;;) {
      const next = steps.find((step) =>
        !run.includes(step)
        && step.maxX <= current.minX + 0.05
        && step.maxX > current.minX - 0.5
        && overlapsZ(step, current)
        && step.maxY - current.maxY > 1e-6
        && step.maxY - current.maxY <= STEP_HEIGHT + 1e-6);
      if (!next) break;
      run.push(next);
      current = next;
    }
    const top = run[run.length - 1];
    if (!top) continue;
    const under = cx >= top.minX - 1 && cx <= top.maxX + 1 && cz >= top.minZ - 1 && cz <= top.maxZ + 1;
    if (under && run.length > best.length) best = run;
  }
  return best;
}

test("one client takes alien-weapon-1 and the other sees it gone", { timeout: 40_000 }, async () => {
  const host = await startArenaServer(0);
  const open: WebSocket[] = [];
  try {
    const page = await fetch(`${host.url}/arena.json`);
    const view = await page.json() as {
      world: string;
      bundleId: string;
      authoritativeHash: string;
      pickups?: PickupPlacement[];
      buildings?: Array<{ id: string; model: string }>;
      props?: Array<{ id: string }>;
      aabbs?: Array<{ source?: string; minX: number; maxX: number; minY?: number; maxY?: number; minZ: number; maxZ: number }>;
    };
    const pickups = view.pickups ?? [];
    const weapon = pickups.find((item) => item.id === "alien-weapon-1");
    assert.ok(weapon);
    assert.equal(weapon.kind, "weapon");
    assert.equal(weapon.weapon, "alien-weapon-enh");
    assert.equal(pickups.some((item) => item.id === "cover-crate-2-9"), true);
    assert.equal(pickups.some((item) => item.id === "alien-weapon-enh"), false);
    assert.equal(
      (view.buildings ?? []).some((item) => item.id === "cover-crate-2-9")
        || (view.props ?? []).some((item) => item.id === "cover-crate-2-9"),
      true,
    );

    const a = openClient(host.url, view);
    open.push(a.ws);
    const aw = await a.welcome;
    const b = openClient(host.url, view);
    open.push(b.ws);
    const bw = await b.welcome;
    assert.notEqual(aw.ownedEntityId, bw.ownedEntityId);
    for (const welcome of [aw, bw]) {
      assert.equal(welcome.pickups.includes("alien-weapon-1"), true);
      assert.equal(welcome.pickups.includes("cover-crate-2-1"), true);
      assert.equal(welcome.pickups.includes("cover-crate-2-6-1"), true);
      assert.equal(welcome.pickups.includes("cover-crate-2-9"), true);
      assert.equal(welcome.pickups.includes("alien-weapon-enh"), false);
      assert.equal(welcome.pickups.every((id) => typeof id === "string"), true);
    }
    await waitFor(2000, () => a.poses.get(aw.ownedEntityId));
    await delay(200);
    const start = a.poses.get(aw.ownedEntityId);
    assert.ok(start);
    const before = [...a.entities].sort((left, right) => left - right);
    assert.ok(before.length > 0);

    // Own every other seat so wanderers stay off the stair during the climb.
    const seats = loadArena().agents.length;
    for (let n = 2; n < seats; n++) {
      const extra = openClient(host.url, view);
      open.push(extra.ws);
      const welcome = await extra.welcome;
      extra.ws.send(JSON.stringify({
        v: 1,
        type: "input",
        seq: 1,
        moveX: 0,
        moveZ: 0,
        yaw: 0,
        buttons: 0,
        entity: welcome.ownedEntityId,
      }));
    }

    const stairs = westStairToward(weapon, view.buildings ?? [], view.aabbs ?? []);
    assert.ok(stairs.length >= 2, "no west stair reaches the weapon");
    const first = stairs[0]!;
    const top = stairs[stairs.length - 1]!;
    const centerZ = (first.minZ + first.maxZ) / 2;
    const goals = [
      { x: start.x, z: centerZ },
      { x: first.maxX + 0.9, z: centerZ },
      { x: (top.minX + top.maxX) / 2, z: centerZ },
      { x: (weapon.minX + weapon.maxX) / 2, z: (weapon.minZ + weapon.maxZ) / 2 },
    ];
    const deadline = Date.now() + 15000;
    let seq = 1;
    let goal = 0;
    while (Date.now() < deadline) {
      const takenA = a.gone.some((frame) => frame.id === "alien-weapon-1");
      const takenB = b.gone.some((frame) => frame.id === "alien-weapon-1");
      if (takenA && takenB) break;
      const pose = a.poses.get(aw.ownedEntityId);
      if (pose && a.ws.readyState === WebSocket.OPEN) {
        while (goal < goals.length - 1 && Math.hypot(pose.x - goals[goal]!.x, pose.z - goals[goal]!.z) < 0.45) goal += 1;
        const target = goals[goal]!;
        const dx = target.x - pose.x;
        const dz = target.z - pose.z;
        const len = Math.hypot(dx, dz) || 1;
        a.ws.send(JSON.stringify({
          v: 1,
          type: "input",
          seq: seq++,
          moveX: dx / len,
          moveZ: dz / len,
          yaw: Math.atan2(dx, dz),
          buttons: 0,
          entity: aw.ownedEntityId,
        }));
      }
      await delay(50);
    }
    const pose = a.poses.get(aw.ownedEntityId);
    const aim = goals[goals.length - 1]!;
    const dist = pose ? Math.hypot(pose.x - aim.x, pose.z - aim.z) : Number.NaN;
    const where = `pose ${JSON.stringify(pose)} goal ${goal} dist ${dist.toFixed(3)}`;
    const goneA = a.gone.find((frame) => frame.id === "alien-weapon-1");
    const goneB = b.gone.find((frame) => frame.id === "alien-weapon-1");
    assert.ok(goneA, `A did not see the weapon vanish ${where}`);
    assert.ok(goneB, `B did not see the weapon vanish ${where}`);
    assert.deepEqual(goneA, { t: "pickup", id: "alien-weapon-1", gone: true });
    assert.deepEqual(goneB, { t: "pickup", id: "alien-weapon-1", gone: true });
    assert.equal(typeof goneA.id, "string");
    assert.equal(a.gone.some((frame) => frame.id === "cover-crate-2-9"), false);
    assert.equal(b.gone.some((frame) => frame.id === "cover-crate-2-9"), false);
    assert.ok(a.loadouts.some((frame) => frame.weapon === "alien-weapon-enh"));
    assert.equal(b.loadouts.some((frame) => frame.weapon !== undefined), false);
    assert.ok(a.health.length > 0);
    for (const hp of a.health) assert.ok(hp <= MAX_HP, `hp ${hp}`);
    for (const hp of b.health) assert.ok(hp <= MAX_HP, `hp ${hp}`);
    assert.deepEqual([...a.entities].sort((left, right) => left - right), before);
    assert.deepEqual(a.despawns, []);
    assert.deepEqual(b.despawns, []);

    // The old socket stays open so the host still has this pawn when the token arrives.
    const again = openClient(host.url, view, aw.token);
    open.push(again.ws);
    const re = await again.welcome;
    assert.equal(re.ownedEntityId, aw.ownedEntityId);
    assert.equal(re.pickups.includes("alien-weapon-1"), false);
    assert.equal(re.pickups.includes("alien-weapon-enh"), false);
    assert.equal(re.pickups.includes("cover-crate-2-1"), true);
    assert.equal(re.pickups.includes("cover-crate-2-6-1"), true);
    assert.equal(re.pickups.includes("cover-crate-2-9"), true);
    assert.equal(re.weapon, "alien-weapon-enh");
  } finally {
    for (const ws of open) {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
    }
    await host.close();
  }
});

test("two tabs see a full pawn clear a health crate and a second crate", { timeout: 45_000 }, async () => {
  const host = await startArenaServer(0);
  const open: WebSocket[] = [];
  try {
    const page = await fetch(`${host.url}/arena.json`);
    const view = await page.json() as {
      world: string;
      bundleId: string;
      authoritativeHash: string;
      pickups?: PickupPlacement[];
      aabbs?: Array<{ source?: string }>;
    };
    assert.equal(view.aabbs?.some((box) => box.source === "cover-crate-2-6-1-box"), true);
    assert.equal(view.aabbs?.some((box) => box.source === "cover-crate-2-1-box"), true);
    assert.equal(view.aabbs?.some((box) => box.source === "cover-crate-2-9-box"), true);
    const health = view.pickups?.find((item) => item.id === "cover-crate-2-6-1");
    const ammo = view.pickups?.find((item) => item.id === "cover-crate-2-1");
    assert.ok(health && ammo);

    const seats = loadArena().agents.length;
    const a = openClient(host.url, view);
    open.push(a.ws);
    const aw = await a.welcome;
    const rest: LiveClient[] = [];
    for (let i = 1; i < seats; i += 1) {
      const client = openClient(host.url, view);
      open.push(client.ws);
      rest.push(client);
    }
    await Promise.all(rest.map((client) => client.welcome));
    const b = rest[0];
    assert.ok(b);
    assert.equal(aw.pickups.includes("cover-crate-2-6-1"), true);
    assert.equal(aw.pickups.includes("cover-crate-2-1"), true);
    await waitFor(2000, () => a.poses.get(aw.ownedEntityId));

    let seq = 1;
    let nudge = 0;
    let stillSince = Date.now();
    let stillAt = a.poses.get(aw.ownedEntityId);
    async function steer(id: string, target: { x: number; z: number }) {
      const deadline = Date.now() + 12_000;
      while (Date.now() < deadline) {
        if (a.gone.some((frame) => frame.id === id) && b!.gone.some((frame) => frame.id === id)) return;
        const pose = a.poses.get(aw.ownedEntityId);
        if (pose && stillAt && Math.hypot(pose.x - stillAt.x, pose.z - stillAt.z) > 0.15) {
          stillAt = pose;
          stillSince = Date.now();
          nudge = 0;
        } else if (Date.now() - stillSince > 500) {
          nudge = nudge > 0 ? -0.85 : 0.85;
          stillSince = Date.now();
        }
        if (pose && a.ws.readyState === WebSocket.OPEN) {
          const dx = target.x - pose.x;
          const dz = target.z - pose.z;
          const len = Math.hypot(dx, dz) || 1;
          const fx = dx / len;
          const fz = dz / len;
          let moveX = fx - fz * nudge;
          let moveZ = fz + fx * nudge;
          const scale = Math.hypot(moveX, moveZ) || 1;
          moveX /= scale;
          moveZ /= scale;
          a.ws.send(JSON.stringify({
            v: 1,
            type: "input",
            seq: seq++,
            moveX,
            moveZ,
            yaw: Math.atan2(moveX, moveZ),
            buttons: 0,
            entity: aw.ownedEntityId,
          }));
        }
        await delay(50);
      }
      const pose = a.poses.get(aw.ownedEntityId);
      const dist = pose ? Math.hypot(pose.x - target.x, pose.z - target.z) : Number.NaN;
      assert.fail(`${id} still there at ${JSON.stringify(pose)} dist ${dist.toFixed(3)}`);
    }

    await steer("cover-crate-2-6-1", {
      x: (health.minX + health.maxX) / 2,
      z: (health.minZ + health.maxZ) / 2,
    });
    await steer("cover-crate-2-1", {
      x: (ammo.minX + ammo.maxX) / 2,
      z: (ammo.minZ + ammo.maxZ) / 2,
    });
    assert.equal(typeof a.gone.find((frame) => frame.id === "cover-crate-2-6-1")?.id, "string");
    assert.deepEqual(b.gone.find((frame) => frame.id === "cover-crate-2-1"), {
      t: "pickup",
      id: "cover-crate-2-1",
      gone: true,
    });
    assert.equal(a.gone.some((frame) => frame.id === "cover-crate-2-9"), false);
    assert.equal(b.gone.some((frame) => frame.id === "cover-crate-2-9"), false);
    assert.ok(a.health.length > 0);
    for (const hp of a.health) assert.ok(hp <= MAX_HP, `hp ${hp}`);
    for (const hp of b.health) assert.ok(hp <= MAX_HP, `hp ${hp}`);

    const again = openClient(host.url, view, aw.token);
    open.push(again.ws);
    const re = await again.welcome;
    assert.equal(re.ownedEntityId, aw.ownedEntityId);
    assert.equal(re.pickups.includes("cover-crate-2-6-1"), false);
    assert.equal(re.pickups.includes("cover-crate-2-1"), false);
    assert.equal(re.pickups.includes("cover-crate-2-9"), true);
    assert.equal(re.pickups.includes("alien-weapon-1"), true);
  } finally {
    for (const ws of open) {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
    }
    await host.close();
  }
});
