# Factory interfaces

## Server
HeldInputs — src/server/game.ts:55 — latest command per entity
DoorBlockers — src/server/doors.ts:36 — one live kernel obstacle per door
ArenaDoors — src/server/doors.ts:90 — open, locked, and held doors, plus the use gate
ArenaElevators — src/server/elevators.ts:53 — cab calls, motion, and carried pawns
ArenaFire — src/server/fire.ts:21 — hitscan, lasers, and the shared fire counters
ArenaGrenades — src/server/grenade.ts:25 — in-flight grenades, not world entities
HostBotSense — src/server/bot-sense.ts:24 — host adapter over the bot sensor
HostBotBrain — src/server/bot-brain.ts:66 — goal claims for unowned wander bots

## Shared
PawnHealth — src/shared/health.ts:61 — per-pawn hp, death, and respawn timers
PawnKit — src/shared/pickups.ts:172 — per-pawn ammo count and weapon id
PickupHost — src/shared/pickups.ts:206 — remaining placements and per-pawn keys
Audit — src/shared/audit.ts:67 — six host fire counters
NavCache — src/shared/nav/legs.ts:38 — reused occupancy grids and region overlays
RegionCache — src/shared/nav/regions.ts:75 — reused region graphs
RoadCache — src/shared/nav/route.ts:72 — compiled portal nets for one graph

## Bots
ExitIndex — src/shared/bots/sense.ts:105 — which places can reach the exit
BotSensor — src/shared/bots/sense.ts:133 — per-bot surroundings, overwritten in place
Mind — src/shared/bots/arbiter.ts:38 — escape latch for one bot
