import { EngineClient } from "conveyor-engine-client";
import type { ArenaView } from "../shared/arena-view.js";
import { eyeLook, INPUT_HZ, moveIntent, yawFromQuat } from "../shared/look.js";
import { createArenaScene, loadArenaVisuals } from "./arena-scene.js";
import { createHud } from "./hud.js";
import { attachPlayInput } from "./input.js";
import { connectLive } from "./net.js";
import { createPawnLayer } from "./presentation.js";

const view = await fetch("/arena.json").then((res) => {
  if (!res.ok) throw new Error("arena.json " + res.status);
  return res.json() as Promise<ArenaView>;
});

const hud = createHud();
hud.setStatus("loading arena");
const arena = createArenaScene(view.shadows.quality);
const visuals = await loadArenaVisuals(view, arena);
const pawns = createPawnLayer(arena.content, visuals.templates, view.pawnHeight);
const input = attachPlayInput(arena.renderer.domElement);
hud.onProfileToggle(() => input.toggleProfile());
hud.setProfile(input.profile);
const client = new EngineClient(1, { delayMs: 80, extraMs: 0, predictOwned: false });
let statusText = "connecting";
let aimedPawn: number | undefined;

const link = connectLive({
  bundleId: view.bundleId,
  authoritativeHash: view.authoritativeHash,
  world: view.world,
  client,
  onStatus: (status) => {
    statusText = status.text;
  },
  onApplied: () => {},
});

let last = performance.now();
let sendAcc = 0;
const sendDt = 1 / INPUT_HZ;
function frame(now: number) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  input.update(dt);
  const sample = input.sample();
  const render = client.renderSnapshot();
  const ownedId = client.ownedEntity;
  const owned = ownedId === undefined ? undefined : render.entities.find((entity) => entity.id === ownedId);
  if (owned && ownedId !== aimedPawn) {
    input.setYaw(yawFromQuat(owned.rotation));
    aimedPawn = ownedId;
  }
  if (owned) {
    const aim = eyeLook(owned.position, sample.yaw, sample.pitch);
    arena.camera.position.set(aim.position.x, aim.position.y, aim.position.z);
    arena.camera.up.set(0, 1, 0);
    arena.camera.lookAt(aim.target.x, aim.target.y, aim.target.z);
  }
  pawns.apply(render, dt, (id) => client.authoritative(id)?.action, ownedId);
  sendAcc += dt;
  if (sendAcc >= sendDt) {
    sendAcc = Math.min(sendAcc - sendDt, sendDt);
    const move = moveIntent(sample.yaw, sample.forward, sample.strafe);
    link.sendInput(move.moveX, move.moveZ, sample.yaw);
  }
  const look = input.locked ? "look locked" : "click to look";
  hud.setStatus(`${statusText} · ${look} · meshes ${pawns.count} models ${pawns.count - pawns.fallbacks} fallback ${pawns.fallbacks + visuals.fallbacks}`);
  hud.setProfile(input.profile);
  arena.renderer.render(arena.scene, arena.camera);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
