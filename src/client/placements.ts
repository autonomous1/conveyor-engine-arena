// ARCHITECTURE: Placement visibility handles: cloned vs instanced, hide, and
//   lift shift.
// Wiring: arena-scene.ts builds it; elevator-room.ts shifts a room's copies.
import * as THREE from "three";

const HIDDEN = new THREE.Matrix4().makeScale(0, 0, 0);

type Slot = {
  mesh: THREE.InstancedMesh;
  index: number;
  /** Placed matrix, without the cab offset. */
  matrix: THREE.Matrix4;
  /** World-up shift applied on top of `matrix`. Kept while the slot is hidden. */
  dy: number;
  visible: boolean;
};

const OFFSET = new THREE.Matrix4();
const COMPOSED = new THREE.Matrix4();

/**
 * Show or hide one placement. Clones use `visible`. An instanced prop keeps
 * its slot and the matrix is scaled to zero, so the batch count does not change.
 */
/** Show, hide, and shift placements. Clones use `visible`. Instances keep their slot and scale to zero. */
export interface PlacementVisibility {
  /** Remember a clone and name it `id`. Does not parent it. */
  addClone(id: string, object: THREE.Object3D): void;
  /** Remember one instanced slot and copy its matrix. The batch count stays. */
  addInstance(id: string, mesh: THREE.InstancedMesh, index: number): void;
  /**
   * Shift up by `dy` metres from the loaded pose. An instance composes world T(0, dy, 0).
   * A clone stores home y on the first call.
   */
  setOffsetY(id: string, dy: number): void;
  /** Recompute bounds of instanced batches changed since the last flush. No-op when none changed. */
  flushBounds(): void;
  /** Unknown id is a no-op. An instance writes a zero scale and does not change the batch count. */
  setVisible(id: string, visible: boolean): void;
  /** Unknown id is false. A clone reads `visible`. An instance allocates one matrix to read scale. */
  hidden(id: string): boolean;
}

export function createPlacementVisibility(): PlacementVisibility {
  const clones = new Map<string, THREE.Object3D>();
  const cloneHomeY = new Map<string, number>();
  const instances = new Map<string, Slot[]>();
  const dirty = new Set<THREE.InstancedMesh>();
  const writeSlot = (slot: Slot) => {
    if (!slot.visible) {
      slot.mesh.setMatrixAt(slot.index, HIDDEN);
    } else if (slot.dy === 0) {
      slot.mesh.setMatrixAt(slot.index, slot.matrix);
    } else {
      OFFSET.makeTranslation(0, slot.dy, 0);
      COMPOSED.multiplyMatrices(OFFSET, slot.matrix);
      slot.mesh.setMatrixAt(slot.index, COMPOSED);
    }
    slot.mesh.instanceMatrix.needsUpdate = true;
    dirty.add(slot.mesh);
  };
  return {
    addClone(id: string, object: THREE.Object3D) {
      object.name = id;
      clones.set(id, object);
    },
    addInstance(id: string, mesh: THREE.InstancedMesh, index: number) {
      const matrix = new THREE.Matrix4();
      mesh.getMatrixAt(index, matrix);
      const slots = instances.get(id) ?? [];
      slots.push({ mesh, index, matrix: matrix.clone(), dy: 0, visible: true });
      instances.set(id, slots);
    },
    /**
     * Shift one placement up by `dy` metres from where it was loaded.
     * An instance composes world `T(0, dy, 0)` on the placed matrix.
     * A clone stores its home `position.y` on the first call.
     */
    setOffsetY(id: string, dy: number) {
      const clone = clones.get(id);
      if (clone) {
        const home = cloneHomeY.get(id);
        const y0 = home === undefined ? clone.position.y : home;
        if (home === undefined) cloneHomeY.set(id, y0);
        clone.position.y = y0 + dy;
      }
      const slots = instances.get(id);
      if (!slots) return;
      for (const slot of slots) {
        slot.dy = dy;
        writeSlot(slot);
      }
    },
    /** Recompute the bounding sphere of each instanced batch shifted since the last flush. */
    flushBounds() {
      for (const mesh of dirty) mesh.computeBoundingSphere();
      dirty.clear();
    },
    setVisible(id: string, visible: boolean) {
      const clone = clones.get(id);
      if (clone) clone.visible = visible;
      const slots = instances.get(id);
      if (!slots) return;
      for (const slot of slots) {
        slot.visible = visible;
        writeSlot(slot);
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
