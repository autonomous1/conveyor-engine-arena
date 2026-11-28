// 219 offline chain over the proto fork: the trap's own corner pose and the
// live-AABB filter. No host, no session: `npm run probe -- --tree proto pickup-trap.ts`.
// The world's `TrapProbe` line and the plan reason are the report's BEFORE/AFTER.
import { createBotWorld } from "../src/world.ts";
import { loadArena } from "../../../src/server/world-loader.ts";
import { planPath } from "../../../src/shared/nav/path.ts";

const arena = loadArena();
const live = (arena.view.pickups ?? []).map((pickup) => pickup.id);
const world = createBotWorld(arena.view);
world.applyWelcome({ pickups: live, doors: [], ammo: 0, keys: [] });
const nav = () => ({
  aabbs: world.aabbs,
  doors: arena.view.doors,
  pawnRadius: world.pawnRadius,
  pawnHeight: world.pawnHeight,
});
// The trap report's pose and target (the shelf weapon, hall-5 north wall).
const FROM = { x: 55.84, y: 0, z: -18.66 };
const TO = { x: 53.83, y: 0, z: -22.83 };
const gate = () => "open" as const;

const before = planPath(arena.sceneGraph!, FROM, TO, gate, { view: nav() });
console.log(`BEFORE plan=${before.ok ? "ok" : before.reason}`);
world.applyPickupGone("alien-weapon-1-7-3");
const after = planPath(arena.sceneGraph!, FROM, TO, gate, { view: nav() });
console.log(`AFTER plan=${after.ok ? "ok" : after.reason}`);

// The re-add case: a later welcome puts the pickup back; the box must return.
world.applyWelcome({ pickups: [...live, "alien-weapon-1-7-3"], doors: [], ammo: 0, keys: [] });
const readd = planPath(arena.sceneGraph!, FROM, TO, gate, { view: nav() });
console.log(`RE-ADD plan=${readd.ok ? "ok" : readd.reason}`);
