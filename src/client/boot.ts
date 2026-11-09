import { EngineClient } from "conveyor-engine-client";
import * as THREE from "three";
import type { ArenaElevator, ArenaView } from "../shared/arena-view.js";
import { aimDirection, EYE_HEIGHT, eyeLook, INPUT_HZ, moveIntent, yawFromQuat } from "../shared/look.js";
import {
  elevatorPolygonBounds,
  inCab,
  landingAt,
  stepStop,
  stopForKey,
  type ElevatorRuntime,
  type ElevatorState,
} from "../shared/elevators.js";
import type { CabState } from "../shared/scene-graph.js";
import { encodeMoveButtons } from "../shared/movements.js";
import { dropPickupAabb } from "../shared/pickups.js";
import { createFireDebugLog } from "../shared/fire-debug.js";
import { createClientDiag, presentFaultHud, reportFrameFault } from "./diag.js";
import { doorLeafBox, pickDoorForUse } from "../shared/doors.js";
import { advanceGrenadeClock, type GrenadePose } from "../shared/grenade.js";
import { advanceFireClock, LASER_MS, TRACE_RANGE, traceHitscan, type TraceCapsule } from "../shared/hitscan.js";
import { createAabbDebug } from "./aabb-debug.js";
import { loadKey } from "./auth-key.js";
import { applyDoorSwing, attachKtx2Loader, createArenaScene, loadArenaVisuals, tickDoorSwing } from "./arena-scene.js";
import { createElevatorRooms } from "./elevator-room.js";
import { createEchoDedupe, createSfx } from "./audio.js";
import { createDoorSounds } from "./door-sound.js";
import { createElevatorSounds } from "./elevator-sound.js";
import { createPickupSounds, kindSoundsOf } from "./pickup-sound.js";
import { createCharacterFx, type CharacterFx, type Point as FxPoint } from "./character-fx.js";
import { createExplosionFx, type ExplosionFx } from "./explosion.js";
import { createGrenadeProps } from "./grenade.js";
import { createHitMarker } from "./hit-marker.js";
import { createHud, localHealthLabel } from "./hud.js";
import { cameraAim, createInfoProbe, leafAabb, type ProbePawn } from "./info-probe.js";
import { attachPlayInput } from "./input.js";
import { createLaserBeams } from "./laser.js";
import { assetBase } from "../shared/asset-base.js";
import type { QaCaptureFrame } from "../shared/bot-protocol.js";
import { connectLive, type LaserNotice, type OpenSocket } from "./net.js";
import { createViewModel } from "./viewmodel.js";
import { createOptionsDialog } from "./options.js";
import { createSceneMap, loadMapBakeBounds } from "./scene-map.js";
import { createPawnLayer } from "./presentation.js";
import { installQaApi, type QaApi } from "./qa.js";
import { createRateWindow, formatOverlay } from "./rates.js";
import { formatFireLog, presentShot } from "./shot-view.js";

/** Laser hit point: a small, quick blast. Grenades use the manifest `sprite.size` at 30 fps. */
const LASER_IMPACT_SIZE = 0.8;
const LASER_IMPACT_FPS = 60;
/** Grenade blast centre above the stop point, as a fraction of the sprite size. */
const GRENADE_BLAST_LIFT = 0.25;
/** A grenade's first pose is the thrower's eye. Within this of your own eye, it is yours. */
const OWN_GRENADE_RADIUS = 2.5;

export async function boot(
  view: ArenaView,
  open: () => OpenSocket,
  opts?: { auth?: boolean; onAuthRejected?: (reason: string) => void; qa?: boolean },
): Promise<void> {
  const qa = opts?.qa === true;
  const hud = createHud(qa ? { hidden: true } : undefined);
  const hitMarker = createHitMarker();
  hud.setStatus("loading arena");
  const arena = createArenaScene(view.shadows?.quality ?? "off", qa ? { qa: true } : undefined);
  const collisionDebug = createAabbDebug(view.aabbs);
  arena.scene.add(collisionDebug.group);
  const CAB_BOX_H = 0.1;
  const cabDebug = createCabMeshes(view.elevators ?? [], arena.scene);
  const sceneMap = createSceneMap();
  let pushModel: (id: string) => void = () => {};
  const options = createOptionsDialog(
    (on) => {
      collisionDebug.setVisible(on);
      cabDebug.group.visible = on;
    },
    undefined,
    (on) => sceneMap.setVisible(on),
    {
      noclipAllowed: view.noclip === true,
      modelChoices: view.modelChoices ?? [],
      onModel: (id) => pushModel(id),
    },
  );
  const fireDebug = createFireDebugLog(() => options.fireDebug);
  const visuals = await loadArenaVisuals(view, arena);
  /** Open state per door, from the file then from host frames. A shut leaf stops the predicted beam like the host shot. */
  const doorOpen = new Map((view.doors ?? []).map((door) => [door.id, door.open === true && door.locked !== true]));
  const cabState = new Map<string, ElevatorState>();
  const cabPick = new Map<string, number>();
  const elevatorRooms = createElevatorRooms(view, visuals, collisionDebug);

  // The baked PNG is framed on the SVG bounds rect; pawns must use the same window.
  sceneMap.setWorld({
    bounds: (await loadMapBakeBounds()) ?? view.bounds,
    samples: visuals.mapSamples,
    spawns: view.spawns,
  });
  const pickupIds = new Set((view.pickups ?? []).map((pickup) => pickup.id));
  for (const id of pickupIds) visuals.placements.setVisible(id, false);
  const viewmodel = createViewModel(arena.camera, arena.scene, arena.renderer);
  function dropBox(id: string) {
    dropPickupAabb(view.aabbs, id);
    collisionDebug.remove(id);
  }
  function showRemaining(ids: readonly string[]) {
    const left = new Set(ids);
    for (const id of pickupIds) {
      const visible = left.has(id);
      visuals.placements.setVisible(id, visible);
      if (!visible) dropBox(id);
    }
  }
  function showWeapon(weaponId: string | undefined) {
    if (!weaponId) {
      viewmodel.clear();
      return;
    }
    const model = view.pickups?.find((pickup) => pickup.weapon === weaponId)?.model;
    if (model) void viewmodel.show(weaponId, model);
  }
  const pawns = createPawnLayer(arena.content, visuals.templates, view.pawnHeight);
  const input = attachPlayInput(arena.renderer.domElement, undefined, () => {
    fireDebug.keydown();
  }, () => options.invertY, () => options.open, !qa);
  const probe = createInfoProbe({
    doors: view.doors ?? [],
    pickups: view.pickups ?? [],
    props: view.props ?? [],
    show: (text) => hud.setInfo(text),
    copy: (id) => hud.copyInfo(id),
  });
  input.onPadMenu((ev) => {
    if (ev === "toggle") {
      const opening = !options.open;
      options.toggleDialog();
      if (opening) options.resetFocus();
    } else if (ev === "map") {
      options.toggleShowSceneMap();
    } else if (ev === "back") {
      if (options.open) options.toggleDialog();
    } else if (ev === "select") {
      options.activateFocused();
    } else if (ev === "up") {
      options.moveFocus(-1);
    } else if (ev === "down") {
      options.moveFocus(1);
    } else if (ev === "left") {
      options.adjustFocused(-1);
    } else if (ev === "right") {
      options.adjustFocused(1);
    }
    options.repaint();
    input.setMenuOpen(options.open);
  });
  hud.onProfileToggle(() => input.toggleProfile());
  hud.setProfile(input.profile);
  const lasers = createLaserBeams(arena.scene);
  const grenades = createGrenadeProps(arena.scene, async () => {
    const url = view.grenade ?? `${assetBase()}assets/models/grenade-launched.glb`;
    const { GLTFLoader } = await import("three/addons/loaders/GLTFLoader.js");
    const loader = new GLTFLoader();
    attachKtx2Loader(loader, arena.renderer);
    try {
      const gltf = await loader.loadAsync(url);
      return gltf.scene;
    } catch (err) {
      console.warn("grenade", err);
      return undefined;
    }
  });
  const client = new EngineClient(1, { delayMs: 80, extraMs: 0, predictOwned: false });
  let statusText = "connecting";
  let consoleHint = false;
  const diag = createClientDiag();
  // Sheet and texture come from the manifest asset `grenade-explosion` (`view.explosion`).
  // The solo build already rewrites its `/assets/` uri to `./assets/`.
  const explosions = createExplosionFx(arena.scene, {
    sheet: view.explosion,
    onLoadError(err) {
      diag.report({ level: "error", error: err, fields: { source: "fx", category: "explosion-atlas" } });
    },
  });
  const explosionSheet = view.explosion;
  const laserImpactSize = explosionSheet?.laserImpactSize ?? LASER_IMPACT_SIZE;
  void explosions.load(async () => {
    if (!explosionSheet) throw new Error("manifest has no grenade-explosion sprite");
    return new THREE.TextureLoader().loadAsync(explosionSheet.texture);
  }, arena.renderer);
  // Character spawn and despawn: sound, beam sheet, and a fade of the model. `view.characterBeam`
  // sets the timings; absent, characters appear and go at once. Triggers: a `spawn` host frame (a
  // player took a seat), and the health frames (death: despawn, back alive: spawn). The first health
  // frame of a pawn, and everything in welcome, is only a baseline.
  const beamConfig = view.characterBeam;
  const beamSheets: Record<"spawn" | "despawn", { fx: ExplosionFx; size: number; fps: number } | undefined> = { spawn: undefined, despawn: undefined };
  if (beamConfig) {
    for (const kind of ["spawn", "despawn"] as const) {
      const sheet = beamConfig[kind];
      if (!sheet) continue;
      const fx = createExplosionFx(arena.scene, {
        cap: 6,
        sheet,
        onLoadError(err) {
          diag.report({ level: "error", error: err, fields: { source: "fx", category: `beam-${kind}-sheet` } });
        },
      });
      void fx.load(async () => new THREE.TextureLoader().loadAsync(sheet.texture), arena.renderer);
      beamSheets[kind] = { fx, size: sheet.size, fps: sheet.fps };
    }
  }
  let fxNow = 0;
  const characterFx: CharacterFx | undefined = beamConfig
    ? createCharacterFx(beamConfig, {
      sound(kind, id, at) {
        const name = kind === "spawn" ? "beamSpawn" : "beamDespawn";
        // Your own pawn is not in front of the camera: play it flat. Everyone else's sits at their feet.
        if (id === client.ownedEntity) sfx.play(name);
        else sfx.play(name, { x: at.x, y: at.y + view.pawnHeight / 2, z: at.z });
      },
      beam(kind, id, at) {
        const sheet = beamSheets[kind];
        // No beam over your own first-person view.
        if (!sheet || id === client.ownedEntity) return;
        // Square sprite, world size ≈ pawn height; sheet.rotation (despawn: 90°) is on the material.
        sheet.fx.spawn(at.x, at.y + sheet.size / 2, at.z, sheet.size, sheet.fps);
      },
    })
    : undefined;
  const fadeOf = characterFx ? (id: number) => characterFx.opacity(id, fxNow) : undefined;
  function authoritativeFeet(id: number): FxPoint | undefined {
    const position = client.authoritative(id)?.position;
    return position ? { x: position.x, y: position.y, z: position.z } : undefined;
  }
  // Sounds come from the manifest `audio` assets (`view.sounds`). Files load now; the
  // AudioContext starts on the first click, tap, or key (autoplay policy), then decodes.
  const sfx = createSfx({
    sounds: view.sounds,
    onError(err, effect) {
      diag.report({ level: "error", error: err, fields: { source: "fx", category: "audio", reason: effect } });
    },
  });
  void sfx.load();
  // Kept until the context is running, in case a first resume is refused.
  const unlockAudio = () => {
    if (!sfx.unlock() || sfx.running) removeUnlock();
  };
  const unlockEvents = ["pointerdown", "keydown", "touchend"] as const;
  function removeUnlock() {
    for (const type of unlockEvents) window.removeEventListener(type, unlockAudio, true);
  }
  for (const type of unlockEvents) window.addEventListener(type, unlockAudio, true);
  if (typeof document !== "undefined") {
    sfx.setHidden(document.hidden);
    document.addEventListener("visibilitychange", () => sfx.setHidden(document.hidden));
  }
  // Pickup sounds wait for the host's word: `pickup gone`, then your own loadout/inventory.
  const pickupSounds = createPickupSounds({
    pickups: view.pickups ?? [],
    kindSounds: kindSoundsOf(view.sounds),
    play: (name, at) => sfx.play(name, at),
  });
  // Door sounds: only a real open/closed change in a host door frame. Welcome is silent.
  const doorSounds = createDoorSounds({
    doors: (view.doors ?? []).map((door) => {
      const box = doorLeafBox(door);
      return {
        id: door.id,
        open: door.open,
        locked: door.locked,
        at: { x: (box.minX + box.maxX) / 2, y: (box.minY + box.maxY) / 2, z: (box.minZ + box.maxZ) / 2 },
      };
    }),
    play: (name, at) => sfx.play(name, at),
  });
  // Elevator start: a stationary-to-moving cab frame plays it at the cab, then it rides along.
  const elevatorSounds = createElevatorSounds({
    cabs: (view.elevators ?? []).map((def) => {
      const bounds = elevatorPolygonBounds(def.polygon);
      return { id: def.id, x: (bounds.minX + bounds.maxX) / 2, z: (bounds.minZ + bounds.maxZ) / 2 };
    }),
    play: (name, at) => sfx.playTracked(name, at),
  });
  // Own shots play on the local send. These drop the host echo of each one.
  const ownLaserEcho = createEchoDedupe();
  const ownGrenadeEcho = createEchoDedupe();
  // Debug: `__fx.explode()` in the console puts a blast 4 m in front of the camera.
  // `__fx.audio.setVolume(0.5)`, `__fx.audio.mute()`, `__fx.audio.mute(false)`, `__fx.audio.play("grenadeBlast")`.
  (window as { __fx?: unknown }).__fx = {
    audio: {
      setVolume: (value: number) => sfx.setVolume(value),
      mute: (value = true) => sfx.mute(value),
      play: (name: "laser" | "grenadeLaunch" | "grenadeBlast") => sfx.play(name),
      get volume() {
        return sfx.volume;
      },
      get muted() {
        return sfx.muted;
      },
    },
    explode(size = 4, distance = 4): boolean {
      const cam = arena.camera;
      const ahead = cam.getWorldDirection(new THREE.Vector3()).multiplyScalar(distance).add(cam.position);
      return explosions.spawn(ahead.x, ahead.y, ahead.z, size);
    },
    setBlending: (mode: "normal" | "additive") => explosions.setBlending(mode),
    get active() {
      return explosions.activeCount;
    },
  };
  let aimedPawn: number | undefined;
  let fireSeq = 0;
  let nextFireAt = 0;
  let grenadeSeq = 0;
  let nextGrenadeAt = 0;
  let useSeq = 0;
  let pendingFireLog: { socketClosed: boolean; camBefore: { x: number; y: number; z: number } } | undefined;
  let awaitFireReply = false;
  let loggedFireSnap = false;
  let debugPawn: number | undefined;
  let debugPawnWatch = false;
  let sawFiniteCamera = true;
  const laserQueue: LaserNotice[] = [];
  const grenadeQueue: GrenadePose[] = [];
  const pawnVital = new Map<number, { hp: number; dead: boolean }>();

  let sawSnap = false;
  let resolveSnap = (): void => {};
  const firstSnapshot = new Promise<void>((resolve) => {
    resolveSnap = resolve;
  });
  let frozen = false;
  let followId: number | undefined;
  let followBack = 3;
  let followUp = 1.6;
  const placeFollow = () => {
    if (followId === undefined) return;
    const sample = client.renderSnapshot();
    const entity = sample.entities.find((item) => Number(item.id) === followId);
    if (!entity) return;
    const yaw = yawFromQuat(entity.rotation);
    arena.camera.position.set(
      entity.position.x - Math.sin(yaw) * followBack,
      entity.position.y + followUp,
      entity.position.z - Math.cos(yaw) * followBack,
    );
    arena.camera.up.set(0, 1, 0);
    arena.camera.lookAt(entity.position.x, entity.position.y + 1.6, entity.position.z);
  };

  const snapshotSend: { current: (id: string, png: string) => void } = { current: () => {} };
  const answerQaCapture = (msg: QaCaptureFrame): void => {
    void takeQaCapture(msg).catch((err: unknown) => {
      console.error("qa capture threw", err);
    });
  };
  async function takeQaCapture(msg: QaCaptureFrame): Promise<void> {
    if (qa) {
      const api = (window as { __qa?: QaApi }).__qa;
      if (!api) return;
      if (msg.lookFrom) api.lookFrom(msg.lookFrom.eye, msg.lookFrom.target, msg.lookFrom.fovDeg);
      if (msg.follow) {
        api.follow(msg.follow.entityId, {
          ...(msg.follow.back !== undefined ? { back: msg.follow.back } : {}),
          ...(msg.follow.up !== undefined ? { up: msg.follow.up } : {}),
        });
      }
      if (msg.waitFrames !== undefined) await api.waitFrames(msg.waitFrames);
      snapshotSend.current(msg.id, await api.snapshot());
      return;
    }
    // Aimed shots stay on a ?qa=1 tab. A play tab only ships its current view.
    if (msg.lookFrom || msg.follow) return;
    arena.renderer.render(arena.scene, arena.camera);
    snapshotSend.current(msg.id, arena.renderer.domElement.toDataURL("image/png"));
  }

  const link = connectLive({
    bundleId: view.bundleId,
    authoritativeHash: view.authoritativeHash,
    world: view.world,
    client,
    fireDebug: () => options.fireDebug,
    onStatus: (status) => {
      statusText = status.text;
      resyncs = status.resyncs;
    },
    onApplied: () => {
      if (sawSnap) return;
      sawSnap = true;
      resolveSnap();
    },
    onLaser: (laser) => {
      laserQueue.push(laser);
    },
    onGrenade: (grenade) => {
      grenadeQueue.push(grenade);
    },
    onHealth: (health) => {
      const before = pawnVital.get(health.entity);
      pawnVital.set(health.entity, { hp: health.hp, dead: health.dead });
      // A pawn's first health frame is a baseline. A change of `dead` is a real death or respawn.
      if (characterFx && before && before.dead !== health.dead) {
        const feet = authoritativeFeet(health.entity);
        if (feet) {
          if (health.dead) characterFx.despawn(health.entity, feet, performance.now(), beamConfig?.deathHoldMs ?? 0);
          else characterFx.spawn(health.entity, feet, performance.now());
        }
      }
    },
    onSpawn: (spawn) => {
      characterFx?.spawn(spawn.id, { x: spawn.x, y: spawn.y, z: spawn.z }, performance.now());
    },
    onAudit: (audit) => {
      options.setAudit(audit);
    },
    onPickupSet: (ids) => {
      pickupSounds.onSet(ids);
      showRemaining(ids);
      probe.onPickupSet(ids);
    },
    onPickup: (pickup) => {
      pickupSounds.onGone(pickup.id, performance.now());
      visuals.placements.setVisible(pickup.id, false);
      dropBox(pickup.id);
      probe.onPickupGone(pickup.id);
    },
    onDoor: (door) => {
      doorSounds.onDoor(door, performance.now());
      swingDoor(door.id, door.open);
      probe.onDoor(door);
    },
    onDoors: (doors) => {
      doorSounds.onSet(doors);
      for (const door of doors) swingDoor(door.id, door.open);
      probe.onDoors(doors);
    },
    onSceneGraph: (frame) => probe.onSceneGraph(frame),
    onElevator: (row) => {
      elevatorSounds.onCab(row);
      applyCab(row);
    },
    onElevators: (rows) => {
      elevatorSounds.onSet(rows);
      for (const row of rows) applyCab(row);
    },
    onInventory: (keys) => pickupSounds.onInventory(keys, performance.now()),
    onLoadout: (loadout) => {
      pickupSounds.onLoadout(performance.now());
      showWeapon(loadout.weapon);
    },
    onInbound(summary) {
      if (!options.fireDebug || !awaitFireReply) return;
      const laser = summary.startsWith("laser");
      const control = summary.startsWith("welcome") || summary.startsWith("reject") || summary.startsWith("error");
      if (laser || control) {
        fireDebug.frameReceived(summary);
        awaitFireReply = false;
        return;
      }
      if (summary.startsWith("snapshot ") && !loggedFireSnap) {
        fireDebug.frameReceived(summary);
        loggedFireSnap = true;
      }
    },
    onFault(err) {
      consoleHint = true;
      fireDebug.thrown("socket", err);
    },
    onConsoleHint() {
      consoleHint = true;
    },
    model: () => options.modelChoice || undefined,
    open,
    auth: opts?.auth,
    spectate: qa,
    onAuthRejected: opts?.onAuthRejected,
    onQaCapture: answerQaCapture,
  });
  pushModel = (id) => {
    link.sendModel(id);
  };
  snapshotSend.current = (id, png) => {
    link.sendQaSnapshotData(id, png);
  };

  let last = performance.now();
  let sendAcc = 0;
  let seenSnaps = 0;
  let resyncs = 0;
  const rates = createRateWindow(500);
  const sendDt = 1 / INPUT_HZ;
  let lastDoorTick = 0;
  let wantInfo = false;
  let probeOwn: { x: number; y: number; z: number } | undefined;
  let probeOwnedId: number | undefined;
  let probePawns: readonly ProbePawn[] = [];

  function frame(now: number) {
    let threw = false;
    wantInfo = false;
    try {
      drawFrame(now);
    } catch (err) {
      threw = true;
      consoleHint = true;
      reportFrameFault(diag, err, link.faultContext());
      fireDebug.thrown("frame", err);
      const camera = arena.camera.position;
      fireDebug.camera({ x: camera.x, y: camera.y, z: camera.z });
      fireDebug.pawn(client.ownedEntity);
      fireDebug.socket(link.socketState());
      hud.setStatus(presentFaultHud(statusText, true));
      laserQueue.length = 0;
      lasers.drop();
      grenadeQueue.length = 0;
      grenades.drop();
      explosions.clear();
      pickupSounds.clear();
      doorSounds.clear();
      elevatorSounds.clear();
      characterFx?.clear();
      beamSheets.spawn?.fx.clear();
      beamSheets.despawn?.fx.clear();
      sfx.stopAll();
      ownLaserEcho.clear();
      ownGrenadeEcho.clear();
      try {
        arena.renderer.render(arena.scene, arena.camera);
      } catch (renderErr) {
        reportFrameFault(diag, renderErr, { ...link.faultContext(), category: "render" });
      }
    }
    hitMarker.tick(now);
    const doorDt = lastDoorTick ? Math.min(0.1, (now - lastDoorTick) / 1000) : 0;
    lastDoorTick = now;
    for (const rig of visuals.doors.values()) tickDoorSwing(rig.group, doorDt);
    if (wantInfo) {
      const aim = cameraAim(arena.camera);
      const leaves = new Map<string, ReturnType<typeof leafAabb>>();
      for (const [id, rig] of visuals.doors) leaves.set(id, leafAabb(rig.group));
      probe.inspect({
        now,
        origin: aim.origin,
        direction: aim.direction,
        leaves,
        volumes: view.aabbs,
        pawns: probePawns,
        ownedId: probeOwnedId,
        radius: view.pawnRadius,
        height: view.pawnHeight,
        own: probeOwn,
        cabs: probeCabs(),
        pickupHidden: (id) => visuals.placements.hidden(id),
      });
    }
    probe.refresh(now, probeOwn, probeCabs());
    if (pendingFireLog) {
      if (options.fireDebug) {
        const camera = arena.camera.position;
        console.log(formatFireLog({
          socketClosed: pendingFireLog.socketClosed || link.socketClosed(),
          frameThrew: threw,
          camBefore: pendingFireLog.camBefore,
          camAfter: { x: camera.x, y: camera.y, z: camera.z },
        }));
      }
      pendingFireLog = undefined;
    }
    requestAnimationFrame(frame);
  }
  function drawFrame(now: number) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (!frozen) {
      for (const mixer of visuals.propMixers) mixer.update(dt);
    }
    let debugShot = false;
    input.setMenuOpen(options.open);
    input.update(dt);
    const sample = input.sample();
    const render = client.renderSnapshot();
    const ownedId = client.ownedEntity;
    const owned = ownedId === undefined ? undefined : render.entities.find((entity) => entity.id === ownedId);
    wantInfo = sample.info;
    probeOwnedId = ownedId;
    probeOwn = owned ? { x: owned.position.x, y: owned.position.y, z: owned.position.z } : undefined;
    probePawns = render.entities;
    if (owned && ownedId !== aimedPawn) {
      input.setYaw(yawFromQuat(owned.rotation));
      aimedPawn = ownedId;
    }
    if (owned && ownedId !== undefined) {
      const pawn = { x: owned.position.x, y: owned.position.y, z: owned.position.z };
      let shotFrom: { x: number; y: number; z: number } | undefined;
      let shotTo: { x: number; y: number; z: number } | undefined;
      const clock = advanceFireClock(sample.firing, now, nextFireAt);
      nextFireAt = clock.nextAt;
      const thrown = advanceGrenadeClock(sample.grenade, now, nextGrenadeAt);
      nextGrenadeAt = thrown.nextAt;
      const ownDead = pawnVital.get(ownedId)?.dead === true;
      if (thrown.due) {
        const seq = grenadeSeq + 1;
        if (link.sendGrenade(seq, sample.yaw, sample.pitch)) {
          grenadeSeq = seq;
          // The host admits on the same interval and drops a dead thrower.
          if (!ownDead && sfx.play("grenadeLaunch")) ownGrenadeEcho.noteLocal(now);
        }
      }
      const atDoor = overlapsDoor(pawn);
      if ((sample.using && !sample.cabConfirm) || (sample.cabConfirm && atDoor)) {
        const seq = useSeq + 1;
        if (link.sendUse(seq)) useSeq = seq;
      }
      if (sample.cabNav !== 0) {
        const cab = cabAt(pawn);
        if (cab) {
          const current = cabPick.get(cab.def.id) ?? cab.rt.at;
          cabPick.set(cab.def.id, stepStop(current, sample.cabNav, cab.def.stops.length));
        }
      }
      if (sample.digit) {
        const call = elevatorCall(pawn, sample.digit);
        if (call && link.sendElevator(call.id, call.stop) && call.inCab) cabPick.set(call.id, call.stop);
      }
      if (sample.cabConfirm && !atDoor) {
        const cab = cabAt(pawn);
        if (cab) {
          const pick = cabPick.get(cab.def.id);
          if (pick !== undefined) link.sendElevator(cab.def.id, pick);
        } else {
          const call = elevatorCall(pawn, { landing: true });
          if (call) link.sendElevator(call.id, call.stop);
        }
      }
      if (sample.callLanding) {
        const call = elevatorCall(pawn, { landing: true });
        if (call) link.sendElevator(call.id, call.stop);
      }
      if (clock.due) {
        pendingFireLog = {
          socketClosed: link.socketClosed(),
          camBefore: { x: arena.camera.position.x, y: arena.camera.position.y, z: arena.camera.position.z },
        };
        const seq = fireSeq + 1;
        const sent = link.sendFire(seq, sample.yaw, sample.pitch);
        hitMarker.note({ kind: "fire", sent }, now);
        if (sent) {
          fireSeq = seq;
          if (!ownDead && sfx.play("laser")) ownLaserEcho.noteLocal(now);
          if (options.fireDebug) {
            fireDebug.frameSent(seq, sample.yaw, sample.pitch);
            awaitFireReply = true;
            loggedFireSnap = false;
            debugShot = true;
            debugPawnWatch = true;
            debugPawn = ownedId;
          }
          const aim = eyeLook(pawn, sample.yaw, sample.pitch);
          const predicted = traceHitscan(
            aim.position,
            aimDirection(sample.yaw, sample.pitch),
            [...view.aabbs, ...shutLeafBoxes()],
            shotCapsules(render.entities, ownedId, view.pawnRadius, view.pawnHeight),
          );
          shotFrom = predicted.from;
          shotTo = predicted.to;
        } else if (options.fireDebug) {
          fireDebug.pawn(ownedId);
          fireDebug.socket(link.socketState());
        }
      }
      if (!arena.cameraLocked) {
        presentShot({
          camera: arena.camera,
          pawn,
          yaw: sample.yaw,
          pitch: sample.pitch,
          from: shotFrom,
          to: shotTo,
          show(from, to) {
            lasers.show(ownedId, from, to, now + LASER_MS);
          },
        });
      }
      if (debugShot) {
        const camera = arena.camera.position;
        fireDebug.camera({ x: camera.x, y: camera.y, z: camera.z });
        fireDebug.pawn(ownedId);
        fireDebug.socket(link.socketState());
        sawFiniteCamera = Number.isFinite(camera.x) && Number.isFinite(camera.y) && Number.isFinite(camera.z);
      }
    }
    for (const laser of laserQueue) {
      hitMarker.note({ kind: "laser", shooter: laser.shooter, ownedId }, now);
      if (laser.shooter !== ownedId) sfx.play("laser", laser.from);
      else if (ownLaserEcho.echo(now)) sfx.play("laser");
      // A miss ends at TRACE_RANGE. Anything shorter hit a box or a pawn.
      const lx = laser.to.x - laser.from.x;
      const ly = laser.to.y - laser.from.y;
      const lz = laser.to.z - laser.from.z;
      if (lx * lx + ly * ly + lz * lz < (TRACE_RANGE - 0.01) ** 2) {
        explosions.spawn(laser.to.x, laser.to.y, laser.to.z, laserImpactSize, LASER_IMPACT_FPS);
      }
      const remain = laser.until - Date.now();
      if (!(remain > 0)) continue;
      lasers.show(laser.shooter, laser.from, laser.to, now + remain);
    }
    laserQueue.length = 0;
    lasers.expire(now);
    for (const pose of grenadeQueue) {
      const event = grenades.place(pose, now);
      if (event === "stop") {
        // The stop point is on a surface, usually the floor. Lift the centre so the
        // fireball is not half under the ground.
        explosions.spawn(pose.x, pose.y + explosions.size * GRENADE_BLAST_LIFT, pose.z);
        sfx.play("grenadeBlast", pose);
      } else if (event === "launch") {
        // Poses carry no owner. A launch at your own eye while a local throw waits is yours.
        const mine = owned !== undefined
          && Math.hypot(pose.x - owned.position.x, pose.y - (owned.position.y + EYE_HEIGHT), pose.z - owned.position.z) < OWN_GRENADE_RADIUS;
        if (!mine) sfx.play("grenadeLaunch", pose);
        else if (ownGrenadeEcho.echo(now)) sfx.play("grenadeLaunch");
      }
    }
    grenadeQueue.length = 0;
    grenades.expire(now);
    explosions.update(frozen ? 0 : dt);
    pickupSounds.update(performance.now());
    doorSounds.update(performance.now());
    {
      // Listener is the camera: position, forward (-Z), up (+Y) from its world matrix.
      const m = arena.camera.matrixWorld.elements;
      sfx.setListener(m[12]!, m[13]!, m[14]!, -m[8]!, -m[9]!, -m[10]!, m[4]!, m[5]!, m[6]!);
    }
    fxNow = performance.now();
    characterFx?.update(fxNow);
    beamSheets.spawn?.fx.update(frozen ? 0 : dt);
    beamSheets.despawn?.fx.update(frozen ? 0 : dt);
    pawns.apply(render, frozen ? 0 : dt, (id) => client.authoritative(id)?.action, ownedId, !frozen, fadeOf);
    sendAcc += dt;
    if (sendAcc >= sendDt) {
      sendAcc = Math.min(sendAcc - sendDt, sendDt);
      const move = moveIntent(sample.yaw, sample.forward, sample.strafe);
      // predictOwned stays false, so this send is the only client move. The host
      // integrates it with the same noclip step when the switch is on.
      const fly = view.noclip === true && options.showNoclip;
      link.sendInput(move.moveX, move.moveZ, sample.yaw, fly ? encodeMoveButtons(true, sample.ascend) : 0);
    }
    if (!debugShot && debugPawnWatch && options.fireDebug && client.ownedEntity !== debugPawn) {
      const camera = arena.camera.position;
      fireDebug.camera({ x: camera.x, y: camera.y, z: camera.z });
      fireDebug.pawn(client.ownedEntity);
      fireDebug.socket(link.socketState());
      debugPawn = client.ownedEntity;
    }
    const camNow = arena.camera.position;
    const camOk = Number.isFinite(camNow.x) && Number.isFinite(camNow.y) && Number.isFinite(camNow.z);
    if (options.fireDebug && sawFiniteCamera && !camOk) {
      fireDebug.camera({ x: camNow.x, y: camNow.y, z: camNow.z });
      fireDebug.pawn(client.ownedEntity);
      fireDebug.socket(link.socketState());
    }
    sawFiniteCamera = camOk;
    elevatorRooms.tick(
      now,
      owned ? { x: owned.position.x, y: owned.position.y, z: owned.position.z } : undefined,
    );
    const look = input.locked ? "look locked" : "click to look";
    const mine = ownedId === undefined ? undefined : pawnVital.get(ownedId);
    const hpLabel = localHealthLabel(mine);
    const hpText = hpLabel === "" ? "" : ` · ${hpLabel}`;
    const liftText = owned ? liftLabel(owned.position) : "";
    sceneMap.setSelf(
      owned ? { x: owned.position.x, y: owned.position.y, z: owned.position.z, yaw: yawFromQuat(owned.rotation) } : undefined,
      view.elevators,
    );
    hud.setStatus(presentFaultHud(
      `${statusText} · ${look}${hpText} · meshes ${pawns.count} models ${pawns.count - pawns.fallbacks} fallback ${pawns.fallbacks + visuals.fallbacks}${liftText}`,
      consoleHint,
    ));
    hud.setProfile(input.profile);
    hud.setPad(input.padStatus, input.profile);
    if (followId !== undefined) placeFollow();
    arena.renderer.render(arena.scene, arena.camera);
    const info = arena.renderer.info;
    const calls = info.render.calls;
    const tris = info.render.triangles;
    const geoms = info.memory.geometries;
    const tex = info.memory.textures;
    if (!info.autoReset) info.reset();
    const snaps = client.metrics.snapshotReceive;
    const snapTick = snaps === 0 ? undefined : Number(render.serverTick);
    const sampleRates = rates.push(now, snaps !== seenSnaps ? snapTick : undefined);
    seenSnaps = snaps;
    if (hud.statsVisible) {
      hud.setStats(formatOverlay({
        fps: sampleRates.fps,
        tickPerSec: sampleRates.tickPerSec,
        tick: snapTick,
        snaps,
        resyncs,
        seq: snaps === 0 ? undefined : render.snapshotSeq,
        calls,
        tris: Math.round(tris),
        geoms,
        tex,
        shadows: arena.renderer.shadowMap.enabled ? "on" : "off",
        shadowMap: arena.renderer.shadowMap.type,
        tone: arena.renderer.toneMapping,
        exposure: arena.renderer.toneMappingExposure,
        pawns: pawns.count,
        owned: client.ownedEntity,
        positions: pawns.positionLine(),
        hp: mine?.hp,
      }));
    }
  }
  if (qa) {
    installQaApi({
      scene: arena,
      net: { firstSnapshot },
      render() {
        arena.renderer.render(arena.scene, arena.camera);
      },
      freeze() {
        frozen = true;
      },
      follow(entityId, opts) {
        followId = entityId;
        followBack = opts.back;
        followUp = opts.up;
        placeFollow();
      },
      clearFollow() {
        followId = undefined;
      },
      doors() {
        return [...doorOpen.entries()]
          .map(([id, open]) => ({ id, open }))
          .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      },
      pickups() {
        return (view.pickups ?? [])
          .filter((pickup) => !visuals.placements.hidden(pickup.id))
          .map((pickup) => ({ id: pickup.id }))
          .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      },
      pawns() {
        return client.renderSnapshot().entities.flatMap((entity) => {
          const id = Number(entity.id);
          if (!Number.isFinite(id)) return [];
          return [{
            id,
            x: entity.position.x,
            y: entity.position.y,
            z: entity.position.z,
            yaw: yawFromQuat(entity.rotation),
          }];
        });
      },
      token: loadKey() ?? "",
    });
  }
  requestAnimationFrame(frame);

  function createCabMeshes(elevators: readonly ArenaElevator[], scene: THREE.Scene): { group: THREE.Group; meshes: Map<string, THREE.Mesh> } {
    const group = new THREE.Group();
    group.name = "cab-debug";
    group.visible = false;
    scene.add(group);
    const meshes = new Map<string, THREE.Mesh>();
    for (const def of elevators) {
      const bounds = elevatorPolygonBounds(def.polygon);
      const width = bounds.maxX - bounds.minX;
      const depth = bounds.maxZ - bounds.minZ;
      if (!(width > 0) || !(depth > 0)) continue;
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(width, CAB_BOX_H, depth),
        new THREE.MeshStandardMaterial({ color: 0xb7b1a6, roughness: 0.8 }),
      );
      const y = def.stops[0] ?? 0;
      mesh.position.set((bounds.minX + bounds.maxX) / 2, y + 0.02 - CAB_BOX_H / 2, (bounds.minZ + bounds.maxZ) / 2);
      mesh.name = def.id;
      // A bound room is the cab. Its footprint shows only with collision debug.
      // An unbound shaft keeps the 16a box in normal play.
      if (def.room) group.add(mesh);
      else scene.add(mesh);
      meshes.set(def.id, mesh);
    }
    return { group, meshes };
  }

  function applyCab(row: ElevatorState): void {
    cabState.set(row.id, row);
    const mesh = cabDebug.meshes.get(row.id);
    if (mesh) mesh.position.y = row.y + 0.02 - CAB_BOX_H / 2;
    elevatorRooms.onCab(row);
    if (cabPick.get(row.id) === row.stop && row.doorsOpen) cabPick.delete(row.id);
  }

  function probeCabs(): CabState[] {
    return (view.elevators ?? []).map((def) => {
      const rt = cabRuntime(def);
      return {
        id: rt.id,
        at: rt.at,
        phase: rt.phase,
        y: rt.y,
        ...(rt.target !== undefined ? { target: rt.target } : {}),
      };
    });
  }

  function cabRuntime(def: ArenaElevator): ElevatorRuntime {
    const state = cabState.get(def.id);
    const at = state?.stop ?? 0;
    return {
      id: def.id,
      at,
      queue: [],
      phase: state?.doorsOpen === false ? "moving" : "idle",
      t: 0,
      y: state?.y ?? def.stops[at] ?? def.stops[0] ?? 0,
    };
  }

  function cabAt(pawn: { x: number; y: number; z: number }): { def: ArenaElevator; rt: ElevatorRuntime } | undefined {
    for (const def of view.elevators ?? []) {
      const rt = cabRuntime(def);
      if (inCab(def, rt, pawn.x, pawn.y, pawn.z)) return { def, rt };
    }
    return undefined;
  }

  function overlapsDoor(pawn: { x: number; y: number; z: number }): boolean {
    const doors = (view.doors ?? []).map((door) => ({
      id: door.id,
      hinge: door.hinge,
      open: doorOpen.get(door.id) === true,
      locked: door.locked === true,
      key: door.key,
      position: door.position,
      size: door.size,
      yaw: door.yaw,
    }));
    return pickDoorForUse(doors, {
      id: 0,
      x: pawn.x,
      y: pawn.y,
      z: pawn.z,
      radius: view.pawnRadius,
      height: view.pawnHeight,
      alive: true,
    }) !== undefined;
  }

  function elevatorCall(
    pawn: { x: number; y: number; z: number },
    request: string | { stop?: number; landing?: boolean },
  ): { id: string; stop: number; inCab: boolean } | undefined {
    const digit = typeof request === "string" ? request : undefined;
    const landingOnly = typeof request !== "string" && request.landing === true;
    const explicit = typeof request !== "string" && typeof request.stop === "number" ? request.stop : undefined;
    const elevators = view.elevators ?? [];
    if (!landingOnly) {
      for (const def of elevators) {
        if (!inCab(def, cabRuntime(def), pawn.x, pawn.y, pawn.z)) continue;
        const stop = explicit !== undefined
          ? (explicit >= 0 && explicit < def.stops.length ? explicit : undefined)
          : (digit ? stopForKey(digit, def.stops.length) : undefined);
        if (stop === undefined) return undefined;
        return { id: def.id, stop, inCab: true };
      }
    }
    if (landingOnly || digit) {
      for (const def of elevators) {
        const stop = landingAt(def, pawn.x, pawn.y, pawn.z);
        if (stop === undefined) continue;
        return { id: def.id, stop, inCab: false };
      }
    }
    return undefined;
  }

  function liftLabel(pawn: { x: number; y: number; z: number }): string {
    for (const def of view.elevators ?? []) {
      const rt = cabRuntime(def);
      if (!inCab(def, rt, pawn.x, pawn.y, pawn.z)) continue;
      const at = rt.at + 1;
      const picked = cabPick.get(def.id);
      if (picked !== undefined && picked !== rt.at) return ` · lift ${at}→${picked + 1}`;
      return ` · lift ${at}`;
    }
    return "";
  }

  function shutLeafBoxes(): Array<{ id: number; minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number }> {
    const out: Array<{ id: number; minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number }> = [];
    (view.doors ?? []).forEach((door, index) => {
      if (doorOpen.get(door.id)) return;
      out.push({ id: -1 - index, ...doorLeafBox(door) });
    });
    return out;
  }

  function swingDoor(id: string, open: boolean): void {
    doorOpen.set(id, open);
    const rig = visuals.doors.get(id);
    if (!rig) return;
    const swing = view.doorSwing;
    applyDoorSwing(rig.group, rig.hinge, open, true, swing ? (open ? swing.openMs : swing.closeMs) / 1000 : undefined);
  }

  /** The eye sits inside the shooter's capsule, so that pawn is not a target. */
  function shotCapsules(
    entities: ReadonlyArray<{ id: unknown; position: { x: number; y: number; z: number }; lifecycle?: string }>,
    shooter: number,
    radius: number,
    height: number,
  ): TraceCapsule[] {
    if (!(radius > 0) || !Number.isFinite(height)) return [];
    const out: TraceCapsule[] = [];
    for (const entity of entities) {
      const id = Number(entity.id);
      if (!Number.isFinite(id) || id === shooter || entity.lifecycle === "despawned") continue;
      out.push({ id, x: entity.position.x, y: entity.position.y, z: entity.position.z, radius, height });
    }
    return out;
  }
}
