import { readFileSync } from "node:fs";

const which = process.argv[2];
const failures = [];

if (which === "web") checkWeb();
else if (which === "solo") checkSolo();
else {
  console.error("usage: node scripts/check-web-bundle.mjs <web|solo>");
  process.exit(1);
}

if (failures.length) {
  for (const line of failures) console.error(line);
  process.exit(1);
}
console.log(`check:${which} ok`);

function checkWeb() {
  const js = readFileSync("dist/web/client.js", "utf8");
  const meta = JSON.parse(readFileSync("dist/web/meta.json", "utf8"));
  for (const name of ["createArenaHost", "EngineWsServer", "memoryPair", "compileGame", "preloadGameFiles"]) {
    if (js.includes(name)) failures.push(`web client.js contains ${name}`);
  }
  for (const input of Object.keys(meta.inputs ?? {})) {
    if (input.includes("src/server/") || input.includes("conveyor-engine-transport-ws") || input.includes("conveyor-engine-world") || input.includes("conveyor-engine-assets")) {
      failures.push(`web bundle input ${input}`);
    }
  }
}

function checkSolo() {
  const js = readFileSync("dist/solo/client.js", "utf8");
  const html = readFileSync("dist/solo/index.html", "utf8");
  const meta = JSON.parse(readFileSync("dist/solo/meta.json", "utf8"));
  if (js.includes("node:")) failures.push("solo client.js contains a node: specifier");
  if (js.includes("require(")) failures.push("solo client.js contains require(");
  if (js.includes("process.env")) failures.push("solo client.js contains process.env");
  // ArrayBuffer.isView contains the letters Buffer. A word boundary keeps that
  // and still rejects Node's Buffer.from / Buffer.alloc.
  if (/(?<![A-Za-z0-9_$])Buffer\./.test(js)) failures.push("solo client.js contains Buffer.");
  if (js.includes("readFileSync")) failures.push("solo client.js contains readFileSync");
  if (js.includes("new WebSocket(")) failures.push("solo client.js contains new WebSocket(");
  if (js.includes('"/assets/') || js.includes('"/arena.json"')) failures.push("solo client.js contains an absolute asset or arena.json path");
  if (html.includes('"/assets/') || html.includes('"/arena.json"')) failures.push("solo index.html contains an absolute asset or arena.json path");
  for (const input of Object.keys(meta.inputs ?? {})) {
    if (input.includes("src/server/auth/")) failures.push(`solo bundle input ${input}`);
  }
}
