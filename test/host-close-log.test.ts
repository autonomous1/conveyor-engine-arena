import assert from "node:assert/strict";
import { test } from "node:test";
import { closeLine } from "../src/server/arena-host.ts";

test("close_line_names_the_code_and_reason", () => {
  assert.equal(
    closeLine(2, 14, true, { code: 1005, reason: "" }),
    "close client=2 owned=14 gateway=connected code=1005 reason=-",
  );
});

test("close_line_collapses_reason_whitespace", () => {
  assert.equal(
    closeLine(2, 14, true, { code: 1000, reason: " going  away\n" }),
    "close client=2 owned=14 gateway=connected code=1000 reason=going away",
  );
});

test("close_line_without_an_event_says_code_none", () => {
  assert.equal(closeLine(3, undefined, false), "close client=3 owned=no gateway=closed code=none reason=-");
});

test("close_line_without_a_pawn_says_owned_no", () => {
  assert.equal(
    closeLine(4, undefined, true, { code: 1006, reason: "transport" }),
    "close client=4 owned=no gateway=connected code=1006 reason=transport",
  );
});
