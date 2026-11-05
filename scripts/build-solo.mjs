import { build } from "esbuild";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

await rm("dist/solo", { recursive: true, force: true });
await mkdir("dist/solo", { recursive: true });
const nodeFilesStub = resolve("src/client/game-files-node-stub.ts");
const result = await build({
  entryPoints: ["src/client/solo-main.ts"],
  bundle: true,
  format: "esm",
  minify: true,
  sourcemap: true,
  outfile: "dist/solo/client.js",
  platform: "browser",
  target: "es2022",
  legalComments: "none",
  metafile: true,
  define: {
    __ASSET_BASE__: '"./"',
    __ARENA_SOLO__: "true",
    // three.js zstddec keeps a Node fallback, Buffer.from(base64). The browser
    // path uses fetch. A literal keeps that string out of client.js.
    "Buffer.from": "null",
  },
  alias: {
    "node:http": "./src/client/node-stub.ts",
    "ws": "./src/client/node-stub.ts",
    "node:fs/promises": "./src/client/node-stub.ts",
    "node:path": "./src/client/node-stub.ts",
  },
  plugins: [
    {
      name: "stub-game-files-node",
      setup(b) {
        b.onResolve({ filter: /game-files-node\.js$/ }, () => ({ path: nodeFilesStub }));
      },
    },
  ],
});
await writeFile("dist/solo/meta.json", JSON.stringify(result.metafile));
await cp("web/index.html", "dist/solo/index.html");
const landing = await readFile("web/landing-page.html", "utf8");
await writeFile("dist/solo/landing-page.html", landing.replace(/<!-- play:start -->[\s\S]*?<!-- play:end -->/g, ""));
await cp("web/assets", "dist/solo/assets", { recursive: true });
await cp("web/game", "dist/solo/game", { recursive: true });
const basis = "node_modules/three/examples/jsm/libs/basis";
await mkdir("dist/solo/assets/basis", { recursive: true });
await cp(`${basis}/basis_transcoder.js`, "dist/solo/assets/basis/basis_transcoder.js");
await cp(`${basis}/basis_transcoder.wasm`, "dist/solo/assets/basis/basis_transcoder.wasm");
