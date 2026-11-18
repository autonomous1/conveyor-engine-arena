#!/usr/bin/env bash
# Same manifest-derived capsule as bake-scene-graph.sh, so the dev bake cannot drift.
RADIUS=$(node -e 'process.stdout.write(String(require("./web/game/arena.game.json").player.radius))')
HEIGHT=$(node -e 'process.stdout.write(String(require("./web/game/arena.game.json").player.height))')
../blueprint-scene/bin/blueprint-scene scene-graph \
--buildings ./web/game/buildings.placements.json \
--floors ./dev/scenes/arena-1/designs/floorplans \
--rooms ./web/assets/models \
--doors ./web/game/doors.placements.json \
--room-doors ./web/game/rooms.placements.json \
--props ./web/game/props.placements.json \
--bounds ./web/game/bounds.json \
--radius "$RADIUS" \
--height "$HEIGHT" \
--out ./web/game/scene-graph.json
