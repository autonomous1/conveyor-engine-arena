import { EngineClient } from "conveyor-engine-client";
import type { ArenaView } from "../shared/arena-view.js";
import { createArenaScene, loadArenaVisuals } from "./arena-scene.js";
import { createHud } from "./hud.js";
import { attachCameraControls } from "./input.js";
import { connectLive } from "./net.js";
import { createPawnLayer } from "./presentation.js";

const view = await fetch("/arena.json").then((res) => {
  if (!res.ok) throw new Error("arena.json " + res.status);
  return res.json() as Promise<ArenaView>;
});

const hud = createHud();
hud.set("loading arena");
const arena = createArenaScene(view.shadows.quality);
const visuals = await loadArenaVisuals(view, arena);
const pawns = createPawnLayer(arena.content, visuals.templates, view.pawnHeight);
const controls = attachCameraControls(arena.camera, arena.renderer);
const client = new EngineClient(1, { delayMs: 80, extraMs: 0, predictOwned: false });

connectLive({
  bundleId: view.bundleId,
  authoritativeHash: view.authoritativeHash,
  world: view.world,
  client,
  onStatus: (status) => hud.set(`${status.text} · meshes ${pawns.count} models ${pawns.count - pawns.fallbacks} fallback ${pawns.fallbacks + visuals.fallbacks}`),
  onApplied: () => {},
});

let last = performance.now();
function frame(now: number) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  pawns.apply(client.renderSnapshot(), dt, (id) => client.authoritative(id)?.action);
  controls.update(dt);
  arena.renderer.render(arena.scene, arena.camera);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
