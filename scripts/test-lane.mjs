// Unit/integration lane selector for `npm run test:unit` and `test:integration`.
// Classifies by whether a test imports the built tree, so the lane membership
// follows the source and cannot drift from a hand list.
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";

const lane = process.argv[2];
if (lane !== "unit" && lane !== "integration") {
  console.error("usage: node scripts/test-lane.mjs unit|integration");
  process.exit(2);
}

const files = readdirSync("test").filter((file) => file.endsWith(".test.ts")).sort();
// Direct imports, spawn strings, and existence checks all count: any reference
// to `dist/` means the test reads the built tree. Live host/bot tests start a
// real server too, so they belong in the integration lane.
const isIntegration = (file) =>
  /dist\/|startLiveArena|startArenaServer|connectBot\b/.test(readFileSync(`test/${file}`, "utf8"));
const chosen = files.filter((file) => isIntegration(file) === (lane === "integration"));
if (chosen.length === 0) {
  console.error(`no ${lane} tests`);
  process.exit(2);
}

const result = spawnSync(
  process.execPath,
  ["--import", "./scripts/ts-ext-register.mjs", "--test", ...chosen.map((file) => `test/${file}`)],
  { stdio: "inherit" },
);
process.exit(result.status ?? 1);
