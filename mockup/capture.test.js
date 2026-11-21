/**
 * Tests for the device-emulation capture against a local fixture page that reports what it
 * sees (touch, user agent, colour scheme) to the fixture server. They need a Chromium:
 * `$CHROME_BIN`, or one where `findChrome` looks; without one they are skipped. Run with
 * `npm test` from mockup/.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  addTo,
  capture,
  colorScheme,
  expandRecipe,
  findChrome,
  ignorePatterns,
  main,
  pngSize,
  runBatch,
  userAgent,
} from "./capture.mjs";
import { freeze, freezeRequest } from "./menu.mjs";
import { appendEvent, parseViewport, reviewed, stills } from "./review.mjs";

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

const SHELL = `<!doctype html><html><head><style>
body{margin:0;height:100vh;display:flex;flex-direction:column}
header{height:60px;background:#334}main{flex:1;overflow-y:auto}#content{height:3000px;background:#eef}
[role=dialog]{position:fixed;top:100px;left:100px;width:300px;height:200px;background:#fff}
</style></head><body><header></header><main><div id="content"></div></main><script>
if (new URLSearchParams(location.search).has("dialog")) {
  const d = document.createElement("div");
  d.setAttribute("role", "dialog");
  document.body.append(d);
}
</script></body></html>`;

const APP = `<!doctype html><html><head><title>App</title><style>
body{margin:0;font:16px sans-serif}[role=dialog]{position:fixed;top:30%;left:10%;background:#fff;border:1px solid}
</style></head><body><h1>Users</h1><button id="invite"><span>Invite user</span></button><p id="status"></p>
<div style="height:1500px"></div><a href="/done">Next page</a><script>
const api = { invite: (email) => new Promise((done) => setTimeout(() => done({ email }), 700)) };
document.getElementById("invite").addEventListener("click", () => setTimeout(() => {
  const d = document.createElement("div");
  d.setAttribute("role", "dialog");
  d.innerHTML = '<label>Email <input type="email"></label><button>Send invitation</button>';
  d.querySelector("button").addEventListener("click", async () => {
    d.querySelector("button").textContent = "Sending";
    const res = await api.invite(d.querySelector("input").value);
    d.remove();
    document.getElementById("status").textContent = "Invitation sent to " + res.email;
  });
  document.body.append(d);
}, 150));
</script></body></html>`;

const FIXED = `<!doctype html><html><body style="margin:0"><div style="height:1000px">
<div style="max-height:300px;overflow-y:auto"><div style="height:5000px"></div></div></div></body></html>`;

const MARKS = `<!doctype html><html><body style="margin:0"><div style="height:2000px"></div>
<div id="a" style="position:absolute;left:10px;top:20px;width:100px;height:50px"></div>
<div id="b" style="position:absolute;left:200px;top:1500px;width:40px;height:30px"></div>
<div id="hidden" style="display:none;width:10px;height:10px"></div><span id="empty"></span>
<i class="dup" style="position:absolute;top:0">x</i><i class="dup" style="position:absolute;top:0">y</i></body></html>`;

const DONE = `<!doctype html><html><head><title>Done</title></head><body><h1>Done</h1></body></html>`;

const THROWS = `<!doctype html><html><body><p>boom</p><script>
console.error("Google Maps noise");
setTimeout(() => { throw new Error("kaboom"); }, 10);
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
    } else if (req.url.startsWith("/shell") || req.url.startsWith("/app") || req.url.startsWith("/done") || req.url.startsWith("/throws") || req.url.startsWith("/fixed") || req.url.startsWith("/marks")) {
      const page = { shell: SHELL, app: APP, done: DONE, throws: THROWS, fixed: FIXED, marks: MARKS }[/^\/(\w+)/.exec(req.url)[1]];
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(page);
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
  assert.deepEqual(shot, { file: out, width: 1170, height: 2532, fullPage: false });
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

test("measure gives each selector's rect on the PNG in CSS pixels, null for one not on it", { skip }, async (t) => {
  const { base } = await fixture(t);
  const dir = outDir(t);
  const url = `${base}/marks`;
  const measure = ["#a", "#b", "#nope", "#hidden", "#empty", "[[bad", ".dup"];
  const a = { x: 10, y: 20, w: 100, h: 50 };
  const b = { x: 200, y: 1500, w: 40, h: 30 };
  const whole = await capture({ url, out: path.join(dir, "f.png"), viewport: "desktop", fullPage: true, measure });
  assert.deepEqual([whole.height, whole.rects], [2000, [a, b, null, null, null, null, null]]);
  const phone = await capture({ url, out: path.join(dir, "m.png"), viewport: "mobile", measure: ["#a"] });
  assert.deepEqual([phone.width, phone.rects], [1170, [a]]);
  const plain = await capture({ url, out: path.join(dir, "p.png"), viewport: "desktop" });
  assert.equal(plain.rects, undefined);
});

test("a freeze over two elements is reproduced on a live still shot whole, anchored around them", { skip }, async (t) => {
  const { base } = await fixture(t);
  const dir = outDir(t);
  const element = (selector) => ({ selector, text: "", html: `<div id="${selector.slice(1)}"></div>` });
  const box = { x: 0, y: 0, w: 300, h: 1600 };
  const asked = { path: "/marks", viewport: "desktop", scroll: { x: 0, y: 0 }, box };
  const frozen = await freeze(dir, freezeRequest({ ...asked, elements: [element("#a"), element("#b")] }), { base });
  const where = [frozen.still, frozen.variant, frozen.rev, frozen.state];
  assert.deepEqual(where, ["live-marks", "desktop", 1, "reproduced"]);
  assert.deepEqual(frozen.anchor, { x: 10 / 1440, y: 20 / 2000, w: 230 / 1440, h: 1510 / 2000 });
  const gone = freezeRequest({ ...asked, elements: [element("#a"), element("#nope")] });
  const missing = await freeze(dir, gone, { base });
  assert.deepEqual([missing.rev, missing.state], [1, "not-reproduced"]);
  assert.deepEqual(missing.anchor, { x: 0, y: 0, w: 300 / 1440, h: 1600 / 2000 });
  assert.equal(stills(dir)[0].variants[0].revs.length, 1);
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

test("expandRecipe takes each shot once per viewport and tag set, defaults filling in, and names a bad shot", () => {
  const steps = async () => {};
  const shots = expandRecipe({
    defaults: { viewports: ["desktop", "mobile"], fullPage: true },
    shots: [
      { name: "03-users", title: "Users", path: "/app" },
      { name: "05-invite", path: "/app", viewports: ["mobile"], tags: [["dark"], ["light"]], steps },
    ],
  });
  assert.deepEqual(
    shots.map((s) => [s.name, s.key, s.fullPage, s.steps === steps]),
    [
      ["03-users", "desktop", true, false],
      ["03-users", "mobile", true, false],
      ["05-invite", "mobile+dark", true, true],
      ["05-invite", "mobile+light", true, true],
    ]
  );
  assert.deepEqual(
    expandRecipe({ shots: [{ name: "a", path: "/" }, { name: "b", path: "/" }] }, /^b/).map((s) => s.key),
    ["mobile"]
  );
  assert.throws(() => expandRecipe({ shots: [{ name: "../x", path: "/" }] }), /shots\[0\] \(\.\.\/x\): 'name'/);
  assert.throws(() => expandRecipe({ shots: [{ name: "x", path: "app" }] }), /shots\[0\] \(x\): 'path'/);
  assert.throws(() => expandRecipe({ shots: [{ name: "x", path: "/", viewports: ["huge"] }] }), /\(x\): a viewport/);
  assert.throws(() => expandRecipe({ shots: [{ name: "x", path: "/", tags: ["dark", "light"] }] }), /contradict/);
  assert.throws(
    () => expandRecipe({ shots: [{ name: "x", path: "/" }, { name: "x", path: "/b" }] }),
    /x \[mobile\] is shot twice/
  );
  assert.throws(() => expandRecipe({ shots: [] }), /non-empty/);
  assert.deepEqual(
    ignorePatterns({ ignore: [/maps/i, "a.b"] }).map((re) => [re.test("Google Maps"), re.test("axb")]),
    [
      [true, false],
      [false, false],
    ]
  );
});

test("a full page of an app shell captures its inner scroller whole; with a dialog open it is the viewport", { skip }, async (t) => {
  const { base } = await fixture(t);
  const dir = outDir(t);
  const whole = await capture({ url: `${base}/shell`, out: path.join(dir, "s.png"), viewport: "desktop", fullPage: true });
  assert.deepEqual([whole.width, whole.height, whole.fullPage], [1440, 3060, true]);
  const capped = await capture({
    url: `${base}/shell`,
    out: path.join(dir, "c.png"),
    viewport: "desktop",
    fullPage: true,
    maxHeight: 2000,
  });
  assert.deepEqual([capped.height, capped.fullPage], [2000, true]);
  const fixed = await capture({ url: `${base}/fixed`, out: path.join(dir, "x.png"), viewport: "desktop", fullPage: true });
  assert.deepEqual([fixed.height, fixed.fullPage], [1000, true]);
  const dialog = await capture({
    url: `${base}/shell?dialog=1`,
    out: path.join(dir, "d.png"),
    viewport: "desktop",
    fullPage: true,
  });
  assert.deepEqual([dialog.width, dialog.height, dialog.fullPage], [1440, 900, false]);
  const lines = [];
  const code = await main([`${base}/shell?dialog=1`, path.join(dir, "m.png"), "--viewport", "desktop", "--full-page"], {
    out: (l) => lines.push(l),
    err: () => {},
  });
  assert.equal(code, 0);
  assert.deepEqual(lines, [`${path.join(dir, "m.png")} 1440x900 viewport`]);
});

/** Steps that invite a user through the fixture app's dialog and its in-page mock, then navigate. */
function inviteSteps(seen) {
  return async (page) => {
    await page.click("Invite user");
    await page.type("[role=dialog] input[type=email]", "luis@example.com");
    await page.click("Send invitation", { within: "[role=dialog]" });
    await page.waitFor("#status", { text: "Invitation sent to luis@example.com" });
    await page.waitFor("[role=dialog]", { gone: true });
    seen.status = await page.evaluate("byText('Invitation sent', document)[0].textContent");
    await page.click("Next page");
    await page.waitFor("h1", { text: "Done" });
    seen.after = await page.evaluate("$$('h1').map((h) => h.textContent)");
    seen.title = await page.evaluate(() => document.title);
  };
}

test("steps click, type and wait with no sleep, on a mock that answers on a timer and across a navigation", { skip }, async (t) => {
  const { base } = await fixture(t);
  const dir = outDir(t);
  for (const viewport of ["desktop", "mobile"]) {
    const seen = {};
    await capture({ url: `${base}/app`, out: path.join(dir, `${viewport}.png`), viewport, steps: inviteSteps(seen) });
    assert.deepEqual(seen, { status: "Invitation sent to luis@example.com", after: ["Done"], title: "Done" }, viewport);
  }
});

test("a step whose target is missing fails, naming it", { skip }, async (t) => {
  const { base } = await fixture(t);
  await assert.rejects(
    capture({
      url: `${base}/app`,
      out: path.join(outDir(t), "x.png"),
      viewport: "desktop",
      waitMs: 1000,
      steps: (page) => page.click("Remove user", { within: "#status" }),
    }),
    /^Error: steps: click 'Remove user': no element matches 'Remove user' within '#status'/
  );
});

test("a batch with --parallel 4 is at least twice as fast as the same shots one by one", { skip }, async (t) => {
  const { base } = await fixture(t);
  const dir = outDir(t);
  const names = Array.from({ length: 12 }, (_, i) => `still-${String(i).padStart(2, "0")}`);
  const recipe = { defaults: { viewports: ["desktop"] }, shots: names.map((name) => ({ name, path: "/?h=1200" })) };
  let started = Date.now();
  const summary = await runBatch({ recipe, base, outDir: path.join(dir, "batch"), parallel: 4 });
  const batch = Date.now() - started;
  assert.deepEqual([summary.shots, summary.ok, summary.failed], [12, 12, 0]);
  started = Date.now();
  for (const name of names) {
    await capture({ url: `${base}/?h=1200`, out: path.join(dir, `${name}.png`), viewport: "desktop" });
  }
  const single = Date.now() - started;
  assert.ok(batch * 2 <= single, `batch ${batch}ms, one by one ${single}ms`);
});

test("each shot of a batch has its own storage and cookies", { skip }, async (t) => {
  const { base } = await fixture(t);
  const seen = {};
  const recipe = {
    defaults: { viewports: ["desktop"] },
    shots: [
      {
        name: "writer",
        path: "/done",
        steps: async (page) => {
          await page.evaluate("localStorage.setItem('who', 'writer'); document.cookie = 'who=writer'");
          seen.writer = await page.evaluate("[localStorage.getItem('who'), document.cookie]");
        },
      },
      {
        name: "reader",
        path: "/done",
        steps: async (page) => {
          seen.reader = await page.evaluate("[localStorage.getItem('who'), document.cookie]");
        },
      },
    ],
  };
  await runBatch({ recipe, base, outDir: outDir(t), parallel: 1 });
  assert.deepEqual(seen, { writer: ["writer", "who=writer"], reader: [null, ""] });
});

test("a batch run twice adds nothing the second time and the reviewed marks stay", { skip }, async (t) => {
  const { base } = await fixture(t);
  const store = outDir(t);
  const recipe = {
    defaults: { viewports: ["desktop", "mobile"], fullPage: true },
    shots: [
      { name: "home", title: "Home", path: "/?h=1200" },
      { name: "shell", path: "/shell" },
    ],
  };
  const run = async () => {
    const lines = [];
    await runBatch({ recipe, base, outDir: path.join(store, "shots"), add: addTo(store), report: (l) => lines.push(l) });
    return lines;
  };
  const first = await run();
  assert.deepEqual(first.at(-1).summary.added, 4);
  assert.deepEqual(new Set(first.slice(0, -1).map((l) => l.added)), new Set(["rev 1"]));
  await appendEvent(store, { type: "viewed", author: { kind: "human", name: "dante" }, still: "home", variant: "mobile", rev: 1 });
  const second = await run();
  assert.deepEqual(new Set(second.slice(0, -1).map((l) => l.added)), new Set(["unchanged"]));
  assert.deepEqual([second.at(-1).summary.added, second.at(-1).summary.unchanged], [0, 4]);
  assert.equal(reviewed(store, "dante").home.variants.mobile.reviewed, true);
  const [home] = stills(store);
  assert.deepEqual([home.title, home.source.path, home.variants[0].viewport.fullPage], ["Home", "/?h=1200", true]);
});

test("the batch CLI fails one shot alone, names its missing target, reports exceptions and exits 1", { skip }, async (t) => {
  const { base } = await fixture(t);
  const dir = outDir(t);
  const shots = path.join(dir, "shots.mjs");
  writeFileSync(
    shots,
    `export default {
  defaults: { viewports: ["desktop"] },
  ignore: [/Google Maps/],
  shots: [
    { name: "good", path: "/done" },
    { name: "throws", path: "/throws" },
    { name: "broken", path: "/app", steps: (page) => page.click("No such button") },
  ],
};
`
  );
  const store = path.join(dir, "store");
  const run = async (...extra) => {
    const out = [];
    const err = [];
    const code = await main(["--batch", shots, "--base", base, "--add", store, ...extra], {
      out: (l) => out.push(JSON.parse(l)),
      err: (l) => err.push(l),
    });
    return { code, out, err };
  };
  process.env.MOCKUP_SHOT_WAIT_MS = "1000";
  t.after(() => delete process.env.MOCKUP_SHOT_WAIT_MS);
  const r = await run();
  assert.equal(r.code, 1);
  const by = Object.fromEntries(r.out.filter((l) => l.name).map((l) => [l.name, l]));
  assert.equal(by.good.ok, true);
  assert.equal(by.good.added, "rev 1");
  assert.equal(by.broken.ok, false);
  assert.match(by.broken.error, /click 'No such button': no element matches 'No such button'/);
  assert.equal(by.broken.added, undefined);
  assert.equal(by.throws.ok, true);
  assert.equal(by.throws.added, "rev 1");
  assert.match(by.throws.exceptions.join(" "), /kaboom/);
  assert.deepEqual(by.throws.consoleErrors, []);
  assert.deepEqual([r.out.at(-1).summary.failed, r.out.at(-1).summary.exceptions], [1, 1]);
  assert.deepEqual(stills(store).map((s) => s.name).sort(), ["good", "throws"]);
  const strict = await run("--strict", "--only", "throws");
  assert.equal(strict.code, 1);
  assert.match(strict.out[0].error, /page exception/);
  assert.equal(strict.out[0].added, undefined);
});
