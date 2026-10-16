/**
 * Unit tests for the menu, the manifest check and the URL routing of the /mockup runtime.
 * Run with `npm test` from mockup/.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { checkManifest, listShots, renderMenu, rewriteRefs, route } from "./menu.mjs";

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
