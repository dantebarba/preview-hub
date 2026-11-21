/**
 * Device-emulation capture for the /mockup runtime: stills of pages as devices show them, shot
 * the way Chrome's device toolbar does, through the Chrome DevTools protocol.
 *
 *   node capture.mjs <url> <out.png> [--viewport V] [--tag T]... [--full-page] [--max-height N]
 *   node capture.mjs --batch <shots.mjs> [--only REGEX] [--parallel N] [--strict] [--base URL]
 *                    [--out DIR] [--add DIR]
 *
 * `--viewport` is a preset of `review.mjs` (`mobile`, `mobile-s`, `tablet`, `desktop`/`web`,
 * default `mobile`) or `WxH[@dpr][+touch]`. A `dark` or `light` tag sets
 * `prefers-color-scheme`; other tags mean nothing here. A single shot prints `<out.png> <W>x<H>`
 * (pixels), followed by ` viewport` when a full page was asked for but a dialog was open. Exit
 * status: 0 shot, 1 failed, 2 bad usage.
 *
 * It starts its own headless Chromium (`$CHROME_BIN`, else the first one found) and speaks raw
 * CDP over Node's built-in WebSocket. A page is settled once it has fired `load`, its fonts are
 * ready, no fetch or XHR has been in flight for 500 ms (WebSocket, EventSource and Vite's HMR
 * socket are not counted) and it is still: no DOM mutation and no running finite animation or
 * transition for 300 ms, which a mock API living in the page needs since it makes no request.
 * A page that never settles is shot anyway once `$MOCKUP_SHOT_WAIT_MS` (default 5000) have
 * passed; every action of a step is capped the same way.
 *
 * A full page is as tall as the document or as the viewport plus what its tallest inner
 * scroller (`overflow-y` auto or scroll) hides, so an app shell whose document is the
 * viewport's height lays out whole: the viewport is resized to that height, at most
 * `maxHeight` (6000 CSS px), before the shot; when what the scrollers hide does not shrink as
 * the viewport grows, the growth is undone, so a fixed-height scroller adds no blank space.
 * With a dialog open (`[role=dialog]`, `[role=alertdialog]`, `[aria-modal=true]`,
 * `dialog[open]`) the viewport is shot as is and the still is not a full page.
 *
 * `capture` can also measure a list of CSS selectors on the shot it takes: where the one
 * visible element each one matches is on the PNG, or null for one not on the page or on it
 * more than once. The live mark's freeze (`menu.mjs`) places a remark's box by them.
 *
 * A batch runs the shots of a recipe (see `loadRecipe`) in one Chromium, `--parallel` tabs at
 * a time (default 4), each in a browser context of its own so cookies and storage never leak
 * between shots, each shot once per viewport and tag set. A shot's `steps(page, { viewport,
 * tags })` drive the page before the shot with real input (see `openTab`). A failing shot fails
 * alone. It prints one JSON line per shot and variant, `{ name, variant, ok, error, ms,
 * exceptions, consoleErrors, fullPage, width, height, file, added }`, then `{ summary: { shots,
 * ok, failed, added, unchanged, exceptions, ms } }`, and exits 1 when a shot failed. With
 * `--add DIR`, each still is added to the mockup scratch dir `DIR` through `addStill`, `added`
 * being `rev <n>` or `unchanged`; a shot whose steps failed is never added, and one with page
 * exceptions is added unless `--strict`, which fails it.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { addStill, isObject, parseTags, parseViewport, STILL_NAME, variantKey } from "./review.mjs";

const CHROMES = [
  "/usr/bin/chromium-browser",
  "/usr/bin/chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
];
const QUIET_MS = 500;
const STILL_MS = 300;
const POLL_MS = 50;
const LAUNCH_MS = 20000;
const COMMAND_MS = 15000;
const DEFAULT_WAIT_MS = 5000;
const RESIZE_WAIT_MS = 2000;
const STEPS_MS = 120000;
const DEFAULT_PARALLEL = 4;
const MAX_HEIGHT = 6000;
const COUNTED = new Set(["XHR", "Fetch"]);
const MODAL = "[role=dialog], [role=alertdialog], [aria-modal=true], dialog[open]";

const KEYS = {
  Enter: { code: "Enter", keyCode: 13, text: "\r" },
  Tab: { code: "Tab", keyCode: 9 },
  Escape: { code: "Escape", keyCode: 27 },
  Backspace: { code: "Backspace", keyCode: 8 },
  Delete: { code: "Delete", keyCode: 46 },
  " ": { code: "Space", keyCode: 32, text: " " },
  Space: { key: " ", code: "Space", keyCode: 32, text: " " },
  ArrowLeft: { code: "ArrowLeft", keyCode: 37 },
  ArrowUp: { code: "ArrowUp", keyCode: 38 },
  ArrowRight: { code: "ArrowRight", keyCode: 39 },
  ArrowDown: { code: "ArrowDown", keyCode: 40 },
  Home: { code: "Home", keyCode: 36 },
  End: { code: "End", keyCode: 35 },
  PageUp: { code: "PageUp", keyCode: 33 },
  PageDown: { code: "PageDown", keyCode: 34 },
};

const USAGE = `usage: node capture.mjs <url> <out.png> [--viewport mobile|mobile-s|tablet|desktop|WxH[@dpr][+touch]]
                          [--tag T]... [--full-page] [--max-height N]
       node capture.mjs --batch <shots.mjs> [--only REGEX] [--parallel N] [--strict] [--base URL]
                          [--out DIR] [--add DIR]`;

/**
 * Installed in every document of a tab before its own scripts: `__mockupStill()` is how long
 * the page has been still, in ms, a DOM mutation or a running finite animation restarting it.
 */
const TRACKER = `(() => {
  if (window.__mockupStill) return;
  let last = performance.now();
  const touch = () => { last = performance.now(); };
  new MutationObserver(touch).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  const finite = (a) => a.playState === "running" && Number.isFinite(a.effect?.getComputedTiming().endTime);
  Object.defineProperty(window, "__mockupStill", {
    value: () => {
      if (document.getAnimations().some(finite)) touch();
      return performance.now() - last;
    },
  });
})()`;

const PROBE = `(() => document.readyState === "complete" && document.fonts.status === "loaded"
  ? (window.__mockupStill ? window.__mockupStill() : ${STILL_MS}) : 0)()`;

/** The Chromium to run: `$CHROME_BIN`, else the first of CHROMES that exists. */
export function findChrome(env = process.env) {
  if (env.CHROME_BIN) return env.CHROME_BIN;
  return CHROMES.find((c) => existsSync(c)) ?? null;
}

/**
 * The user agent a device of `viewport` sends, from the browser's `product` (`Chrome/<v>` or
 * `HeadlessChrome/<v>`): Android Chrome on a phone, without "Mobile" on a tablet; null for a
 * viewport without touch, which keeps the browser's own.
 */
export function userAgent(viewport, product) {
  if (!viewport.mobile) return null;
  const version = /Chrome\/([\d.]+)/.exec(product)?.[1] ?? "130.0.0.0";
  const tablet = viewport.preset === "tablet";
  const device = tablet ? "Pixel Tablet" : "Pixel 7";
  const chrome = `Chrome/${version}${tablet ? "" : " Mobile"}`;
  return `Mozilla/5.0 (Linux; Android 14; ${device}) AppleWebKit/537.36 (KHTML, like Gecko) ${chrome} Safari/537.36`;
}

/** The `prefers-color-scheme` the tags ask for, `dark` or `light`, or null; both is an error. */
export function colorScheme(tags) {
  const dark = tags.includes("dark");
  const light = tags.includes("light");
  if (dark && light) throw new Error("tags 'dark' and 'light' contradict each other");
  return dark ? "dark" : light ? "light" : null;
}

/** The width and height of the PNG `bytes`, from its IHDR chunk. */
export function pngSize(bytes) {
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/** `promise`, or a rejection saying `what` took longer than `ms`. */
function within(promise, ms, what) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what}: no answer after ${ms / 1000}s`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Start headless Chromium on a fresh profile with its DevTools on a free port. Resolves to `{
 * ws, close }`: the browser's DevTools WebSocket URL and a function that stops it and removes
 * the profile.
 */
async function launch(chrome) {
  const profile = mkdtempSync(path.join(tmpdir(), "capture-"));
  const proc = spawn(
    chrome,
    [
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--hide-scrollbars",
      "--mute-audio",
      "--no-first-run",
      "--no-default-browser-check",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"], detached: true }
  );
  const exited = new Promise((resolve) => proc.once("exit", resolve));
  const close = async () => {
    if (proc.exitCode === null && proc.signalCode === null) {
      proc.kill("SIGTERM");
      await Promise.race([exited, sleep(3000)]);
    }
    try {
      if (proc.pid !== undefined) process.kill(-proc.pid, "SIGKILL");
    } catch (e) {
      if (e.code !== "ESRCH") throw e;
    }
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch (e) {
      console.error(`capture: profile ${profile} left behind: ${e.message}`);
    }
  };
  let log = "";
  const ws = new Promise((resolve, reject) => {
    proc.once("error", (e) => reject(new Error(`${chrome}: ${e.message}`)));
    proc.stderr.on("data", (d) => {
      log += d;
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(log);
      if (m) resolve(m[1]);
    });
    exited.then((code) =>
      reject(new Error(`${chrome} exited (${code}) before it listened: ${log.trim().slice(-500)}`))
    );
  });
  try {
    return { ws: await within(ws, LAUNCH_MS, `${chrome} to start`), close };
  } catch (e) {
    await close();
    throw e;
  }
}

/**
 * A DevTools connection over the WebSocket at `url`. `send(method, params, sessionId)`
 * resolves to the result or rejects with the protocol's error; `on(fn)` calls `fn` with every
 * event until the function it returns is called; `close()` hangs up.
 */
async function connect(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = () => reject(new Error(`could not connect to ${url}`));
  });
  let next = 0;
  const pending = new Map();
  const listeners = new Set();
  socket.onmessage = ({ data }) => {
    const msg = JSON.parse(data);
    if (msg.id === undefined) {
      for (const fn of listeners) fn(msg);
      return;
    }
    const call = pending.get(msg.id);
    if (!call) return;
    pending.delete(msg.id);
    if (msg.error) call.reject(new Error(`${call.method}: ${msg.error.message}`));
    else call.resolve(msg.result);
  };
  socket.onclose = () => {
    for (const call of pending.values()) call.reject(new Error(`${call.method}: the browser hung up`));
    pending.clear();
  };
  return {
    send(method, params = {}, sessionId) {
      const id = ++next;
      const answer = new Promise((resolve, reject) => pending.set(id, { method, resolve, reject }));
      socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      return within(answer, COMMAND_MS, method);
    },
    on(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    close() {
      socket.close();
    },
  };
}

/**
 * The helpers every in-page lookup uses, and that a string given to `evaluate` sees: `$$(selector,
 * root)` lists the elements a selector matches, `byText(text, root)` the deepest visible
 * elements whose text (or aria-label, value, placeholder or title) is `text`, else contains it,
 * and `find(target, root)` the visible elements a selector matches, else those `byText` finds.
 * Runs in the page, so it uses nothing from this module.
 */
function pageKit() {
  const norm = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
  const shown = (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const textOf = (el) =>
    norm(el.innerText) ||
    norm(el.getAttribute("aria-label")) ||
    norm(typeof el.value === "string" ? el.value : "") ||
    norm(el.getAttribute("placeholder")) ||
    norm(el.getAttribute("title"));
  const byText = (text, root = document) => {
    const want = norm(text);
    const all = $$("*", root).filter(shown);
    for (const match of [(t) => t === want, (t) => t.includes(want)]) {
      const hits = all.filter((el) => match(textOf(el)));
      const deepest = hits.filter((el) => !hits.some((other) => other !== el && el.contains(other)));
      if (deepest.length) return deepest;
    }
    return [];
  };
  const find = (target, root = document) => {
    let hits = [];
    try {
      hits = $$(target, root).filter(shown);
    } catch {
      hits = [];
    }
    return hits.length ? hits : byText(target, root);
  };
  return { $$, byText, find, norm, textOf, shown };
}

/**
 * In the page: the elements `target` names inside the first element `within` names (the
 * document without it), those whose text holds `text` when given. Returns `{ missing }`, what
 * was not found, or `{ count, x, y }`, the count and the centre of the first one in CSS pixels
 * after scrolling it into view, focused when `focus`, with `locate`; without it, only `{ count }`.
 */
function pageTarget(kit, { target, within: scope, text, locate, focus }) {
  let root = document;
  if (scope) {
    root = kit.find(scope)[0];
    if (!root) return { missing: scope, count: 0 };
  }
  const hits = kit.find(target, root).filter((el) => !text || kit.textOf(el).includes(kit.norm(text)));
  if (!hits.length) return { missing: target, count: 0 };
  if (!locate) return { count: hits.length };
  const el = hits[0];
  el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
  if (focus && typeof el.focus === "function") el.focus();
  const r = el.getBoundingClientRect();
  return { count: hits.length, x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

/**
 * In the page: whether a dialog is open, the document's height and the most any scroller of it
 * (`overflow-y` auto or scroll) hides below its box, in CSS pixels.
 */
function pageMeasure(kit, modal) {
  const open = kit.$$(modal).some(kit.shown);
  const root = document.scrollingElement ?? document.documentElement;
  let hidden = 0;
  for (const el of kit.$$("*")) {
    const overflow = getComputedStyle(el).overflowY;
    if ((overflow === "auto" || overflow === "scroll") && el.scrollHeight > el.clientHeight) {
      hidden = Math.max(hidden, el.scrollHeight - el.clientHeight);
    }
  }
  return { modal: open, document: Math.max(root.scrollHeight, document.body?.scrollHeight ?? 0), hidden };
}

/**
 * In the page: where each of `selectors` is on the screenshot, `{x, y, w, h}` in CSS pixels
 * from its top left, for the one visible element it matches, one with no opacity left hidden
 * as the live shell holds it; null for a selector that matches none, or more than one so which
 * was meant is not known, does not parse, or matches only an element with no area.
 */
function pageRects(kit, selectors) {
  return selectors.map((selector) => {
    let shown;
    try {
      shown = kit.$$(selector).filter((el) => kit.shown(el) && el.checkVisibility({ checkOpacity: true }));
    } catch {
      return null;
    }
    const r = shown.length === 1 ? shown[0].getBoundingClientRect() : null;
    return r && r.width > 0 && r.height > 0 ? { x: r.left, y: r.top, w: r.width, h: r.height } : null;
  });
}

/** The expression that runs the in-page function `fn` with the kit and `args`. */
function inPage(fn, args) {
  return `(${fn})((${pageKit})(), ${JSON.stringify(args)})`;
}

/** The text of a page exception, from its `exceptionDetails`. */
function exceptionText(details) {
  return (details.exception?.description ?? details.text ?? "exception").split("\n")[0];
}

/** The text of a console call's argument, a `RemoteObject`. */
function argText(arg) {
  if (arg.value !== undefined) return typeof arg.value === "string" ? arg.value : JSON.stringify(arg.value);
  return arg.description ?? arg.type;
}

/** The key event fields of `key`: a name of KEYS or a single character. */
function keyFields(key) {
  if (Object.hasOwn(KEYS, key)) {
    const { code, keyCode, text, key: name = key } = KEYS[key];
    return { key: name, code, windowsVirtualKeyCode: keyCode, ...(text ? { text } : {}) };
  }
  if ([...key].length !== 1) throw new Error(`press '${key}': a key is one character or one of ${Object.keys(KEYS).join(", ")}`);
  const upper = key.toUpperCase();
  const letter = /^[A-Z]$/.test(upper);
  const digit = /^\d$/.test(key);
  const code = letter ? `Key${upper}` : digit ? `Digit${key}` : "";
  return { key, code, text: key, windowsVirtualKeyCode: letter || digit ? upper.charCodeAt(0) : 0 };
}

/**
 * Open a tab in a browser context of its own on the connection `cdp`, set up as a device at the
 * parsed viewport `vp` with the colour `scheme` and the user agent from the browser's `product`.
 * `wait` caps each wait for the page to settle; console errors and exceptions matching a
 * pattern of `ignore` are not kept. Returns `{ page, goto, settle, shoot, problems, close }`:
 * `page` is what steps drive (see `steps`), `shoot` takes the still, `problems()` the page
 * exceptions and console errors so far.
 */
async function openTab(cdp, product, { vp, scheme, wait, ignore = [] }) {
  const { browserContextId } = await cdp.send("Target.createBrowserContext", { disposeOnDetach: true });
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank", browserContextId });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  const send = (method, params) => cdp.send(method, params, sessionId);
  const inFlight = new Set();
  let netChanged = Date.now();
  let loading = false;
  const exceptions = [];
  const consoleErrors = [];
  const keep = (list, text) => {
    if (!ignore.some((re) => re.test(text))) list.push(text);
  };
  const off = cdp.on((msg) => {
    if (msg.sessionId !== sessionId) return;
    const p = msg.params ?? {};
    switch (msg.method) {
      case "Network.requestWillBeSent":
        if (COUNTED.has(p.type)) {
          inFlight.add(p.requestId);
          netChanged = Date.now();
        }
        break;
      case "Network.loadingFinished":
      case "Network.loadingFailed":
        if (inFlight.delete(p.requestId)) netChanged = Date.now();
        break;
      case "Page.frameStartedLoading":
        if (p.frameId === targetId) loading = true;
        break;
      case "Page.frameStoppedLoading":
        if (p.frameId === targetId) loading = false;
        break;
      case "Page.javascriptDialogOpening":
        send("Page.handleJavaScriptDialog", { accept: true }).catch(() => {});
        break;
      case "Runtime.exceptionThrown":
        keep(exceptions, exceptionText(p.exceptionDetails));
        break;
      case "Runtime.consoleAPICalled":
        if (p.type === "error" || p.type === "assert") keep(consoleErrors, p.args.map(argText).join(" "));
        break;
      case "Log.entryAdded":
        if (p.entry.level === "error") keep(consoleErrors, p.entry.text);
        break;
      default:
    }
  });
  const close = async () => {
    off();
    await cdp.send("Target.disposeBrowserContext", { browserContextId }).catch(() => {});
  };
  try {
    await send("Page.enable");
    await send("Network.enable");
    await send("Runtime.enable");
    await send("Log.enable");
    await send("Page.addScriptToEvaluateOnNewDocument", { source: TRACKER });
    await setMetrics(vp.height);
    await send(
      "Emulation.setTouchEmulationEnabled",
      vp.mobile ? { enabled: true, maxTouchPoints: 5 } : { enabled: false }
    );
    const ua = userAgent(vp, product);
    if (ua) await send("Emulation.setUserAgentOverride", { userAgent: ua, platform: "Linux armv8l" });
    if (scheme) {
      await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] });
    }
  } catch (e) {
    await close();
    throw e;
  }

  function setMetrics(height) {
    return send("Emulation.setDeviceMetricsOverride", {
      width: vp.width,
      height,
      deviceScaleFactor: vp.dpr,
      mobile: vp.mobile,
    });
  }

  async function run(expression) {
    const { result, exceptionDetails } = await send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (exceptionDetails) throw new Error(exceptionText(exceptionDetails));
    return result.value;
  }

  async function stillFor() {
    try {
      return await run(PROBE);
    } catch {
      return 0;
    }
  }

  async function settle(cap = wait, since = 0) {
    const deadline = Date.now() + cap;
    for (;;) {
      const quiet = !loading && !inFlight.size && Date.now() - netChanged >= QUIET_MS;
      if (quiet && Date.now() - since >= STILL_MS && (await stillFor()) >= STILL_MS) return true;
      if (Date.now() >= deadline) return false;
      await sleep(POLL_MS);
    }
  }

  async function goto(url) {
    netChanged = Date.now();
    const { errorText } = await send("Page.navigate", { url });
    if (errorText) throw new Error(`${url}: ${errorText}`);
    return settle(wait, Date.now());
  }

  async function poll(target, opts, timeout, done, fail) {
    const deadline = Date.now() + timeout;
    for (;;) {
      let found;
      try {
        found = await run(inPage(pageTarget, { target, ...opts }));
      } catch {
        found = null;
      }
      if (found && done(found)) return found;
      if (Date.now() >= deadline) throw new Error(fail(found));
      await sleep(POLL_MS);
    }
  }

  function lookup(what, target, opts, timeout = wait) {
    return poll(target, opts, timeout, (found) => !found.missing, (found) => {
      const missing = found?.missing ?? target;
      const where = opts.within && missing !== opts.within ? ` within '${opts.within}'` : "";
      return `${what} '${target}': no element matches '${missing}'${where}`;
    });
  }

  async function act(input) {
    const since = Date.now();
    await input();
    await settle(wait, since);
  }

  async function resize(height) {
    await setMetrics(height);
    await settle(Math.min(wait, RESIZE_WAIT_MS), Date.now());
  }

  async function tap(x, y) {
    if (vp.mobile) {
      await send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
      await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      return;
    }
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  }

  const page = {
    async click(target, { within: scope } = {}) {
      const at = await lookup("click", target, { within: scope, locate: true });
      await act(() => tap(at.x, at.y));
    },
    async hover(target, { within: scope } = {}) {
      const at = await lookup("hover", target, { within: scope, locate: true });
      await act(() => send("Input.dispatchMouseEvent", { type: "mouseMoved", x: at.x, y: at.y }));
    },
    async type(target, text, { within: scope } = {}) {
      const at = await lookup("type", target, { within: scope, locate: true, focus: true });
      await act(async () => {
        await tap(at.x, at.y);
        await send("Input.insertText", { text: String(text) });
      });
    },
    async press(key) {
      const fields = keyFields(key);
      await act(async () => {
        await send("Input.dispatchKeyEvent", { type: "keyDown", ...fields });
        await send("Input.dispatchKeyEvent", { type: "keyUp", ...fields, text: undefined });
      });
    },
    async waitFor(target, { text, gone = false, timeout = wait, within: scope } = {}) {
      if (!gone) {
        await lookup("waitFor", target, { within: scope, text }, timeout);
        return;
      }
      const fail = () => `waitFor '${target}' gone: still there after ${timeout / 1000}s`;
      await poll(target, { within: scope, text }, timeout, (found) => !found.count, fail);
    },
    async evaluate(fn) {
      const expression =
        typeof fn === "function"
          ? `(${fn})()`
          : `(() => { const { $$, byText } = (${pageKit})(); return eval(${JSON.stringify(String(fn))}); })()`;
      return run(expression);
    },
    sleep(ms) {
      return sleep(ms);
    },
  };

  async function shoot({ fullPage = false, maxHeight = MAX_HEIGHT, measure } = {}) {
    let height = vp.height;
    let whole = fullPage;
    if (fullPage) {
      let last = null;
      for (let i = 0; i < 4; i += 1) {
        const m = await run(inPage(pageMeasure, MODAL));
        if (m.modal) {
          whole = false;
          if (height !== vp.height) {
            height = vp.height;
            await resize(height);
          }
          break;
        }
        if (last && m.hidden >= last.hidden) {
          const back = Math.min(maxHeight, Math.max(last.height, last.document));
          if (back !== height) {
            height = back;
            await resize(height);
          }
          break;
        }
        const need = Math.min(maxHeight, Math.max(m.document, height + m.hidden));
        if (need <= height) break;
        last = { height, document: m.document, hidden: m.hidden };
        height = need;
        await resize(height);
      }
    }
    const { data } = await send("Page.captureScreenshot", { format: "png" });
    const png = Buffer.from(data, "base64");
    const rects = measure ? { rects: await run(inPage(pageRects, measure)) } : {};
    return { png, fullPage: whole, ...pngSize(png), ...rects };
  }

  return {
    page,
    goto,
    settle,
    shoot,
    problems: () => ({ exceptions: [...exceptions], consoleErrors: [...consoleErrors] }),
    close,
  };
}

/**
 * Run `fn` with a browser started on `chrome` (else `findChrome()`): `{ cdp, product }`, the
 * DevTools connection and the browser's product string. The browser is stopped afterwards.
 */
async function withBrowser(chrome, fn) {
  const binary = chrome ?? findChrome();
  if (!binary) throw new Error("no Chromium found; set CHROME_BIN");
  const browser = await launch(binary);
  let cdp = null;
  try {
    cdp = await connect(browser.ws);
    const { product } = await cdp.send("Browser.getVersion");
    return await fn({ cdp, product });
  } finally {
    await cdp?.send("Browser.close").catch(() => {});
    cdp?.close();
    await browser.close();
  }
}

/** The cap on each wait for a page to settle: `waitMs`, else `$MOCKUP_SHOT_WAIT_MS`, else 5 s. */
function waitCap(waitMs) {
  return waitMs ?? (Number(process.env.MOCKUP_SHOT_WAIT_MS) || DEFAULT_WAIT_MS);
}

/**
 * Shoot one variant in the open browser `browser` (`{ cdp, product }`): `url` at the parsed
 * viewport `vp` with `tags`, after `steps` when given. Resolves to `{ png, width, height,
 * fullPage, exceptions, consoleErrors }`; rejects when the page cannot be loaded or a step
 * fails, the error carrying the page problems seen so far as `problems`.
 */
async function shootOne(browser, { url, vp, tags, fullPage, maxHeight, measure, steps, wait, ignore }) {
  const tab = await openTab(browser.cdp, browser.product, { vp, scheme: colorScheme(tags), wait, ignore });
  try {
    await tab.goto(url);
    if (steps) {
      try {
        await within(Promise.resolve().then(() => steps(tab.page, { viewport: vp, tags })), STEPS_MS, "the steps");
      } catch (e) {
        throw new Error(`steps: ${e.message}`);
      }
      await tab.settle();
    }
    const shot = await tab.shoot({ fullPage, maxHeight, measure });
    return { ...shot, ...tab.problems() };
  } catch (e) {
    e.problems = tab.problems();
    throw e;
  } finally {
    await tab.close();
  }
}

/**
 * Shoot `url` as a device at `viewport` (a preset or `WxH[@dpr][+touch]`) with `tags`, after
 * `steps(page)` when given, the whole page with `fullPage` (at most `maxHeight` CSS px), and
 * write the PNG to `out`. Waits as the module says, each wait capped at `waitMs`. Resolves to
 * `{ file, width, height, fullPage }`, in pixels, `fullPage` false when a dialog was open.
 * With `measure`, a list of CSS selectors, it also has `rects`: where each one is on the PNG,
 * `{x, y, w, h}` in CSS pixels (a pixel of the PNG is one over the pixel ratio), or null for
 * a selector that is not on the page or matches more than one element (see `pageRects`).
 */
export async function capture({
  url,
  out,
  viewport = "mobile",
  tags = [],
  fullPage = false,
  maxHeight = MAX_HEIGHT,
  measure,
  steps,
  waitMs,
  chrome,
}) {
  const vp = parseViewport(viewport, fullPage);
  const sorted = shotTags(tags);
  const wait = waitCap(waitMs);
  return withBrowser(chrome, async (browser) => {
    const shot = await shootOne(browser, { url, vp, tags: sorted, fullPage, maxHeight, measure, steps, wait });
    writeFileSync(out, shot.png);
    const rects = measure ? { rects: shot.rects } : {};
    return { file: out, width: shot.width, height: shot.height, fullPage: shot.fullPage, ...rects };
  });
}

/** `tags` as `parseTags` gives them, refused when they ask for two colour schemes. */
function shotTags(tags) {
  const sorted = parseTags(tags);
  colorScheme(sorted);
  return sorted;
}

/** True when `page` is an http(s) URL rather than a path on the mockup. */
function isUrl(page) {
  return /^https?:\/\//.test(page);
}

/** `value` as a list of tag sets: a list of tags is one set, a list of lists is several. */
function tagSets(value, where) {
  if (!Array.isArray(value)) throw new Error(`${where}: 'tags' is a list of tags, or a list of tag lists`);
  const sets = value.length && value.every(Array.isArray) ? value : [value];
  return sets.map(shotTags);
}

/**
 * The shots of the recipe `recipe` (a shots module's default export), one per shot, viewport
 * and tag set: `{ name, title, path, viewport, vp, tags, key, fullPage, maxHeight, steps }`,
 * in the recipe's order, only those whose name matches `only` when given. A recipe is `{
 * defaults, ignore, shots }`: `defaults` the fields every shot takes unless it gives its own
 * (`viewports`, default `["mobile"]`; `tags`, a list or a list of lists; `fullPage`;
 * `maxHeight`), `ignore` patterns (RegExps or substrings) of console errors and exceptions
 * that are noise, and `shots` the list of `{ name, title?, path, steps?, ...defaults }`,
 * `path` a page path (`/app?x=1`) or an http(s) URL. Throws naming the first problem.
 */
export function expandRecipe(recipe, only) {
  if (!isObject(recipe)) throw new Error("the shots file's default export must be { defaults, ignore, shots }");
  const defaults = recipe.defaults ?? {};
  if (!isObject(defaults)) throw new Error("'defaults' must be an object");
  if (!Array.isArray(recipe.shots) || !recipe.shots.length) throw new Error("'shots' must be a non-empty list");
  const out = [];
  const seen = new Set();
  recipe.shots.forEach((shot, i) => {
    const where = `shots[${i}]${isObject(shot) && typeof shot.name === "string" ? ` (${shot.name})` : ""}`;
    if (!isObject(shot)) throw new Error(`${where}: a shot is an object`);
    const { name, title, path: page, steps } = shot;
    if (typeof name !== "string" || !STILL_NAME.test(name)) {
      throw new Error(`${where}: 'name' is 1-100 letters, digits, '.', '_' or '-', starting with a letter or digit`);
    }
    if (title !== undefined && (typeof title !== "string" || !title.trim())) {
      throw new Error(`${where}: 'title' must be a non-empty string`);
    }
    if (typeof page !== "string" || !(page.startsWith("/") || isUrl(page))) {
      throw new Error(`${where}: 'path' is a page path starting with / or an http(s) URL`);
    }
    if (steps !== undefined && typeof steps !== "function") throw new Error(`${where}: 'steps' must be a function`);
    const field = (k, fallback) => shot[k] ?? defaults[k] ?? fallback;
    const viewports = field("viewports", ["mobile"]);
    if (!Array.isArray(viewports) || !viewports.length) throw new Error(`${where}: 'viewports' must be a non-empty list`);
    const fullPage = field("fullPage", false);
    if (typeof fullPage !== "boolean") throw new Error(`${where}: 'fullPage' must be true or false`);
    const maxHeight = field("maxHeight", MAX_HEIGHT);
    if (!Number.isInteger(maxHeight) || maxHeight < 1) throw new Error(`${where}: 'maxHeight' must be a positive integer`);
    let sets;
    try {
      sets = tagSets(field("tags", []), where);
    } catch (e) {
      throw new Error(e.message.startsWith(where) ? e.message : `${where}: ${e.message}`);
    }
    if (only && !only.test(name)) return;
    for (const viewport of viewports) {
      let vp;
      try {
        vp = parseViewport(viewport, fullPage);
      } catch (e) {
        throw new Error(`${where}: ${e.message}`);
      }
      for (const tags of sets) {
        const key = variantKey(vp, tags);
        if (seen.has(`${name} ${key}`)) throw new Error(`${where}: ${name} [${key}] is shot twice`);
        seen.add(`${name} ${key}`);
        out.push({ name, title, path: page, viewport, vp, tags, key, fullPage, maxHeight, steps });
      }
    }
  });
  return out;
}

/** The `ignore` patterns of `recipe` as RegExps, a string matching where it occurs. */
export function ignorePatterns(recipe) {
  const list = recipe?.ignore ?? [];
  if (!Array.isArray(list)) throw new Error("'ignore' must be a list of RegExps or strings");
  return list.map((p) => {
    if (p instanceof RegExp) return new RegExp(p.source, p.flags.replace(/[gy]/g, ""));
    if (typeof p === "string" && p) return new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    throw new Error("'ignore' must be a list of RegExps or strings");
  });
}

/** The recipe the shots module `file` exports by default. */
export async function loadRecipe(file) {
  const mod = await import(`${pathToFileURL(path.resolve(file)).href}?t=${Date.now()}`);
  return mod.default;
}

/** Run `fn(item, index)` on each of `items`, at most `n` at a time. */
async function pool(items, n, fn) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      await fn(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, items.length)) }, worker));
}

/**
 * Shoot every shot of `recipe` against `base` (the origin a page path is relative to) into the
 * folder `outDir`, `<name>@<key>.png` each, in one Chromium, `parallel` tabs at a time, only
 * the shots whose name matches `only`. `add(shot, file, line)` keeps a shot's still and
 * resolves to what it added (`rev <n>` or `unchanged`); it is not called for a failed shot, nor
 * with `strict` for one with page exceptions, which fails it. Shots are added and reported in
 * the recipe's order, so the stills keep it: `report(line)` gets each shot's line, then the
 * summary. Resolves to the summary, `{ shots, ok, failed, added,
 * unchanged, exceptions, ms }`, `exceptions` counting the shots that had any.
 */
export async function runBatch({
  recipe,
  base,
  outDir,
  parallel = DEFAULT_PARALLEL,
  only,
  strict = false,
  add,
  report = () => {},
  waitMs,
  chrome,
}) {
  const shots = expandRecipe(recipe, only);
  const ignore = ignorePatterns(recipe);
  const wait = waitCap(waitMs);
  const started = Date.now();
  const summary = { shots: shots.length, ok: 0, failed: 0, added: 0, unchanged: 0, exceptions: 0, ms: 0 };
  mkdirSync(outDir, { recursive: true });
  if (!shots.length) {
    report({ summary });
    return summary;
  }
  const ready = shots.map(() => Promise.withResolvers());
  const keep = (async () => {
    for (const [index, shot] of shots.entries()) {
      const line = await ready[index].promise;
      try {
        if (line.ok && add) line.added = await add(shot, line.file, line);
      } catch (e) {
        Object.assign(line, { ok: false, error: `adding the still: ${e.message}` });
      }
      if (line.exceptions?.length) summary.exceptions += 1;
      if (line.ok) summary.ok += 1;
      else summary.failed += 1;
      if (line.added === "unchanged") summary.unchanged += 1;
      else if (line.added) summary.added += 1;
      report(line);
    }
  })();
  const shoot = withBrowser(chrome, (browser) =>
    pool(shots, parallel, async (shot, index) => {
      const t0 = Date.now();
      const line = { name: shot.name, variant: shot.key, ok: false };
      try {
        const url = isUrl(shot.path) ? shot.path : new URL(shot.path, base).href;
        const result = await shootOne(browser, { ...shot, url, wait, ignore });
        Object.assign(line, {
          exceptions: result.exceptions,
          consoleErrors: result.consoleErrors,
          fullPage: result.fullPage,
          width: result.width,
          height: result.height,
        });
        if (strict && result.exceptions.length) {
          line.error = `${result.exceptions.length} page exception(s) with --strict`;
        } else {
          const file = path.join(outDir, `${shot.name}@${shot.key}.png`);
          writeFileSync(file, result.png);
          line.file = file;
          line.ok = true;
        }
      } catch (e) {
        line.error = e.message;
        if (e.problems) Object.assign(line, e.problems);
      }
      line.ms = Date.now() - t0;
      ready[index].resolve(line);
    })
  );
  await Promise.all([shoot, keep]);
  summary.ms = Date.now() - started;
  report({ summary });
  return summary;
}

/** `add` for `runBatch` that keeps each still in the mockup scratch dir `dir` with `addStill`. */
export function addTo(dir) {
  return async (shot, file, line) => {
    const { rev, unchanged } = await addStill(dir, {
      file,
      name: shot.name,
      title: shot.title,
      source: isUrl(shot.path) ? undefined : shot.path,
      viewport: shot.viewport,
      tags: shot.tags,
      fullPage: line.fullPage,
    });
    return unchanged ? "unchanged" : `rev ${rev.n}`;
  };
}

/**
 * Run the batch CLI: `values` are the parsed options. A still's file is reported under
 * `$MOCKUP_HOST_OUT` when set, the out dir as the host names it. Returns the exit status.
 */
async function batchMain(values, { out, err, env = process.env }) {
  const parallel = values.parallel === undefined ? DEFAULT_PARALLEL : Number(values.parallel);
  if (!Number.isInteger(parallel) || parallel < 1 || parallel > 32) {
    err("--parallel must be a whole number from 1 to 32");
    return 2;
  }
  let only;
  try {
    only = values.only === undefined ? undefined : new RegExp(values.only);
  } catch (e) {
    err(`--only: ${e.message}`);
    return 2;
  }
  const file = path.resolve(values.batch);
  try {
    const recipe = await loadRecipe(file);
    const summary = await runBatch({
      recipe,
      base: values.base ?? "http://127.0.0.1:80",
      outDir: path.resolve(values.out ?? path.join(path.dirname(file), "shots")),
      parallel,
      only,
      strict: values.strict,
      add: values.add ? addTo(path.resolve(values.add)) : undefined,
      report: (line) => {
        const host = line.file && env.MOCKUP_HOST_OUT;
        out(JSON.stringify(host ? { ...line, file: path.join(host, path.basename(line.file)) } : line));
      },
    });
    if (!summary.shots) {
      err(`no shot's name matches --only ${values.only}`);
      return 1;
    }
    return summary.failed ? 1 : 0;
  } catch (e) {
    err(`batch failed: ${e.message}`);
    return 1;
  }
}

/** Run the CLI on `argv` and return its exit status, printing with `out` and `err`. */
export async function main(argv, { out, err }) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        viewport: { type: "string" },
        tag: { type: "string", multiple: true },
        "full-page": { type: "boolean" },
        "max-height": { type: "string" },
        batch: { type: "string" },
        only: { type: "string" },
        parallel: { type: "string" },
        strict: { type: "boolean" },
        base: { type: "string" },
        out: { type: "string" },
        add: { type: "string" },
      },
      allowPositionals: true,
    });
  } catch (e) {
    err(e.message);
    return 2;
  }
  const { positionals, values } = parsed;
  if (values.batch !== undefined) {
    if (positionals.length || values.viewport || values.tag || values["full-page"] || values["max-height"]) {
      err(USAGE);
      return 2;
    }
    return batchMain(values, { out, err });
  }
  if (positionals.length !== 2 || values.only || values.parallel || values.strict || values.base || values.out || values.add) {
    err(USAGE);
    return 2;
  }
  const maxHeight = values["max-height"] === undefined ? MAX_HEIGHT : Number(values["max-height"]);
  if (!Number.isInteger(maxHeight) || maxHeight < 1) {
    err("--max-height must be a positive whole number of CSS pixels");
    return 2;
  }
  const [url, file] = positionals;
  try {
    const shot = await capture({
      url,
      out: file,
      viewport: values.viewport,
      tags: values.tag,
      fullPage: values["full-page"],
      maxHeight,
    });
    const asked = Boolean(values["full-page"]);
    out(`${shot.file} ${shot.width}x${shot.height}${asked && !shot.fullPage ? " viewport" : ""}`);
    return 0;
  } catch (e) {
    err(`capture failed: ${e.message}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2), {
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
  });
}
