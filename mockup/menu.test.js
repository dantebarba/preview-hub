/**
 * Unit tests for the menu, the manifest check, the URL routing and the stills viewer's state of
 * the /mockup runtime.
 * Run with `npm test` from mockup/.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  annotatedPng,
  authorOf,
  checkManifest,
  freezeRequest,
  handleReview,
  listShots,
  placeMark,
  renderMenu,
  reviewer,
  reviewStills,
  rewriteRefs,
  route,
} from "./menu.mjs";
import { addStill, appendEvent, parseViewport, stills, threads, working } from "./review.mjs";
import { folder } from "./source.mjs";
import {
  ago,
  applyEvent,
  applyThread,
  applyWorking,
  chip,
  choices,
  choose,
  chosen,
  classLabel,
  classOf,
  counts,
  cropOf,
  DEVICES,
  edge,
  elementsLabel,
  fitted,
  holds,
  keyOf,
  lastMessage,
  linkedKey,
  liveDraft,
  livePath,
  markedIn,
  markOf,
  MAX_ZOOM,
  moved,
  opposite,
  pageOfLive,
  pickOf,
  pin,
  presetSize,
  progress,
  region,
  revealed,
  sameChoice,
  scaleToFit,
  sizeLabel,
  sizesOf,
  step,
  tagsLabel,
  tagsOf,
  title,
  unread,
  unshownNote,
  variantFor,
  viewOn,
  viewportLabel,
  viewportOf,
  workingAt,
  WORKING_MS,
  zoomed,
} from "./stills/state.js";

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

test("route sends /live/<slug> to the live shell when that page exists, and else leaves it to a page of that name", (t) => {
  const app = scratch(t, { ".mockup/pages/pay.html": "", ".mockup/pages/nested/step.html": "", ".mockup/pages/live/tv.html": "" });
  assert.deepEqual(route("/live/pay", app), { live: true });
  assert.deepEqual(route("/live/pay?v=b", app), { live: true });
  assert.deepEqual(route("/live/nested/step/", app), { live: true });
  assert.deepEqual(route("/live/tv", app), { url: "/pages/live/tv.html" });
  assert.deepEqual(route("/live/live/tv", app), { live: true });
  assert.equal(route("/live/missing", app), null);
  assert.equal(route("/live", app), null);
  assert.equal(route("/live//pay", app), null);
});

test("renderMenu puts a Live link to the shell beside every page and variant", () => {
  const pages = [{ title: "Pay", path: "/pay", variants: [{ label: "B", query: "?v=b&x=1" }] }, { title: "Home", path: "/home" }];
  const html = renderMenu({ manifest: { pages }, error: null }, []);
  assert.match(html, /<a href="\/pay\?v=b&#38;x=1">B<\/a><a class="live" href="\/live\/pay\?v=b&#38;x=1"[^>]*>Live<\/a>/);
  assert.match(html, /<a href="\/home">Home<\/a><a class="live" href="\/live\/home"[^>]*>Live<\/a>/);
});

test("livePath and pageOfLive turn a page into its shell's URL and back", () => {
  assert.equal(livePath("/checkout?step=2"), "/live/checkout?step=2");
  assert.equal(pageOfLive("/live/checkout", "?step=2"), "/checkout?step=2");
  assert.equal(pageOfLive("/live/a/b"), "/a/b");
  for (const not of ["/live", "/live/", "/live//host", "/live/\\host", "/stills", "/lively/x"]) assert.equal(pageOfLive(not), null, not);
});

test("a device class is a viewport preset of the store, at its size, scaled down only to fit a room", () => {
  assert.deepEqual(DEVICES, ["mobile", "tablet", "desktop"]);
  for (const name of [...DEVICES, "mobile-s"]) {
    const { width, height } = parseViewport(name);
    assert.deepEqual(presetSize(name), { width, height }, name);
  }
  assert.equal(scaleToFit({ width: 390, height: 844 }, { width: 1000, height: 900 }), 1);
  assert.equal(scaleToFit({ width: 390, height: 844 }, { width: 195, height: 900 }), 0.5);
  assert.equal(scaleToFit({ width: 390, height: 844 }, { width: 1000, height: 211 }), 0.25);
  assert.equal(scaleToFit({ width: 390, height: 844 }, { width: -24, height: 500 }), 0);
});

test("elementsLabel counts a target's elements, with a plus when it was truncated", () => {
  const of = (n, truncated) => elementsLabel({ elements: Array(n).fill({}), truncated });
  assert.deepEqual([of(0), of(1), of(3), of(20, true), of(1, true)], ["0 elements", "1 element", "3 elements", "20+ elements", "1+ elements"]);
});

test("unshownNote says a shot did not reproduce a mark, and why when the box held no element", () => {
  const of = (state, n, truncated) => unshownNote({ state, elements: Array(n).fill({}), truncated });
  assert.equal(of("reproduced", 3), "");
  assert.match(of("not-reproduced", 1), /^Not reproduced: .*without the state you marked/);
  assert.equal(of("not-reproduced", 0, true), of("not-reproduced", 1));
  assert.match(of("not-reproduced", 0), /^Not reproduced: no element was inside the box/);
});

test("holds says whether a rect is inside a box, to half a pixel", () => {
  const box = { x: 10, y: 10, w: 100, h: 50 };
  assert.equal(holds(box, { x: 10, y: 10, w: 100, h: 50 }), true);
  assert.equal(holds(box, { x: 9.6, y: 20, w: 100.8, h: 10 }), true);
  assert.equal(holds(box, { x: 9, y: 20, w: 20, h: 10 }), false);
  assert.equal(holds(box, { x: 20, y: 20, w: 20, h: 41 }), false);
});

test("markedIn keeps the elements inside a box but a wrapper of the same area, outermost first, at most 20", () => {
  const rect = (x, y, w, h) => ({ x, y, w, h });
  const three = [0, 1, 2].map((i) => ({ rect: rect(i * 50, 0, 40, 20), parent: -1 }));
  assert.deepEqual(markedIn(three), { picked: [0, 1, 2], truncated: false });
  const wrapped = [
    { rect: rect(0, 0, 100, 40), parent: -1 },
    { rect: rect(0, 0, 100, 40.6), parent: 0 },
    { rect: rect(0, 0, 100, 40), parent: 1 },
    { rect: rect(10, 10, 20, 20), parent: 2 },
    { rect: rect(200, 0, 50, 50), parent: -1 },
  ];
  assert.deepEqual(markedIn(wrapped), { picked: [4, 2, 3], truncated: false });
  const nested = [
    { rect: rect(0, 0, 300, 300), parent: -1 },
    { rect: rect(0, 0, 100, 100), parent: 0 },
    { rect: rect(0, 0, 50, 50), parent: 1 },
    { rect: rect(150, 0, 100, 100), parent: 0 },
  ];
  assert.deepEqual(markedIn(nested).picked, [0, 1, 3, 2]);
  const many = Array.from({ length: 25 }, (_, i) => ({ rect: rect(i * 10, 0, 8, 8), parent: -1 }));
  const cut = markedIn(many);
  assert.deepEqual([cut.picked.length, cut.picked[19], cut.truncated], [20, 19, true]);
  assert.deepEqual(markedIn(many, 2), { picked: [0, 1], truncated: true });
  assert.deepEqual(markedIn([]), { picked: [], truncated: false });
});

test("liveDraft reads the draft a freeze's answer opens, on the whole still when it placed no anchor", () => {
  const target = { page: "/pay", elements: [], viewport: "mobile", scroll: { x: 0, y: 0 }, state: "not-reproduced" };
  const anchor = { x: 0.1, y: 0.2, w: 0.3, h: 0.4 };
  const frozen = { still: "live-pay", variant: "mobile", rev: 2, anchor, state: "not-reproduced", target };
  assert.deepEqual(liveDraft(JSON.stringify(frozen)), { still: "live-pay", variant: "mobile", rev: 2, anchor, target });
  const whole = liveDraft(JSON.stringify({ ...frozen, anchor: null }));
  assert.deepEqual(whole.anchor, { x: 0, y: 0, w: 1, h: 1 });
  const bad = [null, "", "{", "null", "[]", JSON.stringify({ ...frozen, rev: "2" }), JSON.stringify({ ...frozen, target: null })];
  for (const text of bad) assert.equal(liveDraft(text), null, String(text));
  assert.equal(liveDraft(JSON.stringify({ ...frozen, target: { page: "/pay" } })), null);
});

test("route reserves /stills for the viewer, even over a page of that name", (t) => {
  const app = scratch(t, { ".mockup/pages/stills.html": "" });
  assert.deepEqual(route("/stills", app), { viewer: true });
  assert.deepEqual(route("/stills/?x=1", app), { viewer: true });
  assert.equal(route("/stills/05-invite/1.png", app), null);
  assert.equal(route("/stills/05-invite/mobile+dark/1.png", app), null);
  assert.deepEqual(route("/stills/05-invite/mobile%2Bdark%2Brtl/2.png?v=1", app), {
    url: "/stills/05-invite/mobile+dark+rtl/2.png?v=1",
  });
  assert.deepEqual(route("/stills/x/custom-360x740%402-touch/1.png", app), {
    url: "/stills/x/custom-360x740@2-touch/1.png",
  });
});

test("reviewStills lists each still with its first variant's revisions, the reviewer's mark, the cursor", async (t) => {
  const dir = scratch(t, { "shot.png": PNG });
  const file = path.join(dir, "shot.png");
  await addStill(dir, { file, name: "a", title: "First" });
  await addStill(dir, { file, name: "b" });
  await appendEvent(dir, { type: "viewed", author: HUMAN, still: "a", rev: 1 });
  writeFileSync(file, Buffer.concat([PNG, Buffer.from("2")]));
  await addStill(dir, { file, name: "a" });
  await addStill(dir, { file, name: "a", viewport: "mobile", tags: ["dark"] });
  const { stills, marks, cursor } = reviewStills(dir, "dante");
  assert.equal(cursor, 1);
  assert.deepEqual(marks, { dante: { a: { desktop: 1 } } });
  const mark = (rev, viewed) => ({ rev, viewed, reviewed: viewed === rev, changed: viewed !== null && viewed < rev });
  assert.deepEqual(
    stills.map((s) => [s.name, s.title, s.revs.map((r) => r.file), s.variants.map((v) => v.key), s.mark]),
    [
      [
        "a",
        "First",
        ["stills/a/desktop/1.png", "stills/a/desktop/2.png"],
        ["desktop", "mobile+dark"],
        { ...mark(2, 1), variants: { desktop: mark(2, 1), "mobile+dark": mark(1, null) } },
      ],
      ["b", "b", ["stills/b/desktop/1.png"], ["desktop"], { ...mark(1, null), variants: { desktop: mark(1, null) } }],
    ]
  );
  assert.equal(reviewStills(dir).stills[0].mark.viewed, null);
  assert.deepEqual(reviewStills(scratch(t, {})), { stills: [], marks: {}, working: [], cursor: 0 });
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

/** A viewer still named `name` with a variant at rev `rev` for each of `keys`. */
function variantStill(name, keys, rev = 1) {
  const revs = Array.from({ length: rev }, (_, i) => ({ n: i + 1, file: `stills/${name}/${i + 1}.png` }));
  return { name, variants: keys.map((key) => ({ key, revs })) };
}

test("applyEvent folds each reviewer's viewed and unviewed into their own marks, per variant", () => {
  const stills = [variantStill("a", ["desktop", "mobile+dark"], 2)];
  const marks = {};
  const by = (name, event) => applyEvent(marks, stills, { ...event, author: { kind: "human", name } });
  assert.equal(by("dante", { type: "viewed", still: "a", rev: 1 }), true);
  by("Ana", { type: "viewed", still: "a", variant: "mobile+dark", rev: 2 });
  by("__proto__", { type: "viewed", still: "a", rev: 2 });
  assert.deepEqual(marks.dante, { a: { desktop: 1 } });
  assert.deepEqual(marks.Ana, { a: { "mobile+dark": 2 } });
  assert.equal({}.a, undefined);
  choose(stills, null, marks, "dante");
  assert.deepEqual(stills[0].mark, { rev: 2, viewed: 1, reviewed: false, changed: true });
  choose(stills, "mobile+dark", marks, "dante");
  assert.deepEqual(stills[0].mark, markOf(2, null));
  choose(stills, "mobile+dark", marks, "Ana");
  assert.equal(stills[0].mark.reviewed, true);
  choose(stills, "mobile+dark", marks, "");
  assert.equal(stills[0].mark.viewed, null);
  choose(stills, "desktop", marks, "constructor");
  assert.equal(stills[0].mark.viewed, null);
  assert.deepEqual(progress(marks, stills, "dante"), [{ name: "__proto__", reviewed: 1 }]);
  choose(stills, "mobile+dark", marks, "dante");
  assert.deepEqual(progress(marks, stills, "dante"), [{ name: "Ana", reviewed: 1 }]);
  by("Ana", { type: "unviewed", still: "a", variant: "mobile+dark", rev: 2 });
  assert.deepEqual(progress(marks, stills, "dante"), []);
  assert.equal(by("dante", { type: "viewed", still: "gone", rev: 1 }), false);
  assert.equal(by("dante", { type: "reply", thread: "t", body: "x" }), false);
});

test("a pick is sticky: a still without that variant shows its first of the class, else its first", () => {
  const stills = [
    variantStill("a", ["desktop", "mobile+light", "mobile+dark"]),
    variantStill("b", ["mobile+light", "custom-360x740@2-touch"]),
    variantStill("c", ["desktop"]),
  ];
  const shown = (pick) => stills.map((s) => variantFor(s, pick).key);
  assert.deepEqual(shown(null), ["desktop", "mobile+light", "desktop"]);
  assert.deepEqual(shown("mobile+dark"), ["mobile+dark", "mobile+light", "desktop"]);
  assert.deepEqual(shown("tablet"), ["desktop", "mobile+light", "desktop"]);
  assert.deepEqual(choices(stills), {
    classes: ["mobile", "desktop"],
    viewports: ["mobile", "desktop", "custom-360x740@2-touch"],
    tags: ["", "light", "dark"],
  });
  const is = (key) => (k) => k === key;
  assert.equal(pickOf(stills, [is("mobile+dark")]), "mobile+dark");
  assert.equal(pickOf(stills, [is("desktop+dark"), (k) => viewportOf(k) === "desktop"]), "desktop");
  assert.equal(pickOf(stills, [is("custom-360x740@2-touch+dark"), (k) => tagsOf(k) === "dark"]), "mobile+dark");
  assert.equal(pickOf([stills[1], ...stills], [(k) => classOf(k) === "mobile"]), "mobile+light");
  assert.equal(pickOf(stills, [is("typo")]), null);
  assert.deepEqual(choices([stills[2]]), { classes: ["desktop"], viewports: ["desktop"], tags: [""] });
  const parts = [viewportOf("mobile+dark+rtl"), tagsOf("mobile+dark+rtl"), tagsOf("desktop")];
  assert.deepEqual(parts, ["mobile", "dark+rtl", ""]);
  assert.deepEqual([keyOf("mobile", "dark"), keyOf("desktop", "")], ["mobile+dark", "desktop"]);
  const labels = ["mobile-s", "desktop", "custom-360x740@2-touch", "constructor"].map(viewportLabel);
  assert.deepEqual(labels, ["Mobile S", "Desktop", "360×740@2 touch", "constructor"]);
  assert.deepEqual([tagsLabel(""), tagsLabel("dark+rtl")], ["default", "dark+rtl"]);
});

test("a variant's device class is its preset's, and a custom size's by its width", () => {
  const classes = (keys) => keys.map(classOf);
  assert.deepEqual(classes(["mobile", "mobile-s", "tablet", "desktop"]), ["mobile", "mobile", "tablet", "desktop"]);
  assert.deepEqual(classes(["mobile-s+dark+rtl", "custom-360x740@2-touch+dark"]), ["mobile", "mobile"]);
  assert.deepEqual(classes(["custom-599x900", "custom-600x900", "custom-1099x900"]), ["mobile", "tablet", "tablet"]);
  assert.deepEqual(classes(["custom-1100x900", "custom-1440x1250@2"]), ["desktop", "desktop"]);
  assert.deepEqual(classes(["constructor", "custom-wide", ""]), ["desktop", "desktop", "desktop"]);
  assert.deepEqual(["mobile", "tablet", "desktop"].map(classLabel), ["Mobile", "Tablet", "Desktop"]);
  assert.equal(sameChoice("custom-1440x1250+dark", "desktop+dark"), true);
  assert.equal(sameChoice("custom-1440x1250+dark", "desktop"), false);
  assert.equal(sameChoice("mobile-s", "tablet"), false);
});

test("the switcher lists device classes, not sizes: one mobile preset and 13 desktop heights are two", () => {
  const heights = Array.from({ length: 13 }, (_, i) => `custom-1440x${1000 + 50 * i}`);
  const stills = heights.map((key, i) => variantStill(`s${i}`, ["mobile", key]));
  const { classes, viewports } = choices(stills);
  assert.deepEqual(classes, ["mobile", "desktop"]);
  assert.equal(viewports.length, 14);
  const mixed = [variantStill("a", ["desktop", "custom-800x600"]), variantStill("b", ["custom-320x480"])];
  assert.deepEqual(choices(mixed).classes, ["mobile", "tablet", "desktop"]);
  assert.deepEqual(choices(heights.map((key, i) => variantStill(`s${i}`, [key]))).classes, ["desktop"]);
});

test("a pick is sticky by class and tags, and by size where the next still has it", () => {
  const stills = [
    variantStill("a", ["mobile", "custom-1440x1250", "custom-1440x1250+dark"]),
    variantStill("b", ["mobile", "custom-1440x1000+dark", "custom-1440x1000", "custom-1440x1100"]),
    variantStill("c", ["mobile-s", "mobile", "custom-1440x1250"]),
    variantStill("d", ["tablet", "custom-1440x900+dark"]),
    variantStill("e", ["tablet"]),
  ];
  const shown = (pick) => stills.map((s) => variantFor(s, pick).key);
  assert.deepEqual(shown("custom-1440x1250"), [
    "custom-1440x1250",
    "custom-1440x1000",
    "custom-1440x1250",
    "custom-1440x900+dark",
    "tablet",
  ]);
  assert.deepEqual(shown("custom-1440x1250+dark"), [
    "custom-1440x1250+dark",
    "custom-1440x1000+dark",
    "custom-1440x1250",
    "custom-1440x900+dark",
    "tablet",
  ]);
  assert.deepEqual(shown("mobile"), ["mobile", "mobile", "mobile", "tablet", "tablet"]);
  assert.deepEqual(shown("mobile-s"), ["mobile", "mobile", "mobile-s", "tablet", "tablet"]);
  const counted = (pick, marks) => {
    choose(stills, pick, marks, "dante");
    return counts(chosen(stills, pick));
  };
  assert.deepEqual(counted("custom-1440x1250", {}), { reviewed: 0, total: 3 });
  const marks = { dante: { b: { "custom-1440x1000": 1, mobile: 1 }, c: { mobile: 1 }, e: { tablet: 1 } } };
  assert.deepEqual(counted("custom-1440x1250", marks), { reviewed: 1, total: 3 });
  assert.deepEqual(counted("custom-1440x1250+dark", marks), { reviewed: 0, total: 3 });
  assert.deepEqual(counted("mobile", marks), { reviewed: 2, total: 3 });
  assert.deepEqual(counted(null, marks), { reviewed: 2, total: 5 });
  assert.deepEqual(progress({ Ana: { e: { tablet: 1 } } }, chosen(stills, "tablet"), "dante"), [
    { name: "Ana", reviewed: 1 },
  ]);
});

test("a still's sizes are its variants of the shown class and tags, labelled by size", () => {
  const sized = (key, width, height) => ({ key, viewport: { width, height }, revs: [] });
  const still = {
    name: "a",
    variants: [
      sized("mobile", 390, 844),
      sized("mobile-s", 375, 812),
      sized("mobile+dark", 390, 844),
      sized("custom-360x740@2-touch", 360, 740),
      sized("custom-1440x1250", 1440, 1250),
    ],
  };
  const keys = (key) => sizesOf(still, key).map((v) => v.key);
  assert.deepEqual(keys("mobile-s"), ["mobile", "mobile-s", "custom-360x740@2-touch"]);
  assert.deepEqual(keys("mobile+dark"), ["mobile+dark"]);
  assert.deepEqual(keys("custom-1440x1250"), ["custom-1440x1250"]);
  const labels = still.variants.map((v) => sizeLabel(v));
  assert.deepEqual(labels, ["390×844", "375×812", "390×844", "360×740@2 touch", "1440×1250"]);
  assert.equal(sizeLabel(still.variants[1], true), "Mobile S · 375×812");
  assert.equal(sizeLabel(still.variants[4], true), "1440×1250");
  assert.equal(sizeLabel({ key: "desktop+dark" }), "Desktop");
});

test("a link's key names its variant, a custom one by its size alone too", () => {
  const stills = [variantStill("a", ["mobile", "custom-1440x1250", "custom-1440x1250+dark"])];
  assert.equal(linkedKey(stills, "custom-1440x1250"), "custom-1440x1250");
  assert.equal(linkedKey(stills, "1440x1250"), "custom-1440x1250");
  assert.equal(linkedKey(stills, "1440x1250+dark"), "custom-1440x1250+dark");
  assert.equal(linkedKey(stills, "mobile"), "mobile");
  assert.equal(linkedKey(stills, "1440x1000"), null);
  assert.equal(linkedKey(stills, "tablet"), null);
});

test("applyWorking folds the agent's working states as the store does, ended by its reply or idle", async (t) => {
  const dir = scratch(t, { "shot.png": PNG });
  await addStill(dir, { file: path.join(dir, "shot.png"), name: "home" });
  const agent = { kind: "agent", name: "claude", via: "cli" };
  const thread = await appendEvent(dir, { type: "thread", author: HUMAN, still: "home", rev: 1, body: "Wide" });
  const events = [
    thread,
    await appendEvent(dir, { type: "working", author: agent, thread: thread.id, note: "re-shooting" }),
    await appendEvent(dir, { type: "working", author: agent, still: "home" }),
    await appendEvent(dir, { type: "working", author: HUMAN, still: "home", variant: "desktop" }),
    await appendEvent(dir, { type: "reply", author: HUMAN, thread: thread.id, body: "Any news?" }),
  ];
  const on = new Map();
  assert.deepEqual(events.map((e) => applyWorking(on, e)), [false, true, true, false, false]);
  const now = Date.parse(events.at(-1).at);
  assert.deepEqual(workingAt(on, now), working(dir, now));
  const states = workingAt(on, now).map((w) => [w.thread, w.still, w.note]);
  assert.deepEqual(states, [[thread.id, null, "re-shooting"], [null, "home", null]]);
  assert.deepEqual(workingAt(on, now + WORKING_MS + 1000), []);
  const reply = await appendEvent(dir, { type: "reply", author: agent, thread: thread.id, body: "Fixed" });
  assert.equal(applyWorking(on, reply), true);
  assert.deepEqual(workingAt(on, now).map((w) => w.still), ["home"]);
  assert.equal(applyWorking(on, await appendEvent(dir, { type: "idle", author: agent })), true);
  assert.deepEqual(workingAt(on, now), working(dir, now));
  assert.equal(on.size, 0);
});

test("reviewer names a tailnet user by the headers tailscale serve adds, and nobody on another host", () => {
  const hosts = ["Box.tail1234.ts.net", ".Share.example"];
  const login = "dante@example.com";
  const named = { host: "box.tail1234.ts.net:40000", "tailscale-user-login": login, "tailscale-user-name": "Dante B" };
  assert.deepEqual(reviewer(named, hosts), { name: "Dante B", via: "tailnet" });
  assert.deepEqual(reviewer({ ...named, "tailscale-user-name": "" }, hosts), { name: login, via: "tailnet" });
  const called = (name) => reviewer({ ...named, "tailscale-user-name": name }, hosts).name;
  assert.equal(called("=?utf-8?q?Ana_Mar=C3=ADa?="), "Ana María");
  assert.equal(called("=?utf-8?q?Ana_Mar=C3=AD?= =?utf-8?q?a_100%41?="), "Ana María 100%41");
  assert.equal(called(`=?UTF-8?b?${Buffer.from("José").toString("base64")}?=`), "José");
  assert.equal(called("x".repeat(300)).length, 100);
  assert.equal(reviewer({ host: "box.tail1234.ts.net" }, hosts), null);
  assert.equal(reviewer({ host: "box.tail1234.ts.net", "tailscale-user-name": "Dante" }, hosts), null);
  assert.equal(reviewer({ ...named, host: "my-app.share.example" }, hosts), null);
  assert.equal(reviewer({ ...named, host: "SHARE.example:443" }, hosts), null);
  assert.equal(reviewer({ ...named, host: "100.64.0.7:40000" }, hosts), null);
  assert.equal(reviewer({ ...named, host: "my-app.share.example" }, [".share.example"]), null);
  assert.deepEqual(reviewer({ ...named, host: "127.0.0.1:5173" }, []), { name: "Dante B", via: "tailnet" });
});

test("authorOf writes a tailnet user's name, and a guest's own, of 1 to 40 characters", () => {
  const owner = { name: "Dante", via: "tailnet" };
  assert.deepEqual(authorOf(owner, { name: "Ana" }), { kind: "human", name: "Dante", via: "tailnet" });
  assert.deepEqual(authorOf(null, { name: "  Ana " }), { kind: "human", name: "Ana", via: "share" });
  assert.deepEqual(authorOf(null, { name: "x".repeat(40) }).name.length, 40);
  const refused = (given) => {
    try {
      authorOf(null, given);
    } catch (e) {
      return [e.status, e.message];
    }
    return null;
  };
  assert.deepEqual(refused(undefined), [400, "name required"]);
  assert.deepEqual(refused({ name: " " }), [400, "name required"]);
  assert.deepEqual(refused({ name: 7 }), [400, "name required"]);
  assert.equal(refused({ name: "x".repeat(41) })[0], 400);
});

test("a drag makes a region between its two ends, in either direction, kept inside the still", () => {
  assert.deepEqual(region({ x: 0.1, y: 0.2 }, { x: 0.4, y: 0.5 }), { x: 0.1, y: 0.2, w: 0.3, h: 0.3 });
  assert.deepEqual(region({ x: 0.4, y: 0.5 }, { x: 0.1, y: 0.2 }), { x: 0.1, y: 0.2, w: 0.3, h: 0.3 });
  assert.deepEqual(region({ x: -0.3, y: 0.5 }, { x: 1.4, y: 2 }), { x: 0, y: 0.5, w: 1, h: 0.5 });
  assert.deepEqual(region({ x: 0.123456, y: 0 }, { x: 0.5, y: 1 }), { x: 0.1235, y: 0, w: 0.3765, h: 1 });
  assert.deepEqual(region({ x: 1, y: 0 }, { x: 1, y: 0 }), { x: 0.99, y: 0, w: 0.01, h: 0.01 });
  assert.deepEqual(pin({ x: 1.2, y: 0.33333 }), { x: 1, y: 0.3333 });
});

test("a mark moves without leaving the still or changing size, and resizes from the opposite corner", () => {
  const box = { x: 0.2, y: 0.2, w: 0.3, h: 0.2 };
  assert.deepEqual(moved(box, 0.1, -0.1), { x: 0.3, y: 0.1, w: 0.3, h: 0.2 });
  assert.deepEqual(moved(box, 0.9, -0.9), { x: 0.7, y: 0, w: 0.3, h: 0.2 });
  assert.deepEqual(moved({ x: 0.5, y: 0.5 }, 0.1, 0.9), { x: 0.6, y: 1 });
  assert.deepEqual(opposite(box, "nw"), { x: 0.5, y: 0.4 });
  assert.deepEqual(opposite(box, "se"), { x: 0.2, y: 0.2 });
  assert.deepEqual(region(opposite(box, "ne"), { x: 0.9, y: 0.1 }), { x: 0.2, y: 0.1, w: 0.7, h: 0.3 });
});

test("every region a drag or a move can make is one the store takes", async (t) => {
  const dir = scratch(t, { "shot.png": PNG });
  await addStill(dir, { file: path.join(dir, "shot.png"), name: "home" });
  let seed = 7;
  const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const point = () => ({ x: random() * 1.4 - 0.2, y: random() * 1.4 - 0.2 });
  for (let i = 0; i < 2000; i++) {
    const drawn = region(point(), point());
    for (const a of [drawn, moved(drawn, random() - 0.5, random() - 0.5)]) {
      assert.ok(a.w > 0 && a.h > 0 && a.x >= 0 && a.y >= 0 && a.x + a.w <= 1 && a.y + a.h <= 1, JSON.stringify(a));
    }
  }
  for (const anchor of [region({ x: 0.9999, y: 0.9999 }, { x: 3, y: 3 }), pin({ x: 2, y: -1 })]) {
    const remark = { type: "thread", author: HUMAN, still: "home", rev: 1, anchor, body: "Here" };
    const stored = await appendEvent(dir, remark);
    assert.deepEqual(stored.anchor, anchor);
  }
});

test("applyThread folds the log into the threads as the store does, and takes an event only once", async (t) => {
  const dir = scratch(t, { "shot.png": PNG });
  await addStill(dir, { file: path.join(dir, "shot.png"), name: "home" });
  const agent = { kind: "agent", name: "claude" };
  const anchor = { x: 0.1, y: 0.2, w: 0.3, h: 0.3 };
  const opened = await appendEvent(dir, { type: "thread", author: HUMAN, still: "home", rev: 1, anchor, body: "Wide" });
  const whole = await appendEvent(dir, { type: "thread", author: HUMAN, still: "home", rev: 1, body: "All of it" });
  const events = [
    opened,
    whole,
    await appendEvent(dir, { type: "reply", author: agent, thread: opened.id, body: "Fixed in rev 2" }),
    await appendEvent(dir, { type: "resolve", author: HUMAN, thread: opened.id }),
    await appendEvent(dir, { type: "reopen", author: HUMAN, thread: opened.id }),
    await appendEvent(dir, { type: "resolve", author: HUMAN, thread: whole.id }),
    await appendEvent(dir, { type: "viewed", author: HUMAN, still: "home", rev: 1 }),
  ];
  const folded = [];
  const stored = () => threads(dir).map((t) => ({ ...t, variant: null }));
  assert.deepEqual(events.map((e) => applyThread(folded, e)), [true, true, true, true, true, true, false]);
  assert.deepEqual(folded, stored());
  const summary = folded.map((f) => [f.status, f.replies.length, f.anchor]);
  assert.deepEqual(summary, [["open", 1, anchor], ["resolved", 0, null]]);
  assert.deepEqual(events.map((e) => applyThread(folded, e)), events.map(() => false));
  assert.deepEqual(folded, stored());
  const stray = { type: "reply", seq: 99, id: "x", thread: "gone", author: agent, body: "?" };
  assert.equal(applyThread(folded, stray), false);
});

test("annotatedPng takes a PNG data URL only, of at most 8 MiB", () => {
  const url = (bytes) => `data:image/png;base64,${bytes.toString("base64")}`;
  assert.deepEqual(annotatedPng(url(PNG)), PNG);
  const refused = (value) => {
    try {
      annotatedPng(value);
    } catch (e) {
      return e.status;
    }
    return null;
  };
  assert.equal(refused(PNG.toString("base64")), 400);
  assert.equal(refused(`data:image/jpeg;base64,${PNG.toString("base64")}`), 400);
  assert.equal(refused(url(Buffer.from("<svg onload=alert(1)>"))), 400);
  assert.equal(refused(url(Buffer.alloc(0))), 400);
  assert.equal(refused(42), 400);
  assert.equal(refused(url(Buffer.concat([PNG, Buffer.alloc(8 * 1024 * 1024 - PNG.length)]))), null);
  assert.equal(refused(url(Buffer.concat([PNG, Buffer.alloc(8 * 1024 * 1024)]))), 413);
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

/** A phone's room, 375 by 600, holding a 1440 by 900 still. */
const ROOM = { vw: 375, vh: 600, ratio: 900 / 1440 };

/** The spot of the still under the point `p` of the room in `view`, normalized to the still. */
function under(view, p, box = ROOM) {
  const width = box.vw * view.z;
  return { x: (p.x - view.x) / width, y: (p.y - view.y) / (width * box.ratio) };
}

test("fitted keeps the zoom in range, centers a still shorter than its room and leaves no gap past it", () => {
  const short = (ROOM.vh - ROOM.vw * ROOM.ratio) / 2;
  assert.deepEqual(fitted({ z: 0.4, x: -50, y: 90 }, ROOM), { z: 1, x: 0, y: short });
  assert.equal(fitted({ z: 99, x: 0, y: 0 }, ROOM).z, MAX_ZOOM);
  assert.deepEqual(fitted({ z: 4, x: 40, y: 30 }, ROOM), { z: 4, x: 0, y: 0 });
  assert.deepEqual(fitted({ z: 4, x: -9999, y: -9999 }, ROOM), { z: 4, x: 375 - 1500, y: 600 - 937.5 });
  const page = { vw: 375, vh: 600, ratio: 4 };
  assert.deepEqual(fitted({ z: 1, x: 0, y: -200 }, page), { z: 1, x: 0, y: -200 });
  assert.deepEqual(fitted({ z: 1, x: 0, y: -2000 }, page), { z: 1, x: 0, y: -900 });
});

test("zoomed keeps the spot under the fingers: a point marked at 3x lands where it was aimed", () => {
  const start = fitted({ z: 1, x: 0, y: 0 }, ROOM);
  const finger = { x: 300, y: 300 };
  const spot = under(start, finger);
  const close = zoomed(start, finger, finger, 3, ROOM);
  assert.equal(close.z, 3);
  const marked = under(close, finger);
  assert.ok(Math.abs(marked.x - spot.x) < 0.01 && Math.abs(marked.y - spot.y) < 0.01, JSON.stringify({ spot, marked }));
  const panned = zoomed(close, finger, { x: 200, y: 300 }, 1, ROOM);
  const dragged = under(panned, { x: 200, y: 300 });
  assert.ok(Math.abs(dragged.x - spot.x) < 1e-9 && Math.abs(dragged.y - spot.y) < 1e-9);
  const pinched = zoomed(close, { x: 100, y: 100 }, { x: 120, y: 140 }, 1.5, ROOM);
  assert.equal(pinched.z, 4.5);
  assert.deepEqual(zoomed(close, finger, finger, 1 / 3, ROOM), start);
});

test("viewOn and revealed bring a mark into the room", () => {
  const anchor = { x: 0.7, y: 0.45, w: 0.2, h: 0.1 };
  const view = viewOn(anchor, ROOM);
  assert.ok(Math.abs(view.z - 3) < 1e-9);
  const middle = under(view, { x: ROOM.vw / 2, y: ROOM.vh / 2 });
  assert.ok(Math.abs(middle.x - 0.8) < 1e-9 && Math.abs(middle.y - 0.5) < 1e-9);
  assert.equal(viewOn({ x: 0.5, y: 0.5 }, ROOM).z, 2);
  assert.equal(viewOn({ x: 0, y: 0, w: 0.01, h: 0.01 }, ROOM).z, 4);
  const seen = { z: 3, x: -700, y: -50 };
  assert.equal(revealed(seen, anchor, ROOM), seen);
  const away = revealed({ z: 3, x: 0, y: 0 }, anchor, ROOM);
  assert.equal(away.z, 3);
  assert.ok(Math.abs(under(away, { x: ROOM.vw / 2, y: ROOM.vh / 2 }).x - 0.8) < 1e-9);
  const low = { vw: 375, vh: 150, ratio: 900 / 1440 };
  const lifted = revealed(fitted({ z: 1, x: 0, y: 0 }, low), { x: 0.5, y: 0.95 }, low);
  assert.ok(lifted.y + 0.95 * 375 * low.ratio <= low.vh);
});

test("cropOf frames a mark with what is around it and never leaves a gap", () => {
  const image = { w: 1440, h: 900 };
  const frame = { w: 375, h: 120 };
  const box = cropOf({ x: 0.5, y: 0.5, w: 0.4, h: 0.1 }, image, frame);
  assert.ok(Math.abs(box.width - (375 / (0.4 * 1.5 * 1440)) * 1440) < 1e-9);
  assert.ok(Math.abs(box.left + 0.7 * box.width - 375 / 2) < 1e-9);
  assert.ok(Math.abs(box.top + 0.55 * box.height - 60) < 1e-9);
  const corner = cropOf({ x: 0, y: 0 }, image, frame);
  assert.deepEqual([corner.left, corner.top], [0, 0]);
  assert.ok(Math.abs(corner.width - 375 / 0.35) < 1e-9);
  const end = cropOf({ x: 1, y: 1 }, image, frame);
  assert.ok(Math.abs(end.left + end.width - 375) < 1e-9 && Math.abs(end.top + end.height - 120) < 1e-9);
});

test("a card's title, latest message, age, chip and unread replies", () => {
  const reply = (seq, kind) => ({ seq, author: { kind, name: kind }, body: `r${seq}`, at: "2026-01-01T00:00:00Z" });
  const thread = { id: "t1", rev: 1, status: "open", body: "\n  Label wraps \nsecond line", replies: [] };
  assert.equal(title(thread.body), "Label wraps");
  assert.equal(title("  "), "");
  assert.equal(lastMessage(thread), thread);
  thread.replies.push(reply(5, "agent"), reply(7, "human"), reply(9, "agent"));
  assert.equal(lastMessage(thread).seq, 9);
  const ages = [0, 59_000, 60_000, 3_599_000, 3_600_000, 86_400_000 * 3].map((ms) => ago(0, ms));
  assert.deepEqual(ages, ["now", "now", "1m", "59m", "1h", "3d"]);
  assert.equal(chip(thread, 1), "open");
  assert.equal(chip(thread, 2), "moved");
  assert.equal(chip({ ...thread, rev: null }, 2), "open");
  assert.equal(chip({ ...thread, status: "resolved" }, 2), "resolved");
  assert.equal(unread(thread, {}), 3);
  assert.equal(unread(thread, { t1: 5 }), 2);
  assert.equal(unread(thread, { t1: 5 }, "agent"), 1);
  assert.equal(unread(thread, { t1: 9 }), 0);
  assert.equal(unread(thread, { constructor: 99 }, "agent"), 2);
});

/**
 * A stand-in for `capture` that writes a PNG ending in `shot.bytes` and answers `shot.size`
 * (`[width, height]` in pixels) and `shot.rects`, else a rect for no selector. `calls` are the
 * options it was called with.
 */
function shooter() {
  const shot = { bytes: "a", size: [1170, 2532], rects: null, calls: [], fail: null };
  shot.shoot = async (opts) => {
    shot.calls.push(opts);
    if (shot.fail) throw new Error(shot.fail);
    writeFileSync(opts.out, Buffer.concat([PNG, Buffer.from(shot.bytes)]));
    const [width, height] = shot.size;
    const rects = shot.rects ?? opts.measure.map(() => null);
    return { file: opts.out, width, height, fullPage: opts.fullPage, rects };
  };
  return shot;
}

/**
 * The `/_review/` routes on `dir` (a scratch dir, given the pages in `FROZEN_PAGES`, or a folder
 * source), served for one test with `shot.shoot` as it is at each request (see `shooter`), as
 * `shot.who`. Returns `{ post, fetchAt }`: `post(body, headers)` posts JSON to `/_review/freeze`.
 */
async function reviewServer(t, dir, shot) {
  if (typeof dir === "string") {
    for (const page of FROZEN_PAGES) {
      mkdirSync(path.join(dir, "pages", path.dirname(page)), { recursive: true });
      writeFileSync(path.join(dir, "pages", `${page}.html`), "<!doctype html>");
    }
  }
  const { who = { name: "Dante", via: "tailnet" } } = shot;
  const stream = { notify() {}, push() {} };
  const shoot = (opts) => shot.shoot(opts);
  const server = createServer((req, res) => handleReview(req, res, { scratch: dir, stream, who, shoot }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (body, headers = {}) =>
    fetch(`${base}/_review/freeze`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  return { base, post };
}

/** The `x`, `y`, `w` and `h` of `anchor`, each to 6 decimals. */
function rounded(anchor) {
  return [anchor.x, anchor.y, anchor.w, anchor.h].map((v) => Number(v.toFixed(6)));
}

const FROZEN_PAGES = ["checkout", "Check_out/Pay", "a-b"];
const ELEMENT = { selector: "#pay", text: "Pay now", html: "<button id=pay>Pay now</button>" };
const FREEZE = {
  path: "/checkout",
  viewport: "mobile",
  scroll: { x: 0, y: 0 },
  box: { x: 39, y: 84.4, w: 195, h: 84.4 },
  elements: [ELEMENT],
};

test("a freeze of a page whose still did not change returns it and its latest rev, adding none", async (t) => {
  const dir = scratch(t, { "shot.png": Buffer.concat([PNG, Buffer.from("a")]) });
  await addStill(dir, { file: path.join(dir, "shot.png"), name: "checkout", source: "/checkout", viewport: "mobile" });
  const shot = shooter();
  const { base, post } = await reviewServer(t, dir, shot);
  shot.rects = [{ x: 39, y: 84.4, w: 195, h: 84.4 }];
  const res = await post(FREEZE);
  assert.equal(res.status, 200);
  const frozen = await res.json();
  assert.deepEqual(
    { ...frozen, anchor: rounded(frozen.anchor) },
    {
      still: "checkout",
      variant: "mobile",
      rev: 1,
      anchor: [0.1, 0.1, 0.5, 0.1],
      state: "reproduced",
      target: {
        page: "/checkout",
        elements: [ELEMENT],
        viewport: "mobile",
        scroll: { x: 0, y: 0 },
        state: "reproduced",
      },
    }
  );
  assert.deepEqual(shot.calls.map((c) => [c.url, c.viewport, c.tags, c.fullPage, c.measure]), [
    [`${base}/checkout`, "mobile", [], false, ["#pay"]],
  ]);
  assert.deepEqual(stills(dir).map((s) => [s.name, s.variants[0].revs.length]), [["checkout", 1]]);
  shot.bytes = "b";
  assert.equal((await (await post(FREEZE)).json()).rev, 2);
  const thread = { type: "thread", author: HUMAN, still: frozen.still, variant: frozen.variant, rev: frozen.rev };
  const stored = await appendEvent(dir, { ...thread, anchor: frozen.anchor, body: "Lower", target: frozen.target });
  assert.deepEqual(threads(dir)[0].target, stored.target);
});

test("a freeze of a page without a still of that screen makes live-<slug>, shot whole", async (t) => {
  const dir = scratch(t, { "shot.png": Buffer.concat([PNG, Buffer.from("a")]) });
  const keep = (name, source, opts = {}) =>
    addStill(dir, { file: path.join(dir, "shot.png"), name, source, viewport: "mobile", ...opts });
  await keep("tablet-only", "/checkout", { viewport: "tablet" });
  await keep("short", "/checkout");
  await keep("stepped", "/checkout", { fullPage: true });
  writeFileSync(
    path.join(dir, "shots.mjs"),
    'export default { shots: [{ name: "stepped", path: "/checkout", steps: async () => {} }] };\n'
  );
  const shot = shooter();
  shot.size = [1170, 6000];
  const { post } = await reviewServer(t, dir, shot);
  const below = { ...FREEZE, scroll: { x: 0, y: 900 } };
  const frozen = await (await post(below)).json();
  const where = [frozen.still, frozen.variant, frozen.rev, frozen.state];
  assert.deepEqual(where, ["live-checkout", "mobile", 1, "not-reproduced"]);
  assert.deepEqual(rounded(frozen.anchor), [0.1, 0.4922, 0.5, 0.0422]);
  assert.equal(shot.calls[0].fullPage, true);
  const live = stills(dir).find((s) => s.name === "live-checkout");
  const kept = [live.title, live.source.path, live.variants[0].viewport.fullPage];
  assert.deepEqual(kept, ["/checkout (live)", "/checkout", true]);
  assert.equal((await (await post(below)).json()).still, "live-checkout");
  assert.equal(stills(dir).length, 4);
  const query = await (await post({ ...FREEZE, path: "/Check_out/Pay?step=2&x=%20" })).json();
  assert.equal(query.still, "live-check_out-pay-step-2-x-20");
  writeFileSync(path.join(dir, "shots.mjs"), "export default {");
  const unread = await (await post({ ...FREEZE, tags: ["dark"] })).json();
  assert.deepEqual([unread.still, unread.variant], ["live-checkout", "mobile+dark"]);
});

test("a freeze shoots a kept still at the maxHeight shots.mjs gives it, and waits its turn", async (t) => {
  const dir = scratch(t, { "shot.png": Buffer.concat([PNG, Buffer.from("a")]) });
  await addStill(dir, { file: path.join(dir, "shot.png"), name: "home", source: "/checkout", viewport: "mobile" });
  writeFileSync(
    path.join(dir, "shots.mjs"),
    'export default { defaults: { maxHeight: 3000 }, shots: [{ name: "home", path: "/checkout" }] };\n'
  );
  const shot = shooter();
  const { post } = await reviewServer(t, dir, shot);
  assert.equal((await post(FREEZE)).status, 200);
  assert.equal(shot.calls[0].maxHeight, 3000);
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const shoot = shot.shoot;
  shot.shoot = async (opts) => {
    await held;
    return shoot(opts);
  };
  const queued = Array.from({ length: 4 }, () => post(FREEZE));
  await new Promise((resolve) => setTimeout(resolve, 100));
  const busy = await post(FREEZE);
  assert.equal(busy.status, 503);
  release();
  assert.deepEqual((await Promise.all(queued)).map((r) => r.status), [200, 200, 200, 200]);
});

test("a live still's name another page has already ends with a hash of the page", async (t) => {
  const dir = scratch(t, { "shot.png": Buffer.concat([PNG, Buffer.from("a")]) });
  await addStill(dir, { file: path.join(dir, "shot.png"), name: "live-a-b", source: "/a/b", viewport: "desktop" });
  const { post } = await reviewServer(t, dir, shooter());
  const frozen = await (await post({ ...FREEZE, path: "/a-b" })).json();
  assert.match(frozen.still, /^live-a-b-[0-9a-f]{6}$/);
});

test("a freeze keeps 20 elements, cut to the target's limits, and says the list was truncated", async (t) => {
  const dir = scratch(t, {});
  const shot = shooter();
  const { post } = await reviewServer(t, dir, shot);
  const many = Array.from({ length: 25 }, (_, i) => ({
    selector: `#e${i}`,
    text: "t".repeat(300),
    html: "h".repeat(2000),
  }));
  const frozen = await (await post({ ...FREEZE, elements: many })).json();
  assert.equal(frozen.target.truncated, true);
  assert.equal(frozen.target.elements.length, 20);
  assert.deepEqual([frozen.target.elements[0].text.length, frozen.target.elements[0].html.length], [200, 1000]);
  assert.equal(shot.calls[0].measure.length, 20);
  const none = await (await post({ ...FREEZE, elements: [] })).json();
  assert.deepEqual([none.state, none.target.truncated], ["not-reproduced", undefined]);
});

test("a freeze follows the rules of posting an event: origin, JSON, a guest's name; a bad one is a 400", async (t) => {
  const dir = scratch(t, {});
  const shot = shooter();
  const { base, post } = await reviewServer(t, dir, shot);
  assert.equal((await post(FREEZE, { Origin: "https://evil.example" })).status, 403);
  assert.equal((await post(FREEZE, { "Content-Type": "text/plain" })).status, 415);
  assert.equal((await post("{")).status, 400);
  assert.equal((await post("[]")).status, 400);
  assert.equal((await post({ ...FREEZE, elements: Array(4000).fill(ELEMENT) })).status, 413);
  assert.equal((await fetch(`${base}/_review/freeze`)).status, 405);
  const bad = [
    { ...FREEZE, path: "//evil.example/x" },
    { ...FREEZE, path: "checkout" },
    { ...FREEZE, path: "/\\evil.example/x" },
    { ...FREEZE, viewport: "5000x900" },
    { ...FREEZE, viewport: "390x844@5" },
    { ...FREEZE, tags: Array.from({ length: 17 }, (_, i) => `t${i}`) },
    { ...FREEZE, viewport: "huge" },
    { ...FREEZE, viewport: { width: 390 } },
    { ...FREEZE, tags: ["dark", "light"] },
    { ...FREEZE, tags: "dark" },
    { ...FREEZE, scroll: { x: -1, y: 0 } },
    { ...FREEZE, box: { x: 0, y: 0, w: 0, h: 10 } },
    { ...FREEZE, elements: [{ text: "x" }] },
    { ...FREEZE, truncated: "yes" },
    { ...FREEZE, extra: 1 },
  ];
  for (const body of bad) assert.equal((await post(body)).status, 400, JSON.stringify(body));
  for (const page of ["/", "/stills", "/missing", "/app/package.json", "/checkout.html"]) {
    assert.equal((await post({ ...FREEZE, path: page })).status, 404, page);
  }
  assert.equal(shot.calls.length, 0);
  shot.fail = "Chromium is gone";
  const failed = await post(FREEZE);
  assert.deepEqual([failed.status, (await failed.json()).error], [500, "Chromium is gone"]);
  assert.deepEqual(stills(dir), []);
});

test("a guest freezes under a name only, and a folder source has no pages to freeze", async (t) => {
  const dir = scratch(t, {});
  const { post } = await reviewServer(t, dir, { ...shooter(), who: null });
  const nameless = await post(FREEZE);
  assert.deepEqual([nameless.status, (await nameless.json()).error], [400, "name required"]);
  assert.equal((await post({ ...FREEZE, author: { name: "Ana" } })).status, 200);
  const images = scratch(t, { "home.png": PNG });
  const served = await reviewServer(t, folder(images), shooter());
  assert.equal((await served.post(FREEZE)).status, 404);
});

test("placeMark takes the region around the marked elements, else the box sent, never off the shot", () => {
  const size = { w: 400, h: 1000 };
  const marked = { x: 100, y: 900, w: 200, h: 200 };
  const rects = [{ x: 10, y: 20, w: 100, h: 50 }, { x: 200, y: 100, w: 40, h: 30 }];
  const around = { anchor: { x: 0.025, y: 0.02, w: 0.575, h: 0.11 }, state: "reproduced" };
  assert.deepEqual(placeMark(rects, marked, size), around);
  const clipped = { anchor: { x: 0.25, y: 0.9, w: 0.5, h: 0.1 }, state: "not-reproduced" };
  assert.deepEqual(placeMark([rects[0], null], marked, size), clipped);
  assert.deepEqual(placeMark([{ x: 0, y: 1200, w: 10, h: 10 }], marked, size), clipped);
  assert.deepEqual(placeMark([], marked, size), clipped);
  assert.deepEqual(placeMark([], { x: 0, y: 1100, w: 10, h: 10 }, size), { anchor: null, state: "not-reproduced" });
});

test("freezeRequest cuts nothing it keeps and names the variant the freeze shoots", () => {
  const request = freezeRequest({ ...FREEZE, viewport: "390x844@3+touch", tags: ["Dark"] });
  const asked = [request.key, request.page, request.truncated, request.elements];
  assert.deepEqual(asked, ["mobile+dark", "/checkout", false, [ELEMENT]]);
  assert.equal(freezeRequest({ ...FREEZE, truncated: true }).truncated, true);
});
