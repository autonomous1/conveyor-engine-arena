#!/usr/bin/env bash
../blueprint-scene/bin/blueprint-scene scene-graph \
--buildings ./web/game/buildings.placements.json \
--floors ./dev/scenes/arena-1/designs/floorplans \
--rooms ./web/assets/models \
--doors ./web/game/doors.placements.json \
--room-doors ./web/game/rooms.placements.json \
--bounds ./web/game/bounds.json \
--out ./web/game/scene-graph.json
