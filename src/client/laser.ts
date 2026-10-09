import * as THREE from "three";
import type { Vec3 } from "../shared/hitscan.js";

/**
 * One world-space segment per shooter. The mesh is allocated once and reused.
 * `expire` takes it out of the scene at `until`. It does not raycast.
 * The parent is the scene. A camera parent is refused.
 */
export function createLaserBeams(parent: THREE.Object3D) {
  if ((parent as { isCamera?: boolean }).isCamera) {
    throw new Error("laser line must not be parented to the camera");
  }
  const group = new THREE.Group();
  group.name = "lasers";
  parent.add(group);
  const material = new THREE.LineBasicMaterial({
    color: 0xff3318,
    depthTest: true,
    depthWrite: false,
    toneMapped: false,
  });
  const beams = new Map<number, { line: THREE.Line; until: number }>();

  function show(shooter: number, from: Vec3, to: Vec3, until: number) {
    const id = Number(shooter);
    if (!Number.isFinite(id) || !Number.isFinite(until) || !finitePoint(from) || !finitePoint(to)) {
      console.error("laser dropped", shooter, from, to, until);
      return;
    }
    let beam = beams.get(id);
    if (!beam) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(6), 3));
      const line = new THREE.Line(geometry, material);
      line.name = "laser";
      line.frustumCulled = false;
      line.renderOrder = 2;
      line.raycast = () => {};
      beam = { line, until };
      beams.set(id, beam);
    }
    const attr = beam.line.geometry.getAttribute("position") as THREE.BufferAttribute;
    attr.setXYZ(0, from.x, from.y, from.z);
    attr.setXYZ(1, to.x, to.y, to.z);
    attr.needsUpdate = true;
    beam.line.geometry.computeBoundingSphere();
    beam.until = until;
    beam.line.visible = true;
    if (beam.line.parent !== group) group.add(beam.line);
  }

  function expire(now: number) {
    for (const beam of beams.values()) {
      if (now < beam.until) continue;
      beam.line.visible = false;
      beam.line.removeFromParent();
    }
  }

  /** Take every segment out of the scene. The rest of the scene stays. */
  function drop() {
    for (const beam of beams.values()) {
      beam.line.visible = false;
      beam.line.removeFromParent();
    }
  }

  return { show, expire, drop };
}

function finitePoint(p: Vec3): boolean {
  return Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z);
}
