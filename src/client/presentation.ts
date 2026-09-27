import * as THREE from "three";
import { clone as cloneWithSkeleton } from "three/addons/utils/SkeletonUtils.js";
import type { RenderSnapshot } from "conveyor-engine-client";
import type { CharacterTemplates, CharacterVisual } from "./arena-scene.js";
import { findClip, MOVEMENTS } from "../shared/movements.js";

type Pawn = {
  root: THREE.Object3D;
  px: number;
  pz: number;
  fallback: boolean;
  mixer?: THREE.AnimationMixer;
  action?: THREE.AnimationAction;
  movement?: string;
  clips: Map<string, THREE.AnimationClip>;
};

export function createPawnLayer(parent: THREE.Object3D, templates: CharacterTemplates, pawnHeight: number) {
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
    if (!clip) return;
    const next = pawn.mixer.clipAction(clip);
    next.reset().fadeIn(0.15).play();
    pawn.action?.fadeOut(0.15);
    pawn.action = next;
    pawn.movement = movement;
  }

  function ensure(id: number, assetKey: string | undefined): Pawn {
    const existing = pawns.get(id);
    if (existing) return existing;
    const visual = assetKey ? templates.get(assetKey) : undefined;
    const root = new THREE.Group();
    let fallback = false;
    let mixer: THREE.AnimationMixer | undefined;
    let clips = new Map<string, THREE.AnimationClip>();
    // Object3D.clone shares the source skeleton, so a skinned mesh keeps the
    // unloaded template's bones and draws at the world origin.
    if (visual) {
      const model = cloneWithSkeleton(visual.object);
      root.add(model);
      mixer = new THREE.AnimationMixer(model);
      clips = clipMap(visual);
    } else {
      fallback = true;
      root.add(capsule(id));
    }
    parent.add(root);
    const pawn = { root, px: 0, pz: 0, fallback, mixer, clips };
    pawns.set(id, pawn);
    return pawn;
  }

  return {
    /** Positions come only from the render snapshot supplied by the frame loop. */
    apply(render: RenderSnapshot, dt: number, movementOf: (id: number) => string | undefined) {
      const seen = new Set<number>();
      for (const entity of render.entities) {
        const id = Number(entity.id);
        if (!Number.isFinite(id)) continue;
        seen.add(id);
        const pawn = ensure(id, entity.render?.assetKey);
        const named = movementOf(id);
        const movement = named && (MOVEMENTS as readonly string[]).includes(named) ? named : "idle";
        play(pawn, movement);
        pawn.mixer?.update(dt);
        const dx = entity.position.x - pawn.px;
        const dz = entity.position.z - pawn.pz;
        pawn.px = entity.position.x;
        pawn.pz = entity.position.z;
        pawn.root.position.set(pawn.px, entity.position.y, pawn.pz);
        const speed = Math.hypot(dx, dz);
        if (speed > 0.04) {
          const target = Math.atan2(dx, dz);
          let delta = target - pawn.root.rotation.y;
          while (delta > Math.PI) delta -= Math.PI * 2;
          while (delta < -Math.PI) delta += Math.PI * 2;
          pawn.root.rotation.y += delta * 0.65;
        }
      }
      for (const [id, pawn] of pawns) {
        if (seen.has(id)) continue;
        parent.remove(pawn.root);
        if (pawn.fallback) {
          pawn.root.traverse((obj) => {
            const mesh = obj as THREE.Mesh;
            if (mesh.userData.ownedGeometry) {
              mesh.geometry?.dispose();
              const material = mesh.material;
              if (material && !Array.isArray(material)) material.dispose();
            }
          });
        }
        pawns.delete(id);
      }
    },
    get count() {
      return pawns.size;
    },
    get fallbacks() {
      let n = 0;
      for (const pawn of pawns.values()) if (pawn.fallback) n += 1;
      return n;
    },
  };
}
