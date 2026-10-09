import { EngineClient } from "conveyor-engine-client";
import type { ArenaView } from "../shared/arena-view.js";
import { aimDirection, eyeLook, INPUT_HZ, moveIntent, yawFromQuat } from "../shared/look.js";
import { clientFaultText, createFireDebugLog } from "../shared/fire-debug.js";
import { advanceFireClock, LASER_MS, traceHitscan, type TraceCapsule } from "../shared/hitscan.js";
import { createAabbDebug } from "./aabb-debug.js";
import { createArenaScene, loadArenaVisuals } from "./arena-scene.js";
import { createHud } from "./hud.js";
import { attachPlayInput } from "./input.js";
import { createLaserBeams } from "./laser.js";
import { connectLive, type LaserNotice } from "./net.js";
import { createOptionsDialog } from "./options.js";
import { createPawnLayer } from "./presentation.js";
import { createRateWindow, formatOverlay } from "./rates.js";
import { formatFireLog, presentShot } from "./shot-view.js";

const view = await fetch("/arena.json").then((res) => {
  if (!res.ok) throw new Error("arena.json " + res.status);
  return res.json() as Promise<ArenaView>;
});

const hud = createHud();
hud.setStatus("loading arena");
const arena = createArenaScene(view.shadows?.quality ?? "off");
const collisionDebug = createAabbDebug(view.aabbs);
arena.scene.add(collisionDebug.group);
const options = createOptionsDialog((on) => collisionDebug.setVisible(on));
const fireDebug = createFireDebugLog(() => options.fireDebug);
const visuals = await loadArenaVisuals(view, arena);
const pawns = createPawnLayer(arena.content, visuals.templates, view.pawnHeight);
const input = attachPlayInput(arena.renderer.domElement, undefined, () => {
  fireDebug.keydown();
});
hud.onProfileToggle(() => input.toggleProfile());
hud.setProfile(input.profile);
const lasers = createLaserBeams(arena.scene);
const client = new EngineClient(1, { delayMs: 80, extraMs: 0, predictOwned: false });
let statusText = "connecting";
let aimedPawn: number | undefined;
let fireSeq = 0;
let nextFireAt = 0;
let pinnedError: string | undefined;
let pendingFireLog: { socketClosed: boolean; camBefore: { x: number; y: number; z: number } } | undefined;
let awaitFireReply = false;
let loggedFireSnap = false;
let debugPawn: number | undefined;
let debugPawnWatch = false;
let sawFiniteCamera = true;
const laserQueue: LaserNotice[] = [];

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
  onApplied: () => {},
  onLaser: (laser) => {
    laserQueue.push(laser);
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
    if (summary.startsWith("snapshot") && !loggedFireSnap) {
      fireDebug.frameReceived(summary);
      loggedFireSnap = true;
    }
  },
  onFault(err) {
    pinnedError = clientFaultText(err);
    fireDebug.thrown("socket", err);
    hud.setStatus(`frame error ${pinnedError}`);
  },
});

let last = performance.now();
let sendAcc = 0;
let seenSnaps = 0;
let resyncs = 0;
const rates = createRateWindow(500);
const sendDt = 1 / INPUT_HZ;
function frame(now: number) {
  let threw = false;
  try {
    drawFrame(now);
  } catch (err) {
    threw = true;
    pinnedError = clientFaultText(err);
    console.error(err);
    console.error("frame threw", pinnedError);
    fireDebug.thrown("frame", err);
    const camera = arena.camera.position;
    fireDebug.camera({ x: camera.x, y: camera.y, z: camera.z });
    fireDebug.pawn(client.ownedEntity);
    fireDebug.socket(link.socketState());
    hud.setStatus(`frame error ${pinnedError}`);
    laserQueue.length = 0;
    lasers.drop();
    try {
      arena.renderer.render(arena.scene, arena.camera);
    } catch (renderErr) {
      console.error(renderErr);
    }
  }
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
  if (pinnedError) hud.setStatus(`frame error ${pinnedError}`);
  requestAnimationFrame(frame);
}
function drawFrame(now: number) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  let debugShot = false;
  input.update(dt);
  const sample = input.sample();
  const render = client.renderSnapshot();
  const ownedId = client.ownedEntity;
  const owned = ownedId === undefined ? undefined : render.entities.find((entity) => entity.id === ownedId);
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
    if (clock.due) {
      pendingFireLog = {
        socketClosed: link.socketClosed(),
        camBefore: { x: arena.camera.position.x, y: arena.camera.position.y, z: arena.camera.position.z },
      };
      const seq = fireSeq + 1;
      if (link.sendFire(seq, sample.yaw, sample.pitch)) {
        fireSeq = seq;
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
          view.aabbs,
          shotCapsules(render.entities, ownedId, view.pawnRadius, view.pawnHeight),
        );
        shotFrom = predicted.from;
        shotTo = predicted.to;
      } else if (options.fireDebug) {
        fireDebug.pawn(ownedId);
        fireDebug.socket(link.socketState());
      }
    }
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
    if (debugShot) {
      const camera = arena.camera.position;
      fireDebug.camera({ x: camera.x, y: camera.y, z: camera.z });
      fireDebug.pawn(ownedId);
      fireDebug.socket(link.socketState());
      sawFiniteCamera = Number.isFinite(camera.x) && Number.isFinite(camera.y) && Number.isFinite(camera.z);
    }
  }
  for (const laser of laserQueue) {
    const remain = laser.until - Date.now();
    if (!(remain > 0)) continue;
    lasers.show(laser.shooter, laser.from, laser.to, now + remain);
  }
  laserQueue.length = 0;
  lasers.expire(now);
  pawns.apply(render, dt, (id) => client.authoritative(id)?.action, ownedId);
  sendAcc += dt;
  if (sendAcc >= sendDt) {
    sendAcc = Math.min(sendAcc - sendDt, sendDt);
    const move = moveIntent(sample.yaw, sample.forward, sample.strafe);
    link.sendInput(move.moveX, move.moveZ, sample.yaw);
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
  const look = input.locked ? "look locked" : "click to look";
  if (!pinnedError) {
    hud.setStatus(`${statusText} · ${look} · meshes ${pawns.count} models ${pawns.count - pawns.fallbacks} fallback ${pawns.fallbacks + visuals.fallbacks}`);
  }
  hud.setProfile(input.profile);
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
    }));
  }
}
requestAnimationFrame(frame);

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
