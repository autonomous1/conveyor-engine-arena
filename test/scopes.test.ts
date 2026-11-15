import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { matchScopes, pathScopes, selectScope } from "../scripts/test-scope.mjs";

const tests = readdirSync("test").filter((file) => file.endsWith(".test.ts")).sort();
const manifest = JSON.parse(readFileSync("test/scopes.json", "utf8"));

test("every_test_has_a_scope", () => {
  const unclassified = tests.filter((file) => !manifest.always.includes(file) && matchScopes(manifest, file).length === 0);
  assert.deepEqual(unclassified, []);
});

test("path_map_and_scopes", () => {
  assert.deepEqual(pathScopes("src/shared/nav/legs.ts"), ["nav"]);
  assert.deepEqual(pathScopes("src/shared/doors.ts"), ["doors", "nav"]);
  assert.deepEqual(pathScopes("packages/bot-client/src/brain.ts"), ["bot"]);
  assert.ok(selectScope(manifest, ["nav"]).includes("nav-grid.test.ts"));
  assert.ok(selectScope(manifest, ["nav"]).includes("contract-grep.test.ts"));
});
