#!/usr/bin/env bash
if [[ -x ../blueprint-scene/bin/blueprint-scene ]]; then
  BIN=../blueprint-scene/bin/blueprint-scene
else
  BIN=./node_modules/.bin/blueprint-scene
fi
# The manifest is the only authored capsule. The CLI defaults (0.5 / 1.8) are
# not the arena's, and game-manifest.ts warns when the baked regions disagree.
RADIUS=$(node -e 'process.stdout.write(String(require("./web/game/arena.game.json").player.radius))')
HEIGHT=$(node -e 'process.stdout.write(String(require("./web/game/arena.game.json").player.height))')
"$BIN" scene-graph \
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
