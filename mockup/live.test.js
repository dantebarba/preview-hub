/**
 * Tests for the live shell (`stills/live.js`) in a real Chromium, driven through `capture`'s
 * steps: the shell, the viewer and the `/_review/` routes are served for each test over a
 * scratch dir with fixture pages, and a freeze shoots them with a Chromium of its own. They need
 * a Chromium: `$CHROME_BIN`, or one where `findChrome` looks; without one they are skipped. Run
 * with `npm test` from mockup/.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createReadStream, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { capture, findChrome } from "./capture.mjs";
import { eventStream, handleReview, sendLivePage, sendViewerPage } from "./menu.mjs";
import { stills, storePaths, threads } from "./review.mjs";

const CHROME = findChrome();
const skip = CHROME ? false : "no Chromium: set CHROME_BIN";

const HEAD = `<!doctype html><html><head><meta name="viewport" content="width=device-width"><style>
body{margin:0;font:16px sans-serif}button{position:absolute;left:20px;width:120px;height:40px}
#card{position:absolute;top:300px;left:20px;width:300px;height:120px}#lead{margin:10px;height:30px}
[role=dialog]{position:fixed;top:100px;left:40px;width:260px;height:160px;background:#fff;border:1px solid}
</style></head><body>`;

const PAGES = {
  three: `${HEAD}<div class="wrap"><button id="a" style="top:20px">One</button></div>
<button id="b" style="top:80px">Two</button><button id="c" style="top:140px">Three</button>
<section id="card"><p id="lead"><b id="word">Hello</b> there</p></section>
<div style="height:3000px"></div><script>
window.clicks = 0;
document.addEventListener("click", () => { window.clicks += 1; });
</script></body></html>`,
  modal: `${HEAD}<h1>Users</h1><script>
document.addEventListener("click", () => {
  if (document.querySelector("[role=dialog]")) return;
  const d = document.createElement("div");
  d.setAttribute("role", "dialog");
  d.innerHTML = '<button id="send" style="top:60px">Send invitation</button>';
  document.body.append(d);
});
</script></body></html>`,
  nav: `${HEAD}<a href="/other?tab=2" style="position:fixed;inset:0">Next</a></body></html>`,
  other: `${HEAD}<button id="only" style="top:20px">Only</button></body></html>`,
};

/**
 * The shell, the viewer, the review routes and the fixture pages over a new scratch dir, which
 * holds them under `pages/` too, served for one test as the reviewer `who`: `{ base, dir }`.
 */
async function serve(t, who = { name: "Dante", via: "tailnet" }) {
  const dir = mkdtempSync(path.join(tmpdir(), "live-"));
  mkdirSync(path.join(dir, "pages"));
  for (const [name, html] of Object.entries(PAGES)) writeFileSync(path.join(dir, "pages", `${name}.html`), html);
  const stream = eventStream(dir);
  const open = new Set();
  const server = createServer(async (req, res) => {
    open.add(res);
    res.on("close", () => open.delete(res));
    const { pathname } = new URL(req.url, "http://mockup");
    if (await handleReview(req, res, { scratch: dir, stream, who })) return undefined;
    if (pathname.startsWith("/live/")) return sendLivePage(req, res);
    if (pathname === "/stills") return sendViewerPage(req, res);
    const file = path.join(dir, decodeURIComponent(pathname));
    if (pathname.endsWith(".png") && existsSync(file)) {
      res.writeHead(200, { "Content-Type": "image/png" });
      return createReadStream(file).pipe(res);
    }
    const page = PAGES[pathname.slice(1)];
    res.writeHead(page ? 200 : 404, { "Content-Type": "text/html" });
    return res.end(page ?? "");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    stream.close();
    for (const res of open) res.destroy();
    server.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { base: `http://127.0.0.1:${server.address().port}`, dir };
}

/** Run `steps(page)` on `url` in a Chromium at `viewport`. */
async function drive(t, url, viewport, steps) {
  const out = mkdtempSync(path.join(tmpdir(), "live-shot-"));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  await capture({ url, out: path.join(out, "end.png"), viewport, steps });
}

/** The expression that calls the in-page function `fn` with `args`. */
function call(fn, ...args) {
  return `(${fn})(...${JSON.stringify(args)})`;
}

/**
 * In the shell: press at `from` and lift at `to`, points of the page's viewport in CSS pixels,
 * as one pointer of kind `type`; the same point twice is a tap.
 */
function gesture(from, to, type = "mouse") {
  const layer = document.getElementById("layer");
  const box = layer.getBoundingClientRect();
  const k = box.width / document.getElementById("frame").offsetWidth;
  const fire = (name, p) => {
    const at = { clientX: box.left + p.x * k, clientY: box.top + p.y * k };
    const init = { bubbles: true, cancelable: true, pointerId: 7, pointerType: type, button: 0, ...at };
    document.elementFromPoint(at.clientX, at.clientY).dispatchEvent(new PointerEvent(name, init));
  };
  fire("pointerdown", from);
  if (from.x !== to.x || from.y !== to.y) {
    fire("pointermove", { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 });
    fire("pointermove", to);
  }
  fire("pointerup", to);
}

/** In the shell: two fingers land `apart` pixels apart around `at` and move up by `dy`, then lift. */
function twoFingers(at, dy, apart = 60) {
  const layer = document.getElementById("layer");
  const box = layer.getBoundingClientRect();
  const k = box.width / document.getElementById("frame").offsetWidth;
  const fire = (name, id, x, y) => {
    const init = { bubbles: true, cancelable: true, pointerId: id, pointerType: "touch", button: 0 };
    layer.dispatchEvent(new PointerEvent(name, { ...init, clientX: box.left + x * k, clientY: box.top + y * k }));
  };
  fire("pointerdown", 1, at.x, at.y);
  fire("pointerdown", 2, at.x + apart, at.y);
  fire("pointermove", 1, at.x, at.y - dy);
  fire("pointermove", 2, at.x + apart, at.y - dy);
  fire("pointerup", 1, at.x, at.y - dy);
  fire("pointerup", 2, at.x + apart, at.y - dy);
}

/**
 * In the shell: what it shows, `{ marking, mode, cursor, frame, found, crumbs, box, path, url,
 * clicks, scrollY }`, `box` the mark in CSS pixels of the page's viewport, rounded.
 */
function shell() {
  const el = (id) => document.getElementById(id);
  const frame = el("frame");
  const draft = el("draft");
  const px = (v) => Math.round(parseFloat(v) * 100) / 100;
  const { left, top, width, height } = draft.style;
  const size = { w: frame.offsetWidth / 100, h: frame.offsetHeight / 100 };
  return {
    marking: !el("layer").hidden,
    mode: el("mode").hidden ? "" : el("mode").textContent,
    cursor: getComputedStyle(el("layer")).cursor,
    frame: getComputedStyle(el("screen")).boxShadow,
    found: el("pick").hidden ? "" : el("found").textContent,
    crumbs: el("crumbs").hidden ? [] : [...el("crumbs").children].map((c) => c.textContent),
    box: draft.hidden ? null : [px(left) * size.w, px(top) * size.h, px(width) * size.w, px(height) * size.h].map(Math.round),
    path: el("path").textContent,
    url: location.pathname + location.search,
    clicks: frame.contentWindow.clicks,
    scrollY: frame.contentWindow.scrollY,
  };
}

/** In the viewer: the draft a live mark opened, `{ hash, where, unshown, composer, draft }`. */
function viewer() {
  const el = (id) => document.getElementById(id);
  return {
    hash: location.hash,
    where: el("where").textContent,
    unshown: !el("unshown").hidden,
    composer: !el("composer").hidden,
    draft: el("draft").hidden ? "" : el("draft").className,
  };
}

/** In the viewer: write `body` in the composer of the draft and post it, then wait for its card. */
async function post(page, body) {
  await page.waitFor("#composer");
  await page.type("#body", body);
  await page.click("#post");
  await page.waitFor(".thread .target");
}

test("Use mode acts and selects nothing; Mark mode selects and does not act, and Esc and m switch", { skip }, async (t) => {
  const { base } = await serve(t);
  const seen = {};
  await drive(t, `${base}/live/three`, "desktop", async (page) => {
    await page.waitFor("#marking");
    await page.click("#frame");
    seen.use = await page.evaluate(call(shell));
    await page.click("#marking");
    seen.mark = await page.evaluate(call(shell));
    await page.click("#layer");
    seen.tapped = await page.evaluate(call(shell));
    await page.press("Escape");
    seen.left = await page.evaluate(call(shell));
    await page.press("m");
    seen.again = await page.evaluate(call(shell));
    await page.click("#cancel");
    seen.cancelled = await page.evaluate(call(shell));
  });
  assert.deepEqual([seen.use.clicks, seen.use.marking, seen.use.box, seen.use.mode], [1, false, null, ""]);
  assert.equal(seen.mark.marking, true);
  assert.equal(seen.mark.mode, "Marking: taps select, they don't act");
  assert.equal(seen.mark.cursor, "crosshair");
  assert.notEqual(seen.mark.frame, seen.use.frame);
  assert.equal(seen.mark.found, "Drag a box, or tap an element");
  assert.deepEqual([seen.tapped.clicks, seen.tapped.found], [1, "1 element"]);
  assert.ok(seen.tapped.box);
  assert.deepEqual([seen.left.marking, seen.left.box], [false, null]);
  assert.deepEqual([seen.again.marking, seen.again.box], [true, null]);
  assert.equal(seen.cancelled.marking, false);
});

test("a box over three elements counts them, a tap and a step up the breadcrumb marks the parent, and Comment opens the viewer on the shot with the target", { skip }, async (t) => {
  const { base, dir } = await serve(t);
  const seen = {};
  await drive(t, `${base}/live/three`, "desktop", async (page) => {
    await page.click("#marking");
    await page.evaluate(call(gesture, { x: 300, y: 400 }, { x: 300, y: 400 }));
    seen.empty = await page.evaluate(call(shell));
    await page.evaluate(call(gesture, { x: 45, y: 318 }, { x: 45, y: 318 }));
    seen.word = await page.evaluate(call(shell));
    await page.click("p#lead", { within: "#crumbs" });
    seen.parent = await page.evaluate(call(shell));
    await page.evaluate(call(gesture, { x: 10, y: 10 }, { x: 160, y: 190 }));
    seen.three = await page.evaluate(call(shell));
    await page.click("#comment");
    await page.waitFor("#composer");
    seen.viewer = await page.evaluate(call(viewer));
    await post(page, "Too tight");
  });
  assert.deepEqual(seen.empty.crumbs, []);
  assert.deepEqual([seen.empty.found, seen.empty.box], ["1 element", [20, 300, 300, 120]]);
  assert.deepEqual(seen.word.crumbs, ["section#card", "p#lead", "b#word"]);
  assert.equal(seen.word.found, "1 element");
  assert.deepEqual([seen.parent.found, seen.parent.box], ["1 element", [30, 310, 280, 30]]);
  assert.deepEqual([seen.three.found, seen.three.crumbs], ["3 elements", []]);
  assert.deepEqual(seen.viewer, { hash: "#live-three@desktop", where: "box on rev 1 · 3 elements", unshown: false, composer: true, draft: "box" });
  const [thread] = threads(dir);
  assert.deepEqual([thread.still, thread.variant, thread.rev, thread.body], ["live-three", "desktop", 1, "Too tight"]);
  assert.deepEqual(thread.target.elements.map((e) => [e.selector, e.text]), [["#a", "One"], ["#b", "Two"], ["#c", "Three"]]);
  assert.match(thread.target.elements[0].html, /^<button id="a"/);
  assert.deepEqual([thread.target.page, thread.target.viewport, thread.target.state], ["/three", "desktop", "reproduced"]);
  const { x, y, w, h } = thread.anchor;
  const [shot] = stills(dir)[0].variants[0].revs;
  assert.ok(shot);
  assert.deepEqual([x, w].map((v) => Math.round(v * 1440)), [20, 120]);
  assert.ok(y > 0 && h > 0 && y + h < 0.2);
  assert.ok(existsSync(path.join(storePaths(dir).annotated, `${thread.id}.png`)));
});

test("marking inside a dialog a click opened posts a thread that is not reproduced, with the element's HTML", { skip }, async (t) => {
  const { base, dir } = await serve(t);
  const seen = {};
  await drive(t, `${base}/live/modal`, "desktop", async (page) => {
    await page.waitFor("#marking");
    await page.click("#frame");
    await page.press("m");
    await page.evaluate(call(gesture, { x: 100, y: 180 }, { x: 100, y: 180 }));
    seen.shell = await page.evaluate(call(shell));
    await page.click("#comment");
    await page.waitFor("#composer");
    seen.viewer = await page.evaluate(call(viewer));
    await post(page, "Wrong label");
    seen.card = await page.evaluate(() => document.querySelector(".thread .target").textContent);
  });
  assert.deepEqual([seen.shell.found, seen.shell.crumbs], ["1 element", ["div", "button#send"]]);
  assert.deepEqual([seen.viewer.unshown, seen.viewer.draft], [true, "box"]);
  assert.equal(seen.card, "on /modal · 1 element · not reproduced");
  const [thread] = threads(dir);
  assert.equal(thread.target.state, "not-reproduced");
  assert.deepEqual(thread.target.elements, [{ selector: "#send", text: "Send invitation", html: '<button id="send" style="top:60px">Send invitation</button>' }]);
  assert.deepEqual([thread.anchor.x, thread.anchor.w].map((v) => Math.round(v * 1440)), [61, 120]);
});

test("after navigating in Use mode the bar, the shell's URL and the mark use the new path", { skip }, async (t) => {
  const { base, dir } = await serve(t);
  const seen = {};
  await drive(t, `${base}/live/nav`, "desktop", async (page) => {
    await page.waitFor("#marking");
    seen.before = await page.evaluate(call(shell));
    await page.click("#frame");
    await page.waitFor("#path", { text: "/other?tab=2" });
    seen.after = await page.evaluate(call(shell));
    await page.click("#marking");
    await page.evaluate(call(gesture, { x: 10, y: 10 }, { x: 200, y: 100 }));
    await page.click("#comment");
    await post(page, "Here");
  });
  assert.deepEqual([seen.before.path, seen.before.url], ["/nav", "/live/nav"]);
  assert.deepEqual([seen.after.path, seen.after.url, seen.after.marking], ["/other?tab=2", "/live/other?tab=2", false]);
  const [thread] = threads(dir);
  assert.deepEqual([thread.still, thread.target.page, thread.target.elements[0].selector], ["live-other-tab-2", "/other?tab=2", "#only"]);
});

test("on a phone the Mark button is in a dock under the page, one finger draws and two fingers scroll", { skip }, async (t) => {
  const { base } = await serve(t);
  const seen = {};
  await drive(t, `${base}/live/three`, "mobile", async (page) => {
    await page.waitFor("#arm");
    seen.layout = await page.evaluate(() => {
      const rect = (id) => document.getElementById(id).getBoundingClientRect().toJSON();
      return { arm: rect("arm"), screen: rect("screen"), top: rect("marking").width, high: innerHeight };
    });
    await page.click("#arm");
    await page.evaluate(call(gesture, { x: 10, y: 10 }, { x: 160, y: 190 }, "touch"));
    seen.drawn = await page.evaluate(call(shell));
    await page.evaluate(call(twoFingers, { x: 100, y: 400 }, 150));
    await page.sleep(100);
    seen.scrolled = await page.evaluate(call(shell));
  });
  assert.equal(seen.layout.top, 0);
  assert.ok(seen.layout.arm.top >= seen.layout.screen.bottom);
  assert.ok(seen.layout.arm.bottom > seen.layout.high * 0.85);
  assert.ok(seen.layout.arm.height >= 44);
  assert.deepEqual([seen.drawn.found, seen.drawn.scrollY, seen.drawn.marking], ["3 elements", 0, true]);
  assert.ok(seen.scrolled.scrollY > 100);
  assert.deepEqual([seen.scrolled.box, seen.scrolled.marking, seen.scrolled.clicks], [null, true, 0]);
});
