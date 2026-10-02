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
  assetKey?: string;
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
    // TODO spammy log
    //console.log("id:", pawn.assetKey, "movement:", movement, "clip:", clip?.name);
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
    const pawn = { root, px: 0, pz: 0, fallback, mixer, clips, assetKey };
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
    apply(render: RenderSnapshot, dt: number, movementOf: (id: number) => string | undefined, ownedId?: number) {
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
        play(pawn, movement);
        pawn.mixer?.update(dt);
        pawn.px = entity.position.x;
        pawn.pz = entity.position.z;
        pawn.root.position.set(pawn.px, entity.position.y, pawn.pz);
        pawn.root.quaternion.set(entity.rotation.x, entity.rotation.y, entity.rotation.z, entity.rotation.w);
        pawn.root.visible = ownedId === undefined || id !== ownedId;
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
      const report = [...pawns.entries()].map(([id, pawn]) => ({
        id,
        assetKey: pawn.assetKey,
        movement: pawn.movement,
        clips: [...pawn.clips.keys()],
        time: pawn.mixer?.time ?? 0,
        running: pawn.action?.isRunning() ?? false,
      }));
      (globalThis as { __pawnAnim?: unknown }).__pawnAnim = report;
    },
    get count() {
      return pawns.size;
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
