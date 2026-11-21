/**
 * Tests for the DOM snapshot of a live page (`stills/snapshot.js`) and its renderer
 * (`renderSnapshot` of `capture.mjs`) in a real Chromium: a fixture page is driven as a
 * reviewer would and shot, its snapshot is taken in the page and rendered in a Chromium of its
 * own, and the render is held against the live shot, pixel by pixel. They need a Chromium:
 * `$CHROME_BIN`, or one where `findChrome` looks; without one they are skipped. Run with
 * `npm test` from mockup/.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";
import { capture, findChrome, renderSnapshot } from "./capture.mjs";

const CHROME = findChrome();
const skip = CHROME ? false : "no Chromium: set CHROME_BIN";
const SNAPSHOT_JS = fileURLToPath(new URL("./stills/snapshot.js", import.meta.url));
const VIEWPORT = "400x700";
const GREEN = [0, 128, 0];
const WHITE = [255, 255, 255];

const HEAD = `<!doctype html><html><head><meta name="viewport" content="width=device-width"><style>
body{margin:0;font:16px sans-serif}.swatch{height:40px;background:rgb(200,0,0)}
</style>`;

const PAGES = {
  state: `${HEAD}<style>
#org{display:none;height:100px;background:rgb(0,128,0)}body.org #org{display:block}body.org #profile{display:none}
#profile{height:100px;background:rgb(200,0,0)}
#agree:checked~#agreed,#name:not(:placeholder-shown)~#named,#plan:has(option[value=team]:checked)~#planned{background:rgb(0,128,0)}
</style></head><body><button id="tab" onclick="document.body.classList.add('org')">Organization</button>
<div id="profile"></div><div id="org"></div>
<input id="agree" type="checkbox"><input id="name" placeholder="Name">
<select id="plan"><option value="free">Free</option><option value="team">Team</option></select>
<textarea id="notes"></textarea>
<div id="agreed" class="swatch"></div><div id="named" class="swatch"></div><div id="planned" class="swatch"></div>
<script>window.ran = true;</script></body></html>`,
  scroll: `${HEAD}<style>
#list{position:fixed;top:0;left:0;width:200px;height:300px;overflow-y:auto}
.row{height:100px}.band{height:100px;margin-left:200px}
</style></head><body><div id="list"></div><script>
for (let i = 0; i < 20; i += 1) {
  const row = document.createElement("div");
  row.className = "row";
  row.style.background = "rgb(" + i * 10 + ",0,0)";
  document.getElementById("list").append(row);
  const band = document.createElement("div");
  band.className = "band";
  band.style.background = "rgb(0," + i * 10 + ",0)";
  document.body.append(band);
}
</script></body></html>`,
  cssinjs: `${HEAD}<style id="rules"></style><link rel="stylesheet" href="/assets/linked.css"></head><body>
<div class="sc-a"></div><div class="sc-b"></div><div class="linked"></div><script>
document.getElementById("rules").sheet.insertRule(".sc-a{height:100px;background:rgb(0,0,255)}");
const sheet = new CSSStyleSheet();
sheet.replaceSync(".sc-b{height:100px;background:rgb(0,128,0)}");
document.adoptedStyleSheets = [sheet];
</script></body></html>`,
  shadow: `${HEAD}</head><body><x-card><p id="slotted">Slotted</p></x-card><script>
customElements.define("x-card", class extends HTMLElement {
  constructor() {
    super();
    const root = this.attachShadow({ mode: "open" });
    root.innerHTML = '<style>#inner{height:100px;background:rgb(128,0,128)}</style><div id="inner"></div><div id="adopted"></div><slot></slot>';
    const sheet = new CSSStyleSheet();
    sheet.replaceSync("#adopted{height:100px;background:rgb(0,128,0)}");
    root.adoptedStyleSheets = [sheet];
  }
});
</script></body></html>`,
  dialog: `${HEAD}<style>
dialog{width:200px;height:100px;padding:0;border:0;background:rgb(0,128,0)}dialog::backdrop{background:rgb(10,20,30)}
#tip{position:fixed;inset:auto;top:0;left:0;margin:0;border:0;padding:0;width:60px;height:40px;background:rgb(0,0,255)}
#plain{position:fixed;top:600px;left:0;margin:0;width:60px;height:40px;background:rgb(128,0,128)}
</style></head><body><button id="open">Open</button><dialog id="confirm"><button id="yes">Yes</button></dialog>
<dialog id="plain" open></dialog><div id="tip" popover="manual"></div><script>
document.getElementById("open").addEventListener("click", () => {
  document.getElementById("confirm").showModal();
  document.getElementById("tip").showPopover();
});
</script></body></html>`,
  host: `<!doctype html><html><body style="margin:0">
<iframe id="frame" src="/marks" style="display:block;border:0;width:360px;height:500px"></iframe></body></html>`,
  marks: `${HEAD}<style>
#pane{height:200px;overflow-y:auto}.item{height:90px;margin:10px}
</style></head><body><h1 id="title">Marks</h1><div id="pane"></div><x-tag></x-tag><div style="height:2000px"></div><script>
for (let i = 0; i < 12; i += 1) {
  const item = document.createElement("div");
  item.className = "item";
  item.id = "item" + i;
  item.textContent = "Item " + i;
  document.getElementById("pane").append(item);
}
customElements.define("x-tag", class extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" }).innerHTML = '<span id="tag" style="display:inline-block;margin:7px;padding:3px">Tag</span>';
  }
});
</script></body></html>`,
  heavy: `${HEAD}</head><body><canvas id="noise" width="1800" height="1800" style="width:300px;height:300px"></canvas>
<div class="swatch" style="background:rgb(0,128,0)"></div><script>
const c = document.getElementById("noise").getContext("2d");
const data = c.createImageData(1800, 1800);
for (let i = 0; i < data.data.length; i += 1) data.data[i] = i % 4 === 3 ? 255 : Math.random() * 256;
c.putImageData(data, 0, 0);
</script></body></html>`,
  drawn: `${HEAD}</head><body><canvas id="pad" width="200" height="100"></canvas><script>
const c = document.getElementById("pad").getContext("2d");
c.fillStyle = "rgb(0,128,0)";
c.fillRect(0, 0, 200, 100);
</script></body></html>`,
};

const ASSETS = {
  "/assets/linked.css": [".linked{height:100px;background:url(dot.svg)}", "text/css"],
  "/assets/dot.svg": [
    '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="rgb(128,0,128)"/></svg>',
    "image/svg+xml",
  ],
};

/** The fixture pages, their assets and the snapshot module served for one test: its origin. */
async function serve(t) {
  const server = createServer((req, res) => {
    const { pathname } = new URL(req.url, "http://fixture");
    const page = PAGES[pathname.slice(1)];
    const [body, type] = page
      ? [page, "text/html"]
      : pathname === "/snapshot.js"
        ? [readFileSync(SNAPSHOT_JS), "text/javascript"]
        : (ASSETS[pathname] ?? [null]);
    res.writeHead(body ? 200 : 404, { "Content-Type": type ?? "text/plain" });
    res.end(body ?? "not found");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}

/** The expression that calls the in-page function `fn` with `args`. */
function call(fn, ...args) {
  return `(${fn})(...${JSON.stringify(args)})`;
}

/**
 * In the page: drop the focus, then take the snapshot of the page, or of the document in the
 * iframe `frame` names, with the elements `selectors` match marked, a selector after `>>>`
 * looked up in the shadow root of the one before it. Resolves to `{ snap, live }`, `live` the
 * rect of each marked element in the page, or to `{ error }` when the snapshot throws.
 */
async function takeSnapshot(selectors, frame) {
  const doc = frame ? document.querySelector(frame).contentDocument : document;
  const { snapshot } = await import("/snapshot.js");
  const lookup = (selector) =>
    selector.split(">>>").reduce((root, part) => (root.shadowRoot ?? root).querySelector(part.trim()), doc);
  const marked = selectors.map(lookup);
  doc.activeElement?.blur();
  try {
    const live = marked.map((el) => {
      const r = el.getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height };
    });
    return { snap: snapshot(doc, marked), live };
  } catch (e) {
    return { error: e.message };
  }
}

/**
 * Drive the fixture page `name` with `steps(page)` at `viewport`, take its snapshot with the
 * elements of `marked` marked, and shoot it: `{ snap, live, error, png }`, `png` the live shot.
 */
async function liveShot(t, base, name, { steps, marked = [], frame, viewport = VIEWPORT } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "snapshot-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const out = path.join(dir, "live.png");
  let taken;
  await capture({
    url: `${base}/${name}`,
    out,
    viewport,
    steps: async (page) => {
      await steps?.(page);
      taken = await page.evaluate(call(takeSnapshot, marked, frame));
    },
  });
  return { ...taken, png: decode(readFileSync(out)) };
}

/** The snapshot `snap` rendered against `base` at `viewport`: `{ png, rects }`, the PNG decoded. */
async function rendered(base, snap, { viewport = VIEWPORT, marks } = {}) {
  const { png, rects } = await renderSnapshot({ ...snap, viewport, marks, base });
  return { png: decode(png), rects };
}

/** The 8-bit RGB or RGBA PNG `bytes` decoded: `{ width, height, at }`, `at(x, y)` a pixel's `[r, g, b]`. */
function decode(bytes) {
  const chunks = [];
  let header = null;
  for (let at = 8; at < bytes.length; ) {
    const length = bytes.readUInt32BE(at);
    const type = bytes.toString("latin1", at + 4, at + 8);
    const data = bytes.subarray(at + 8, at + 8 + length);
    if (type === "IHDR") header = data;
    if (type === "IDAT") chunks.push(data);
    at += length + 12;
  }
  const width = header.readUInt32BE(0);
  const height = header.readUInt32BE(4);
  assert.equal(header[8], 8, "an 8-bit PNG");
  assert.ok(header[9] === 2 || header[9] === 6, "an RGB or RGBA PNG");
  const bpp = header[9] === 6 ? 4 : 3;
  const stride = width * bpp;
  const raw = inflateSync(Buffer.concat(chunks));
  const px = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x += 1) {
      const a = x >= bpp ? px[y * stride + x - bpp] : 0;
      const b = y ? px[(y - 1) * stride + x] : 0;
      const c = x >= bpp && y ? px[(y - 1) * stride + x - bpp] : 0;
      const p = a + b - c;
      const [pa, pb, pc] = [Math.abs(p - a), Math.abs(p - b), Math.abs(p - c)];
      const paeth = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      const add = [0, a, b, (a + b) >> 1, paeth][filter];
      px[y * stride + x] = (raw[y * (stride + 1) + 1 + x] + add) & 255;
    }
  }
  return { width, height, at: (x, y) => [...px.subarray(y * stride + x * bpp, y * stride + x * bpp + 3)] };
}

/** How many pixels of the decoded PNGs `a` and `b`, of one size, differ. */
function differing(a, b) {
  assert.deepEqual([a.width, a.height], [b.width, b.height]);
  let count = 0;
  for (let y = 0; y < a.height; y += 1) {
    for (let x = 0; x < a.width; x += 1) {
      const [p, q] = [a.at(x, y), b.at(x, y)];
      if (p[0] !== q[0] || p[1] !== q[1] || p[2] !== q[2]) count += 1;
    }
  }
  return count;
}

test("a tab switched by click, a toggled checkbox, typed text and a selected option show in the render, which runs no script", { skip }, async (t) => {
  const base = await serve(t);
  let tops;
  const live = await liveShot(t, base, "state", {
    steps: async (page) => {
      await page.click("#tab");
      await page.click("#agree");
      await page.type("#name", "Grace Hopper");
      await page.type("#notes", "two\nlines");
      await page.evaluate(() => {
        const plan = document.getElementById("plan");
        plan.value = "team";
        plan.dispatchEvent(new Event("change", { bubbles: true }));
      });
      tops = await page.evaluate(() =>
        ["org", "agreed", "named", "planned"].map((id) => document.getElementById(id).getBoundingClientRect().top)
      );
    },
  });
  assert.doesNotMatch(live.snap.html, /<script|onclick/);
  assert.match(live.snap.html, /value="Grace Hopper"/);
  assert.match(live.snap.html, /<textarea id="notes">two\nlines<\/textarea>/);
  assert.deepEqual(live.snap.viewport, { width: 400, height: 700 });
  const shot = await rendered(base, live.snap);
  assert.equal(tops.length, 4);
  for (const y of tops) assert.deepEqual(shot.png.at(200, Math.round(y) + 5), GREEN);
  assert.equal(differing(shot.png, live.png), 0);
});

test("an inner scroller scrolled to 400px renders scrolled to 400px, and the window to where it was", { skip }, async (t) => {
  const base = await serve(t);
  const live = await liveShot(t, base, "scroll", {
    steps: (page) =>
      page.evaluate(() => {
        document.getElementById("list").scrollTop = 400;
        window.scrollTo(0, 300);
      }),
  });
  assert.deepEqual([live.snap.scroll, live.snap.scrollers], [{ x: 0, y: 300 }, 1]);
  assert.match(live.snap.html, /id="list" data-pv-scroll="0,400"/);
  const shot = await rendered(base, live.snap);
  assert.deepEqual(shot.png.at(10, 10), [40, 0, 0]);
  assert.deepEqual(shot.png.at(300, 10), [0, 30, 0]);
  assert.equal(differing(shot.png, live.png), 0);
  await assert.rejects(
    renderSnapshot({ ...live.snap, scrollers: 2, viewport: VIEWPORT, base }),
    /rendered 1 of its 2 scrollers/
  );
});

test("a page whose rules exist only through insertRule and adopted sheets renders styled, a linked sheet with its own URLs", { skip }, async (t) => {
  const base = await serve(t);
  const live = await liveShot(t, base, "cssinjs");
  assert.doesNotMatch(live.snap.html, /<link/);
  assert.doesNotMatch(live.snap.html, /127\.0\.0\.1/);
  const shot = await rendered(base, live.snap);
  assert.deepEqual(shot.png.at(200, 50), [0, 0, 255]);
  assert.deepEqual(shot.png.at(200, 150), GREEN);
  assert.deepEqual(shot.png.at(200, 250), [128, 0, 128]);
  assert.equal(differing(shot.png, live.png), 0);
});

test("a custom element with an open shadow root renders its shadow content, adopted sheets and slot", { skip }, async (t) => {
  const base = await serve(t);
  const live = await liveShot(t, base, "shadow");
  assert.match(live.snap.html, /<x-card><template shadowrootmode="open">/);
  const shot = await rendered(base, live.snap);
  assert.deepEqual(shot.png.at(200, 50), [128, 0, 128]);
  assert.deepEqual(shot.png.at(200, 150), GREEN);
  assert.equal(differing(shot.png, live.png), 0);
});

test("an open dialog renders open, a modal one centred over its backdrop, and an open popover over both", { skip }, async (t) => {
  const base = await serve(t);
  const live = await liveShot(t, base, "dialog", { steps: (page) => page.click("#open") });
  const shot = await rendered(base, live.snap);
  assert.deepEqual(shot.png.at(200, 350), GREEN);
  assert.deepEqual(shot.png.at(390, 10), [10, 20, 30]);
  assert.deepEqual(shot.png.at(30, 20), [0, 0, 255]);
  assert.equal(differing(shot.png, live.png), 0);
  const closed = await liveShot(t, base, "dialog");
  const plain = await rendered(base, closed.snap);
  assert.deepEqual(plain.png.at(30, 620), [128, 0, 128]);
  assert.deepEqual(plain.png.at(200, 350), WHITE);
  assert.equal(differing(plain.png, closed.png), 0);
});

test("a canvas renders its pixels", { skip }, async (t) => {
  const base = await serve(t);
  const live = await liveShot(t, base, "drawn");
  const shot = await rendered(base, live.snap);
  assert.deepEqual(shot.png.at(100, 50), GREEN);
  assert.deepEqual(shot.png.at(300, 50), WHITE);
  assert.equal(differing(shot.png, live.png), 0);
});

test("rects are the marked elements' rects in the live page within 1px, in an iframe, a scroller and a shadow root; null for one not in the page", { skip }, async (t) => {
  const base = await serve(t);
  const live = await liveShot(t, base, "host", {
    frame: "#frame",
    marked: ["#title", "#item5", "x-tag >>> #tag"],
    steps: (page) =>
      page.evaluate(() => {
        const doc = document.getElementById("frame").contentDocument;
        doc.getElementById("pane").scrollTop = 430;
        doc.defaultView.scrollTo(0, 60);
      }),
  });
  assert.deepEqual(live.snap.viewport, { width: 360, height: 500 });
  const shot = await rendered(base, live.snap, { viewport: live.snap.viewport, marks: 4 });
  assert.deepEqual([shot.png.width, shot.png.height], [360, 500]);
  assert.equal(shot.rects.length, 4);
  assert.equal(shot.rects[3], null);
  live.live.forEach((rect, i) => {
    assert.ok(rect.w > 0 && rect.h > 0, `marked element ${i} has a box in the live page`);
    for (const side of ["x", "y", "w", "h"]) {
      assert.ok(Math.abs(shot.rects[i][side] - rect[side]) <= 1, `rects[${i}].${side}: ${shot.rects[i][side]} for ${rect[side]}`);
    }
  });
});

test("a snapshot over the cap drops its inline images and keeps their size; one still over fails naming the size", { skip }, async (t) => {
  const base = await serve(t);
  const live = await liveShot(t, base, "heavy");
  assert.doesNotMatch(live.snap.html, /data:image/);
  assert.match(live.snap.html, /<img id="noise" width="300" height="300"/);
  const shot = await rendered(base, live.snap);
  assert.deepEqual(shot.png.at(200, 320), GREEN);
  const over = await liveShot(t, base, "heavy", {
    steps: (page) => page.evaluate(() => document.body.append("x".repeat(9 * 1024 * 1024))),
  });
  assert.match(over.error, /snapshot is 9\.0 MiB, over the 8\.0 MiB/);
});
