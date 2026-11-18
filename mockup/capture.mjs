/**
 * Device-emulation capture for the /mockup runtime: a still of a page as a device shows it,
 * shot the way Chrome's device toolbar does, through the Chrome DevTools protocol.
 *
 *   node capture.mjs <url> <out.png> [--viewport V] [--tag T]... [--full-page]
 *
 * `--viewport` is a preset of `review.mjs` (`mobile`, `mobile-s`, `tablet`, `desktop`/`web`,
 * default `mobile`) or `WxH[@dpr][+touch]`. A `dark` or `light` tag sets
 * `prefers-color-scheme`; other tags mean nothing here. `--full-page` captures the whole
 * document, beyond the viewport. Prints `<out.png> <W>x<H>` (pixels). Exit status: 0 shot, 1
 * failed, 2 bad usage.
 *
 * It starts its own headless Chromium (`$CHROME_BIN`, else the first one found) and speaks raw
 * CDP over Node's built-in WebSocket. It never hangs on a page that keeps a connection open:
 * it waits for `load`, `document.fonts.ready` and 500 ms with no fetch or XHR in flight
 * (WebSocket, EventSource and Vite's HMR socket are not counted), and shoots anyway once
 * `$MOCKUP_SHOT_WAIT_MS` (default 5000) have passed since the navigation.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { parseTags, parseViewport } from "./review.mjs";

const CHROMES = [
  "/usr/bin/chromium-browser",
  "/usr/bin/chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
];
const QUIET_MS = 500;
const LAUNCH_MS = 20000;
const COMMAND_MS = 15000;
const DEFAULT_WAIT_MS = 5000;
const COUNTED = new Set(["XHR", "Fetch"]);

const USAGE = `usage: node capture.mjs <url> <out.png> [--viewport mobile|mobile-s|tablet|desktop|WxH[@dpr][+touch]]
                          [--tag T]... [--full-page]`;

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
      process.kill(-proc.pid, "SIGKILL");
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
 * event; `close()` hangs up.
 */
async function connect(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = () => reject(new Error(`could not connect to ${url}`));
  });
  let next = 0;
  const pending = new Map();
  const listeners = [];
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
      listeners.push(fn);
    },
    close() {
      socket.close();
    },
  };
}

/**
 * Follow the fetches and XHRs of a page's session; `quiet(ms, signal)` resolves once none has
 * been in flight for `ms`. Other requests (documents, images, WebSocket, EventSource) are not
 * counted: `load` covers the first, and the others may stay open for good.
 */
function network(cdp, sessionId) {
  const open = new Set();
  let changed = Date.now();
  cdp.on((msg) => {
    if (msg.sessionId !== sessionId) return;
    const id = msg.params?.requestId;
    if (msg.method === "Network.requestWillBeSent" && COUNTED.has(msg.params.type)) open.add(id);
    else if (msg.method !== "Network.loadingFinished" && msg.method !== "Network.loadingFailed") return;
    else if (!open.delete(id)) return;
    changed = Date.now();
  });
  return {
    async quiet(ms, signal) {
      while (!signal.aborted && (open.size || Date.now() - changed < ms)) {
        await sleep(25);
      }
    },
  };
}

/** Resolve with the first event `method` of the session `sessionId`. */
function once(cdp, sessionId, method) {
  return new Promise((resolve) => {
    cdp.on((msg) => {
      if (msg.sessionId === sessionId && msg.method === method) resolve(msg.params);
    });
  });
}

/**
 * Shoot `url` as a device at `viewport` (a preset or `WxH[@dpr][+touch]`) with `tags`, the
 * whole document with `fullPage`, and write the PNG to `out`. Waits as the module says, at
 * most `waitMs` after the navigation. Resolves to `{ file, width, height }`, in pixels.
 */
export async function capture({ url, out, viewport = "mobile", tags = [], fullPage = false, waitMs, chrome }) {
  const vp = parseViewport(viewport, fullPage);
  const scheme = colorScheme(parseTags(tags));
  const binary = chrome ?? findChrome();
  if (!binary) throw new Error("no Chromium found; set CHROME_BIN");
  const wait = waitMs ?? (Number(process.env.MOCKUP_SHOT_WAIT_MS) || DEFAULT_WAIT_MS);
  const browser = await launch(binary);
  let cdp = null;
  try {
    cdp = await connect(browser.ws);
    const { product } = await cdp.send("Browser.getVersion");
    const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    const page = (method, params) => cdp.send(method, params, sessionId);
    const requests = network(cdp, sessionId);
    await page("Page.enable");
    await page("Network.enable");
    await page("Emulation.setDeviceMetricsOverride", {
      width: vp.width,
      height: vp.height,
      deviceScaleFactor: vp.dpr,
      mobile: vp.mobile,
    });
    await page(
      "Emulation.setTouchEmulationEnabled",
      vp.mobile ? { enabled: true, maxTouchPoints: 5 } : { enabled: false }
    );
    const ua = userAgent(vp, product);
    if (ua) await page("Emulation.setUserAgentOverride", { userAgent: ua, platform: "Linux armv8l" });
    if (scheme)
      await page("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] });
    const loaded = once(cdp, sessionId, "Page.loadEventFired");
    const stop = new AbortController();
    const settled = (async () => {
      await loaded;
      await page("Runtime.evaluate", { expression: "document.fonts.ready.then(() => true)", awaitPromise: true });
      await requests.quiet(QUIET_MS, stop.signal);
    })();
    settled.catch(() => {});
    const { errorText } = await page("Page.navigate", { url });
    if (errorText) throw new Error(`${url}: ${errorText}`);
    await Promise.race([settled, sleep(wait, undefined, { signal: stop.signal }).catch(() => {})]);
    stop.abort();
    const shot = { format: "png" };
    if (vp.fullPage) {
      const { cssContentSize } = await page("Page.getLayoutMetrics");
      const height = Math.max(vp.height, Math.ceil(cssContentSize.height));
      Object.assign(shot, { captureBeyondViewport: true, clip: { x: 0, y: 0, width: vp.width, height, scale: 1 } });
    }
    const { data } = await page("Page.captureScreenshot", shot);
    const png = Buffer.from(data, "base64");
    writeFileSync(out, png);
    return { file: out, ...pngSize(png) };
  } finally {
    await cdp?.send("Browser.close").catch(() => {});
    cdp?.close();
    await browser.close();
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
      },
      allowPositionals: true,
    });
  } catch (e) {
    err(e.message);
    return 2;
  }
  const { positionals, values } = parsed;
  if (positionals.length !== 2) {
    err(USAGE);
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
    });
    out(`${shot.file} ${shot.width}x${shot.height}`);
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
