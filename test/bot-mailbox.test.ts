import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { NOTE_MAX, openMailbox, sendCommand } from "../packages/bot-client/src/mailbox.ts";

function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "arena-mailbox-"));
}

function lines(file: string): string[] {
  return readFileSync(file, "utf8").split("\n").filter((line) => line.length > 0);
}

test("mailbox_creates_the_directory", () => {
  const root = tempDir();
  try {
    const dir = path.join(root, "a", "b");
    const box = openMailbox({ dir });
    assert.ok(existsSync(dir), dir);
    assert.equal(box.files.inbox, path.join(dir, "inbox.ndjson"));
    assert.equal(box.files.session, path.join(dir, "session.json"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("mailbox_polls_only_new_rows_and_restarts_after_truncation", () => {
  const root = tempDir();
  try {
    const dir = path.join(root, "box");
    sendCommand(dir, { id: "a" });
    sendCommand(dir, { id: "b" });
    const box = openMailbox({ dir, startAtEnd: true });
    assert.deepEqual(box.poll(), []);
    sendCommand(dir, { id: "c" });
    assert.deepEqual(box.poll(), ['{"id":"c"}']);
    assert.deepEqual(box.poll(), []);
    // A rewritten inbox is shorter than the offset: poll starts over.
    writeFileSync(box.files.inbox, '{"id":"d"}\n');
    assert.deepEqual(box.poll(), ['{"id":"d"}']);
    assert.deepEqual(box.poll(), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("send_command_then_poll_sees_it", () => {
  const root = tempDir();
  try {
    const dir = path.join(root, "box");
    sendCommand(dir, { cmd: "ping", id: "c1" });
    const box = openMailbox({ dir });
    assert.deepEqual(box.poll(), ['{"cmd":"ping","id":"c1"}']);
    assert.deepEqual(box.poll(), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("mailbox_out_writes_rows_verbatim", () => {
  const root = tempDir();
  try {
    const box = openMailbox({ dir: path.join(root, "box") });
    box.out({ type: "ack", id: "c1" });
    const rows = lines(box.files.outbox);
    assert.equal(rows.length, 1);
    const row = JSON.parse(rows[0]!) as Record<string, unknown>;
    assert.deepEqual(row, { type: "ack", id: "c1" });
    // No `at`/`t` envelope: the caller wraps (the two drivers disagree).
    assert.deepEqual(Object.keys(row).sort(), ["id", "type"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("mailbox_status_is_atomic_and_enveloped", () => {
  const root = tempDir();
  try {
    const now = 1_700_000_000_000;
    const box = openMailbox({ dir: path.join(root, "box"), startedAt: now - 1_500, now: () => now });
    box.status({ hp: 5 });
    const text = readFileSync(box.files.status, "utf8");
    assert.ok(text.endsWith("}\n"), "one JSON document plus a newline");
    assert.deepEqual(JSON.parse(text), { at: "2023-11-14T22:13:20.000Z", t: 1.5, hp: 5 });
    assert.equal(existsSync(`${box.files.status}.tmp`), false, "the tmp file was not renamed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("mailbox_notes_cap_and_session_overwrite", () => {
  const root = tempDir();
  try {
    const box = openMailbox({ dir: path.join(root, "box") });
    box.note("x".repeat(NOTE_MAX + 500));
    const notes = lines(box.files.notes);
    assert.equal(notes.length, 1);
    const bullet = notes[0]!;
    assert.ok(/^- \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z /.test(bullet), bullet.slice(0, 30));
    assert.ok(bullet.endsWith("x".repeat(NOTE_MAX)), "the note is clipped");
    assert.equal(bullet.length, 2 + 24 + 1 + NOTE_MAX);
    box.session({ ok: 1 });
    box.session({ ok: 2 });
    const session = lines(box.files.session);
    assert.equal(session.length, 1);
    assert.deepEqual(JSON.parse(session[0]!), { ok: 2 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
