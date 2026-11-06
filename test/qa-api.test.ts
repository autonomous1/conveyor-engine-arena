import assert from "node:assert/strict";
import test from "node:test";
import { installQaApi, isQaMode, takeHashToken, type QaApi } from "../src/client/qa.ts";

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

test("upload posts the snapshot png with the page token", async () => {
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
  const dataUrl = `data:image/png;base64,${png.toString("base64")}`;
  const previous = { window: globalThis.window, fetch: globalThis.fetch };
  const posted: Array<{ url: string; init: RequestInit }> = [];
  const win: { __qa?: QaApi } = {};
  globalThis.window = win as unknown as Window & typeof globalThis;
  const okFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    posted.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify({ ok: true, id: "snap-id", url: "/qa-snaps/snap-id.png" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  globalThis.fetch = okFetch;
  try {
    installQaApi({
      scene: {
        camera: {
          fov: 55,
          position: { set() {} },
          up: { set() {} },
          lookAt() {},
          updateProjectionMatrix() {},
        },
        cameraLocked: false,
        renderer: { domElement: { toDataURL: () => dataUrl } },
      },
      net: { firstSnapshot: Promise.resolve() },
      render() {},
      freeze() {},
      follow() {},
      clearFollow() {},
      doors: () => [],
      pickups: () => [],
      pawns: () => [],
      token: "page-token",
    });
    const api = win.__qa;
    assert.ok(api);
    assert.equal(typeof api.upload, "function");
    assert.equal(await api.snapshot(), dataUrl);

    const shot = await api.upload();
    assert.deepEqual(shot, { id: "snap-id", url: "/qa-snaps/snap-id.png" });
    assert.equal(posted.length, 1);
    const call = posted[0];
    assert.ok(call);
    assert.equal(call.url, "/qa/snapshots");
    assert.equal(call.init.method, "POST");
    const headers = call.init.headers as Record<string, string>;
    assert.equal(headers.authorization, "Bearer page-token");
    assert.equal(headers["content-type"], "image/png");
    const body = call.init.body;
    assert.ok(body instanceof Uint8Array);
    assert.ok(Buffer.from(body).equals(png));

    globalThis.fetch = (async () => new Response("forbidden", { status: 403 })) as typeof fetch;
    await assert.rejects(() => api.upload(), { message: "403" });
  } finally {
    globalThis.window = previous.window;
    globalThis.fetch = previous.fetch;
  }
});
