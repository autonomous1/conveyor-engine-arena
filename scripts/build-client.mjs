import { build } from "esbuild";
import { cp, mkdir, rm, writeFile } from "node:fs/promises";

await mkdir("dist/web", { recursive: true });
const result = await build({
  entryPoints: ["src/client/main.ts"],
  bundle: true,
  format: "esm",
  minify: true,
  sourcemap: true,
  outfile: "dist/web/client.js",
  platform: "browser",
  target: "es2022",
  legalComments: "none",
  metafile: true,
  define: { __ASSET_BASE__: '"/"', __ARENA_SOLO__: "false" },
});
await build({
  entryPoints: ["src/client/auth-key.ts"],
  bundle: true,
  format: "esm",
  minify: true,
  sourcemap: true,
  outfile: "dist/web/auth-key.js",
  platform: "browser",
  target: "es2022",
  legalComments: "none",
  define: { __ARENA_SOLO__: "false" },
});
await writeFile("dist/web/meta.json", JSON.stringify(result.metafile));
await cp("web/index.html", "dist/web/index.html");
await cp("web/landing-page.html", "dist/web/landing-page.html");
await cp("web/qa.html", "dist/web/qa.html");
await rm("dist/web/assets", { recursive: true, force: true });
await cp("web/assets", "dist/web/assets", { recursive: true });
const basis = "node_modules/three/examples/jsm/libs/basis";
await mkdir("dist/web/assets/basis", { recursive: true });
await cp(`${basis}/basis_transcoder.js`, "dist/web/assets/basis/basis_transcoder.js");
await cp(`${basis}/basis_transcoder.wasm`, "dist/web/assets/basis/basis_transcoder.wasm");
