import { build } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";

await mkdir("dist/web", { recursive: true });
await build({
  entryPoints: ["src/client/main.ts"],
  bundle: true,
  format: "esm",
  minify: true,
  sourcemap: true,
  outfile: "dist/web/client.js",
  platform: "browser",
  target: "es2022",
  legalComments: "none",
});
await cp("web/index.html", "dist/web/index.html");
await rm("dist/web/assets", { recursive: true, force: true });
await cp("web/assets", "dist/web/assets", { recursive: true });
