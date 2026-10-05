#!/usr/bin/env bash
./node_modules/blueprint-scene/bin/blueprint-scene bake \
--svg ./dev/scenes/arena-1/designs/arena-1.svg \
--models ./web/assets/models \
--collision-dir ./dev/scenes/arena-1/generated \
--out ./web/game/buildings.placements.json
