/**
 * Unit tests for the review store: stills and their revisions, the event log, its folds to
 * threads and reviewed marks, malformed lines and appends from two processes at once. Run with
 * `npm test` from mockup/.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { addStill, appendEvent, readEvents, reviewed, stills, threads } from "./review.mjs";

const REVIEW = fileURLToPath(new URL("./review.mjs", import.meta.url));
const HUMAN = { kind: "human", name: "dante" };
const AGENT = { kind: "agent", name: "claude" };
const REMARK = { type: "thread", author: HUMAN, still: "invite", rev: 1 };

/** An empty scratch dir, removed when the test ends. */
function scratch(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "mockup-review-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A PNG file in `dir` whose bytes end with `tag`, so revisions can be told apart. */
function png(dir, tag) {
  const file = path.join(dir, `${tag}.png`);
  writeFileSync(file, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(tag)]));
  return file;
}

/** A scratch dir holding the still `invite` at rev 1. */
async function withStill(t) {
  const dir = scratch(t);
  await addStill(dir, { file: png(dir, "a"), name: "invite", title: "Invite", source: "/invite", size: "390x844" });
  return dir;
}

test("addStill bumps the revision and keeps every revision's file", async (t) => {
  const dir = scratch(t);
  const name = "05-invite-user";
  const first = await addStill(dir, { file: png(dir, "a"), name, source: "/invite", size: "390x844" });
  assert.equal(first.title, name);
  assert.deepEqual(first.source, { path: "/invite", size: "390x844" });
  const second = await addStill(dir, { file: png(dir, "b"), name, title: "Invite a user" });
  assert.deepEqual(
    second.revs.map((r) => [r.n, r.file]),
    [
      [1, "stills/05-invite-user/1.png"],
      [2, "stills/05-invite-user/2.png"],
    ]
  );
  assert.equal(second.title, "Invite a user");
  assert.deepEqual(second.source, { path: "/invite", size: "390x844" });
  assert.match(readFileSync(path.join(dir, "stills/05-invite-user/1.png"), "utf8"), /a$/);
  assert.match(readFileSync(path.join(dir, "stills/05-invite-user/2.png"), "utf8"), /b$/);
  assert.deepEqual(stills(dir), [second]);
  assert.deepEqual(JSON.parse(readFileSync(path.join(dir, "stills/manifest.json"), "utf8")), [second]);
});

test("addStill rejects bad names, sizes and files that are not PNGs", async (t) => {
  const dir = scratch(t);
  await assert.rejects(addStill(dir, { file: png(dir, "a"), name: "../x" }), /still name/);
  await assert.rejects(addStill(dir, { file: png(dir, "a"), name: "x", size: "big" }), /390x844/);
  await addStill(dir, { file: png(dir, "a"), name: "home" });
  await assert.rejects(addStill(dir, { file: png(dir, "b"), name: "Home" }), /only in case/);
  writeFileSync(path.join(dir, "shot.png"), "not a png");
  await assert.rejects(addStill(dir, { file: path.join(dir, "shot.png"), name: "x" }), /not a PNG/);
  assert.deepEqual(
    stills(dir).map((s) => s.name),
    ["home"]
  );
});

test("appendEvent assigns seq, id and at, and readEvents resumes from a cursor", async (t) => {
  const dir = await withStill(t);
  const a = await appendEvent(dir, { ...REMARK, anchor: { x: 0.1, y: 0.2 }, body: "pin" });
  const b = await appendEvent(dir, { type: "reply", author: AGENT, thread: a.id, body: "on it" });
  assert.equal(a.seq, 1);
  assert.equal(b.seq, 2);
  assert.match(a.id, /^[0-9a-f]{8}$/);
  assert.notEqual(a.id, b.id);
  assert.ok(!Number.isNaN(Date.parse(a.at)));
  assert.deepEqual(readEvents(dir), { events: [a, b], problems: [], cursor: 2 });
  assert.deepEqual(readEvents(dir, 1), { events: [b], problems: [], cursor: 2 });
  assert.deepEqual(readEvents(dir, 2), { events: [], problems: [], cursor: 2 });
  assert.deepEqual(readEvents(scratch(t), 5), { events: [], problems: [], cursor: 5 });
});

test("appendEvent rejects events that break the schema or name what does not exist", async (t) => {
  const dir = await withStill(t);
  const thread = { type: "thread", author: HUMAN, still: "invite", rev: 1, body: "x" };
  const bad = [
    [{ ...thread, type: "comment" }, /'type'/],
    [{ ...thread, author: { kind: "bot", name: "x" } }, /author.kind/],
    [{ ...thread, author: { kind: "human", name: " " } }, /author.name/],
    [{ ...thread, body: "  " }, /'body'/],
    [{ ...thread, seq: 7 }, /'seq' is not a field/],
    [{ ...thread, anchor: { x: 1.2, y: 0 } }, /0\.\.1/],
    [{ ...thread, anchor: { x: 0, y: 0, w: 0.5 } }, /pin or/],
    [{ ...thread, anchor: { x: 0.8, y: 0, w: 0.5, h: 0.1 } }, /fit in the image/],
    [{ ...thread, rev: 0 }, /'rev'/],
    [{ ...thread, still: null }, /general thread/],
    [{ ...thread, rev: 2 }, /no still 'invite' at rev 2/],
    [{ ...thread, still: "other" }, /no still 'other'/],
    [{ type: "reply", author: AGENT, thread: "deadbeef", body: "x" }, /no thread 'deadbeef'/],
    [{ type: "resolve", author: AGENT, thread: "deadbeef", body: "x" }, /'body' is not a field/],
    [{ type: "viewed", author: HUMAN, still: "invite" }, /'rev'/],
  ];
  for (const [event, error] of bad) await assert.rejects(appendEvent(dir, event), error);
  assert.equal(existsSync(path.join(dir, "review/events.jsonl")), false);
  const general = await appendEvent(dir, { type: "thread", author: HUMAN, still: null, body: "chat" });
  assert.equal(general.still, null);
});

test("threads folds anchors, replies and resolve/reopen into each thread", async (t) => {
  const dir = await withStill(t);
  const box = { x: 0.1, y: 0.2, w: 0.3, h: 0.4 };
  const one = await appendEvent(dir, { ...REMARK, anchor: box, body: "too tight" });
  const two = await appendEvent(dir, { ...REMARK, anchor: { x: 0.5, y: 0.5 }, body: "typo" });
  const reply = await appendEvent(dir, { type: "reply", author: AGENT, thread: one.id, body: "fixed in rev 2" });
  await appendEvent(dir, { type: "resolve", author: HUMAN, thread: one.id });
  await appendEvent(dir, { type: "resolve", author: HUMAN, thread: two.id });
  const last = await appendEvent(dir, { type: "reopen", author: HUMAN, thread: two.id });
  const [a, b] = threads(dir);
  assert.deepEqual(a, {
    id: one.id,
    still: "invite",
    rev: 1,
    anchor: box,
    body: "too tight",
    author: HUMAN,
    at: one.at,
    seq: 1,
    status: "resolved",
    replies: [{ id: reply.id, author: AGENT, body: "fixed in rev 2", at: reply.at, seq: 3 }],
    updated: 4,
  });
  assert.equal(b.status, "open");
  assert.deepEqual(b.anchor, { x: 0.5, y: 0.5 });
  assert.equal(b.updated, last.seq);
  assert.deepEqual(threads(scratch(t)), []);
});

test("reviewed marks a still's revision and a newer revision clears it", async (t) => {
  const dir = await withStill(t);
  await addStill(dir, { file: png(dir, "c"), name: "home" });
  assert.deepEqual(reviewed(dir), {
    invite: { rev: 1, viewed: null, reviewed: false, changed: false },
    home: { rev: 1, viewed: null, reviewed: false, changed: false },
  });
  await appendEvent(dir, { type: "viewed", author: HUMAN, still: "invite", rev: 1 });
  assert.deepEqual(reviewed(dir).invite, { rev: 1, viewed: 1, reviewed: true, changed: false });
  await addStill(dir, { file: png(dir, "b"), name: "invite" });
  assert.deepEqual(reviewed(dir).invite, { rev: 2, viewed: 1, reviewed: false, changed: true });
  await appendEvent(dir, { type: "viewed", author: HUMAN, still: "invite", rev: 2 });
  assert.deepEqual(reviewed(dir).invite, { rev: 2, viewed: 2, reviewed: true, changed: false });
  await appendEvent(dir, { type: "unviewed", author: HUMAN, still: "invite", rev: 2 });
  assert.deepEqual(reviewed(dir).invite, { rev: 2, viewed: null, reviewed: false, changed: false });
});

test("malformed lines are skipped and reported, and a torn line does not swallow the next append", async (t) => {
  const dir = await withStill(t);
  const first = await appendEvent(dir, { type: "viewed", author: HUMAN, still: "invite", rev: 1 });
  const log = path.join(dir, "review/events.jsonl");
  appendFileSync(log, "{oops\n\n");
  appendFileSync(log, `${JSON.stringify({ ...first, id: "dup" })}\n`);
  appendFileSync(log, `${JSON.stringify({ ...first, seq: 5, type: "shout" })}\n`);
  appendFileSync(log, `${JSON.stringify({ ...first, seq: 6 })}\n`);
  appendFileSync(log, `{"seq":7,"half`);
  assert.deepEqual(readEvents(dir).events, [first]);
  assert.deepEqual(
    readEvents(dir).problems.map((p) => p.line),
    [2, 4, 5, 6]
  );
  assert.match(readEvents(dir).problems[0].error, /bad JSON/);
  assert.match(readEvents(dir).problems[1].error, /does not follow 1/);
  assert.match(readEvents(dir).problems[2].error, /'type'/);
  assert.match(readEvents(dir).problems[3].error, /'id' \w+ is not unique/);
  const next = await appendEvent(dir, { type: "unviewed", author: HUMAN, still: "invite", rev: 1 });
  assert.equal(next.seq, 2);
  const { events, problems } = readEvents(dir);
  assert.deepEqual(events, [first, next]);
  assert.match(problems.at(-1).error, /bad JSON/);
  assert.equal(problems.at(-1).line, 7);
});

test("a lock left by a writer that died is taken over", async (t) => {
  const dir = await withStill(t);
  const lock = path.join(dir, "review/.lock");
  mkdirSync(path.dirname(lock), { recursive: true });
  writeFileSync(lock, "");
  const old = new Date(Date.now() - 60000);
  utimesSync(lock, old, old);
  const event = await appendEvent(dir, { type: "viewed", author: HUMAN, still: "invite", rev: 1 });
  assert.equal(event.seq, 1);
  assert.equal(existsSync(lock), false);
  assert.deepEqual(readdirSync(path.dirname(lock)), ["events.jsonl"]);
});

test("appends from two processes at once get distinct, growing seqs and whole lines", async (t) => {
  const dir = await withStill(t);
  const script = `
    const { appendEvent } = await import(${JSON.stringify(REVIEW)});
    for (let i = 0; i < 40; i++) {
      const author = { kind: "agent", name: process.argv[2] };
      await appendEvent(process.argv[1], { type: "viewed", author, still: "invite", rev: 1 });
    }`;
  const run = promisify(execFile);
  await Promise.all(
    ["one", "two"].map((name) => run(process.execPath, ["--input-type=module", "-e", script, dir, name]))
  );
  const { events, problems } = readEvents(dir);
  assert.deepEqual(problems, []);
  assert.deepEqual(
    events.map((e) => e.seq),
    Array.from({ length: 80 }, (_, i) => i + 1)
  );
  assert.equal(events.filter((e) => e.author.name === "one").length, 40);
  assert.equal(new Set(events.map((e) => e.id)).size, 80);
  assert.equal(existsSync(path.join(dir, "review/.lock")), false);
});
