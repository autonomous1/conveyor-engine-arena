import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const PLAY_MARK = /<!-- play:start -->[\s\S]*?<!-- play:end -->/g;

function textFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { recursive: true })) {
    const file = path.join(dir, String(entry));
    if (!statSync(file).isFile()) continue;
    if (/\.(html|js|css|mjs|json|svg|txt)$/.test(file)) out.push(file);
  }
  return out;
}

test("landing page ships the play form and solo strips it", () => {
  const web = "dist/web/landing-page.html";
  assert.equal(existsSync(web), true, "dist/web/landing-page.html is missing; run npm run build");
  assert.equal(existsSync("dist/web/auth-key.js"), true, "dist/web/auth-key.js is missing; run npm run build");
  const html = readFileSync(web, "utf8");
  assert.match(html, /id="play"/);
  assert.match(html, /id="auth-key"/);
  assert.match(html, /type="password"/);
  assert.match(html, /auth-key\.js/);
  assert.doesNotMatch(html, /udp/i);
  assert.doesNotMatch(html, /lockstep/i);

  const source = readFileSync("web/landing-page.html", "utf8");
  const stripped = source.replace(PLAY_MARK, "");
  assert.equal(stripped.includes('id="play"'), false);
  assert.equal(stripped.includes("auth-key.js"), false);

  for (const file of textFiles("dist/solo")) {
    const text = readFileSync(file, "utf8");
    assert.equal(text.includes('id="play"'), false, file);
  }
});
