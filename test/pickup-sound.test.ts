import assert from "node:assert/strict";
import test from "node:test";
import type { ArenaSoundName } from "../src/shared/arena-view.ts";
import type { PickupPlacement } from "../src/shared/pickups.ts";
import { createPickupSounds, kindSoundsOf } from "../src/client/pickup-sound.ts";

const box = (id: string, kind: PickupPlacement["kind"], x: number): PickupPlacement => ({
  id, kind, model: "/assets/models/x.glb", amount: 0, minX: x - 1, maxX: x + 1, minY: 0, maxY: 2, minZ: 4, maxZ: 6,
});
const pickups = [box("ammo-1", "ammo", 10), box("ammo-2", "ammo", 20), box("key-1", "key", 30), box("med-1", "health", 40), box("gun-1", "weapon", 50)];

type Played = [ArenaSoundName, { x: number; y: number; z: number } | undefined];
function setup() {
  const played: Played[] = [];
  const sounds = createPickupSounds({ pickups, play: (name, at) => void played.push([name, at]), graceMs: 250 });
  sounds.onSet(["ammo-1", "ammo-2", "key-1", "med-1", "gun-1"]);
  return { sounds, played };
}

test("own ammo crate: plays once, non-positional, as soon as the loadout follows the gone frame", () => {
  const { sounds, played } = setup();
  sounds.onGone("ammo-1", 1000);
  assert.equal(played.length, 0, "gone alone is not yet known to be yours");
  sounds.onLoadout(1005);
  assert.deepEqual(played, [["cratePickup", undefined]]);
  sounds.update(2000);
  assert.equal(played.length, 1, "no second play when the grace runs out");
  sounds.onGone("ammo-1", 3000);
  assert.equal(played.length, 1, "a repeated gone frame for the same placement is ignored");
});

test("own key: the inventory that lists the key makes it yours", () => {
  const { sounds, played } = setup();
  sounds.onGone("key-1", 500);
  sounds.onInventory(["key-9"], 510);
  assert.equal(played.length, 0, "an inventory without this key does not claim it");
  sounds.onInventory(["key-1"], 520);
  assert.deepEqual(played, [["keyPickup", undefined]]);
  sounds.update(5000);
  assert.equal(played.length, 1);
});

test("someone else's pickup plays once, positional at the pickup centre, after the grace", () => {
  const { sounds, played } = setup();
  sounds.onGone("ammo-2", 100);
  sounds.onGone("key-1", 100);
  sounds.update(200);
  assert.equal(played.length, 0, "still inside the grace");
  sounds.update(400);
  assert.deepEqual(played, [
    ["cratePickup", { x: 20, y: 1, z: 5 }],
    ["keyPickup", { x: 30, y: 1, z: 5 }],
  ]);
  sounds.update(900);
  assert.equal(played.length, 2);
  assert.equal(sounds.waiting, 0);
});

test("welcome state never plays: taken-before-join placements, welcome loadout, inventory resend", () => {
  const { sounds, played } = setup();
  sounds.onSet(["ammo-2", "med-1", "gun-1"]); // late joiner: ammo-1 and key-1 were already taken
  sounds.onLoadout(10);
  sounds.onInventory(["key-1"], 10);
  sounds.onGone("ammo-1", 20);
  sounds.onGone("key-1", 20);
  sounds.update(1000);
  assert.deepEqual(played, [], "nothing plays for pickups gone at welcome, even if a gone frame repeats");
  sounds.onInventory(["key-1"], 2000);
  sounds.onLoadout(2000);
  assert.deepEqual(played, [], "an inventory or loadout with nothing waiting is silent");
});

test("a re-welcome clears anything waiting", () => {
  const { sounds, played } = setup();
  sounds.onGone("ammo-2", 100);
  sounds.onSet(["ammo-1", "key-1"]);
  sounds.update(1000);
  assert.deepEqual(played, []);
});

test("health plays its own effect at once, positioned; weapon and unknown ids stay silent", () => {
  const { sounds, played } = setup();
  sounds.onGone("med-1", 0);
  assert.deepEqual(played, [["medkitPickup", { x: 40, y: 1, z: 5 }]]);
  sounds.onGone("med-1", 10);
  sounds.onGone("gun-1", 0);
  sounds.onGone("nope", 0);
  sounds.onLoadout(10);
  sounds.update(1000);
  assert.equal(played.length, 1, "once, and nothing for weapon or unknown ids");
  sounds.onGone("ammo-1", 2000);
  sounds.onLoadout(2400); // past the grace: not this pickup's follow-up
  assert.equal(played.length, 1);
  sounds.update(2400);
  assert.deepEqual(played[1], ["cratePickup", { x: 10, y: 1, z: 5 }]);
});

test("the kind to effect map comes from the manifest's pickupKinds, else the defaults", () => {
  const sound = (pickupKinds?: string[]) => ({ uri: "/a.wav", volume: 1, maxVoices: 2, positional: true, refDistance: 3, ...(pickupKinds ? { pickupKinds } : {}) });
  assert.deepEqual(kindSoundsOf({ cratePickup: sound(["ammo", "health"]), keyPickup: sound(["key"]) }), { ammo: "cratePickup", health: "cratePickup", key: "keyPickup" });
  assert.deepEqual(kindSoundsOf(undefined), { ammo: "cratePickup", key: "keyPickup", health: "medkitPickup" });
  // Med-kit file absent: its effect is not in view.sounds, so health is silent.
  const map = kindSoundsOf({ cratePickup: sound(["ammo"]), keyPickup: sound(["key"]) });
  assert.equal(map.health, undefined);
  const played: ArenaSoundName[] = [];
  const s = createPickupSounds({ pickups, kindSounds: map, play: (name) => void played.push(name) });
  s.onSet(["med-1"]);
  s.onGone("med-1", 0);
  assert.deepEqual(played, []);
  // A manifest can hand health to the crate effect.
  const crate = createPickupSounds({ pickups, kindSounds: { health: "cratePickup" }, play: (name) => void played.push(name) });
  crate.onSet(["med-1"]);
  crate.onGone("med-1", 0);
  assert.deepEqual(played, ["cratePickup"]);
});
