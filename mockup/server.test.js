/**
 * Tests of the /mockup runtime against a real Vite server on a throwaway project: clean URLs,
 * the `/app/` prefix, PostCSS and Tailwind detection, tsconfig paths from a page, and a hot
 * update received over the HMR websocket after a file changes. Run with `npm test` from mockup/.
 */

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { allowedHosts, findPostcssConfig, start, tailwindV4Sources, withPages } from "./server.mjs";

/** Write `files` (relative path to contents) under `dir`. */
function write(dir, files) {
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), body);
  }
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

test("allowedHosts splits PREVIEW_ALLOWED_HOSTS", () => {
  assert.deepEqual(allowedHosts("box.ts.net, .example.com,"), ["box.ts.net", ".example.com"]);
  assert.deepEqual(allowedHosts(undefined), []);
});
