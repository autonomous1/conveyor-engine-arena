// ARCHITECTURE: The pawn layer: cloned characters, fallback capsules, clip
//   application, and fade/beam opacities.
// Wiring: boot.ts calls `apply` each frame; arena-scene.ts supplies templates.
import * as THREE from "three";
import { clone as cloneWithSkeleton } from "three/addons/utils/SkeletonUtils.js";
import type { RenderSnapshot } from "conveyor-engine-client";
import type { CharacterTemplates, CharacterVisual } from "./arena-scene.js";
import { findClip, MOVE_IDLE, MOVEMENTS } from "../shared/movements.ts";
import { lowerRootToFeet, skinnedSoleGap } from "./pawn-feet.ts";
import { clipTimeScale, freshGroundSpeed, noteGroundSpeed, noteVelocitySpeed, pickLocomotion, type ClipRate, type GroundSpeed } from "../shared/anim-speed.ts";

/**
 * @post Fall holds its last frame; every other gait repeats.
 */
export function configureClip(action: THREE.AnimationAction, movement: string): void {
  if (movement === "fall") {
    action.setLoop(THREE.LoopOnce, 1);
    action.clampWhenFinished = true;
    return;
  }
  action.setLoop(THREE.LoopRepeat, Infinity);
  action.clampWhenFinished = false;
}

type Pawn = {
  root: THREE.Object3D;
  px: number;
  pz: number;
  fallback: boolean;
  mixer?: THREE.AnimationMixer;
  action?: THREE.AnimationAction;
  movement?: string;
  clips: Map<string, THREE.AnimationClip>;
  assetKey?: string;
  /** Fall root-motion bone. Its Y is not driven by the mixer. */
  motionBone?: THREE.Object3D;
  restRootY?: number;
  planted: boolean;
  /** Per-movement playback fields from the asset. Only `referenceSpeed` entries retime. */
  rates: Map<string, ClipRate>;
  /** Asset scale applied to the model. */
  scale: number;
  /** Smoothed rendered horizontal speed, m/s. */
  ground: GroundSpeed;
  /** Set only while the pawn is translucent: its meshes carry private material clones. */
  faded?: FadedMaterials;
};

/** One mesh's own material clones while it fades. `original` goes back when the fade ends. */
type FadedMaterials = {
  entries: Array<{ mesh: THREE.Mesh; original: THREE.Material | THREE.Material[]; clones: THREE.Material[] }>;
  opacity: number;
};

/**
 * Fade a pawn without making every character translucent for good. Meshes of one model share
 * their materials with every other instance of it, so a fade gives this pawn's meshes private
 * clones (textures stay shared, so nothing is re-uploaded), sets `transparent` and `opacity` on
 * them, and puts the shared originals back at opacity 1. Cost: one material clone per material
 * for the fade's length, and one extra shader variant per material type the first time (the
 * `transparent` flag selects a program). Nothing is allocated per frame.
 */
function setPawnOpacity(pawn: Pawn, opacity: number): void {
  // Plain or hidden: shared materials, no clones.
  if (opacity >= 1 || !(opacity > 0)) {
    restoreMaterials(pawn);
    return;
  }
  if (!pawn.faded) {
    const faded: FadedMaterials = { entries: [], opacity: 1 };
    pawn.root.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh || !mesh.material) return;
      const original = mesh.material;
      const clones = (Array.isArray(original) ? original : [original]).map((material) => {
        const clone = material.clone();
        clone.transparent = true;
        return clone;
      });
      mesh.material = Array.isArray(original) ? clones : clones[0]!;
      faded.entries.push({ mesh, original, clones });
    });
    pawn.faded = faded;
  }
  const faded = pawn.faded;
  if (faded.opacity === opacity) return;
  faded.opacity = opacity;
  for (const entry of faded.entries) for (const clone of entry.clones) clone.opacity = opacity;
}

function restoreMaterials(pawn: Pawn): void {
  const faded = pawn.faded;
  if (!faded) return;
  pawn.faded = undefined;
  for (const entry of faded.entries) {
    entry.mesh.material = entry.original;
    for (const clone of entry.clones) clone.dispose();
  }
}

function motionBoneOf(model: THREE.Object3D, clips: Map<string, THREE.AnimationClip>): THREE.Object3D | undefined {
  const track = clips.get("fall")?.tracks.find((item) => item.name.endsWith(".position[x]"));
  if (!track) return undefined;
  const name = track.name.slice(0, -".position[x]".length);
  return model.getObjectByName(name) ?? undefined;
}

/**
 * Cloned characters under `parent`, or a capsule when the asset is missing.
 * @post The owned pawn stays hidden.
 */
export interface PawnLayer {
  /**
   * Once per frame. Snapshot pose and clip (`movementOf` is called, its result unused).
   * Hides the owned pawn. Removes missing ids, frees a fallback's geometry and material and any fade clones, and writes `__pawnAnim`.
   */
  apply(
    render: RenderSnapshot,
    dt: number,
    movementOf: (id: number) => string | undefined,
    ownedId?: number,
    stepMixers?: boolean,
    /** 1 plain, 0 hidden, between faded. Absent: every pawn plain. */
    opacityOf?: (id: number) => number,
  ): void;
  /** Ids in the layer, including the hidden owned pawn. */
  readonly count: number;
  /** Pawns holding private material clones for a fade right now. */
  readonly fading: number;
  /** Pawns drawn as a capsule because the asset was missing. */
  readonly fallbacks: number;
  /** Presentation xz, lowest id first, labeled A, B, C. New string. */
  positionLine(): string;
}

export function createPawnLayer(parent: THREE.Object3D, templates: CharacterTemplates, pawnHeight: number): PawnLayer {
  const pawns = new Map<number, Pawn>();

  function capsule(id: number): THREE.Mesh {
    const mesh = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.35, Math.max(0.4, pawnHeight - 0.7), 4, 8),
      new THREE.MeshStandardMaterial({ color: id % 2 ? 0xe07a3d : 0x4aa3ff, roughness: 0.45 }),
    );
    mesh.position.y = pawnHeight / 2;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.ownedGeometry = true;
    return mesh;
  }

  function clipMap(visual: CharacterVisual): Map<string, THREE.AnimationClip> {
    const mapped = new Map<string, THREE.AnimationClip>();
    for (const movement of MOVEMENTS) {
      const clip = findClip(visual.clips, visual.animations[movement].clip);
      if (clip) mapped.set(movement, clip);
    }
    return mapped;
  }

  function play(pawn: Pawn, movement: string): void {
    if (!pawn.mixer || pawn.movement === movement) return;
    const clip = pawn.clips.get(movement);
    // TODO spammy log
    //console.log("id:", pawn.assetKey, "movement:", movement, "clip:", clip?.name);
    if (!clip) return;
    const next = pawn.mixer.clipAction(clip);
    if (next === pawn.action) {
      // Two movements name the same clip (e.g. idle and run both "zombie run").
      // Keep it playing; fading it out here would fade the action just faded in.
      configureClip(next, movement);
      pawn.movement = movement;
      return;
    }
    next.reset();
    configureClip(next, movement);
    next.fadeIn(0.15).play();
    pawn.action?.fadeOut(0.15);
    pawn.action = next;
    pawn.movement = movement;
  }

  function locomotionFor(pawn: Pawn, movement: string, groundSpeed: number): string {
    if (movement !== "walk" && movement !== "run") return movement;
    const walk = pawn.rates.get("walk")?.referenceSpeed;
    const run = pawn.rates.get("run")?.referenceSpeed;
    // The host keeps "walk" on a pawn pushed against a wall: its velocity is 0 but the
    // label is the wished gait. A measured clip would crawl in place at minTimeScale.
    if (groundSpeed <= MOVE_IDLE && pawn.rates.get(movement)?.referenceSpeed !== undefined && pawn.clips.has("idle")) return "idle";
    if (walk === undefined || run === undefined || !pawn.clips.has("run") || !pawn.clips.has("walk")) return movement;
    const current = pawn.movement === "walk" || pawn.movement === "run" ? pawn.movement : undefined;
    return pickLocomotion(current, groundSpeed, walk * pawn.scale, run * pawn.scale);
  }

  function release(pawn: Pawn): void {
    restoreMaterials(pawn);
    parent.remove(pawn.root);
    if (!pawn.fallback) return;
    pawn.root.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (mesh.userData.ownedGeometry) {
        mesh.geometry?.dispose();
        const material = mesh.material;
        if (material && !Array.isArray(material)) material.dispose();
      }
    });
  }

  function ensure(id: number, assetKey: string | undefined): Pawn {
    const existing = pawns.get(id);
    if (existing) {
      if (existing.assetKey === assetKey) return existing;
      release(existing);
      pawns.delete(id);
    }
    const visual = assetKey ? templates.get(assetKey) : undefined;
    const root = new THREE.Group();
    let fallback = false;
    let mixer: THREE.AnimationMixer | undefined;
    let clips = new Map<string, THREE.AnimationClip>();
    // Object3D.clone shares the source skeleton, so a skinned mesh keeps the
    // unloaded template's bones and draws at the world origin.
    let motionBone: THREE.Object3D | undefined;
    let restRootY: number | undefined;
    const rates = new Map<string, ClipRate>();
    if (visual) {
      for (const movement of MOVEMENTS) {
        const entry = visual.animations[movement];
        if (entry?.referenceSpeed !== undefined) rates.set(movement, entry);
      }
      const model = cloneWithSkeleton(visual.object);
      root.add(model);
      mixer = new THREE.AnimationMixer(model);
      clips = clipMap(visual);
      motionBone = motionBoneOf(model, clips);
      restRootY = motionBone?.position.y;
    } else {
      fallback = true;
      root.add(capsule(id));
    }
    parent.add(root);
    const pawn: Pawn = {
      root, px: 0, pz: 0, fallback, mixer, clips, assetKey, motionBone, restRootY, planted: false,
      rates, scale: visual?.scale ?? 1, ground: freshGroundSpeed(),
    };
    pawns.set(id, pawn);
    return pawn;
  }

  const order: number[] = [];
  const byId = (a: number, b: number) => a - b;

  return {
    /**
     * Positions and facing come only from the render snapshot. The owned pawn
     * is hidden so the first-person camera is not inside the mesh.
     */
    apply(
      render: RenderSnapshot,
      dt: number,
      movementOf: (id: number) => string | undefined,
      ownedId?: number,
      stepMixers = true,
      /** 1: plain, 0: hidden, between: faded. Absent: every pawn plain. */
      opacityOf?: (id: number) => number,
    ) {
      const seen = new Set<number>();
      for (const entity of render.entities) {
        const id = Number(entity.id);
        if (!Number.isFinite(id)) continue;
        seen.add(id);
        const pawn = ensure(id, entity.render?.assetKey);
        const named = movementOf(id);
        //let movement = named && (MOVEMENTS as readonly string[]).includes(named) ? named : "idle";
        const movement = entity.clip;
        const speed = entity.speed;
        // TODO: spammy log
        //console.log(`pawn ${id} movement:${movement} speed:${entity.animation?.speed}`);
        // Feet match the ground: rate = rendered speed / (referenceSpeed * scale). Others play at 1x.
        // Speed source: the snapshot velocity (|v.xz| from the host), as is. The mixer advances by
        // the same frame dt as the positions. The rendered position delta is only a fallback.
        const groundSpeed = Number.isFinite(entity.speed)
          ? noteVelocitySpeed(pawn.ground, entity.speed, entity.position.x, entity.position.z)
          : noteGroundSpeed(pawn.ground, entity.position.x, entity.position.z, dt);
        // The host labels walk or run from planar speed, with no hysteresis. When both
        // gaits are measured, the client still picks the stride that fits the ground speed.
        const shown = locomotionFor(pawn, movement, groundSpeed);
        play(pawn, shown);
        const rate = pawn.rates.get(shown);
        if (pawn.action && rate) pawn.action.setEffectiveTimeScale(clipTimeScale(groundSpeed, rate, pawn.scale));
        else if (pawn.action && pawn.action.getEffectiveTimeScale() !== 1) pawn.action.setEffectiveTimeScale(1);
        if (movement !== "fall" && pawn.planted && pawn.motionBone && pawn.restRootY !== undefined) {
          pawn.motionBone.position.y = pawn.restRootY;
          pawn.planted = false;
        }
        if (stepMixers) pawn.mixer?.update(dt);
        pawn.px = entity.position.x;
        pawn.pz = entity.position.z;
        // The snapshot owns the pawn transform. The mixer does not write position.
        pawn.root.position.set(pawn.px, entity.position.y, pawn.pz);
        pawn.root.quaternion.set(entity.rotation.x, entity.rotation.y, entity.rotation.z, entity.rotation.w);
        if (movement === "fall" && pawn.action && !pawn.action.isRunning() && !pawn.planted && pawn.motionBone) {
          // The clip has finished. Hold that pose with the root lowered onto the feet.
          lowerRootToFeet(pawn.motionBone, skinnedSoleGap(pawn.root));
          pawn.planted = true;
        }
        const alpha = opacityOf ? opacityOf(id) : 1;
        setPawnOpacity(pawn, alpha);
        pawn.root.visible = (ownedId === undefined || id !== ownedId) && alpha > 0;
      }
      for (const [id, pawn] of pawns) {
        if (seen.has(id)) continue;
        release(pawn);
        pawns.delete(id);
      }
      const report = [...pawns.entries()].map(([id, pawn]) => ({
        id,
        assetKey: pawn.assetKey,
        movement: pawn.movement,
        clips: [...pawn.clips.keys()],
        time: pawn.mixer?.time ?? 0,
        running: pawn.action?.isRunning() ?? false,
        loop: pawn.action?.loop,
        clamp: pawn.action?.clampWhenFinished === true,
        groundSpeed: pawn.ground.speed,
        timeScale: pawn.action?.getEffectiveTimeScale() ?? 1,
      }));
      (globalThis as { __pawnAnim?: unknown }).__pawnAnim = report;
    },
    get count() {
      return pawns.size;
    },
    /** Pawns holding private material clones for a fade right now. */
    get fading() {
      let n = 0;
      for (const pawn of pawns.values()) if (pawn.faded) n += 1;
      return n;
    },
    get fallbacks() {
      let n = 0;
      for (const pawn of pawns.values()) if (pawn.fallback) n += 1;
      return n;
    },
    /** Presentation xz, lowest id first, labeled A, B, C. */
    positionLine(): string {
      order.length = 0;
      for (const id of pawns.keys()) order.push(id);
      if (order.length > 1) order.sort(byId);
      let text = "";
      for (let i = 0; i < order.length; i++) {
        const pawn = pawns.get(order[i]!);
        if (!pawn) continue;
        if (text) text += " ";
        const label = i < 26 ? String.fromCharCode(65 + i) : String(i + 1);
        text += label + "(" + pawn.px.toFixed(2) + "," + pawn.pz.toFixed(2) + ")";
      }
      return text;
    },
  };
}
