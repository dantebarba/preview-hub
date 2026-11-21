/**
 * Tests of the /mockup runtime against a real Vite server on a throwaway project: clean URLs,
 * the `/app/` prefix, PostCSS and Tailwind detection, tsconfig paths from a page, a hot update
 * received over the HMR websocket after a file changes, and the stills viewer with its
 * `/_review/` routes. Run with `npm test` from mockup/.
 */

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { addStill, appendEvent } from "./review.mjs";
import { fileUrl } from "./stills/state.js";
import { allowedHosts, findPostcssConfig, scratchOwner, start, tailwindV4Sources, withPages } from "./server.mjs";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const HUMAN = { kind: "human", name: "dante" };
const OWNER = { "Tailscale-User-Login": "dante@example.com", "Tailscale-User-Name": "Dante" };
const GUEST = {};

/** Write `files` (relative path to contents) under `dir`. */
function write(dir, files) {
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), body);
  }
}

/**
 * Open the server-sent event stream at `url`. Returns `{ next, close }`: `next()` resolves to
 * the next frame that carries data, as `{ id, event, data }` with `data` parsed, and rejects
 * when none comes within 10s.
 */
async function eventSource(url, headers = {}) {
  const controller = new AbortController();
  const res = await fetch(url, { headers, signal: controller.signal });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /^text\/event-stream/);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const frames = [];
  let buffer = "";
  const next = async () => {
    const deadline = AbortSignal.timeout(10000);
    while (!frames.length) {
      const expired = new Promise((_, reject) => {
        deadline.addEventListener("abort", () => reject(new Error("no event within 10s")), { once: true });
      });
      const { value, done } = await Promise.race([reader.read(), expired]);
      if (done) throw new Error("the event stream ended");
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split("\n\n");
      buffer = parts.pop();
      for (const part of parts) {
        const frame = { id: null, event: "message", data: null };
        for (const line of part.split("\n")) {
          if (line.startsWith("id: ")) frame.id = line.slice(4);
          if (line.startsWith("event: ")) frame.event = line.slice(7);
          if (line.startsWith("data: ")) frame.data = JSON.parse(line.slice(6));
        }
        if (frame.data !== null) frames.push(frame);
      }
    }
    return frames.shift();
  };
  return { next, close: () => controller.abort() };
}

const FAKE_TAILWIND = `
module.exports = (config) => ({
  postcssPlugin: "tailwindcss",
  Once(root) { root.append({ text: "content " + JSON.stringify(config.content) }); },
});
module.exports.postcss = true;
`;

const PROJECT = {
  "package.json": JSON.stringify({ name: "acme", private: true }),
  "tsconfig.json": JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@/*": ["./src/*"] } }, include: ["src"] }),
  "postcss.config.cjs": "module.exports = { plugins: { tailwindcss: {}, 'postcss-mark': {} } };",
  "tailwind.config.cjs": "module.exports = { content: ['./src/**/*.tsx'] };",
  "node_modules/postcss-mark/package.json": JSON.stringify({ name: "postcss-mark", main: "index.js" }),
  "node_modules/postcss-mark/index.js":
    "module.exports = () => ({ postcssPlugin: 'postcss-mark', Once(root) { root.append({ text: 'marked' }); } });\nmodule.exports.postcss = true;",
  "node_modules/tailwindcss/package.json": JSON.stringify({ name: "tailwindcss", main: "index.js" }),
  "node_modules/tailwindcss/index.js": FAKE_TAILWIND,
  "node_modules/tailwindcss/loadConfig.js": "module.exports = (file) => require(file);",
  "src/lib/greet.ts": "export const greet = () => 'hi';",
  "web/styles.css": "body { color: red }",
  "web/hot.css": "body { color: blue }",
  ".mockup/.gitignore": "*",
  ".mockup/manifest.json": JSON.stringify({ title: "Acme", pages: [{ title: "Pay", path: "/pay" }] }),
  ".mockup/pages/pay.html": `<link rel="stylesheet" href="/app/web/styles.css"><script type="module" src="./pay.ts"></script>`,
  ".mockup/pages/pay.ts": "import { greet } from '@/lib/greet';\nimport '/app/web/hot.css';\ndocument.body.textContent = greet();",
};

describe("the mockup server", () => {
  let app;
  let server;
  let base;

  before(async () => {
    app = mkdtempSync(path.join(tmpdir(), "mockup-app-"));
    write(app, PROJECT);
    server = await start({ app, port: 0, hosts: [], cacheDir: path.join(app, ".vite-cache") });
    base = `http://127.0.0.1:${server.httpServer.address().port}`;
  });

  after(async () => {
    await server?.close();
    rmSync(app, { recursive: true, force: true });
  });

  test("serves the menu at / with the HMR client, never cached", async () => {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const html = await res.text();
    assert.match(html, /<a href="\/pay">Pay<\/a>/);
    assert.match(html, /\/@vite\/client/);
  });

  test("serves a page at its clean URL with its entry pointed at /pages/", async () => {
    const res = await fetch(`${base}/pay?v=b`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const html = await res.text();
    assert.match(html, /src="\/pages\/pay\.ts"/);
    assert.ok(html.includes(`href="/@fs${app}/web/styles.css"`), html);
    assert.equal((await fetch(`${base}/missing`)).status, 404);
  });

  test("serves the project root under /app/, through the project's PostCSS plugins", async () => {
    const res = await fetch(`${base}/app/web/styles.css`, { headers: { Accept: "text/css" } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const css = await res.text();
    assert.match(css, /color: red/);
    assert.match(css, /marked/);
  });

  test("adds the mockup pages to Tailwind v3's content", async () => {
    const css = await (await fetch(`${base}/app/web/styles.css`, { headers: { Accept: "text/css" } })).text();
    assert.match(css, /\.\/src\/\*\*\/\*\.tsx/);
    assert.ok(css.includes(path.join(app, ".mockup", "pages")));
  });

  test("resolves tsconfig paths and /app/ imports from a page entry", async () => {
    const res = await fetch(`${base}/pages/pay.ts`);
    assert.equal(res.status, 200);
    const js = await res.text();
    assert.ok(js.includes(`/@fs${app}/src/lib/greet.ts`), js);
    assert.ok(js.includes(`/@fs${app}/web/hot.css`), js);
  });

  test("pushes a hot update over the websocket when an imported file changes", async () => {
    await fetch(`${base}/pay`);
    await fetch(`${base}/pages/pay.ts`);
    await fetch(`${base}/@fs${app}/web/hot.css`);
    const ws = new WebSocket(base.replace("http", "ws"), "vite-hmr");
    const messages = [];
    const got = (type) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no ${type}; got ${JSON.stringify(messages)}`)), 10000);
        ws.addEventListener("message", (e) => {
          const msg = JSON.parse(e.data);
          messages.push(msg);
          if (msg.type === type) {
            clearTimeout(timer);
            resolve(msg);
          }
        });
      });
    try {
      await got("connected");
      const update = got("update");
      writeFileSync(path.join(app, "web/hot.css"), "body { color: green }");
      const msg = await update;
      assert.ok(msg.updates.some((u) => u.path.endsWith("/web/hot.css")), JSON.stringify(msg));
    } finally {
      ws.close();
    }
  });

  /** POST `body` to the review log with the content type `type`, as the tailnet user or the guest `who` is. */
  const post = (body, type = "application/json", who = OWNER) =>
    fetch(`${base}/_review/events`, { method: "POST", headers: { "Content-Type": type, ...who }, body });

  /** The entry of the still `name` in `GET /_review/stills`, as the tailnet user sees it. */
  const still = async (name) => {
    const res = await fetch(`${base}/_review/stills`, { headers: OWNER });
    assert.equal(res.status, 200);
    return (await res.json()).stills.find((s) => s.name === name);
  };

  let shots = 0;

  /** Add a revision of the still `name` to the project's review store, a PNG unlike the last. */
  const shoot = (name, title) => {
    const file = path.join(app, "shot.png");
    shots += 1;
    writeFileSync(file, Buffer.concat([PNG, Buffer.from(String(shots))]));
    return addStill(path.join(app, ".mockup"), { file, name, title });
  };

  test("a URL that does not parse is left to Vite, not answered 500", async () => {
    assert.notEqual((await fetch(`${base}//`)).status, 500);
  });

  test("serves the stills viewer at the reserved /stills, with its script and styles", async () => {
    const res = await fetch(`${base}/stills`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.match(res.headers.get("content-type"), /^text\/html/);
    assert.match(await res.text(), /src="\/_review\/viewer\.js"/);
    const scripts = ["viewer.js", "live.js", "state.js", "annotate.js", "swipe.js"].map((file) => [file, /javascript/]);
    for (const [file, type] of [...scripts, ["viewer.css", /css/]]) {
      const asset = await fetch(`${base}/_review/${file}`);
      assert.equal(asset.status, 200, file);
      assert.match(asset.headers.get("content-type"), type);
    }
    assert.equal((await fetch(`${base}/_review/nope`)).status, 404);
  });

  test("serves the live shell at /live/<slug> for a page that exists, and links it from the menu", async () => {
    const res = await fetch(`${base}/live/pay?v=b`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.match(res.headers.get("content-type"), /^text\/html/);
    assert.match(await res.text(), /src="\/_review\/live\.js"/);
    assert.equal((await fetch(`${base}/live/missing`)).status, 404);
    assert.match(await (await fetch(`${base}/`)).text(), /<a class="live" href="\/live\/pay/);
  });

  test("two shots of one name are rev 2: listed, served and linked from the menu", async () => {
    await shoot("landing", "Home");
    await shoot("landing");
    const landing = await still("landing");
    assert.equal(landing.title, "Home");
    const files = landing.revs.map((r) => [r.n, r.file]);
    assert.deepEqual(files, [[1, "stills/landing/desktop/1.png"], [2, "stills/landing/desktop/2.png"]]);
    const none = { rev: 2, viewed: null, reviewed: false, changed: false };
    assert.deepEqual(landing.mark, { ...none, variants: { desktop: none } });
    const image = await fetch(`${base}/stills/landing/desktop/2.png`);
    assert.equal(image.status, 200);
    assert.notEqual(image.headers.get("cache-control"), "no-store");
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), readFileSync(path.join(app, "shot.png")));
    const menu = await (await fetch(`${base}/`)).text();
    assert.match(menu, /<a href="\/stills">Review the stills/);
    assert.match(menu, /<a href="\/stills#landing"><img src="\/stills\/landing\/desktop\/2\.png"/);
  });

  test("a variant's image is served at the URL fileUrl gives it, its key's + encoded", async () => {
    const file = path.join(app, "shot.png");
    writeFileSync(file, PNG);
    const dir = path.join(app, ".mockup");
    const { rev } = await addStill(dir, { file, name: "dark", viewport: "mobile", tags: ["dark"] });
    const image = await fetch(`${base}${fileUrl(rev.file)}`);
    assert.equal(image.status, 200);
    assert.notEqual(image.headers.get("cache-control"), "no-store");
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), PNG);
  });

  test("POST /_review/events takes only JSON (415) and only a good event (400)", async () => {
    await shoot("posted");
    const viewed = JSON.stringify({ type: "viewed", still: "posted", rev: 1 });
    assert.equal((await post(viewed, "text/plain")).status, 415);
    assert.equal((await fetch(`${base}/_review/events`, { method: "POST", body: viewed })).status, 415);
    assert.equal((await post("{")).status, 400);
    assert.equal((await post("[]")).status, 400);
    const unknown = await post(JSON.stringify({ type: "viewed", still: "no-such-still", rev: 1 }));
    assert.equal(unknown.status, 400);
    assert.match((await unknown.json()).error, /no still 'no-such-still'/);
    assert.equal((await post(JSON.stringify({ type: "viewed", still: "posted", rev: 1, extra: 1 }))).status, 400);
    assert.equal((await post(JSON.stringify({ type: "x".repeat(70000) }))).status, 413);
    assert.equal((await post(JSON.stringify({ type: "working", still: "posted" }))).status, 403);
    assert.equal((await post(JSON.stringify({ type: "idle" }))).status, 403);
    assert.equal((await still("posted")).mark.reviewed, false);
    assert.equal((await fetch(`${base}/_review/stills`, { method: "POST" })).status, 405);
  });

  test("a post from another origin is refused, one from the page's own origin stored", async () => {
    await shoot("origin");
    const send = (origin) =>
      fetch(`${base}/_review/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: origin, ...OWNER },
        body: JSON.stringify({ type: "viewed", still: "origin", rev: 1 }),
      });
    assert.equal((await send("http://localhost:5173")).status, 403);
    assert.equal((await send("null")).status, 403);
    assert.equal((await still("origin")).mark.reviewed, false);
    assert.equal((await send(base)).status, 201);
    assert.equal((await still("origin")).mark.reviewed, true);
  });

  test("the reviewed mark is an event: set, cleared by a new revision, which is flagged changed", async () => {
    await shoot("marked");
    const res = await post(JSON.stringify({ type: "viewed", still: "marked", rev: 1 }));
    assert.equal(res.status, 201);
    const stored = await res.json();
    assert.deepEqual(stored.author, { kind: "human", name: "Dante", via: "tailnet" });
    assert.ok(stored.seq >= 1 && stored.id && stored.at);
    const mark = async () => {
      const { variants, ...m } = (await still("marked")).mark;
      assert.deepEqual(variants.desktop, m);
      return m;
    };
    assert.deepEqual(await mark(), { rev: 1, viewed: 1, reviewed: true, changed: false });
    await shoot("marked");
    assert.deepEqual(await mark(), { rev: 2, viewed: 1, reviewed: false, changed: true });
    const unviewed = { type: "unviewed", still: "marked", rev: 2, author: { name: "Ana" } };
    const other = await post(JSON.stringify(unviewed), "application/json", GUEST);
    assert.deepEqual((await other.json()).author, { kind: "human", name: "Ana", via: "share" });
    assert.deepEqual(await mark(), { rev: 2, viewed: 1, reviewed: false, changed: true });
    await post(JSON.stringify({ type: "unviewed", still: "marked", rev: 2 }));
    assert.deepEqual(await mark(), { rev: 2, viewed: null, reviewed: false, changed: false });
  });

  test("a guest writes under the name they give, never as the tailnet, and cannot resolve or reopen", async () => {
    await shoot("shared");
    const guest = (event) => post(JSON.stringify(event), "application/json", GUEST);
    const remark = { type: "thread", still: "shared", rev: 1, body: "Too dark" };
    const nameless = await guest(remark);
    assert.equal(nameless.status, 400);
    assert.equal((await nameless.json()).error, "name required");
    assert.equal((await guest({ ...remark, author: { name: "   " } })).status, 400);
    assert.equal((await guest({ ...remark, author: { name: "x".repeat(41) } })).status, 400);
    const claimed = { kind: "agent", name: " Dante ", via: "tailnet" };
    const res = await guest({ ...remark, author: claimed });
    assert.equal(res.status, 201);
    const thread = await res.json();
    assert.deepEqual(thread.author, { kind: "human", name: "Dante", via: "share" });
    for (const type of ["resolve", "reopen"]) {
      assert.equal((await guest({ type, thread: thread.id, author: { name: "Ana" } })).status, 403);
    }
    const ana = { name: "Ana" };
    assert.equal((await guest({ type: "reply", thread: thread.id, body: "Still", author: ana })).status, 201);
    assert.equal((await guest({ type: "viewed", still: "shared", rev: 1, author: ana })).status, 201);
    const owner = await post(JSON.stringify({ type: "resolve", thread: thread.id, author: { name: "Ana" } }));
    assert.deepEqual((await owner.json()).author, { kind: "human", name: "Dante", via: "tailnet" });
    const seen = await (await fetch(`${base}/_review/stills`)).json();
    assert.deepEqual(seen.me, { name: null, via: "share" });
    assert.equal(seen.marks["Ana (guest)"].shared.desktop, 1);
    assert.equal(seen.stills.find((s) => s.name === "shared").mark.reviewed, false);
    const mine = await (await fetch(`${base}/_review/stills`, { headers: OWNER })).json();
    assert.deepEqual(mine.me, { name: "Dante", via: "tailnet" });
    assert.deepEqual(mine.working, []);
  });

  test("GET /_review/events resumes from since, then pushes what is posted and what the CLI appends", async () => {
    const dir = path.join(app, ".mockup");
    await shoot("live");
    const first = await appendEvent(dir, { type: "viewed", author: HUMAN, still: "live", rev: 1 });
    const second = await appendEvent(dir, { type: "unviewed", author: HUMAN, still: "live", rev: 1 });
    const stream = await eventSource(`${base}/_review/events?since=${first.seq}`);
    try {
      const resumed = await stream.next();
      assert.equal(resumed.id, String(second.seq));
      assert.deepEqual(resumed.data, second);
      const posted = await (await post(JSON.stringify({ type: "viewed", still: "live", rev: 1 }))).json();
      assert.deepEqual((await stream.next()).data, posted);
      const appended = await appendEvent(dir, { type: "unviewed", author: HUMAN, still: "live", rev: 1 });
      assert.deepEqual((await stream.next()).data, appended);
      await shoot("live");
      assert.equal((await stream.next()).event, "stills");
    } finally {
      stream.close();
    }
    const again = await eventSource(`${base}/_review/events?since=0`, { "Last-Event-ID": String(second.seq) });
    try {
      assert.equal((await again.next()).data.seq, second.seq + 1);
    } finally {
      again.close();
    }
    assert.equal((await fetch(`${base}/_review/events?since=abc`)).status, 400);
  });

  test("GET /_review/threads folds the log's threads", async () => {
    await shoot("remarked");
    const dir = path.join(app, ".mockup");
    const remark = { type: "thread", author: HUMAN, still: "remarked", rev: 1, body: "Too wide" };
    const thread = await appendEvent(dir, remark);
    const res = await fetch(`${base}/_review/threads`);
    assert.equal(res.status, 200);
    const found = (await res.json()).threads.find((t) => t.id === thread.id);
    assert.equal(found.body, "Too wide");
    assert.equal(found.status, "open");
  });

  test("a posted thread carries its annotated still, kept as review/annotated/<id>.png", async () => {
    await shoot("boxed");
    const annotated = `data:image/png;base64,${PNG.toString("base64")}`;
    const anchor = { x: 0.1, y: 0.2, w: 0.5, h: 0.1 };
    const remark = { type: "thread", still: "boxed", rev: 1, anchor, body: "Overflows" };
    const file = (id) => path.join(app, ".mockup", "review", "annotated", `${id}.png`);
    const res = await post(JSON.stringify({ ...remark, annotated }));
    assert.equal(res.status, 201);
    const stored = await res.json();
    assert.deepEqual(stored.anchor, remark.anchor);
    assert.equal(stored.rev, 1);
    assert.equal("annotated" in stored, false);
    assert.deepEqual(readFileSync(file(stored.id)), PNG);
    const threads = async () => (await (await fetch(`${base}/_review/threads`)).json()).threads;
    assert.deepEqual((await threads()).find((t) => t.id === stored.id).anchor, remark.anchor);
    const before = (await threads()).length;
    const notPng = `data:image/png;base64,${Buffer.from("GIF89a").toString("base64")}`;
    assert.equal((await post(JSON.stringify({ ...remark, annotated: notPng }))).status, 400);
    assert.equal((await post(JSON.stringify({ ...remark, annotated: "x".repeat(12 * 1024 * 1024) }))).status, 413);
    const reply = { type: "reply", thread: stored.id, body: "And here", annotated };
    assert.equal((await post(JSON.stringify(reply))).status, 400);
    assert.equal((await post(JSON.stringify({ ...remark, still: "no-such-still", annotated }))).status, 400);
    assert.equal((await threads()).length, before);
    const bare = await (await post(JSON.stringify(remark))).json();
    assert.equal(existsSync(file(bare.id)), false);
  });

  test("reloads the open tabs when the manifest changes", async () => {
    const ws = new WebSocket(base.replace("http", "ws"), "vite-hmr");
    const reload = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no full-reload")), 10000);
      ws.addEventListener("message", (e) => {
        const msg = JSON.parse(e.data);
        if (msg.type === "connected") {
          writeFileSync(path.join(app, ".mockup/manifest.json"), JSON.stringify({ title: "Acme 2", pages: [] }));
        }
        if (msg.type === "full-reload") {
          clearTimeout(timer);
          resolve(msg);
        }
      });
    });
    try {
      await reload;
    } finally {
      ws.close();
    }
  });
});

test("findPostcssConfig finds a config file or a package.json postcss key", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "mockup-postcss-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(findPostcssConfig(dir), null);
  write(dir, { "package.json": JSON.stringify({ postcss: { plugins: {} } }) });
  assert.equal(findPostcssConfig(dir), path.join(dir, "package.json"));
  write(dir, { "postcss.config.mjs": "export default {}" });
  assert.equal(findPostcssConfig(dir), path.join(dir, "postcss.config.mjs"));
});

test("withPages adds the pages glob to either shape of Tailwind content", () => {
  assert.deepEqual(withPages(["./src/**/*"], "/app/.mockup/pages"), [
    "./src/**/*",
    "/app/.mockup/pages/**/*.{html,js,jsx,ts,tsx,vue,svelte}",
  ]);
  assert.deepEqual(withPages({ files: ["./src/**/*"], relative: true }, "/p"), {
    files: ["./src/**/*", "/p/**/*.{html,js,jsx,ts,tsx,vue,svelte}"],
    relative: true,
  });
});

test("tailwindV4Sources adds @source lines only to stylesheets that import tailwindcss", () => {
  const plugin = tailwindV4Sources({ app: "/app" });
  const out = plugin.transform('@import "tailwindcss";', "/app/src/index.css");
  assert.match(out.code, /@source "\/app\/\.mockup\/pages";/);
  assert.equal(plugin.transform("body{}", "/app/src/plain.css"), null);
  assert.equal(plugin.transform('@import "tailwindcss";', "/app/src/index.ts"), null);
});

test("scratchOwner names the scratch dir's owner only to a server started as root", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "mockup-owner-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { uid, gid } = statSync(dir);
  assert.equal(scratchOwner(dir, 1000), null);
  assert.equal(scratchOwner(path.join(dir, "missing"), 0), null);
  assert.deepEqual(scratchOwner(dir, 0), uid === 0 ? null : { uid, gid });
});

test("allowedHosts splits PREVIEW_ALLOWED_HOSTS", () => {
  assert.deepEqual(allowedHosts("box.ts.net, .example.com,"), ["box.ts.net", ".example.com"]);
  assert.deepEqual(allowedHosts(undefined), []);
});
