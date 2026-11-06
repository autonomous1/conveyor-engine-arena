import assert from "node:assert/strict";
import test from "node:test";
import { isQaMode, takeHashToken } from "../src/client/qa.ts";

test("QA mode is only the search qa=1", () => {
  assert.equal(isQaMode("?qa=1"), true);
  assert.equal(isQaMode("qa=1"), true);
  assert.equal(isQaMode("?qa=1&ws=ws://127.0.0.1/"), true);
  assert.equal(isQaMode(""), false);
  assert.equal(isQaMode("?qa"), false);
  assert.equal(isQaMode("?qa=true"), false);
  assert.equal(isQaMode("?qa=2"), false);
  assert.equal(isQaMode("?QA=1"), false);
  assert.equal(isQaMode("?mode=qa"), false);
});

test("the token fragment is read and then removed", () => {
  const calls: unknown[][] = [];
  const history = {
    replaceState(...args: unknown[]) {
      calls.push(args);
    },
  };
  const loc = { hash: "#token=abc.def.ghi", pathname: "/qa.html", search: "?qa=1" };
  assert.equal(takeHashToken(loc, history), "abc.def.ghi");
  assert.deepEqual(calls, [[null, "", "/qa.html?qa=1"]]);

  calls.length = 0;
  const bare = { hash: "", pathname: "/qa.html", search: "?qa=1" };
  assert.equal(takeHashToken(bare, history), undefined);
  assert.deepEqual(calls, []);

  const empty = { hash: "#token=", pathname: "/qa.html", search: "?qa=1" };
  assert.equal(takeHashToken(empty, history), undefined);
  assert.deepEqual(calls, []);
});
