import * as THREE from "three";

const HIDDEN = new THREE.Matrix4().makeScale(0, 0, 0);

type Slot = {
  mesh: THREE.InstancedMesh;
  index: number;
  matrix: THREE.Matrix4;
};

/**
 * Show or hide one placement. Clones use `visible`. An instanced prop keeps
 * its slot and the matrix is scaled to zero, so the batch count does not change.
 */
export function createPlacementVisibility() {
  const clones = new Map<string, THREE.Object3D>();
  const instances = new Map<string, Slot[]>();
  return {
    addClone(id: string, object: THREE.Object3D) {
      object.name = id;
      clones.set(id, object);
    },
    addInstance(id: string, mesh: THREE.InstancedMesh, index: number) {
      const matrix = new THREE.Matrix4();
      mesh.getMatrixAt(index, matrix);
      const slots = instances.get(id) ?? [];
      slots.push({ mesh, index, matrix: matrix.clone() });
      instances.set(id, slots);
    },
    setVisible(id: string, visible: boolean) {
      const clone = clones.get(id);
      if (clone) clone.visible = visible;
      const slots = instances.get(id);
      if (!slots) return;
      for (const slot of slots) {
        slot.mesh.setMatrixAt(slot.index, visible ? slot.matrix : HIDDEN);
        slot.mesh.instanceMatrix.needsUpdate = true;
      }
    },
    hidden(id: string): boolean {
      const clone = clones.get(id);
      if (clone) return clone.visible === false;
      const slots = instances.get(id);
      const slot = slots?.[0];
      if (!slot) return false;
      const matrix = new THREE.Matrix4();
      slot.mesh.getMatrixAt(slot.index, matrix);
      const e = matrix.elements;
      // decompose() reports scale 1 for a singular matrix, so read the columns.
      const sx = Math.hypot(e[0]!, e[1]!, e[2]!);
      const sy = Math.hypot(e[4]!, e[5]!, e[6]!);
      const sz = Math.hypot(e[8]!, e[9]!, e[10]!);
      return sx === 0 && sy === 0 && sz === 0;
    },
  };
}

export type PlacementVisibility = ReturnType<typeof createPlacementVisibility>;
