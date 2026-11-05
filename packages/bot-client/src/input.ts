/**
 * Player-equivalent frames. Throttled like the browser client.
 * No Node builtins and no WebSocket package.
 */
import { useFrame } from "../../../src/shared/doors.js";
import { fireShotFrame } from "../../../src/shared/fire-debug.js";
import { grenadeFrame } from "../../../src/shared/grenade.js";
import { INPUT_HZ } from "../../../src/shared/look.js";

const INPUT_INTERVAL_MS = 1000 / INPUT_HZ;

export type MoveCommand = {
  moveX: number;
  moveZ: number;
  yaw: number;
  buttons?: number;
};

export type BotInput = {
  sendInput(cmd: MoveCommand): void;
  use(): boolean;
  fire(yaw?: number, pitch?: number): boolean;
  grenade(yaw?: number, pitch?: number): boolean;
  /** A new welcome starts the input sequence at 1, matching the browser client. */
  resetSeq(): void;
};

export type InputLink = {
  send(text: string): boolean;
  ownedId(): number | undefined;
};

export function createBotInput(link: InputLink): BotInput {
  let inputSeq = 1;
  let fireSeq = 1;
  let grenadeSeq = 1;
  let useSeq = 1;
  let nextInputAt = 0;
  let aimYaw = 0;

  const sendOwned = (text: string, advance: () => void): boolean => {
    if (link.ownedId() === undefined) return false;
    if (!link.send(text)) return false;
    advance();
    return true;
  };

  return {
    sendInput(cmd) {
      const now = Date.now();
      if (now < nextInputAt) return;
      const owned = link.ownedId();
      if (owned === undefined) return;
      const buttons = cmd.buttons ?? 0;
      const text = JSON.stringify({
        v: 1,
        type: "input",
        seq: inputSeq,
        moveX: cmd.moveX,
        moveZ: cmd.moveZ,
        yaw: cmd.yaw,
        buttons,
        entity: owned,
      });
      if (!link.send(text)) return;
      inputSeq += 1;
      aimYaw = cmd.yaw;
      nextInputAt = now + INPUT_INTERVAL_MS;
    },
    use() {
      const seq = useSeq;
      return sendOwned(JSON.stringify(useFrame(seq)), () => {
        useSeq += 1;
      });
    },
    fire(yaw = aimYaw, pitch = 0) {
      const seq = fireSeq;
      return sendOwned(JSON.stringify(fireShotFrame(seq, yaw, pitch, false)), () => {
        fireSeq += 1;
      });
    },
    grenade(yaw = aimYaw, pitch = 0) {
      const seq = grenadeSeq;
      return sendOwned(JSON.stringify(grenadeFrame(seq, yaw, pitch)), () => {
        grenadeSeq += 1;
      });
    },
    resetSeq() {
      inputSeq = 1;
    },
  };
}
