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

## Client
Sfx — src/client/audio.ts:135 — one Web Audio context, decoded after unlock
EchoDedupe — src/client/audio.ts:503 — drop the host echo of your own shot
CharacterFx — src/client/character-fx.ts:50 — spawn and despawn fade timelines
ClientDiag — src/client/diag.ts:51 — first fault in full, later repeats counted
DoorSounds — src/client/door-sound.ts:29 — door open and close from host frames
ElevatorSounds — src/client/elevator-sound.ts:24 — cab departure sound that follows the cab
PickupSounds — src/client/pickup-sound.ts:48 — one pickup sound, yours or at the placement
ElevatorRooms — src/client/elevator-room.ts:49 — shift a cab's room with host frames
ExplosionFx — src/client/explosion.ts:285 — pooled blast sprites
GrenadeProps — src/client/grenade.ts:31 — grenade meshes from host poses
Hud — src/client/hud.ts:19 — status bar, crosshair, inspect line, and stats
InfoProbe — src/client/info-probe.ts:32 — crosshair inspect string
LaserBeams — src/client/laser.ts:10 — one reused beam per shooter
OptionsModel — src/client/options.ts:32 — option switches kept in localStorage
OptionsDialog — src/client/options.ts:62 — options panel and host fire counters
PlacementVisibility — src/client/placements.ts:23 — show, hide, and shift a placement
PawnLayer — src/client/presentation.ts:104 — cloned characters, owned pawn hidden
RateWindow — src/client/rates.ts:16 — half-second fps and tick averages
ViewModel — src/client/viewmodel.ts:40 — first-person weapon on the camera
AabbDebug — src/client/aabb-debug.ts:60 — obstacle wireframe the caller parents
ArenaScene — src/client/arena-scene.ts:14 — renderer, scene, camera, and content group
HitMarker — src/client/hit-marker.ts:13 — crosshair circle for a local shot
SceneMap — src/client/scene-map.ts:348 — corner map and the local player marker
