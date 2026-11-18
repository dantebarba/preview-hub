/**
 * Unit tests for the review CLI: stills add|ls and review ls|show|reply|resolve|reopen run
 * in-process on a scratch dir, and `review watch` as a child process, the way an agent runs it.
 * Run with `npm test` from mockup/.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eventLine, main } from "./review-cli.mjs";
import { addStill, appendEvent, readEvents, threads, working } from "./review.mjs";

const CLI = fileURLToPath(new URL("./review-cli.mjs", import.meta.url));
const HUMAN = { kind: "human", name: "dante" };
const ANA = { kind: "human", name: "Ana", via: "share" };
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** An empty scratch dir, removed when the test ends. */
function scratch(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "mockup-review-cli-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A PNG file in `dir` whose bytes end with `tag`. */
function png(dir, tag) {
  const file = path.join(dir, `${tag}.png`);
  writeFileSync(file, Buffer.concat([PNG, Buffer.from(tag)]));
  return file;
}

/** Run the CLI in-process on `dir`; returns `{ code, out, err }` with the lines joined. */
async function cli(dir, args, { env = {}, stdin = Buffer.alloc(0) } = {}) {
  const out = [];
  const err = [];
  const code = await main(["--dir", dir, ...args], {
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    readStdin: () => stdin,
    env,
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

/** A scratch dir with the still `invite` at rev 1 and a box remark on it. */
async function withRemark(t) {
  const dir = scratch(t);
  await addStill(dir, { file: png(dir, "a"), name: "invite", title: "Invite a user" });
  const remark = await appendEvent(dir, {
    type: "thread",
    author: HUMAN,
    still: "invite",
    rev: 1,
    anchor: { x: 0.12, y: 0.4, w: 0.5, h: 0.08 },
    body: "The button\noverflows",
  });
  return { dir, remark };
}

/** Resolve with the first line `child` prints on stdout. */
function firstLine(child) {
  return new Promise((resolve, reject) => {
    let buf = "";
    child.stdout.on("data", (d) => {
      buf += d;
      if (buf.includes("\n")) resolve(buf.split("\n")[0]);
    });
    child.on("exit", (code) => reject(new Error(`watch exited ${code} before printing: ${buf}`)));
  });
}

/** Resolve with the exit status of `child`. */
function exitCode(child) {
  return new Promise((resolve) => child.on("exit", (code) => resolve(code)));
}

test("stills add records a revision from a file or stdin, and stills ls shows its state", async (t) => {
  const dir = scratch(t);
  const env = { MOCKUP_HOST_DIR: "/host/.mockup" };
  let r = await cli(dir, ["stills", "add", png(dir, "a"), "--name", "invite", "--source", "/invite?v=b"], { env });
  assert.deepEqual(r, { code: 0, out: "invite [desktop] r1 /host/.mockup/stills/invite/desktop/1.png", err: "" });
  r = await cli(dir, ["stills", "add", "-", "--name", "invite", "--viewport", "web"], {
    env,
    stdin: Buffer.concat([PNG, Buffer.from("b")]),
  });
  assert.equal(r.out, "invite [desktop] r2 /host/.mockup/stills/invite/desktop/2.png");
  await appendEvent(dir, { type: "viewed", author: HUMAN, still: "invite", rev: 1 });
  await appendEvent(dir, { type: "thread", author: HUMAN, still: "invite", rev: 2, body: "x" });
  r = await cli(dir, ["stills", "ls", "--as", "dante"]);
  assert.equal(r.out, 'invite [desktop]  r2  changed since reviewed (r1)  1 open  "invite"');
  const [row] = JSON.parse((await cli(dir, ["stills", "ls", "--as", "dante", "--json"], { env })).out);
  assert.deepEqual(row, {
    name: "invite",
    title: "invite",
    source: { path: "/invite?v=b" },
    variants: [
      {
        key: "desktop",
        viewport: { preset: "desktop", width: 1440, height: 900, dpr: 1, mobile: false, fullPage: false },
        tags: [],
        rev: 2,
        file: "/host/.mockup/stills/invite/desktop/2.png",
        viewed: 1,
        reviewed: false,
        changed: true,
        marks: { dante: { rev: 2, viewed: 1, reviewed: false, changed: true } },
        state: "changed since reviewed (r1)",
        open: 1,
      },
    ],
  });
});

test("stills add shoots variants by --viewport, --tag and --full-page, and stills ls lists each", async (t) => {
  const dir = scratch(t);
  let r = await cli(dir, [
    "stills",
    "add",
    png(dir, "a"),
    "--name",
    "landing",
    "--viewport",
    "mobile",
    "--tag",
    "light",
  ]);
  assert.equal(r.out, `landing [mobile+light] r1 ${dir}/stills/landing/mobile+light/1.png`);
  r = await cli(dir, ["stills", "add", png(dir, "b"), "--name", "landing", "--viewport", "mobile", "--tag", "dark"]);
  assert.equal(r.out, `landing [mobile+dark] r1 ${dir}/stills/landing/mobile+dark/1.png`);
  r = await cli(dir, ["stills", "add", png(dir, "c"), "--name", "landing", "--viewport", "desktop", "--full-page"]);
  assert.equal(r.code, 0);
  r = await cli(dir, ["stills", "add", png(dir, "d"), "--name", "landing", "--size", "1440x1250"]);
  assert.equal(r.out, `landing [custom-1440x1250] r1 ${dir}/stills/landing/custom-1440x1250/1.png`);
  r = await cli(dir, ["stills", "add", png(dir, "e"), "--name", "landing", "--viewport", "mobile", "--size", "1x1"]);
  assert.equal(r.code, 2);
  r = await cli(dir, ["stills", "add", png(dir, "e"), "--name", "landing", "--viewport", "watch"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /viewport/);
  await appendEvent(dir, { type: "viewed", author: ANA, still: "landing", variant: "mobile+dark", rev: 1 });
  await appendEvent(dir, { type: "viewed", author: HUMAN, still: "landing", variant: "mobile+dark", rev: 1 });
  await appendEvent(dir, { type: "thread", author: ANA, still: "landing", variant: "mobile+dark", rev: 1, body: "x" });
  r = await cli(dir, ["stills", "ls"]);
  assert.deepEqual(r.out.split("\n"), [
    'landing [mobile+light]  r1  not reviewed  0 open  "landing"',
    'landing [mobile+dark]  r1  reviewed by Ana, dante  1 open  "landing"',
    'landing [desktop]  r1  not reviewed  0 open  "landing"',
    'landing [custom-1440x1250]  r1  not reviewed  0 open  "landing"',
  ]);
  r = await cli(dir, ["stills", "ls", "--as", "nobody"]);
  assert.match(r.out.split("\n")[1], /^landing \[mobile\+dark\] {2}r1 {2}not reviewed/);
  const [row] = JSON.parse((await cli(dir, ["stills", "ls", "--json"])).out);
  assert.equal(row.variants[2].viewport.fullPage, true);
  assert.deepEqual(Object.keys(row.variants[1].marks), ["Ana", "dante"]);
});

test("stills add refuses a missing name, a missing file and a file that is not a PNG", async (t) => {
  const dir = scratch(t);
  assert.equal((await cli(dir, ["stills", "add", png(dir, "a")])).code, 2);
  assert.match((await cli(dir, ["stills", "add", "nope.png", "--name", "x"])).err, /no such file/);
  writeFileSync(path.join(dir, "x.png"), "text");
  const r = await cli(dir, ["stills", "add", path.join(dir, "x.png"), "--name", "x"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /not a PNG/);
});

test("review ls lists threads on one line each, and --open drops resolved ones", async (t) => {
  const { dir, remark } = await withRemark(t);
  const pin = await appendEvent(dir, {
    type: "thread",
    author: HUMAN,
    still: "invite",
    rev: 1,
    anchor: { x: 0.5, y: 0.25 },
    body: "typo",
  });
  await appendEvent(dir, { type: "resolve", author: HUMAN, thread: pin.id });
  let r = await cli(dir, ["review", "ls"]);
  assert.deepEqual(r.out.split("\n"), [
    `${remark.id}  open  invite [desktop] r1 box 0.12,0.40 0.50x0.08  0 replies  dante: "The button\\noverflows"`,
    `${pin.id}  resolved  invite [desktop] r1 pin 0.50,0.25  0 replies  dante: "typo"`,
  ]);
  r = await cli(dir, ["review", "ls", "--open", "--json"]);
  assert.deepEqual(
    JSON.parse(r.out).map((x) => x.id),
    [remark.id]
  );
  await appendEvent(dir, { type: "resolve", author: HUMAN, thread: remark.id });
  assert.equal((await cli(dir, ["review", "ls", "--open"])).out, "no open threads");
});

test("review reply, resolve and reopen write agent events, and show prints the thread", async (t) => {
  const { dir, remark } = await withRemark(t);
  const env = { REVIEW_AUTHOR: "claude", MOCKUP_HOST_DIR: "/host/.mockup" };
  let r = await cli(dir, ["review", "reply", remark.id, "Wrapped", "the label"], { env });
  assert.deepEqual(r, { code: 0, out: `#2 reply ${remark.id}`, err: "" });
  assert.equal((await cli(dir, ["review", "resolve", remark.id], { env })).out, `#3 resolve ${remark.id}`);
  assert.equal(threads(dir)[0].status, "resolved");
  await cli(dir, ["review", "reopen", remark.id]);
  const [thread] = threads(dir);
  assert.equal(thread.status, "open");
  assert.deepEqual(thread.replies[0].author, { kind: "agent", name: "claude", via: "cli" });
  assert.equal(thread.replies[0].body, "Wrapped the label");
  assert.deepEqual(readEvents(dir).events.at(-1).author, { kind: "agent", name: "agent", via: "cli" });

  r = await cli(dir, ["review", "show", remark.id], { env });
  const lines = r.out.split("\n");
  assert.deepEqual(lines.slice(0, 4), [
    `thread  ${remark.id}  open`,
    "on      invite [desktop] r1 box 0.12,0.40 0.50x0.08",
    "image   /host/.mockup/stills/invite/desktop/1.png",
    "marked  (none: not written yet, or the viewer could not draw it; read image at the anchor above)",
  ]);
  assert.deepEqual(lines.slice(5, 8), [`#1 dante (human) ${remark.at}`, "  The button", "  overflows"]);
  assert.equal(lines.at(-2), `#2 claude (agent, cli) ${thread.replies[0].at}`);
  assert.match(lines.at(-1), /^ {2}Wrapped the label$/);

  mkdirSync(path.join(dir, "review", "annotated"), { recursive: true });
  writeFileSync(path.join(dir, "review", "annotated", `${remark.id}.png`), PNG);
  const shown = JSON.parse((await cli(dir, ["review", "show", remark.id, "--json"], { env })).out);
  assert.equal(shown.annotated, `/host/.mockup/review/annotated/${remark.id}.png`);
  assert.equal(shown.image, "/host/.mockup/stills/invite/desktop/1.png");
  assert.equal(shown.variant, "desktop");
  assert.equal(shown.replies.length, 1);
});

test("review commands refuse unknown threads, bad usage and empty replies", async (t) => {
  const { dir, remark } = await withRemark(t);
  let r = await cli(dir, ["review", "reply", "deadbeef", "hi"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /no thread 'deadbeef'/);
  assert.equal((await cli(dir, ["review", "show"])).code, 2);
  assert.equal((await cli(dir, ["review", "ls", "--bogus"])).code, 2);
  assert.equal((await cli(dir, ["review", "frobnicate"])).code, 2);
  assert.equal((await cli(dir, ["--help"])).code, 0);
  r = await cli(dir, ["review", "reply", remark.id, "  "]);
  assert.equal(r.code, 1);
  assert.match(r.err, /'body'/);
  assert.equal((await cli(dir, ["constructor"])).code, 2);
});

test("review reply takes a body that starts with '-' verbatim", async (t) => {
  const { dir, remark } = await withRemark(t);
  const r = await cli(dir, ["review", "reply", remark.id, "- wrapped the label\n- shortened it"]);
  assert.equal(r.code, 0);
  assert.equal(threads(dir)[0].replies[0].body, "- wrapped the label\n- shortened it");
});

test("eventLine prints every event type on one line, with the variant and how the author came", () => {
  const base = { seq: 4, id: "e1", at: "2026-11-17T10:00:00.000Z", author: HUMAN };
  const first = new Map([["invite", "desktop"]]);
  assert.equal(
    eventLine({ ...base, type: "thread", still: "invite", rev: 2, body: "a\nb" }, first),
    '#4 thread e1 invite [desktop] r2 whole dante: "a\\nb"'
  );
  assert.equal(
    eventLine({ ...base, author: ANA, type: "thread", still: "invite", variant: "mobile+dark", rev: 3, body: "x" }),
    '#4 thread e1 invite [mobile+dark] r3 whole Ana (guest): "x"'
  );
  assert.equal(
    eventLine({ ...base, type: "thread", still: "gone", rev: 1, body: "x" }),
    '#4 thread e1 gone r1 whole dante: "x"'
  );
  assert.equal(eventLine({ ...base, type: "thread", still: null, body: "hi" }), '#4 thread e1 general dante: "hi"');
  assert.equal(eventLine({ ...base, type: "reply", thread: "t1", body: "ok" }), '#4 reply t1 dante: "ok"');
  const tailnet = { ...HUMAN, via: "tailnet" };
  assert.equal(eventLine({ ...base, author: tailnet, type: "reopen", thread: "t1" }), "#4 reopen t1 dante (tailnet)");
  assert.equal(
    eventLine({ ...base, type: "viewed", still: "invite", rev: 2 }, first),
    "#4 viewed invite [desktop] r2 dante"
  );
  assert.doesNotMatch(eventLine({ ...base, type: "working", thread: "t1" }), /undefined/);
  assert.doesNotMatch(eventLine({ ...base, type: "idle" }), /undefined/);
});

test("review working and idle write the agent's working state on a thread or a still", async (t) => {
  const { dir, remark } = await withRemark(t);
  let r = await cli(dir, ["review", "working", remark.id, "--note", "re-shooting the button"]);
  assert.deepEqual(r, { code: 0, out: `#2 working ${remark.id}`, err: "" });
  r = await cli(dir, ["review", "working", "invite", "--variant", "desktop"]);
  assert.equal(r.out, "#3 working invite [desktop]");
  assert.deepEqual(
    working(dir).map((w) => [w.thread, w.still, w.note, w.author.via]),
    [
      [remark.id, null, "re-shooting the button", "cli"],
      [null, "invite", null, "cli"],
    ]
  );
  assert.equal((await cli(dir, ["review", "idle", remark.id])).out, `#4 idle ${remark.id}`);
  assert.equal(working(dir).length, 1);
  assert.equal((await cli(dir, ["review", "idle"])).out, "#5 idle");
  assert.deepEqual(working(dir), []);
  r = await cli(dir, ["review", "working", "nothing"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /no thread or still 'nothing'/);
  assert.equal((await cli(dir, ["review", "working", remark.id, "--variant", "desktop"])).code, 2);
  r = await cli(dir, ["review", "working", "invite", "--variant", "mobile"]);
  assert.match(r.err, /no still 'invite' \[mobile\]/);
  assert.match((await cli(dir, ["review", "idle", "deadbeef"])).err, /no thread 'deadbeef'/);
});

test("review watch prints a new human remark within a second and skips agent events", async (t) => {
  const { dir } = await withRemark(t);
  const child = spawn(process.execPath, [CLI, "--dir", dir, "review", "watch"], { stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => child.kill());
  const line = firstLine(child);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const [thread] = threads(dir);
  await appendEvent(dir, { type: "reply", author: { kind: "agent", name: "claude" }, thread: thread.id, body: "x" });
  const started = Date.now();
  const remark = await appendEvent(dir, { type: "thread", author: HUMAN, still: "invite", rev: 1, body: "Too tight" });
  assert.equal(await line, `#3 thread ${remark.id} invite [desktop] r1 whole dante: "Too tight"`);
  assert.ok(Date.now() - started < 1000, `took ${Date.now() - started}ms`);
});

test("review watch --since replays from a seq, --json prints events, and it fails when the dir goes", async (t) => {
  const { dir, remark } = await withRemark(t);
  const child = spawn(process.execPath, [CLI, "--dir", dir, "review", "watch", "--since", "0", "--json"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => child.kill());
  const exited = exitCode(child);
  assert.deepEqual(JSON.parse(await firstLine(child)), remark);
  rmSync(dir, { recursive: true, force: true });
  assert.equal(await exited, 1);
});

test("review watch stops cleanly on SIGTERM", async (t) => {
  const { dir } = await withRemark(t);
  const child = spawn(process.execPath, [CLI, "--dir", dir, "review", "watch"], { stdio: ["ignore", "pipe", "pipe"] });
  const exited = exitCode(child);
  await new Promise((resolve) => setTimeout(resolve, 300));
  child.kill("SIGTERM");
  assert.equal(await exited, 0);
});
