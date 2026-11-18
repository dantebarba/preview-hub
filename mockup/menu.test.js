/**
 * Unit tests for the menu, the manifest check, the URL routing and the stills viewer's state of
 * the /mockup runtime.
 * Run with `npm test` from mockup/.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { checkManifest, listShots, renderMenu, reviewStills, rewriteRefs, route } from "./menu.mjs";
import { addStill, appendEvent } from "./review.mjs";
import { applyEvent, counts, edge, markOf, step } from "./stills/state.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const HUMAN = { kind: "human", name: "dante" };

/** A scratch dir holding the given files, removed when the test ends. */
function scratch(t, files) {
  const dir = mkdtempSync(path.join(tmpdir(), "mockup-menu-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), body);
  }
  return dir;
}

test("renderMenu links every variant and escapes labels and queries", () => {
  const html = renderMenu(
    {
      manifest: {
        title: "Checkout <b>",
        pages: [{ title: "Pay", path: "/pay", variants: [{ label: "A & B", query: "?v=a&x=1" }] }],
      },
      error: null,
    },
    []
  );
  assert.match(html, /<title>Checkout &#60;b&#62;<\/title>/);
  assert.match(html, /<a href="\/pay\?v=a&#38;x=1">A &#38; B<\/a>/);
  assert.doesNotMatch(html, /Stills/);
});

test("renderMenu links a page without variants once, and lists the stills", () => {
  const html = renderMenu({ manifest: { pages: [{ title: "Home", path: "/home" }] }, error: null }, ["a b.png"]);
  assert.match(html, /<a href="\/home">Home<\/a>/);
  assert.match(html, /<img src="\/shots\/a%20b\.png"/);
});

test("renderMenu shows a manifest error instead of failing", () => {
  const html = renderMenu({ manifest: { pages: [] }, error: "manifest.json: Unexpected token" }, []);
  assert.match(html, /class="err">manifest.json: Unexpected token/);
  assert.match(html, /No pages listed yet/);
});

test("listShots returns the images in shots/, sorted", (t) => {
  const dir = scratch(t, { "shots/b.png": "", "shots/a.jpg": "", "shots/notes.txt": "" });
  assert.deepEqual(listShots(dir), ["a.jpg", "b.png"]);
});

test("checkManifest accepts pages whose files exist", (t) => {
  const dir = scratch(t, {
    "manifest.json": JSON.stringify({ pages: [{ title: "Pay", path: "/pay", variants: [] }] }),
    "pages/pay.html": "<p>pay</p>",
  });
  assert.deepEqual(checkManifest(dir), []);
});

test("checkManifest names missing pages, bad paths and bad JSON", (t) => {
  const dir = scratch(t, {
    "manifest.json": JSON.stringify({ pages: [{ title: "Pay", path: "/pay" }, { path: "pay.html" }] }),
  });
  assert.deepEqual(checkManifest(dir), [
    "pages[0]: pages/pay.html does not exist",
    "pages[1]: missing 'title'",
    "pages[1]: 'path' must look like /<slug>",
  ]);
  writeFileSync(path.join(dir, "manifest.json"), "{");
  assert.match(checkManifest(dir)[0], /^manifest\.json: /);
});

test("route sends / to the menu, /app/ to the project and /<slug> to its page", (t) => {
  const app = scratch(t, { ".mockup/pages/pay.html": "", ".mockup/pages/nested/step.html": "" });
  assert.deepEqual(route("/", app), { menu: true });
  assert.deepEqual(route("/?v=b", app), { menu: true });
  assert.deepEqual(route("/app/web/styles.css?x=1", app), { url: `/@fs${app}/web/styles.css?x=1` });
  assert.deepEqual(route("/pay?v=b", app), { url: "/pages/pay.html?v=b" });
  assert.deepEqual(route("/pay/", app), { url: "/pages/pay.html" });
  assert.deepEqual(route("/nested/step", app), { url: "/pages/nested/step.html" });
  assert.equal(route("/missing", app), null);
  assert.equal(route("/pages/pay.ts", app), null);
  assert.equal(route("/@vite/client", app), null);
});

test("route reserves /stills for the viewer, even over a page of that name", (t) => {
  const app = scratch(t, { ".mockup/pages/stills.html": "" });
  assert.deepEqual(route("/stills", app), { viewer: true });
  assert.deepEqual(route("/stills/?x=1", app), { viewer: true });
  assert.equal(route("/stills/05-invite/1.png", app), null);
});

test("reviewStills lists each still with its revisions and reviewed mark, and the log's cursor", async (t) => {
  const dir = scratch(t, { "shot.png": PNG });
  const file = path.join(dir, "shot.png");
  await addStill(dir, { file, name: "a", title: "First" });
  await addStill(dir, { file, name: "b" });
  await appendEvent(dir, { type: "viewed", author: HUMAN, still: "a", rev: 1 });
  await addStill(dir, { file, name: "a" });
  const { stills, cursor } = reviewStills(dir);
  assert.equal(cursor, 1);
  assert.deepEqual(
    stills.map((s) => [s.name, s.title, s.revs.map((r) => r.file), s.mark]),
    [
      ["a", "First", ["stills/a/1.png", "stills/a/2.png"], { rev: 2, viewed: 1, reviewed: false, changed: true }],
      ["b", "b", ["stills/b/1.png"], { rev: 1, viewed: null, reviewed: false, changed: false }],
    ]
  );
  assert.deepEqual(reviewStills(scratch(t, {})), { stills: [], cursor: 0 });
});

test("renderMenu links the viewer and lists the stills by their latest revision, not the shots", () => {
  const stills = [
    {
      name: "a",
      title: "First <1>",
      revs: [{ n: 1, file: "stills/a/1.png" }, { n: 2, file: "stills/a/2.png" }],
      mark: markOf(2, 1),
    },
    { name: "b", title: "Second", revs: [{ n: 1, file: "stills/b/1.png" }], mark: markOf(1, 1) },
  ];
  const html = renderMenu({ manifest: { pages: [] }, error: null }, ["old.png"], { stills, error: null });
  assert.match(html, /<a href="\/stills">Review the stills · 1 \/ 2 reviewed<\/a>/);
  assert.match(html, /<a href="\/stills#a"><img src="\/stills\/a\/2\.png"/);
  assert.match(html, /First &#60;1&#62; · changed since reviewed/);
  assert.match(html, /Second · reviewed/);
  assert.doesNotMatch(html, /old\.png/);
});

test("renderMenu reports an unreadable stills manifest and falls back to the shots", () => {
  const review = { stills: [], error: "stills/manifest.json: must be a list" };
  const html = renderMenu({ manifest: { pages: [] }, error: null }, ["old.png"], review);
  assert.match(html, /class="err">stills\/manifest.json: must be a list/);
  assert.match(html, /<img src="\/shots\/old\.png"/);
  assert.doesNotMatch(html, /href="\/stills"/);
});

/** `n` viewer stills named s1..sn at rev 1, those whose number is in `done` reviewed. */
function viewerStills(n, done = []) {
  const mark = (i) => markOf(1, done.includes(i + 1) ? 1 : null);
  return Array.from({ length: n }, (_, i) => ({ name: `s${i + 1}`, mark: mark(i) }));
}

test("stepping skips the reviewed stills: with 23 of 24 reviewed, every step lands on the one left", () => {
  const all = Array.from({ length: 24 }, (_, i) => i + 1);
  const stills = viewerStills(24, all.filter((n) => n !== 17));
  assert.deepEqual(counts(stills), { reviewed: 23, total: 24 });
  for (const at of [0, 5, 16, 23]) {
    assert.equal(step(stills, at, 1, false), 16);
    assert.equal(step(stills, at, -1, false), 16);
  }
  assert.equal(edge(stills, 3, false, false), 16);
  assert.equal(edge(stills, 3, true, false), 16);
  assert.equal(step(stills, 23, 1, true), 0);
  assert.equal(step(stills, 0, -1, true), 23);
  assert.equal(edge(stills, 3, true, true), 23);
});

test("stepping stays put when every still is reviewed, and wraps over the ones that are not", () => {
  assert.equal(step(viewerStills(3, [1, 2, 3]), 1, 1, false), 1);
  assert.equal(edge(viewerStills(3, [1, 2, 3]), 1, false, false), 1);
  const stills = viewerStills(4, [2]);
  assert.equal(step(stills, 0, 1, false), 2);
  assert.equal(step(stills, 3, 1, false), 0);
  assert.equal(step(stills, 2, -1, false), 0);
  assert.equal(step([], 0, 1, false), 0);
});

test("applyEvent folds viewed and unviewed into the marks: an older revision is changed, not reviewed", () => {
  const stills = [{ name: "a", mark: markOf(2, null) }];
  assert.equal(applyEvent(stills, { type: "viewed", still: "a", rev: 1 }), true);
  assert.deepEqual(stills[0].mark, { rev: 2, viewed: 1, reviewed: false, changed: true });
  applyEvent(stills, { type: "viewed", still: "a", rev: 2 });
  assert.deepEqual(stills[0].mark, { rev: 2, viewed: 2, reviewed: true, changed: false });
  applyEvent(stills, { type: "unviewed", still: "a", rev: 2 });
  assert.deepEqual(stills[0].mark, { rev: 2, viewed: null, reviewed: false, changed: false });
  assert.equal(applyEvent(stills, { type: "viewed", still: "gone", rev: 1 }), false);
  assert.equal(applyEvent(stills, { type: "reply", thread: "t", body: "x" }), false);
});

test("rewriteRefs resolves ./ references of a nested page against its own directory", (t) => {
  const dir = scratch(t, { "step.tsx": "" });
  assert.equal(
    rewriteRefs(`<script src="./step.tsx"></script>`, { app: "/srv/app", pageDir: dir, pageUrlDir: "/pages/nested" }),
    `<script src="/pages/nested/step.tsx"></script>`
  );
});

test("rewriteRefs points ./ references at /pages/ when the file exists, and /app/ at /@fs", (t) => {
  const dir = scratch(t, { "pay.tsx": "", "pay.css": "" });
  const html =
    `<script type="module" src="./pay.tsx?x"></script><link href='./pay.css'><a href="./other">o</a>` +
    `<a href="?v=b">b</a><link rel="stylesheet" href="/app/web/styles.css"><img src='/app/logo.png'>`;
  assert.equal(
    rewriteRefs(html, { app: "/srv/app", pageDir: dir, pageUrlDir: "/pages" }),
    `<script type="module" src="/pages/pay.tsx?x"></script><link href='/pages/pay.css'><a href="./other">o</a>` +
      `<a href="?v=b">b</a><link rel="stylesheet" href="/@fs/srv/app/web/styles.css"><img src='/@fs/srv/app/logo.png'>`
  );
});
