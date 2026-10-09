import * as THREE from "three";
import { clone as cloneWithSkeleton } from "three/addons/utils/SkeletonUtils.js";
import { findClip } from "../shared/movements.ts";

/**
 * Idle soles that float about 10 cm are parented that far above the floor.
 * Poses already within 5 cm are left where they are, so a grounded idle is not buried.
 */
export const SKIN_PARENT_DROP = 0.1;
const GROUNDED_SOLE = 0.05;

const _vertex = new THREE.Vector3();
const _world = new THREE.Vector3();
const _origin = new THREE.Vector3();
const _scale = new THREE.Vector3();
const _up = new THREE.Vector3();

/** Lowest skinned vertex, in meters above `root`'s world origin. */
export function skinnedSoleGap(root: THREE.Object3D): number {
  root.updateMatrixWorld(true);
  root.getWorldPosition(_origin);
  let min = Infinity;
  root.traverse((obj) => {
    const mesh = obj as THREE.SkinnedMesh;
    if (!mesh.isSkinnedMesh) return;
    const position = mesh.geometry.attributes.position;
    if (!position) return;
    for (let i = 0; i < position.count; i++) {
      _vertex.fromBufferAttribute(position, i);
      mesh.applyBoneTransform(i, _vertex);
      _world.copy(_vertex).applyMatrix4(mesh.matrixWorld);
      if (_world.y < min) min = _world.y;
    }
  });
  if (!Number.isFinite(min)) return 0;
  return min - _origin.y;
}

/**
 * Move `bone` along its parent's up axis so the skinned sole changes by `-gap`
 * meters in world Y. The animation mixer does not write this component.
 */
export function lowerRootToFeet(bone: THREE.Object3D, gap: number): void {
  const parent = bone.parent;
  if (!parent || !Number.isFinite(gap) || Math.abs(gap) < 1e-4) return;
  parent.updateWorldMatrix(true, false);
  parent.getWorldScale(_scale);
  _up.set(0, 1, 0).transformDirection(parent.matrixWorld);
  const denom = _scale.y * _up.y;
  if (Math.abs(denom) < 1e-4) return;
  bone.position.y -= gap / denom;
}

function componentSpan(track: THREE.KeyframeTrack, component: number): number {
  const size = track.getValueSize();
  if (component >= size || track.values.length < size) return 0;
  let min = Infinity;
  let max = -Infinity;
  for (let i = component; i < track.values.length; i += size) {
    const value = track.values[i] ?? 0;
    if (value < min) min = value;
    if (value > max) max = value;
  }
  return max - min;
}

/** The position track whose Y actually moves. That is the clip's root motion. */
function rootPositionTrack(clip: THREE.AnimationClip): THREE.KeyframeTrack | undefined {
  let best: THREE.KeyframeTrack | undefined;
  let bestSpan = 1e-4;
  for (const track of clip.tracks) {
    if (!track.name.endsWith(".position")) continue;
    const span = componentSpan(track, 1);
    if (span > bestSpan) {
      bestSpan = span;
      best = track;
    }
  }
  return best;
}

function componentTrack(
  name: string,
  times: ArrayLike<number>,
  values: ArrayLike<number>,
  stride: number,
  offset: number,
): THREE.KeyframeTrack {
  const out = new Float32Array(times.length);
  for (let i = 0; i < times.length; i++) out[i] = values[i * stride + offset] ?? 0;
  return new THREE.NumberKeyframeTrack(name, Float32Array.from(times), out);
}

/** Drop every position track so the mixer cannot write position.y. */
export function withoutPositionTracks(clip: THREE.AnimationClip): THREE.AnimationClip {
  return new THREE.AnimationClip(
    clip.name,
    clip.duration,
    clip.tracks.filter((track) => !track.name.endsWith(".position")),
  );
}

/**
 * Fall keeps root-motion X and Z. Root-motion Y is omitted, and so is every
 * other position track, so the mixer never writes position.y.
 */
export function withoutRootMotionY(clip: THREE.AnimationClip): THREE.AnimationClip {
  const root = rootPositionTrack(clip);
  const tracks = clip.tracks.filter((track) => !track.name.endsWith(".position"));
  if (root && root.getValueSize() === 3) {
    const node = root.name.slice(0, -".position".length);
    tracks.push(componentTrack(`${node}.position[x]`, root.times, root.values, 3, 0));
    tracks.push(componentTrack(`${node}.position[z]`, root.times, root.values, 3, 2));
  }
  return new THREE.AnimationClip(clip.name, clip.duration, tracks);
}

function lowestIdleSole(root: THREE.Object3D, clip: THREE.AnimationClip | undefined): number {
  if (!clip || !(clip.duration > 0)) return skinnedSoleGap(root);
  const copy = cloneWithSkeleton(root);
  const mixer = new THREE.AnimationMixer(copy);
  const action = mixer.clipAction(withoutPositionTracks(clip));
  action.play();
  let lowest = Infinity;
  const samples = 8;
  for (let i = 0; i < samples; i++) {
    mixer.setTime(clip.duration * ((i + 0.5) / samples));
    const gap = skinnedSoleGap(copy);
    if (gap < lowest) lowest = gap;
  }
  mixer.stopAllAction();
  return lowest;
}

/** Drop the skinned mesh parent by `meters` in world space. The pawn root is not moved. */
export function dropSkinnedParent(root: THREE.Object3D, meters: number): void {
  root.updateMatrixWorld(true);
  const seen = new Set<THREE.Object3D>();
  root.traverse((obj) => {
    const mesh = obj as THREE.SkinnedMesh;
    if (!mesh.isSkinnedMesh || !mesh.parent || seen.has(mesh.parent)) return;
    seen.add(mesh.parent);
    const parent = mesh.parent;
    parent.getWorldScale(_scale);
    _up.set(0, 1, 0).transformDirection(parent.matrixWorld);
    const denom = _scale.y * _up.y;
    if (Math.abs(denom) < 1e-4) return;
    parent.position.y -= meters / denom;
  });
}

/**
 * Clone a character for spawning. Scale stays on this object, not the cached
 * GLB. An idle whose soles float is lowered by {@link SKIN_PARENT_DROP}.
 * The fall clip ignores root-motion Y.
 */
export function prepareCharacter(
  source: THREE.Object3D,
  sourceClips: readonly THREE.AnimationClip[],
  scale: number,
  names: { idle: string; fall: string },
): { object: THREE.Object3D; clips: THREE.AnimationClip[] } {
  const template = cloneWithSkeleton(source);
  template.scale.multiplyScalar(scale);
  const idle = findClip(sourceClips, names.idle);
  if (lowestIdleSole(template, idle) > GROUNDED_SOLE) dropSkinnedParent(template, SKIN_PARENT_DROP);
  const fall = findClip(sourceClips, names.fall);
  const clips = sourceClips.map((clip) => (clip === fall ? withoutRootMotionY(clip) : withoutPositionTracks(clip)));
  return { object: template, clips };
}
