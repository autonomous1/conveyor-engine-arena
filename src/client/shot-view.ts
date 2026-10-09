import type { PerspectiveCamera } from "three";
import type { Vec3 } from "../shared/hitscan.js";
import { eyeLook } from "../shared/look.ts";

export function finiteVec(p: Vec3 | undefined | null): p is Vec3 {
  return !!p && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z);
}

/**
 * Puts the camera on the pawn eye. A shot may draw a segment.
 * The laser endpoint is not written onto the pawn or the camera.
 * A non-finite endpoint draws nothing.
 */
export function presentShot(opts: {
  camera: PerspectiveCamera;
  pawn: Vec3;
  yaw: number;
  pitch: number;
  from?: Vec3;
  to?: Vec3;
  show: (from: Vec3, to: Vec3) => void;
}): { drew: boolean; camBefore: Vec3; camAfter: Vec3 } {
  const camBefore = { x: opts.camera.position.x, y: opts.camera.position.y, z: opts.camera.position.z };
  const pawn = { x: opts.pawn.x, y: opts.pawn.y, z: opts.pawn.z };
  const aim = eyeLook(pawn, opts.yaw, opts.pitch);
  if (finiteVec(aim.position) && finiteVec(aim.target)) {
    opts.camera.position.set(aim.position.x, aim.position.y, aim.position.z);
    opts.camera.up.set(0, 1, 0);
    opts.camera.lookAt(aim.target.x, aim.target.y, aim.target.z);
  }
  const drew = finiteVec(opts.from) && finiteVec(opts.to);
  if (drew && opts.from && opts.to) opts.show(opts.from, opts.to);
  const camAfter = { x: opts.camera.position.x, y: opts.camera.position.y, z: opts.camera.position.z };
  return { drew, camBefore, camAfter };
}

export function formatFireLog(opts: {
  socketClosed: boolean;
  frameThrew: boolean;
  camBefore: Vec3;
  camAfter: Vec3;
}): string {
  const f = (p: Vec3) => `${p.x.toFixed(3)},${p.y.toFixed(3)},${p.z.toFixed(3)}`;
  return `fire socket=${opts.socketClosed ? "closed" : "open"} threw=${opts.frameThrew ? "yes" : "no"} camBefore=${f(opts.camBefore)} camAfter=${f(opts.camAfter)}`;
}
