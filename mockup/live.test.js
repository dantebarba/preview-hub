/**
 * Tests for the live shell (`stills/live.js`) in a real Chromium, driven through `capture`'s
 * steps: the shell, the viewer and the `/_review/` routes are served for each test over a
 * scratch dir with fixture pages, and a remark's shot is taken by a Chromium of its own. They need
 * a Chromium: `$CHROME_BIN`, or one where `findChrome` looks; without one they are skipped. Run
 * with `npm test` from mockup/.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { capture, findChrome } from "./capture.mjs";
import { eventStream, handleReview, sendLivePage, sendViewerPage } from "./menu.mjs";
import { blankImage, decodePng, encodePng, pixelAt } from "./png.mjs";
import { addStill, appendEvent, stills, storePaths, threads } from "./review.mjs";

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
 * holds them under `pages/` too, served for one test as the reviewer `who`: `{ base, dir,
 * stream }`, `stream` the event stream its routes write to. `remarks(req, res)`, when given,
 * sees each `POST /_review/remarks` first and answers it itself by returning true.
 */
async function serve(t, { who = { name: "Dante", via: "tailnet" }, remarks = null } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "live-"));
  mkdirSync(path.join(dir, "pages"));
  for (const [name, html] of Object.entries(PAGES)) writeFileSync(path.join(dir, "pages", `${name}.html`), html);
  const stream = eventStream(dir);
  const open = new Set();
  const server = createServer(async (req, res) => {
    open.add(res);
    res.on("close", () => open.delete(res));
    const { pathname } = new URL(req.url, "http://mockup");
    if (req.method === "POST" && pathname === "/_review/remarks" && remarks?.(req, res)) return undefined;
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
  return { base: `http://127.0.0.1:${server.address().port}`, dir, stream };
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
 * In the shell: what it shows, `{ marking, pressed, cursor, frame, found, crumbs, box, path, url,
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
    pressed: el("marking").getAttribute("aria-pressed"),
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

/**
 * In the viewer: the thread a link opened, `{ hash, id, said, target, error }`: the card that is
 * unfolded, what its conversation says and what it says of its target, and the error line.
 */
function opened() {
  const on = document.querySelector(".thread.on");
  return {
    hash: location.hash,
    id: on?.closest(".slot").dataset.id ?? null,
    said: on?.querySelector(".entries")?.textContent ?? "",
    target: on?.querySelector(".target")?.textContent ?? "",
    error: document.getElementById("error").textContent,
  };
}

/**
 * In the shell: open the composer on the mark, type `body` and press Post, then wait for the
 * remark to be taken, which ends Mark mode. Resolves to what the page still holds: `{ kept,
 * marking, url }`.
 */
async function comment(page, body) {
  await page.evaluate(() => {
    document.getElementById("frame").contentWindow.kept = "same document";
  });
  await page.click("#comment");
  await page.type("#say", body);
  await page.click("#post");
  await page.waitFor("#layer", { gone: true });
  return page.evaluate(() => ({
    kept: document.getElementById("frame").contentWindow.kept,
    marking: !document.getElementById("layer").hidden,
    url: location.pathname + location.search,
  }));
}

/**
 * In the shell: the toast, null when there is none, else `{ text, spin, retry, failed, link }`:
 * what it says, whether it spins and offers Retry, and its link as `{ href, target }` once it
 * has one.
 */
function toast() {
  const el = (id) => document.getElementById(id);
  if (el("toast").hidden) return null;
  const open = el("open");
  return {
    text: el("toast-text").textContent,
    spin: !el("spin").hidden,
    retry: !el("retry").hidden,
    failed: el("toast").classList.contains("failed"),
    link: open.hidden ? null : { href: open.getAttribute("href"), target: open.target },
  };
}

/** In the shell: what the page in the iframe still is, `{ kept, page, url }`, `kept` a value put on its window. */
function held() {
  const view = document.getElementById("frame").contentWindow;
  return { kept: view.kept, page: view.location.pathname + view.location.search, url: location.pathname + location.search };
}

/** In the shell: where the composer and the mark are in the window, `{ composer, mark, high, wide }`, rects rounded. */
function composed() {
  const rect = (id) => {
    const r = document.getElementById(id).getBoundingClientRect();
    return { left: Math.round(r.left), top: Math.round(r.top), right: Math.round(r.right), bottom: Math.round(r.bottom) };
  };
  return { composer: rect("composer"), mark: rect("draft"), high: innerHeight, wide: innerWidth };
}

/**
 * In the shell: every text it holds, shown or not: the text nodes of its body, and each `title`
 * and `placeholder`, as `{ texts, titles, placeholders }`.
 */
function copy() {
  const texts = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.data.replace(/\s+/g, " ").trim();
    if (text && !node.parentElement.closest("script, style")) texts.push(text);
  }
  const attrs = (name) => [...document.querySelectorAll(`[${name}]`)].map((el) => el.getAttribute(name));
  return { texts, titles: attrs("title"), placeholders: attrs("placeholder") };
}

/** A `remarks` hook of `serve` that refuses each remark with a 500 and `error` while its `on` is true. */
function refusing(error) {
  const hook = (req, res) => {
    if (!hook.on) return false;
    req.resume();
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error }));
    return true;
  };
  hook.on = true;
  return hook;
}

/** The threads of `dir` once it has `n` of them, which a remark's shot takes a while to make. */
async function posted(dir, n = 1) {
  for (let i = 0; i < 600 && threads(dir).length < n; i += 1) await sleep(100);
  return threads(dir);
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
  assert.deepEqual([seen.use.clicks, seen.use.marking, seen.use.box, seen.use.pressed], [1, false, null, "false"]);
  assert.equal(seen.mark.marking, true);
  assert.equal(seen.mark.pressed, "true");
  assert.equal(seen.mark.cursor, "crosshair");
  assert.notEqual(seen.mark.frame, seen.use.frame);
  assert.equal(seen.mark.found, "");
  assert.deepEqual([seen.tapped.clicks, seen.tapped.found], [1, "1 element"]);
  assert.ok(seen.tapped.box);
  assert.deepEqual([seen.left.marking, seen.left.box], [false, null]);
  assert.deepEqual([seen.again.marking, seen.again.box], [true, null]);
  assert.equal(seen.cancelled.marking, false);
});

test("a box over three elements counts them, a tap and a step up the breadcrumb marks the parent, and Comment posts the remark in place, shot from the page as it is", { skip }, async (t) => {
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
    seen.after = await comment(page, "Too tight");
  });
  assert.deepEqual(seen.empty.crumbs, []);
  assert.deepEqual([seen.empty.found, seen.empty.box], ["1 element", [20, 300, 300, 120]]);
  assert.deepEqual(seen.word.crumbs, ["section#card", "p#lead", "b#word"]);
  assert.equal(seen.word.found, "1 element");
  assert.deepEqual([seen.parent.found, seen.parent.box], ["1 element", [30, 310, 280, 30]]);
  assert.deepEqual([seen.three.found, seen.three.crumbs], ["3 elements", []]);
  assert.deepEqual(seen.after, { kept: "same document", marking: false, url: "/live/three" });
  const [thread] = await posted(dir);
  assert.deepEqual([thread.still, thread.variant, thread.rev, thread.body], ["live-three", "desktop", 1, "Too tight"]);
  assert.deepEqual(thread.target.elements.map((e) => [e.selector, e.text]), [["#a", "One"], ["#b", "Two"], ["#c", "Three"]]);
  assert.match(thread.target.elements[0].html, /^<button id="a"/);
  assert.deepEqual([thread.target.page, thread.target.viewport, thread.target.state], ["/three", "desktop", "reproduced"]);
  const { x, y, w, h } = thread.anchor;
  const [shot] = stills(dir)[0].variants[0].revs;
  assert.ok(shot);
  assert.deepEqual([x, y, w, h].map((v, i) => Math.round(v * (i % 2 ? 900 : 1440))), [20, 20, 120, 160]);
  assert.ok(existsSync(path.join(storePaths(dir).annotated, `${thread.id}.png`)));
  await drive(t, `${base}/stills#thread=${thread.id}`, "desktop", async (page) => {
    await page.waitFor(".thread.on");
    seen.link = await page.evaluate(call(opened));
  });
  assert.deepEqual([seen.link.hash, seen.link.id, seen.link.target], ["#live-three@desktop", thread.id, "on /three · 3 elements"]);
  assert.match(seen.link.said, /Too tight/);
});

test("marking inside a dialog a click opened posts a thread whose shot shows the dialog, reproduced", { skip }, async (t) => {
  const { base, dir } = await serve(t);
  const seen = {};
  await drive(t, `${base}/live/modal`, "desktop", async (page) => {
    await page.waitFor("#marking");
    await page.click("#frame");
    await page.press("m");
    await page.evaluate(call(gesture, { x: 100, y: 180 }, { x: 100, y: 180 }));
    seen.shell = await page.evaluate(call(shell));
    await comment(page, "Wrong label");
  });
  assert.deepEqual([seen.shell.found, seen.shell.crumbs], ["1 element", ["div", "button#send"]]);
  const [thread] = await posted(dir);
  assert.equal(thread.target.state, "reproduced");
  assert.deepEqual(thread.target.elements, [{ selector: "#send", text: "Send invitation", html: '<button id="send" style="top:60px">Send invitation</button>' }]);
  assert.deepEqual([thread.anchor.x, thread.anchor.w].map((v) => Math.round(v * 1440)), [61, 120]);
  const marked = await decodePng(readFileSync(path.join(storePaths(dir).annotated, `${thread.id}.png`)));
  assert.deepEqual([marked.width, marked.height], [1440, 900]);
  assert.deepEqual([pixelAt(marked, 40, 240), pixelAt(marked, 20, 240)], [[0, 0, 0], [255, 255, 255]]);
});

test("a link to a thread that is not there yet opens it when the stream brings it, and says so when it was not posted", { skip }, async (t) => {
  const { base, dir, stream } = await serve(t);
  const seen = {};
  const file = path.join(dir, "shot.png");
  writeFileSync(file, await encodePng(blankImage(1440, 900)));
  await drive(t, `${base}/stills#thread=aaaa0001`, "desktop", async (page) => {
    await page.waitFor("#empty");
    seen.waiting = await page.evaluate(call(opened));
    await addStill(dir, { file, name: "live-three", source: "/three", viewport: "desktop" });
    const author = { kind: "human", name: "Dante", via: "tailnet" };
    const anchor = { x: 0.1, y: 0.1, w: 0.2, h: 0.2 };
    const thread = { type: "thread", author, still: "live-three", variant: "desktop", rev: 1, anchor, body: "Late" };
    await appendEvent(dir, thread, { id: "aaaa0001" });
    stream.notify("stills");
    stream.push();
    await page.waitFor(".thread.on");
    seen.landed = await page.evaluate(call(opened));
  });
  assert.deepEqual([seen.waiting.id, seen.waiting.hash], [null, "#thread=aaaa0001"]);
  assert.deepEqual([seen.landed.id, seen.landed.hash], ["aaaa0001", "#live-three@desktop"]);
  assert.match(seen.landed.said, /Late/);
  await drive(t, `${base}/stills#thread=bbbb0002`, "desktop", async (page) => {
    await page.waitFor("#still");
    stream.publish({ type: "remark-failed", id: "bbbb0002", error: "no room" });
    await page.waitFor("#error", { text: "no room" });
    seen.failed = await page.evaluate(call(opened));
  });
  assert.deepEqual([seen.failed.id, seen.failed.error], [null, "The remark was not posted: no room"]);
});

test("Post leaves the page, its URL and the shell's as they were; the toast goes from Posted with a spinner to Open, a link to the thread in a new tab, and hides by itself", { skip }, async (t) => {
  const { base, dir } = await serve(t);
  const seen = {};
  await drive(t, `${base}/live/three`, "desktop", async (page) => {
    await page.waitFor("#marking");
    await page.evaluate(() => {
      document.getElementById("frame").contentWindow.kept = "set before marking";
    });
    await page.click("#marking");
    await page.evaluate(call(gesture, { x: 80, y: 40 }, { x: 80, y: 40 }));
    await page.click("#comment");
    await page.type("#say", "Too loud");
    seen.empty = await page.evaluate(call(toast));
    await page.evaluate(() => {
      const init = { key: "Enter", ctrlKey: true, bubbles: true, cancelable: true };
      document.getElementById("say").dispatchEvent(new KeyboardEvent("keydown", init));
    });
    await page.waitFor("#toast");
    seen.sent = await page.evaluate(call(toast));
    seen.shell = await page.evaluate(call(shell));
    seen.composer = await page.evaluate(() => document.getElementById("composer").hidden);
    await page.waitFor("#open", { timeout: 60000 });
    seen.done = await page.evaluate(call(toast));
    await page.evaluate(() => {
      document.getElementById("open").addEventListener("click", (e) => {
        window.followed = !e.defaultPrevented;
        e.preventDefault();
      });
    });
    await page.click("#open");
    seen.followed = await page.evaluate(() => window.followed);
    seen.held = await page.evaluate(call(held));
    await page.waitFor("#toast", { gone: true, timeout: 10000 });
  });
  const [thread] = await posted(dir);
  assert.equal(seen.empty, null);
  assert.deepEqual(seen.sent, { text: "Posted", spin: true, retry: false, failed: false, link: null });
  assert.deepEqual([seen.shell.marking, seen.shell.box, seen.composer], [false, null, true]);
  assert.deepEqual(seen.done, { text: "Posted", spin: false, retry: false, failed: false, link: { href: `/stills#thread=${thread.id}`, target: "_blank" } });
  assert.equal(seen.followed, true);
  assert.deepEqual(seen.held, { kept: "set before marking", page: "/three", url: "/live/three" });
  assert.deepEqual([thread.body, thread.target.state, thread.target.elements[0].selector], ["Too loud", "reproduced", "#a"]);
  await drive(t, base + seen.done.link.href, "desktop", async (page) => {
    await page.waitFor(".thread.on");
    seen.link = await page.evaluate(call(opened));
  });
  assert.equal(seen.link.id, thread.id);
  assert.match(seen.link.said, /Too loud/);
});

test("a remark the server refuses says Not posted with the reason, and Retry posts the same draft, as the page was when it was made", { skip }, async (t) => {
  const remarks = refusing("no room");
  const { base, dir } = await serve(t, { remarks });
  const seen = {};
  await drive(t, `${base}/live/three`, "desktop", async (page) => {
    await page.click("#marking");
    await page.evaluate(call(gesture, { x: 10, y: 10 }, { x: 160, y: 190 }));
    seen.after = await comment(page, "Too tight");
    await page.waitFor("#retry");
    seen.failed = await page.evaluate(call(toast));
    await page.evaluate(() => {
      document.getElementById("frame").contentDocument.getElementById("a").textContent = "Changed";
    });
    remarks.on = false;
    await page.click("#retry");
    seen.again = await page.evaluate(call(toast));
    await page.waitFor("#open", { timeout: 60000 });
    seen.held = await page.evaluate(call(held));
  });
  assert.deepEqual(seen.after, { kept: "same document", marking: false, url: "/live/three" });
  assert.deepEqual(seen.failed, { text: "Not posted: no room", spin: false, retry: true, failed: true, link: null });
  assert.deepEqual([seen.again.text, seen.again.retry, seen.again.failed], ["Posted", false, false]);
  assert.deepEqual(seen.held, { kept: "same document", page: "/three", url: "/live/three" });
  const threads = await posted(dir);
  assert.equal(threads.length, 1);
  assert.deepEqual([threads[0].body, threads[0].target.state], ["Too tight", "reproduced"]);
  assert.deepEqual(threads[0].target.elements.map((e) => [e.selector, e.text]), [["#a", "One"], ["#b", "Two"], ["#c", "Three"]]);
});

test("a remark the runtime could not shoot says Not posted when the stream tells, Retry posts it, and a dismissed failure is given up", { skip }, async (t) => {
  let fake = "cccc0003";
  const remarks = (req, res) => {
    if (!fake) return false;
    req.resume();
    res.writeHead(202, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ id: fake }));
    return true;
  };
  const { base, dir, stream } = await serve(t, { remarks });
  const seen = {};
  await drive(t, `${base}/live/three`, "desktop", async (page) => {
    await page.click("#marking");
    await page.evaluate(call(gesture, { x: 80, y: 40 }, { x: 80, y: 40 }));
    await comment(page, "First");
    seen.shooting = await page.evaluate(call(toast));
    stream.publish({ type: "remark-failed", id: "cccc0003", error: "no Chromium" });
    await page.waitFor("#retry");
    seen.failed = await page.evaluate(call(toast));
    stream.publish({ type: "remark-failed", id: "cccc0003", error: "said twice" });
    await page.sleep(200);
    seen.twice = await page.evaluate(call(toast));
    await page.click("#dismiss");
    seen.dismissed = await page.evaluate(call(toast));
    await page.click("#marking");
    await page.evaluate(call(gesture, { x: 80, y: 100 }, { x: 80, y: 100 }));
    fake = "dddd0004";
    await comment(page, "Second");
    stream.publish({ type: "remark-failed", id: "dddd0004", error: "no Chromium" });
    await page.waitFor("#retry");
    fake = null;
    await page.click("#retry");
    await page.waitFor("#open", { timeout: 60000 });
  });
  assert.deepEqual([seen.shooting.text, seen.shooting.spin], ["Posted", true]);
  assert.deepEqual(seen.failed, { text: "Not posted: no Chromium", spin: false, retry: true, failed: true, link: null });
  assert.deepEqual(seen.twice, seen.failed);
  assert.equal(seen.dismissed, null);
  const threads = await posted(dir);
  assert.deepEqual(threads.map((thread) => [thread.body, thread.target.elements[0].selector]), [["Second", "#b"]]);
});

test("the composer opens under the box, over it when there is no room, and follows the box, which stays editable; Cancel and Esc close it and keep the mark", { skip }, async (t) => {
  const { base } = await serve(t);
  const seen = {};
  await drive(t, `${base}/live/three`, "desktop", async (page) => {
    await page.click("#marking");
    await page.evaluate(call(gesture, { x: 80, y: 40 }, { x: 80, y: 40 }));
    seen.closed = await page.evaluate(() => [document.getElementById("composer").hidden, document.getElementById("post").disabled]);
    await page.click("#comment");
    seen.under = await page.evaluate(call(composed));
    seen.focus = await page.evaluate(() => document.activeElement.id);
    seen.blank = await page.evaluate(() => document.getElementById("post").disabled);
    await page.type("#say", "Here");
    seen.typed = await page.evaluate(() => document.getElementById("post").disabled);
    await page.evaluate(call(gesture, { x: 900, y: 800 }, { x: 1300, y: 890 }));
    seen.over = await page.evaluate(call(composed));
    seen.kept = await page.evaluate(() => [document.getElementById("say").value, document.getElementById("found").textContent]);
    await page.click("#discard");
    seen.cancelled = await page.evaluate(call(shell));
    seen.gone = await page.evaluate(() => [document.getElementById("composer").hidden, document.getElementById("say").value]);
    await page.click("#comment");
    await page.press("Escape");
    seen.escaped = await page.evaluate(call(shell));
    seen.shut = await page.evaluate(() => document.getElementById("composer").hidden);
    await page.press("Escape");
    seen.left = await page.evaluate(call(shell));
  });
  assert.deepEqual(seen.closed, [true, true]);
  assert.ok(seen.under.composer.top >= seen.under.mark.bottom);
  assert.ok(seen.under.composer.top - seen.under.mark.bottom <= 12);
  assert.equal(seen.focus, "say");
  assert.deepEqual([seen.blank, seen.typed], [true, false]);
  assert.ok(seen.over.composer.bottom <= seen.over.mark.top);
  assert.ok(seen.over.composer.right <= seen.over.wide && seen.over.composer.left >= 0);
  assert.deepEqual(seen.kept, ["Here", "0 elements"]);
  assert.ok(seen.cancelled.marking && seen.cancelled.box);
  assert.deepEqual(seen.gone, [true, ""]);
  assert.ok(seen.escaped.marking && seen.escaped.box);
  assert.equal(seen.shut, true);
  assert.equal(seen.left.marking, false);
});

test("a guest is asked for a name on the first Post alone, with no paragraph; without one the composer stays, and every text and title of the shell is in the epic's copy table", { skip }, async (t) => {
  const remarks = refusing("no room");
  const { base, dir } = await serve(t, { who: null, remarks });
  const seen = { copy: [] };
  await drive(t, `${base}/live/three`, "desktop", async (page) => {
    const note = async () => seen.copy.push(await page.evaluate(call(copy)));
    await page.waitFor("#marking");
    await note();
    await page.click("#marking");
    await note();
    await page.evaluate(call(gesture, { x: 45, y: 318 }, { x: 45, y: 318 }));
    await note();
    await page.evaluate(call(gesture, { x: 10, y: 10 }, { x: 160, y: 190 }));
    await page.click("#comment");
    await page.type("#say", "Too tight");
    await note();
    await page.click("#post");
    await page.waitFor("#who-name");
    await note();
    seen.sheet = await page.evaluate(() => document.getElementById("who-form").innerText.replace(/\s+/g, " ").trim());
    await page.click("#who-close");
    seen.unnamed = await page.evaluate(() => {
      const el = (id) => document.getElementById(id);
      return [el("composer").hidden, el("say").value, el("toast").hidden, !el("layer").hidden];
    });
    await page.click("#post");
    await page.type("#who-name", "Ana");
    await page.click("#continue");
    await page.waitFor("#retry");
    await note();
    remarks.on = false;
    await page.click("#retry");
    seen.asked = await page.evaluate(() => document.getElementById("who").hidden);
    await note();
    await page.waitFor("#open", { timeout: 60000 });
    await note();
  });
  assert.equal(seen.sheet, "What's your name? Continue");
  assert.deepEqual(seen.unnamed, [false, "Too tight", true, true]);
  assert.equal(seen.asked, true);
  const [thread] = await posted(dir);
  assert.deepEqual([thread.author.name, thread.author.via, thread.body], ["Ana", "share", "Too tight"]);
  const table = [
    /^\/three$/,
    /^(Mobile|Tablet|Desktop)$/,
    /^\d+×\d+( · \d+%)?$/,
    /^(Mark|Cancel|Comment|Post|Posted|Open|Retry|Continue)$/,
    /^\d+\+? elements?$/,
    /^[a-z][a-z0-9]*([#.][\w-]+)?$/,
    /^Not posted: .+$/,
    /^What's your name\?$/,
  ];
  const said = new Set(seen.copy.flatMap((c) => c.texts));
  for (const text of said) assert.ok(table.some((re) => re.test(text)), `'${text}' is not in the copy table`);
  for (const text of ["Mark", "3 elements", "b#word", "Post", "Not posted: no room", "Retry", "Posted", "Open", "Continue"]) {
    assert.ok(said.has(text), `'${text}' was never shown`);
  }
  assert.deepEqual(seen.copy.flatMap((c) => c.titles), []);
  assert.deepEqual([...new Set(seen.copy.flatMap((c) => c.placeholders))], ["What is wrong here?"]);
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
    await comment(page, "Here");
  });
  assert.deepEqual([seen.before.path, seen.before.url], ["/nav", "/live/nav"]);
  assert.deepEqual([seen.after.path, seen.after.url, seen.after.marking], ["/other?tab=2", "/live/other?tab=2", false]);
  const [thread] = await posted(dir);
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

test("on a 390×844 touch screen the composer is whole at the bottom, over the room the keyboard takes, and Post there posts", { skip }, async (t) => {
  const { base, dir } = await serve(t);
  const seen = {};
  await drive(t, `${base}/live/three`, "mobile", async (page) => {
    await page.waitFor("#arm");
    await page.click("#arm");
    await page.evaluate(call(gesture, { x: 10, y: 10 }, { x: 160, y: 190 }, "touch"));
    await page.click("#comment");
    seen.open = await page.evaluate(call(composed));
    seen.buttons = await page.evaluate(() => ["discard", "post"].map((id) => document.getElementById(id).offsetHeight));
    await page.evaluate(() => document.documentElement.style.setProperty("--keyboard", "336px"));
    seen.lifted = await page.evaluate(call(composed));
    await page.evaluate(() => document.documentElement.style.removeProperty("--keyboard"));
    await page.type("#say", "Small");
    await page.click("#post");
    await page.waitFor("#open", { timeout: 60000 });
    seen.toast = await page.evaluate(() => document.getElementById("toast").getBoundingClientRect().toJSON());
    seen.shell = await page.evaluate(call(shell));
  });
  assert.deepEqual([seen.open.wide, seen.open.high], [390, 844]);
  assert.deepEqual([seen.open.composer.left, seen.open.composer.right, seen.open.composer.bottom], [0, 390, 844]);
  assert.ok(seen.open.composer.top > 0);
  assert.equal(seen.lifted.composer.bottom, 844 - 336);
  assert.ok(seen.lifted.composer.top > 0);
  assert.deepEqual([seen.lifted.composer.left, seen.lifted.composer.right], [0, 390]);
  assert.ok(seen.buttons.every((high) => high >= 44));
  assert.ok(seen.toast.left >= 0 && seen.toast.right <= 390 && seen.toast.bottom <= 844);
  assert.equal(seen.shell.marking, false);
  const [thread] = await posted(dir);
  assert.deepEqual([thread.variant, thread.body, thread.target.state], ["mobile", "Small", "reproduced"]);
});
