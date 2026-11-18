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
import {
  addStill,
  appendEvent,
  parseTags,
  parseViewport,
  readEvents,
  reviewed,
  reviewMarks,
  stills,
  storeAnnotated,
  threads,
  upgraded,
  variantKey,
  WORKING_MS,
  working,
} from "./review.mjs";

const REVIEW = fileURLToPath(new URL("./review.mjs", import.meta.url));
const HUMAN = { kind: "human", name: "dante" };
const AGENT = { kind: "agent", name: "claude" };
const ANA = { kind: "human", name: "Ana", via: "share" };
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
  await addStill(dir, { file: png(dir, "a"), name: "invite", title: "Invite", source: "/invite", viewport: "390x844" });
  return dir;
}

test("parseViewport knows the presets, the web alias and custom WxH[@dpr][+touch]", () => {
  assert.deepEqual(parseViewport("mobile"), {
    preset: "mobile",
    width: 390,
    height: 844,
    dpr: 3,
    mobile: true,
    fullPage: false,
  });
  assert.deepEqual(parseViewport("mobile-s", true), {
    preset: "mobile-s",
    width: 375,
    height: 812,
    dpr: 3,
    mobile: true,
    fullPage: true,
  });
  assert.equal(parseViewport("tablet").dpr, 2);
  assert.deepEqual(parseViewport("web"), parseViewport("desktop"));
  assert.deepEqual(parseViewport("1440x900"), parseViewport("desktop"));
  assert.deepEqual(parseViewport("1440x1250"), {
    preset: "custom",
    width: 1440,
    height: 1250,
    dpr: 1,
    mobile: false,
    fullPage: false,
  });
  assert.deepEqual(parseViewport("360x740@2.5+touch"), {
    preset: "custom",
    width: 360,
    height: 740,
    dpr: 2.5,
    mobile: true,
    fullPage: false,
  });
  for (const bad of ["phone", "0x10", "10x10@0", "10x10+mouse", "", undefined]) {
    assert.throws(() => parseViewport(bad), /viewport/);
  }
});

test("variantKey is the viewport then the tags, sorted, so the same inputs give the same key", () => {
  assert.equal(variantKey(parseViewport("mobile"), ["light"]), "mobile+light");
  assert.equal(variantKey(parseViewport("mobile"), ["rtl", "Dark", "dark"]), "mobile+dark+rtl");
  assert.equal(variantKey(parseViewport("web")), "desktop");
  assert.equal(variantKey(parseViewport("1440x1250")), "custom-1440x1250");
  assert.equal(variantKey(parseViewport("360x740@2+touch"), ["es"]), "custom-360x740@2-touch+es");
  assert.deepEqual(parseTags(["logged-out", "es"]), ["es", "logged-out"]);
  assert.throws(() => parseTags(["a b"]), /tag 'a b'/);
  assert.throws(() => parseTags(["+x"]), /tag/);
});

test("addStill keeps each variant's revisions apart, and a re-shoot is its next revision", async (t) => {
  const dir = scratch(t);
  const name = "05-invite-user";
  const first = await addStill(dir, {
    file: png(dir, "a"),
    name,
    source: "/invite",
    viewport: "mobile",
    tags: ["dark"],
  });
  assert.equal(first.entry.title, name);
  assert.deepEqual(first.entry.source, { path: "/invite" });
  assert.equal(first.variant.key, "mobile+dark");
  assert.deepEqual(first.rev.file, "stills/05-invite-user/mobile+dark/1.png");
  await addStill(dir, { file: png(dir, "b"), name, viewport: "desktop", fullPage: true });
  const again = await addStill(dir, {
    file: png(dir, "c"),
    name,
    title: "Invite a user",
    viewport: "mobile",
    tags: ["dark"],
  });
  assert.equal(again.rev.n, 2);
  assert.equal(again.entry.title, "Invite a user");
  assert.deepEqual(again.entry.source, { path: "/invite" });
  const [entry] = stills(dir);
  assert.deepEqual(
    entry.variants.map((v) => [v.key, v.tags, v.viewport.fullPage, v.revs.map((r) => r.file)]),
    [
      [
        "mobile+dark",
        ["dark"],
        false,
        ["stills/05-invite-user/mobile+dark/1.png", "stills/05-invite-user/mobile+dark/2.png"],
      ],
      ["desktop", [], true, ["stills/05-invite-user/desktop/1.png"]],
    ]
  );
  assert.match(readFileSync(path.join(dir, "stills/05-invite-user/mobile+dark/1.png"), "utf8"), /a$/);
  assert.match(readFileSync(path.join(dir, "stills/05-invite-user/mobile+dark/2.png"), "utf8"), /c$/);
  assert.deepEqual(JSON.parse(readFileSync(path.join(dir, "stills/manifest.json"), "utf8")), [entry]);
});

test("addStill rejects bad names, viewports, tags and files that are not PNGs", async (t) => {
  const dir = scratch(t);
  await assert.rejects(addStill(dir, { file: png(dir, "a"), name: "../x" }), /still name/);
  await assert.rejects(addStill(dir, { file: png(dir, "a"), name: "x", viewport: "big" }), /viewport/);
  await assert.rejects(addStill(dir, { file: png(dir, "a"), name: "x", tags: ["a/b"] }), /tag/);
  const many = Array.from({ length: 17 }, (_, i) => `t${i}`);
  await assert.rejects(addStill(dir, { file: png(dir, "a"), name: "x", tags: many }), /16 tags/);
  await addStill(dir, { file: png(dir, "a"), name: "home" });
  await assert.rejects(addStill(dir, { file: png(dir, "b"), name: "Home" }), /only in case/);
  writeFileSync(path.join(dir, "shot.png"), "not a png");
  await assert.rejects(addStill(dir, { file: path.join(dir, "shot.png"), name: "x" }), /not a PNG/);
  assert.deepEqual(
    stills(dir).map((s) => s.name),
    ["home"]
  );
});

/** A v1 manifest entry, as phase 1 wrote it, shot at `size` with `revs` revisions. */
function v1Entry(name, size, revs = 1) {
  return {
    name,
    title: `Title of ${name}`,
    source: { path: `/app?p=${name}`, size },
    revs: Array.from({ length: revs }, (_, i) => ({
      n: i + 1,
      file: `stills/${name}/${i + 1}.png`,
      at: "2026-11-18T14:35:37.223Z",
    })),
  };
}

test("a v1 manifest of 44 stills is read as one variant each, keyed by its size, and left as it is", (t) => {
  const dir = scratch(t);
  const sizes = ["1440x1000", "1440x1250", "1440x900", "1440x1100", "1440x640", "1440x1700", "1440x1400"];
  const manifest = Array.from({ length: 44 }, (_, i) =>
    v1Entry(`${String(i + 1).padStart(2, "0")}-screen`, sizes[i % sizes.length], 1 + (i % 2))
  );
  const file = path.join(dir, "stills/manifest.json");
  mkdirSync(path.dirname(file), { recursive: true });
  const text = `${JSON.stringify(manifest, null, 2)}\n`;
  writeFileSync(file, text);
  const read = stills(dir);
  assert.equal(read.length, 44);
  assert.deepEqual(read[0], {
    name: "01-screen",
    title: "Title of 01-screen",
    source: { path: "/app?p=01-screen" },
    variants: [
      {
        key: "custom-1440x1000",
        viewport: { preset: "custom", width: 1440, height: 1000, dpr: 1, mobile: false, fullPage: false },
        tags: [],
        revs: manifest[0].revs,
      },
    ],
  });
  assert.equal(read[2].variants[0].key, "desktop");
  assert.deepEqual(
    read[1].variants[0].revs.map((r) => r.file),
    ["stills/02-screen/1.png", "stills/02-screen/2.png"]
  );
  assert.equal(readFileSync(file, "utf8"), text);
  assert.equal(upgraded(v1Entry("x", null)).variants[0].key, "desktop");
  assert.equal(upgraded({ title: "no name" }), null);
});

test("the first write to a v1 still rewrites its entry in v2 shape, its old files where they were", async (t) => {
  const dir = scratch(t);
  const file = path.join(dir, "stills/manifest.json");
  mkdirSync(path.dirname(file), { recursive: true });
  const other = v1Entry("other", "1440x900");
  writeFileSync(file, JSON.stringify([v1Entry("wide", "1440x1250", 2), other]));
  const { rev } = await addStill(dir, { file: png(dir, "a"), name: "wide", viewport: "1440x1250" });
  assert.deepEqual(rev.n, 3);
  assert.equal(rev.file, "stills/wide/custom-1440x1250/3.png");
  const [wide, kept] = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(kept, other);
  assert.equal(wide.revs, undefined);
  assert.deepEqual(wide.source, { path: "/app?p=wide" });
  assert.deepEqual(
    wide.variants[0].revs.map((r) => r.file),
    ["stills/wide/1.png", "stills/wide/2.png", "stills/wide/custom-1440x1250/3.png"]
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
    [{ ...thread, variant: "mobile" }, /no still 'invite' \[mobile\]/],
    [{ ...thread, variant: "Bad key!" }, /'variant'/],
    [{ ...thread, author: { ...HUMAN, via: "email" } }, /author.via/],
    [{ ...thread, author: { ...HUMAN, role: "x" } }, /'author'/],
    [{ type: "working", author: AGENT, variant: "desktop" }, /goes with a 'still'/],
    [{ type: "working", author: AGENT, note: " " }, /'note'/],
    [{ type: "working", author: AGENT, still: "other" }, /no still 'other'/],
    [{ type: "idle", author: AGENT, thread: "deadbeef" }, /no thread 'deadbeef'/],
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
    variant: "custom-390x844",
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

test("threads take the variant their event names, else the still's first", async (t) => {
  const dir = await withStill(t);
  await addStill(dir, { file: png(dir, "b"), name: "invite", viewport: "mobile", tags: ["dark"] });
  await appendEvent(dir, { ...REMARK, body: "old log" });
  await appendEvent(dir, { ...REMARK, variant: "mobile+dark", author: ANA, body: "dark" });
  await appendEvent(dir, { type: "thread", author: HUMAN, still: null, body: "chat" });
  assert.deepEqual(
    threads(dir).map((t) => [t.body, t.variant, t.author.via]),
    [
      ["old log", "custom-390x844", undefined],
      ["dark", "mobile+dark", "share"],
      ["chat", null, undefined],
    ]
  );
});

test("reviewed marks a still's revision and a newer revision clears it", async (t) => {
  const dir = await withStill(t);
  await addStill(dir, { file: png(dir, "c"), name: "home" });
  const none = { rev: 1, viewed: null, reviewed: false, changed: false };
  assert.deepEqual(reviewed(dir, "dante"), {
    invite: { ...none, variants: { "custom-390x844": none } },
    home: { ...none, variants: { desktop: none } },
  });
  const invite = () => {
    const { variants, ...mark } = reviewed(dir, "dante").invite;
    assert.deepEqual(variants["custom-390x844"], mark);
    return mark;
  };
  await appendEvent(dir, { type: "viewed", author: HUMAN, still: "invite", rev: 1 });
  assert.deepEqual(invite(), { rev: 1, viewed: 1, reviewed: true, changed: false });
  await addStill(dir, { file: png(dir, "b"), name: "invite", viewport: "390x844" });
  assert.deepEqual(invite(), { rev: 2, viewed: 1, reviewed: false, changed: true });
  await appendEvent(dir, { type: "viewed", author: HUMAN, still: "invite", rev: 2 });
  assert.deepEqual(invite(), { rev: 2, viewed: 2, reviewed: true, changed: false });
  await appendEvent(dir, { type: "unviewed", author: HUMAN, still: "invite", rev: 2 });
  assert.deepEqual(invite(), { rev: 2, viewed: null, reviewed: false, changed: false });
});

test("reviewed marks are per reviewer and per variant, so a guest's marks leave the owner's alone", async (t) => {
  const dir = await withStill(t);
  await addStill(dir, { file: png(dir, "b"), name: "invite", viewport: "mobile", tags: ["dark"] });
  await appendEvent(dir, { type: "viewed", author: ANA, still: "invite", variant: "mobile+dark", rev: 1 });
  await appendEvent(dir, { type: "viewed", author: ANA, still: "invite", rev: 1 });
  assert.equal(reviewed(dir, "dante").invite.reviewed, false);
  assert.equal(reviewed(dir, "dante").invite.variants["mobile+dark"].reviewed, false);
  assert.equal(reviewed(dir, "Ana").invite.reviewed, false);
  assert.equal(reviewed(dir, "Ana (guest)").invite.reviewed, true);
  assert.equal(reviewed(dir, "Ana (guest)").invite.variants["mobile+dark"].reviewed, true);
  await appendEvent(dir, { type: "viewed", author: HUMAN, still: "invite", variant: "mobile+dark", rev: 1 });
  await appendEvent(dir, { type: "unviewed", author: ANA, still: "invite", rev: 1 });
  await appendEvent(dir, { type: "unviewed", author: ANA, still: "invite", variant: "mobile+dark", rev: 1 });
  assert.deepEqual(reviewMarks(dir).reviewers, ["dante"]);
  assert.equal(reviewMarks(dir).marks.get("dante").get("invite").get("mobile+dark"), 1);
  assert.equal(reviewed(dir, "dante").invite.variants["mobile+dark"].reviewed, true);
  const posing = { kind: "human", name: "dante", via: "share" };
  await appendEvent(dir, { type: "unviewed", author: posing, still: "invite", variant: "mobile+dark", rev: 1 });
  assert.equal(reviewed(dir, "dante").invite.variants["mobile+dark"].reviewed, true);
});

test("working lasts until the agent replies, goes idle or stays quiet for ten minutes", async (t) => {
  const dir = await withStill(t);
  const remark = await appendEvent(dir, { ...REMARK, author: ANA, body: "dark is too dark" });
  const other = await appendEvent(dir, { ...REMARK, body: "typo" });
  await appendEvent(dir, { type: "working", author: AGENT, thread: remark.id, note: "re-shooting" });
  const again = await appendEvent(dir, { type: "working", author: AGENT, thread: remark.id });
  await appendEvent(dir, { type: "working", author: AGENT, thread: other.id });
  await appendEvent(dir, { type: "working", author: AGENT, still: "invite", variant: "custom-390x844" });
  const now = Date.parse(again.at);
  assert.deepEqual(
    working(dir, now).map((w) => [w.thread, w.still, w.variant, w.note]),
    [
      [remark.id, null, null, null],
      [other.id, null, null, null],
      [null, "invite", "custom-390x844", null],
    ]
  );
  const [first] = working(dir, now);
  assert.equal(first.until, new Date(Date.parse(again.at) + WORKING_MS).toISOString());
  assert.ok(first.since <= first.at);
  assert.deepEqual(working(dir, Date.parse(again.at) + WORKING_MS + 60000), []);
  await appendEvent(dir, { type: "reply", author: HUMAN, thread: remark.id, body: "a human reply ends nothing" });
  assert.equal(working(dir, now).length, 3);
  await appendEvent(dir, { type: "reply", author: AGENT, thread: remark.id, body: "lighter now, Ana" });
  assert.deepEqual(
    working(dir, now).map((w) => w.thread),
    [other.id, null]
  );
  await appendEvent(dir, { type: "idle", author: AGENT, thread: other.id });
  assert.deepEqual(
    working(dir, now).map((w) => w.still),
    ["invite"]
  );
  await appendEvent(dir, { type: "idle", author: AGENT });
  assert.deepEqual(working(dir, now), []);
  await appendEvent(dir, { type: "working", author: HUMAN, thread: other.id });
  assert.deepEqual(working(dir, now), []);
});

test("events written before variants and via are read as the still's first variant", async (t) => {
  const dir = await withStill(t);
  const log = path.join(dir, "review/events.jsonl");
  mkdirSync(path.dirname(log), { recursive: true });
  const old = {
    seq: 1,
    id: "3f9a0c1e",
    type: "viewed",
    at: "2026-11-17T10:05:02.410Z",
    author: HUMAN,
    still: "invite",
    rev: 1,
  };
  writeFileSync(log, `${JSON.stringify(old)}\n`);
  await addStill(dir, { file: png(dir, "b"), name: "invite", viewport: "mobile" });
  assert.deepEqual(readEvents(dir).problems, []);
  assert.equal(reviewed(dir, "dante").invite.variants["custom-390x844"].reviewed, true);
  assert.equal(reviewed(dir, "dante").invite.variants.mobile.reviewed, false);
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

test("storeAnnotated keeps a thread's PNG under its id, replacing it whole and leaving nothing beside it", (t) => {
  const dir = scratch(t);
  const first = readFileSync(png(dir, "a"));
  const file = storeAnnotated(dir, "3f9a0c1e", first);
  assert.equal(file, path.join(dir, "review", "annotated", "3f9a0c1e.png"));
  assert.deepEqual(readFileSync(file), first);
  const again = readFileSync(png(dir, "b"));
  storeAnnotated(dir, "3f9a0c1e", again);
  assert.deepEqual(readFileSync(file), again);
  assert.deepEqual(readdirSync(path.dirname(file)), ["3f9a0c1e.png"]);
});
