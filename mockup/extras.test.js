/**
 * Tests for what a folder source adds to the viewer: the extras of `/_review/stills`, the About
 * page as sanitized HTML, the route serving the folder's images, the live `stills` event and
 * the viewer's group and notes helpers.
 *   node --test
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { aboutPage, renderMarkdown, sourceExtras, sourceFile, watchSource } from "./extras.mjs";
import { eventStream, handleReview, reviewStills } from "./menu.mjs";
import { appendEvent } from "./review.mjs";
import { folder, readSource } from "./source.mjs";
import { notesLine, sectionAt, sections, sectionStart } from "./stills/state.js";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const DANTE = { kind: "human", name: "dante", via: "tailnet" };
const README = [
  "# Locations",
  "",
  "Why the list comes first. <script>alert(1)</script>",
  "",
  "## Sign in",
  "",
  "| # | Screen | Shot |",
  "| - | ------ | ---- |",
  "| 01 | Welcome back | ![welcome](01-welcome.png) |",
  "| 02 | The code<br>by mail | <img src=\"02-code.png\" alt=\"the code\"> |",
  "",
  "## Admin",
  "",
  "![list](03-list.png) and [the phone one](03-list@mobile.png)",
  "",
].join("\n");

/** An empty directory, removed when the test ends. */
function scratch(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "mockup-extras-"));
  t.after(() => {
    chmodSync(dir, 0o755);
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

/** Write an image `rel` in `dir` whose bytes end with `tag`; returns its path. */
function image(dir, rel, tag = rel) {
  const file = path.join(dir, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, Buffer.concat([SIGNATURE, Buffer.from(tag)]));
  return file;
}

/** A folder of four images, one of them a second variant, with the README above. */
function documented(t) {
  const dir = scratch(t);
  for (const rel of ["01-welcome.png", "02-code.png", "03-list.png", "03-list@mobile.png"]) image(dir, rel);
  writeFileSync(path.join(dir, "README.md"), README);
  return dir;
}

/** The review routes over the folder `dir` on a local port: `{ url, stream }`, closed when the test ends. */
async function serve(t, dir) {
  const scratchOf = folder(dir);
  const stream = eventStream(scratchOf);
  const server = createServer(async (req, res) => {
    if (!(await handleReview(req, res, { scratch: scratchOf, stream, who: DANTE }))) res.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    stream.close();
    server.closeAllConnections();
    server.close();
  });
  return { url: `http://127.0.0.1:${server.address().port}`, stream };
}

/** The named events an open event stream at `url` sends, as they arrive; `stop()` ends it. */
async function listen(url) {
  const controller = new AbortController();
  const res = await fetch(`${url}/_review/events?since=0`, { signal: controller.signal });
  const names = [];
  const read = (async () => {
    const decoder = new TextDecoder();
    try {
      for await (const chunk of res.body) {
        for (const m of decoder.decode(chunk, { stream: true }).matchAll(/^event: (\w+)$/gm)) names.push(m[1]);
      }
    } catch {
      return;
    }
  })();
  return {
    names,
    stop: async () => {
      controller.abort();
      await read;
    },
  };
}

/** Wait until `done()` is true, up to `ms`; returns how long it took, or null when it never was. */
async function until(done, ms) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (done()) return Date.now() - start;
    await sleep(20);
  }
  return null;
}

test("a plain scratch dir adds nothing; a folder adds its groups, notes, writable and About", (t) => {
  const dir = documented(t);
  assert.deepEqual(sourceExtras(dir), {});
  const extras = sourceExtras(folder(dir));
  assert.deepEqual(
    extras.groups.map((g) => [g.title, g.stills]),
    [
      ["Sign in", ["01-welcome", "02-code"]],
      ["Admin", ["03-list"]],
    ],
  );
  assert.deepEqual(extras.notes, []);
  assert.equal(extras.writable, true);
  assert.deepEqual(extras.about, { file: "README.md" });
  const answer = reviewStills(folder(dir), "dante");
  assert.deepEqual(answer.stills.map((s) => s.name), ["01-welcome", "02-code", "03-list"]);
  assert.deepEqual(answer.groups, extras.groups);
  assert.equal(readSource(dir).stills.length, 3);
});

test("a folder without a README has no About and no groups, and a broken stills.json is a note", (t) => {
  const dir = scratch(t);
  image(dir, "01-welcome.png");
  writeFileSync(path.join(dir, "stills.json"), "{ not json");
  const extras = sourceExtras(folder(dir));
  assert.equal(extras.about, null);
  assert.deepEqual(extras.groups, []);
  assert.equal(extras.notes.length, 1);
  assert.match(extras.notes[0], /^stills\.json: /);
  assert.equal(aboutPage(dir), null);
  assert.equal(reviewStills(folder(dir)).stills.length, 1);
});

test("a folder that cannot be written says so", { skip: process.getuid?.() === 0 }, (t) => {
  const dir = scratch(t);
  image(dir, "01-welcome.png");
  chmodSync(dir, 0o555);
  assert.equal(sourceExtras(folder(dir)).writable, false);
});

test("About renders the README's tables, serves its images from the folder and links the stills", (t) => {
  const { file, html } = aboutPage(documented(t));
  assert.equal(file, "README.md");
  assert.match(html, /<h1>Locations<\/h1>/);
  assert.match(html, /<div class="table"><table>/);
  assert.match(html, /<td>The code<br>\s*by mail<\/td>/);
  assert.ok(
    html.includes(
      '<a class="still" href="#01-welcome" title="Welcome back">' +
        '<img src="/_review/file/01-welcome.png" alt="welcome" loading="lazy"></a>',
    ),
  );
  assert.ok(html.includes('href="#02-code"'));
  assert.ok(html.includes('<img src="/_review/file/02-code.png" alt="the code" loading="lazy">'));
  assert.ok(html.includes('<a href="#03-list@mobile" class="still">the phone one</a>'));
});

test("About carries no raw HTML, no script and no link that runs one", () => {
  const html = renderMarkdown(
    [
      "<script>alert(1)</script> <b onclick=\"x()\">bold</b>",
      "",
      "<img src=\"x.png\" onerror=\"alert(1)\">",
      "",
      "[run](javascript:alert(1)) [data](data:text/html,<script>1</script>) [vb](vbscript:x)",
      "",
      "![x](javascript:alert(1)) ![\"><script>alert(2)</script>](a.png)",
      "",
      "```",
      "<img src=\"kept.png\">",
      "```",
    ].join("\n"),
  );
  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /<b\b/i);
  assert.doesNotMatch(html, /<[^>]*\son\w+=/i);
  assert.doesNotMatch(html, /(href|src)="\s*(javascript|vbscript|data):/i);
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(html.includes('<img src="/_review/file/x.png" alt="" loading="lazy">'));
  assert.ok(html.includes("&lt;img src=&quot;kept.png&quot;&gt;"));
});

test("About opens outside links in a new tab, loads no outside image and drops links it cannot serve", () => {
  const html = renderMarkdown(
    [
      "[site](https://example.com/a) [mail](mailto:a@example.com)",
      "",
      "![badge](https://example.com/badge.svg)",
      "",
      "[spec](../spec.md) [top](#top) [root](/etc/passwd) [other](notes.txt) [raw](shots/raw.png)",
      "",
      "![up](../up.png) ![vector](logo.svg)",
    ].join("\n"),
  );
  assert.ok(html.includes('<a href="https://example.com/a" target="_blank" rel="noopener noreferrer">site</a>'));
  assert.ok(html.includes('<a href="mailto:a@example.com" target="_blank" rel="noopener noreferrer">mail</a>'));
  assert.ok(
    html.includes('<a href="https://example.com/badge.svg" target="_blank" rel="noopener noreferrer">badge</a>'),
  );
  assert.equal((html.match(/<img/g) ?? []).length, 0);
  for (const text of ["spec", "top", "root", "other"]) assert.ok(html.includes(`<a>${text}</a>`), text);
  assert.ok(
    html.includes('<a href="/_review/file/shots/raw.png" target="_blank" rel="noopener noreferrer">raw</a>'),
  );
  assert.ok(html.includes("<p>up vector</p>"));
});

test("sourceFile serves the folder's images only, never a hidden file or one outside it", (t) => {
  const dir = documented(t);
  const outside = scratch(t);
  image(outside, "secret.png");
  image(dir, "sub/deep.jpg");
  image(dir, ".review/revs/01-welcome/desktop/1.png");
  writeFileSync(path.join(dir, "notes.txt"), "no");
  symlinkSync(path.join(outside, "secret.png"), path.join(dir, "link.png"));
  assert.equal(sourceFile(dir, "01-welcome.png").type, "image/png");
  assert.equal(sourceFile(dir, "sub/deep.jpg").type, "image/jpeg");
  assert.equal(sourceFile(dir, "03-list@mobile.png").file.endsWith("03-list@mobile.png"), true);
  for (const rel of [
    "notes.txt",
    "README.md",
    "missing.png",
    "../secret.png",
    "sub/../../secret.png",
    "/etc/passwd.png",
    ".review/revs/01-welcome/desktop/1.png",
    "link.png",
    "sub",
    "",
  ]) {
    assert.equal(sourceFile(dir, rel), null, rel);
  }
});

test("the review routes answer About and the folder's images, and nothing of the kind for a mockup", async (t) => {
  const dir = documented(t);
  const { url } = await serve(t, dir);
  const stills = await (await fetch(`${url}/_review/stills`)).json();
  assert.deepEqual(stills.about, { file: "README.md" });
  assert.equal(stills.writable, true);
  assert.equal(stills.groups.length, 2);
  const about = await (await fetch(`${url}/_review/about`)).json();
  assert.match(about.html, /<h2>Sign in<\/h2>/);
  const png = await fetch(`${url}/_review/file/03-list%40mobile.png`);
  assert.equal(png.status, 200);
  assert.equal(png.headers.get("content-type"), "image/png");
  assert.equal(png.headers.get("x-content-type-options"), "nosniff");
  assert.equal((await fetch(`${url}/_review/file/README.md`)).status, 404);
  assert.equal((await fetch(`${url}/_review/file/..%2F..%2Fetc%2Fpasswd.png`)).status, 404);
  assert.equal((await fetch(`${url}/_review/file/%E0%A4%A.png`)).status, 404);
  assert.equal((await fetch(`${url}/_review/about`, { method: "POST" })).status, 405);

  const plain = scratch(t);
  const stream = eventStream(plain);
  const res = { writeHead: (status) => Object.assign(res, { status }), end: () => res };
  await handleReview({ url: "/_review/about", method: "GET", headers: {} }, res, { scratch: plain, stream });
  assert.equal(res.status, 404);
});

test("a rewritten image is rev 2 within a second, an added one appears and a removed one goes", async (t) => {
  const dir = documented(t);
  await appendEvent(folder(dir), { type: "viewed", author: DANTE, still: "01-welcome", rev: 1 });
  const { url } = await serve(t, dir);
  const stream = await listen(url);
  t.after(stream.stop);
  const revs = async (name) => {
    const { stills } = await (await fetch(`${url}/_review/stills`)).json();
    return stills.find((s) => s.name === name)?.revs.map((r) => r.n) ?? null;
  };
  const seen = () => stream.names.filter((n) => n === "stills").length;
  await sleep(400);
  assert.equal(seen(), 0);

  image(dir, "01-welcome.png", "second take");
  const took = await until(() => seen() === 1, 1000);
  assert.ok(took !== null, "no stills event within a second of the rewrite");
  assert.deepEqual(await revs("01-welcome"), [1, 2]);
  const { stills } = await (await fetch(`${url}/_review/stills`)).json();
  const welcome = stills.find((s) => s.name === "01-welcome");
  assert.equal(welcome.mark.changed, true);
  assert.equal(welcome.revs[0].file, ".review/revs/01-welcome/desktop/1.png");

  image(dir, "04-new.png");
  assert.ok((await until(() => seen() === 2, 1000)) !== null, "no stills event for the added image");
  assert.deepEqual(await revs("04-new"), [1]);

  rmSync(path.join(dir, "02-code.png"));
  assert.ok((await until(() => seen() === 3, 1000)) !== null, "no stills event for the removed image");
  assert.equal(await revs("02-code"), null);
});

test("watchSource reports a change once it has settled, and stops when told to", async (t) => {
  const dir = scratch(t);
  image(dir, "a.png");
  let changes = 0;
  const stop = watchSource(dir, () => (changes += 1), 20);
  t.after(stop);
  await sleep(100);
  assert.equal(changes, 0);
  writeFileSync(path.join(dir, "README.md"), "# About\n");
  assert.ok((await until(() => changes === 1, 500)) !== null);
  await sleep(100);
  assert.equal(changes, 1);
  stop();
  image(dir, "b.png");
  await sleep(100);
  assert.equal(changes, 1);
  assert.equal(readSource(dir).stills.length, 2);
});

test("sections give each still its group and list the groups in order, Other for the ungrouped", () => {
  const stills = ["a", "b", "c", "d"].map((name) => ({ name, mark: { reviewed: name === "b" } }));
  assert.deepEqual(sections(stills, []), []);
  assert.deepEqual(stills.map((s) => s.group), [null, null, null, null]);
  const groups = [
    { title: "Sign in", stills: ["a", "gone"] },
    { title: "Admin", stills: ["b", "c"] },
    { title: null, stills: ["d"] },
  ];
  const parts = sections(stills, groups);
  assert.deepEqual(parts, [
    { title: "Sign in", at: 0, count: 1 },
    { title: "Admin", at: 1, count: 2 },
    { title: "Other", at: 3, count: 1 },
  ]);
  assert.deepEqual(stills.map((s) => s.group), ["Sign in", "Admin", "Admin", "Other"]);
  assert.equal(sectionAt(parts, 2), 1);
  assert.equal(sectionAt(parts, 9), -1);
  assert.equal(sectionStart(stills, parts[1], false), 2);
  assert.equal(sectionStart(stills, parts[1], true), 1);
  stills[2].mark.reviewed = true;
  assert.equal(sectionStart(stills, parts[1], false), 1);
});

test("the notes read as one line: the first, and how many more", () => {
  assert.equal(notesLine([]), "");
  assert.equal(notesLine(undefined), "");
  assert.equal(notesLine(["stills.json: line 3: bad"]), "stills.json: line 3: bad");
  assert.equal(notesLine(["a", "b", "c"]), "a · and 2 more");
});
