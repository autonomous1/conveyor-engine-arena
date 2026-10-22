#!/usr/bin/env bash
npx blueprint-scene bake \
--svg ./dev/scenes/arena-1/designs/arena-1.svg \
--models ./web/assets/models \
--game ./web/game/arena.game.json \
--collision-dir ./dev/scenes/arena-1/generated \
--out ./web/game/buildings.placements.json
