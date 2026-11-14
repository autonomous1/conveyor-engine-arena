/**
 * One billboard per bot, from host `botLabel` frames. The option defaults off.
 * Off: no sprites, and frames are ignored. On: one canvas texture and one
 * material per bot, redrawn only when that bot's text changes.
 */
// ARCHITECTURE: One billboard per visible bot: canvas texture, material, and
//   text sync.
// Wiring: boot.ts creates the layer and calls `sync` each frame;
//   shared/bot-label.ts supplies the text.
import * as THREE from "three";
import { parseBotLabel } from "../shared/bot-label.js";
import type { ClientDiag } from "./diag.js";

/** Canvas pixels. The sprite is this aspect in the world. */
export const LABEL_W = 128;
export const LABEL_H = 32;
/** Metres from the top of the pawn (its height) up to the label centre. */
export const LABEL_ABOVE_M = 0.4;
/**
 * World metres. Width matches the 128×32 canvas.
 * @why Height 0.4 reads at about 10–20 m with the play camera.
 */
export const LABEL_SCALE_X = 1.6;
export const LABEL_SCALE_Y = 0.4;

export type BotLabelLayer = {
  setEnabled(on: boolean): void;
  /** Ignored while the option is off. A bad frame is logged and dropped. */
  offer(frame: unknown): void;
  /**
   * Feet positions of pawns still in the snapshot. A pawn that left loses its
   * sprite. Positions move; the canvas is not touched here.
   */
  sync(entities: ReadonlyArray<{ id: unknown; position: { x: number; y: number; z: number } }>): void;
  readonly count: number;
  /** Canvas paints. A repeated text does not increment this. */
  readonly redraws: number;
};

type LabelCanvas = HTMLCanvasElement;

type Slot = {
  text: string;
  sprite: THREE.Sprite;
  material: THREE.SpriteMaterial;
  texture: THREE.CanvasTexture;
};

function browserCanvas(): LabelCanvas {
  const canvas = document.createElement("canvas");
  canvas.width = LABEL_W;
  canvas.height = LABEL_H;
  return canvas;
}

function paint(canvas: LabelCanvas, text: string): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("bot label canvas");
  ctx.clearRect(0, 0, LABEL_W, LABEL_H);
  ctx.fillStyle = "rgba(8, 10, 14, 0.72)";
  ctx.fillRect(2, 2, LABEL_W - 4, LABEL_H - 4);
  ctx.font = text.length > 12 ? "700 14px sans-serif" : "700 18px sans-serif";
  ctx.fillStyle = "#f4f7fb";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, LABEL_W / 2, LABEL_H / 2);
}

export function createBotLabelLayer(
  parent: THREE.Object3D,
  pawnHeight: number,
  diag: ClientDiag,
  createCanvas: () => LabelCanvas = browserCanvas,
): BotLabelLayer {
  let enabled = false;
  let redraws = 0;
  const pending = new Map<number, string>();
  const slots = new Map<number, Slot>();
  const seen = new Set<number>();

  function fail(err: unknown, category: string): void {
    diag.report({
      level: "error",
      error: err,
      fields: { source: "bot-label", messageType: "botLabel", category },
    });
  }

  function disposeSlot(slot: Slot): void {
    slot.sprite.removeFromParent();
    slot.material.map = null;
    slot.texture.dispose();
    slot.material.dispose();
  }

  function clear(): void {
    pending.clear();
    for (const slot of slots.values()) disposeSlot(slot);
    slots.clear();
  }

  function makeSlot(text: string): Slot {
    const canvas = createCanvas();
    paint(canvas, text);
    redraws += 1;
    const texture = new THREE.CanvasTexture(canvas);
    texture.generateMipmaps = false;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    const material = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthTest: true,
      depthWrite: false,
    });
    const sprite = new THREE.Sprite(material);
    sprite.name = "bot-label";
    sprite.scale.set(LABEL_SCALE_X, LABEL_SCALE_Y, 1);
    sprite.raycast = () => {};
    sprite.castShadow = false;
    sprite.receiveShadow = false;
    parent.add(sprite);
    return { text, sprite, material, texture };
  }

  function repaint(slot: Slot, text: string): void {
    paint(slot.texture.image as LabelCanvas, text);
    slot.texture.needsUpdate = true;
    slot.text = text;
    redraws += 1;
  }

  return {
    setEnabled(on: boolean) {
      if (enabled === on) return;
      enabled = on;
      if (!on) clear();
    },
    offer(frame: unknown) {
      if (!enabled) return;
      let parsed: ReturnType<typeof parseBotLabel>;
      try {
        parsed = parseBotLabel(frame);
      } catch (err) {
        fail(err, "parse");
        return;
      }
      if (!parsed) {
        fail(undefined, "parse");
        return;
      }
      const slot = slots.get(parsed.id);
      if (slot) {
        if (slot.text === parsed.text) return;
        try {
          repaint(slot, parsed.text);
          pending.set(parsed.id, parsed.text);
        } catch (err) {
          fail(err, "draw");
        }
        return;
      }
      if (pending.get(parsed.id) === parsed.text) return;
      pending.set(parsed.id, parsed.text);
    },
    sync(entities) {
      if (!enabled) return;
      seen.clear();
      for (let i = 0; i < entities.length; i++) {
        const entity = entities[i]!;
        const id = typeof entity.id === "number" ? entity.id : Number(entity.id);
        if (!Number.isInteger(id)) continue;
        seen.add(id);
        const text = pending.get(id);
        if (text === undefined) continue;
        const pos = entity.position;
        let slot = slots.get(id);
        if (!slot) {
          try {
            slot = makeSlot(text);
          } catch (err) {
            fail(err, "draw");
            pending.delete(id);
            continue;
          }
          slots.set(id, slot);
        }
        slot.sprite.position.set(pos.x, pos.y + pawnHeight + LABEL_ABOVE_M, pos.z);
      }
      for (const [id, slot] of slots) {
        if (seen.has(id)) continue;
        pending.set(id, slot.text);
        slots.delete(id);
        disposeSlot(slot);
      }
    },
    get count() {
      return slots.size;
    },
    get redraws() {
      return redraws;
    },
  };
}
