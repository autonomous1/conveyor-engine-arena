// Bundled per build by profile-host.mjs (esbuild from the build's node_modules) so the protocol matches that build.
// argv: <url> <mode stationary|moving> <seconds> <index>
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
  } else {
    session.input.sendInput({ moveX: 0, moveZ: 0, yaw });
  }
  if (t > Number(seconds)) { clearInterval(timer); session.close(); setTimeout(() => process.exit(0), 200); }
}, 50);
process.on("SIGTERM", () => { session.close(); process.exit(0); });
