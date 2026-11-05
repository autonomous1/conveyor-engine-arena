/**
 * Bot pose. Inputs are world-space: `wishPlanar` integrates `moveX` / `moveZ`
 * directly, the same frame the host uses. The browser client is unchanged.
 */
import {
  MOVE_DT,
  approachVelocity,
  floorAlongMove,
  wishPlanar,
  type FloorBox,
} from "../../../src/shared/movements.js";

export type PredictPose = {
  x: number;
  y: number;
  z: number;
  vx: number;
  vz: number;
  yaw: number;
};

export type AuthoritativePose = { x: number; y: number; z: number; yaw: number };

const SNAP_M = 1;
const BLEND = 0.2;

export type MotionPredictor = {
  readonly predictOwned: boolean;
  pose(): PredictPose | undefined;
  /**
   * Integrate the previous command, then pull toward the snapshot.
   * An error above 1 m snaps. Otherwise each tick closes 20% of the gap.
   */
  advance(
    auth: AuthoritativePose | undefined,
    cmd: { moveX: number; moveZ: number; yaw: number } | undefined,
    boxes: readonly FloorBox[],
    radius: number,
    dt?: number,
  ): PredictPose | undefined;
};

export function createMotionPredictor(predictOwned = true): MotionPredictor {
  let pose: PredictPose | undefined;
  return {
    predictOwned,
    pose() {
      return pose ? { ...pose } : undefined;
    },
    advance(auth, cmd, boxes, radius, dt = MOVE_DT) {
      if (!predictOwned) {
        if (!auth) return undefined;
        pose = { x: auth.x, y: auth.y, z: auth.z, vx: 0, vz: 0, yaw: auth.yaw };
        return { ...pose };
      }
      if (!pose) {
        if (!auth) return undefined;
        pose = { x: auth.x, y: auth.y, z: auth.z, vx: 0, vz: 0, yaw: auth.yaw };
      } else if (cmd) {
        const wish = wishPlanar(cmd.moveX, cmd.moveZ);
        const vel = approachVelocity({ x: pose.vx, z: pose.vz }, wish);
        const x = pose.x + vel.x * dt;
        const z = pose.z + vel.z * dt;
        const y = floorAlongMove(boxes, pose.x, pose.z, x, z, radius, pose.y);
        pose = { x, y, z, vx: vel.x, vz: vel.z, yaw: cmd.yaw };
      }
      if (auth && pose) {
        const err = Math.hypot(auth.x - pose.x, auth.z - pose.z);
        if (err > SNAP_M) {
          pose = { x: auth.x, y: auth.y, z: auth.z, vx: 0, vz: 0, yaw: auth.yaw };
        } else {
          pose = {
            x: pose.x + (auth.x - pose.x) * BLEND,
            y: pose.y + (auth.y - pose.y) * BLEND,
            z: pose.z + (auth.z - pose.z) * BLEND,
            vx: pose.vx,
            vz: pose.vz,
            yaw: pose.yaw,
          };
        }
      }
      return pose ? { ...pose } : undefined;
    },
  };
}
