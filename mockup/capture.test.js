/**
 * Tests for the device-emulation capture against a local fixture page that reports what it
 * sees (touch, user agent, colour scheme) to the fixture server. They need a Chromium:
 * `$CHROME_BIN`, or one where `findChrome` looks; without one they are skipped. Run with
 * `npm test` from mockup/.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { capture, colorScheme, findChrome, main, pngSize, userAgent } from "./capture.mjs";
import { parseViewport } from "./review.mjs";

const CHROME = findChrome();
const skip = CHROME ? false : "no Chromium: set CHROME_BIN";

const PAGE = `<!doctype html><html><head><meta name="viewport" content="width=device-width">
<style>body{margin:0}#tall{height:var(--h,10px)}</style></head><body><div id="tall"></div><script>
const q = new URLSearchParams(location.search);
document.getElementById("tall").style.setProperty("--h", (q.get("h") || 10) + "px");
if (q.has("sse")) new EventSource("/sse");
if (q.has("hang")) fetch("/hang");
setTimeout(() => fetch("/report", { method: "POST", body: JSON.stringify({
  coarse: matchMedia("(pointer: coarse)").matches,
  dark: matchMedia("(prefers-color-scheme: dark)").matches,
  mobileUa: /Mobile/.test(navigator.userAgent),
  dpr: devicePixelRatio,
}) }), 100);
</script></body></html>`;

/** A fixture server for one test: `{ base, reports }`, closed when the test ends. */
async function fixture(t) {
  const reports = [];
  const open = new Set();
  const server = createServer((req, res) => {
    open.add(res);
    res.on("close", () => open.delete(res));
    if (req.url.startsWith("/report")) {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => setTimeout(() => (reports.push(JSON.parse(body)), res.end("ok")), 300));
    } else if (req.url === "/sse") {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(": open\n\n");
    } else if (req.url === "/hang") {
      res.writeHead(200);
    } else {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(PAGE);
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    for (const res of open) res.destroy();
    server.close();
  });
  return { base: `http://127.0.0.1:${server.address().port}`, reports };
}

/** A temp dir for the PNGs of one test. */
function outDir(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "capture-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("userAgent is a mobile Chrome for phones, without Mobile on a tablet, and none on a desktop", () => {
  const product = "HeadlessChrome/131.0.6778.33";
  assert.match(userAgent(parseViewport("mobile"), product), /Android.*Chrome\/131\.0\.6778\.33 Mobile Safari/);
  assert.doesNotMatch(userAgent(parseViewport("tablet"), product), /Mobile/);
  assert.match(userAgent(parseViewport("300x600+touch"), product), / Mobile /);
  assert.equal(userAgent(parseViewport("desktop"), product), null);
});

test("colorScheme reads dark and light from the tags and refuses both", () => {
  assert.equal(colorScheme(["dark", "rtl"]), "dark");
  assert.equal(colorScheme(["light"]), "light");
  assert.equal(colorScheme(["es"]), null);
  assert.throws(() => colorScheme(["dark", "light"]), /contradict/);
});

test("the CLI refuses bad usage before starting a browser", async () => {
  const err = [];
  const io = { out: () => {}, err: (l) => err.push(l) };
  assert.equal(await main(["http://x"], io), 2);
  assert.equal(await main(["http://x", "a.png", "--bogus"], io), 2);
  assert.equal(await main(["http://x", "a.png", "--viewport", "huge"], io), 1);
  assert.match(err.at(-1), /viewport/);
});

test("--viewport mobile is a 1170x2532 PNG of a touch device with a mobile user agent", { skip }, async (t) => {
  const { base, reports } = await fixture(t);
  const out = path.join(outDir(t), "m.png");
  const shot = await capture({ url: base, out, viewport: "mobile" });
  assert.deepEqual(shot, { file: out, width: 1170, height: 2532 });
  assert.deepEqual(pngSize(readFileSync(out)), { width: 1170, height: 2532 });
  assert.deepEqual(reports, [{ coarse: true, dark: false, mobileUa: true, dpr: 3 }]);
});

test("a dark tag makes prefers-color-scheme dark match, and desktop is 1x with a mouse", { skip }, async (t) => {
  const { base, reports } = await fixture(t);
  const dir = outDir(t);
  await capture({ url: base, out: path.join(dir, "d.png"), viewport: "desktop", tags: ["dark"] });
  await capture({ url: base, out: path.join(dir, "l.png"), viewport: "desktop", tags: ["light"] });
  assert.deepEqual(reports, [
    { coarse: false, dark: true, mobileUa: false, dpr: 1 },
    { coarse: false, dark: false, mobileUa: false, dpr: 1 },
  ]);
});

test("--full-page captures a page taller than the viewport whole", { skip }, async (t) => {
  const { base } = await fixture(t);
  const dir = outDir(t);
  const whole = await capture({
    url: `${base}/?h=2000`,
    out: path.join(dir, "f.png"),
    viewport: "desktop",
    fullPage: true,
  });
  assert.deepEqual([whole.width, whole.height], [1440, 2000]);
  const window = await capture({ url: `${base}/?h=2000`, out: path.join(dir, "w.png"), viewport: "desktop" });
  assert.deepEqual([window.width, window.height], [1440, 900]);
  const phone = await capture({
    url: `${base}/?h=1000`,
    out: path.join(dir, "p.png"),
    viewport: "mobile-s",
    fullPage: true,
  });
  assert.deepEqual([phone.width, phone.height], [1125, 3000]);
});

test("a page that keeps an EventSource open is shot without waiting for it", { skip }, async (t) => {
  const { base, reports } = await fixture(t);
  const started = Date.now();
  await capture({ url: `${base}/?sse=1`, out: path.join(outDir(t), "s.png"), viewport: "mobile", waitMs: 8000 });
  assert.ok(Date.now() - started < 5000, `took ${Date.now() - started}ms`);
  assert.equal(reports.length, 1);
});

test("a fetch that never ends is cut off by the wait cap", { skip }, async (t) => {
  const { base } = await fixture(t);
  const started = Date.now();
  const shot = await capture({
    url: `${base}/?hang=1`,
    out: path.join(outDir(t), "h.png"),
    viewport: "desktop",
    waitMs: 1500,
  });
  assert.equal(shot.width, 1440);
  const took = Date.now() - started;
  assert.ok(took >= 1500 && took < 6000, `took ${took}ms`);
});
