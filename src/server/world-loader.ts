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
  /** Human pad. Unset pawns wander on `spawnPoints`. */
  role?: "player";
};

export type LoadedArena = {
  world: AuthoritativeWorld;
  agents: WanderAgent[];
  view: ArenaView;
  /** Human pads. Wander pawns are not created here. */
  playerSpawns: ReadonlyArray<{ id: string; x: number; y: number; z: number; yaw: number }>;
};

export function loadArena(): LoadedArena {
  const game = loadInstalledGame();
  const world = new AuthoritativeWorld({ worldVersion: game.view.world });
  world.pawnHeight = game.view.pawnHeight;
  applyStaticWorldDefinition(world, game.definition);
  const bots = game.view.npcModelChoices?.length ? game.view.npcModelChoices : game.view.modelChoices;
  const humans = game.view.modelChoices;
  const playerSpawns = (game.view.playerSpawns ?? []).map((spawn) => ({
    id: spawn.id,
    x: spawn.x,
    y: 0,
    z: spawn.z,
    yaw: spawn.yaw,
  }));
  const agents: WanderAgent[] = [
    ...game.definition.spawnPoints.map((spawn, index) => spawnAgent(world, game, spawn, bots[index % bots.length] ?? humans[0] ?? "grok-bot", index, "walk")),
    ...playerSpawns.map((spawn, index) => spawnAgent(
      world,
      game,
      spawn,
      humans[0] ?? "grok-bot",
      game.definition.spawnPoints.length + index,
      "idle",
      "player",
    )),
  ];
  world.commit(0n);
  return { world, agents, view: game.view, playerSpawns };
}

function spawnAgent(
  world: AuthoritativeWorld,
  game: ReturnType<typeof loadInstalledGame>,
  spawn: { x: number; y: number; z: number },
  assetKey: string,
  index: number,
  gait: Movement,
  role?: "player",
): WanderAgent {
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
  const speeds = Object.fromEntries(
    (Object.entries(animations ?? {}) as Array<[Movement, { speed: number }]>).map(([movement, entry]) => [movement, entry.speed]),
  ) as Record<Movement, number>;
  return {
    id,
    heading: index === 0 ? 0.4 : 2.2,
    gait,
    nextTurn: 10 + index * 8,
    speeds,
    ...(role ? { role } : {}),
  };
}
