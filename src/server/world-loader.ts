import { AuthoritativeWorld, applyStaticWorldDefinition } from "conveyor-engine-world";
import { loadInstalledGame } from "./load-game.js";
import type { ArenaView } from "../shared/arena-view.js";
import type { Movement } from "../shared/movements.js";

export type WanderAgent = {
  id: number;
  heading: number;
  gait: string;
  nextTurn: number;
  speeds: Record<string, number>;
};

export type LoadedArena = {
  world: AuthoritativeWorld;
  agents: WanderAgent[];
  view: ArenaView;
};

export function loadArena(): LoadedArena {
  const game = loadInstalledGame();
  const world = new AuthoritativeWorld({ worldVersion: game.view.world });
  applyStaticWorldDefinition(world, game.definition);
  const choices = game.view.characters.map((character) => character.id);
  const agents: WanderAgent[] = game.definition.spawnPoints.map((spawn, index) => {
    const assetKey = choices[index % choices.length] ?? "player-a";
    const id = world.createEntity(0n, { type: "pawn", shape: "capsule", assetKey }, index + 1);
    world.enqueue({
      kind: "setTransform",
      entity: id,
      position: { x: spawn.x, y: spawn.y, z: spawn.z },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      scale: { x: 1, y: 1, z: 1 },
    });
    world.enqueue({ kind: "setBounds", entity: id, radius: game.view.pawnRadius });
    const animations = game.view.characters.find((character) => character.id === assetKey)?.animations;
    const gait: Movement = "walk";
    // TODO: fix
    //world.triggerAction(id, gait);
    const speeds = Object.fromEntries(
      (Object.entries(animations ?? {}) as Array<[Movement, { speed: number }]>).map(([movement, entry]) => [movement, entry.speed]),
    ) as Record<Movement, number>;
    return { id, heading: index === 0 ? 0.4 : 2.2, gait, nextTurn: 10 + index * 8, speeds };
  });
  world.commit(0n);
  return { world, agents, view: game.view };
}
