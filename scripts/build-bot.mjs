import { chmod, mkdir } from "node:fs/promises";
import { build } from "esbuild";

await mkdir("packages/bot-client/dist", { recursive: true });
await build({
  entryPoints: ["packages/bot-client/src/cli.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  outfile: "packages/bot-client/dist/ce-bot.mjs",
  legalComments: "none",
  // `ws` is CJS and requires Node builtins. ESM has no `require`, so the
  // bundle supplies one. The shebang stays the first line.
  banner: {
    js: [
      "#!/usr/bin/env node",
      "import { createRequire } from 'node:module';",
      "const require = createRequire(import.meta.url);",
    ].join("\n"),
  },
  // Optional native accelerators. `ws` loads them when present and runs without them.
  external: ["bufferutil", "utf-8-validate"],
});
await chmod("packages/bot-client/dist/ce-bot.mjs", 0o755);
