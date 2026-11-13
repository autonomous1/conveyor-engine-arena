// Bundled per build by profile-host.mjs (esbuild from the build's node_modules) so the protocol matches that build.
// argv: <url> <mode stationary|moving|fight> <seconds> <index>
import { connectBot } from "__CONNECTION__";

const [url, mode, seconds, index] = process.argv.slice(2);
const session = await connectBot({ url, token: "", name: `prof-${index}`, role: "player", onLog: (l) => console.error(`[player ${index}] ${l}`) });
console.log(JSON.stringify({ joined: true, index }));
const start = Date.now();
let yaw = Number(index) * 1.3;
const timer = setInterval(() => {
  const t = (Date.now() - start) / 1000;
  if (mode === "moving") {
    // Deterministic pattern: walk forward, sweep yaw, reverse every 6 s, strafe every 4 s.
    yaw += 0.04;
    const fwd = Math.floor(t / 6) % 2 === 0 ? -1 : 1;
    const strafe = Math.floor(t / 4) % 3 === 0 ? (Math.floor(t / 2) % 2 ? 1 : -1) : 0;
    session.input.sendInput({ moveX: strafe, moveZ: fwd, yaw });
  } else if (mode === "fight") {
    // Stand and shoot. Players 1 and 2 each take a pair of bots so four can
    // fight back. A third player is past the host cap and those bots evade.
    // Human pads are skipped so the players do not shoot each other.
    const spawns = session.world.playerSpawns ?? [];
    const bots = session.world.others().filter((pawn) => {
      return !spawns.some((spawn) => Math.hypot(pawn.x - spawn.x, pawn.z - spawn.z) < 2.5);
    });
    bots.sort((a, b) => a.id - b.id);
    const who = Math.max(0, Number(index) - 1);
    const slot = Math.floor(t / 2) % 2;
    const target = bots.length > 0 ? bots[(who * 2 + slot) % bots.length] : undefined;
    const me = session.world.self();
    let pitch = 0;
    if (me && target) {
      const dx = target.x - me.x;
      const dy = (target.y + 1) - (me.y + 1.6);
      const dz = target.z - me.z;
      yaw = Math.atan2(dx, dz);
      pitch = Math.atan2(dy, Math.hypot(dx, dz));
    }
    session.input.sendInput({ moveX: 0, moveZ: 0, yaw });
    session.input.fire(yaw, pitch);
  } else {
    session.input.sendInput({ moveX: 0, moveZ: 0, yaw });
  }
  if (t > Number(seconds)) { clearInterval(timer); session.close(); setTimeout(() => process.exit(0), 200); }
}, 50);
process.on("SIGTERM", () => { session.close(); process.exit(0); });
