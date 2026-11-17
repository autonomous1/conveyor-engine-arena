#!/usr/bin/env bash
./node_modules/.bin/blueprint-scene bake \
--svg ./dev/scenes/arena-1/designs/arena-1.svg \
--models ./web/assets/models \
--floors ./dev/scenes/arena-1/designs/floorplans \
--rooms ./web/assets/models \
--game ./web/game/arena.game.json \
--collision-dir ./dev/scenes/arena-1/generated \
--out ./web/game/buildings.placements.json

# Static spatial DAG foundation (task 59). The flat boxes stay for now.
node ../blueprint-scene/src/cli.ts spatial-dag \
  --placements ./web/game/buildings.placements.json \
  --scene-graph ./web/game/scene-graph.json \
  --bounds ./web/game/bounds.json \
  --out ./web/game/spatial-dag.json
