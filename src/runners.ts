import { defineScenario, run, type LinkProfile } from "conveyor-graph-simulator/reference";
import { SimulatedNetPath } from "conveyor-engine-replication";

const PAWN = { type: "pawn" as const, shape: "capsule" as const };

export type RunnerName = "lossless" | "lossy" | "partition";

export type RunnerResult = {
  name: RunnerName;
  hashes: string[];
  deliveries: number;
  sends: number;
  rejects: number;
  duplicateIgnored: number;
  mirrorCounts: number[];
  worldHash: string;
};

function profileOf(name: RunnerName): LinkProfile {
  if (name === "lossy") return { dropPerU64: 1n << 62n, latencyTicks: 1, jitterTicks: 1 };
  if (name === "partition") return {};
  return {};
}

export function makeRunner(name: RunnerName, seed = 11n, ticks = 8) {
  const path = new SimulatedNetPath({ radius: 32 });
  const scenario = defineScenario({
    id: `example-${name}`,
    seed,
    initialState: {},
    ticks,
    setupNetwork(net) {
      path.setupNetwork(net, profileOf(name));
      if (name === "partition") path.partition(net, 1, 1n, 4n);
    },
    buildAdmit(g, ctx) {
      path.buildAdmit(g, ctx);
    },
    buildSim(g, ctx) {
      path.buildSim(g, ctx);
    },
    schedule(rt, due) {
      if (name === "partition" && due === 5n) path.replicator.requestResync(1);
      rt.scheduleExternal(`t-${due}`, {
        creates:
          due === 1n
            ? [
                { render: PAWN, owner: 1 },
                { render: PAWN, owner: 2 },
              ]
            : undefined,
        inputs:
          due === 1n
            ? []
            : [
                { clientId: 1, seq: Number(due) - 1, moveX: 1, moveZ: 0, yaw: 0 },
                { clientId: 2, seq: Number(due) - 1, moveX: 0, moveZ: 1, yaw: 0 },
              ],
      });
    },
  });
  return { path, scenario };
}

export async function runNamed(name: RunnerName, seed = 11n, ticks = 8): Promise<RunnerResult> {
  const { path, scenario } = makeRunner(name, seed, ticks);
  const result = await run(scenario, "deterministicFast");
  return {
    name,
    hashes: result.hashes,
    deliveries: path.deliveries,
    sends: path.sends,
    rejects: path.rejects,
    duplicateIgnored: path.duplicateIgnored,
    mirrorCounts: [path.mirrors.get(1)?.ids().length ?? 0, path.mirrors.get(2)?.ids().length ?? 0],
    worldHash: path.world.world.canonicalJson(),
  };
}
