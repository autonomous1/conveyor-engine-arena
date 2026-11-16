// Scratch: two clients join together, both walk 10 m forward, hold 60 s, exit.
// Run: CE_TOKEN=<jwt> node --import ./scripts/ts-ext-register.mjs packages/bot-client/tests/two-race.ts
import { readFileSync } from "node:fs";
import { BotRejected, connectBot, type BotSession } from "../../../packages/bot-client/src/connection.ts";
import { openNodeSocket } from "../../../packages/bot-client/src/node-socket.ts";
import { INPUT_HZ } from "../../../src/shared/look.ts";
import { wishTo } from "../../../src/shared/nav/follow.ts";

const STEP_MS = 1000 / INPUT_HZ;
const URL_ = "wss://arena.tszakacs.com";
const token = (process.env.CE_TOKEN ?? "").trim() || readFileSync("/home/tim/.config/ce-arena/qa-token.pem", "utf8").trim();
const t0 = Date.now();
const secs = () => ((Date.now() - t0) / 1000).toFixed(2);
const log = (line: string) => console.log(line);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const sessions: BotSession[] = [];

try {
  for (const name of ["dev-1", "dev-2"]) {
    try {
      const session = await connectBot({
        url: URL_,
        token,
        name,
        role: "qa",
        openSocket: openNodeSocket,
        onLog: (line) => console.error(`[${name}] ${line}`),
      });
      sessions.push(session);
      const started = Date.now();
      while (!session.world.self() && Date.now() - started < 8000) await sleep(40);
      const self = session.world.self();
      log(`${name} joined role=${session.world.role() ?? "none"} self=${self?.x.toFixed(2)},${self?.y.toFixed(2)},${self?.z.toFixed(2)} yaw=${self?.yaw.toFixed(2)} place=${self ? session.world.placeOf(self)?.id : "?"} others=${session.world.others().length}`);
    } catch (err) {
      log(`${name} JOIN FAILED: ${err instanceof BotRejected ? err.code : err instanceof Error ? err.message : String(err)}`);
    }
  }
  log(`seated ${sessions.length} clients t=${secs()}s`);
  if (sessions.length < 2) {
    log("two-client race not possible: only " + sessions.length + " seat(s)");
  } else {
    // Forward targets from each spawn yaw.
    const targets = sessions.map((s) => {
      const self = s.world.self()!;
      return { x: self.x + Math.sin(self.yaw) * 10, z: self.z + Math.cos(self.yaw) * 10, from: { x: self.x, z: self.z } };
    });
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      let all = true;
      for (let i = 0; i < sessions.length; i += 1) {
        const s = sessions[i]!;
        const self = s.world.self();
        if (!self) {
          all = false;
          continue;
        }
        const d = Math.hypot(self.x - targets[i]!.x, self.z - targets[i]!.z);
        if (d > 0.6) {
          all = false;
          s.input.sendInput(wishTo({ x: self.x, y: self.y, z: self.z, vx: 0, vz: 0, yaw: self.yaw }, targets[i]!, d < 1.5 ? 0.5 : 1));
        }
      }
      if (all) break;
      await sleep(STEP_MS);
    }
    for (let i = 0; i < sessions.length; i += 1) {
      const s = sessions[i]!;
      const self = s.world.self();
      const moved = self ? Math.hypot(self.x - targets[i]!.from.x, self.z - targets[i]!.from.z) : 0;
      log(`dev-${i + 1} walk done moved=${moved.toFixed(2)}m self=${self?.x.toFixed(2)},${self?.y.toFixed(2)},${self?.z.toFixed(2)} place=${self ? s.world.placeOf(self)?.id : "?"}`);
    }
    // Hold 60 s, no inputs.
    for (let i = 0; i < 6; i += 1) {
      await sleep(10_000);
      log(`hold t=${secs()}s ` + sessions.map((s, j) => {
        const p = s.world.self();
        return `dev-${j + 1}=${p ? `${p.x.toFixed(2)},${p.z.toFixed(2)}` : "none"}`;
      }).join(" "));
    }
  }
} catch (err) {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
} finally {
  for (const s of sessions) s.close();
  await sleep(400);
  log(`EXITED t=${secs()}s clients=${sessions.length}`);
}
