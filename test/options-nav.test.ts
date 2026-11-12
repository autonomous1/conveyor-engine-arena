import assert from "node:assert/strict";
import test from "node:test";
import {
  BOT_LABELS_STORAGE_KEY,
  createOptionsModel,
  INVERT_Y_STORAGE_KEY,
  SHOW_SCENE_MAP_STORAGE_KEY,
  type KeyValueStorage,
} from "../src/client/options.ts";

function memory(): KeyValueStorage {
  const values = new Map<string, string>();
  return {
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
  };
}

test("focus wraps, the scene-map row persists, and invert Y defaults off", () => {
  const storage = memory();
  const model = createOptionsModel(storage, () => {}, () => {}, () => {});
  assert.equal(model.invertY, false);
  assert.equal(model.botLabels, false);
  assert.equal(model.focusIndex, 0);
  assert.equal(storage.getItem(INVERT_Y_STORAGE_KEY), null);
  assert.equal(storage.getItem(BOT_LABELS_STORAGE_KEY), null);

  model.moveFocus(-1);
  assert.equal(model.focusIndex, 4);
  model.moveFocus(1);
  assert.equal(model.focusIndex, 0);
  model.moveFocus(5);
  assert.equal(model.focusIndex, 0);

  model.moveFocus(2);
  assert.equal(model.focusIndex, 2);
  model.activateFocused();
  assert.equal(model.showSceneMap, true);
  assert.equal(model.showCollision, false);
  assert.equal(storage.getItem(SHOW_SCENE_MAP_STORAGE_KEY), "on");

  model.moveFocus(1);
  assert.equal(model.focusIndex, 3);
  model.activateFocused();
  assert.equal(model.invertY, true);
  assert.equal(storage.getItem(INVERT_Y_STORAGE_KEY), "on");

  model.moveFocus(1);
  assert.equal(model.focusIndex, 4);
  model.activateFocused();
  assert.equal(model.botLabels, true);
  assert.equal(storage.getItem(BOT_LABELS_STORAGE_KEY), "on");

  const again = createOptionsModel(storage, () => {}, () => {}, () => {});
  assert.equal(again.invertY, true);
  assert.equal(again.showSceneMap, true);
  assert.equal(again.botLabels, true);
  again.resetFocus();
  assert.equal(again.focusIndex, 0);
  again.moveFocus(-1);
  again.activateFocused();
  assert.equal(again.botLabels, false);
  assert.equal(storage.getItem(BOT_LABELS_STORAGE_KEY), "off");
  again.moveFocus(-1);
  again.activateFocused();
  assert.equal(again.invertY, false);
  assert.equal(storage.getItem(INVERT_Y_STORAGE_KEY), "off");
});
