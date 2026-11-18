/**
 * Tests of the runtime's folder mode on a real HTTP server: a plain folder of images at
 * `/stills`, only revision images served, the Host check, a remark landing in `.review/`, a
 * rewritten image as rev 2 with the old bytes kept, rewrites with no viewer open each kept, the
 * `stills` event when an image changes, and a read-only folder. Run with `npm test` from mockup/.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { hostAllowed, startFolder } from "./folder.mjs";
import { fileUrl } from "./stills/state.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const OWNER = { "Tailscale-User-Login": "dante@example.com", "Tailscale-User-Name": "Dante" };
const ROOT = process.getuid?.() === 0;

/** PNG bytes ending with `tag`. */
function png(tag) {
  return Buffer.concat([PNG, Buffer.from(tag)]);
}

/** A folder holding `files` (name to contents), removed when the test ends. */
function folderOf(t, files) {
  const dir = mkdtempSync(path.join(tmpdir(), "mockup-folder-"));
  t.after(() => {
    chmodSync(dir, 0o755);
    rmSync(dir, { recursive: true, force: true });
  });
  for (const [name, body] of Object.entries(files)) writeFileSync(path.join(dir, name), body);
  return dir;
}

/** Serve `dir` on a free port of loopback; returns `{ url, close }`, closed when the test ends. */
async function serve(t, dir, hosts = []) {
  const { server, close } = await startFolder({ dir, port: 0, host: "127.0.0.1", hosts });
  t.after(close);
  return { url: `http://127.0.0.1:${server.address().port}`, close };
}

/** GET `/_review/stills` as the owner. */
async function reviewStills(url) {
  const res = await fetch(`${url}/_review/stills`, { headers: OWNER });
  assert.equal(res.status, 200);
  return res.json();
}

/** POST an event as the owner; returns the response. */
function post(url, event) {
  return fetch(`${url}/_review/events`, {
    method: "POST",
    headers: { ...OWNER, "Content-Type": "application/json" },
    body: JSON.stringify(event),
  });
}

test("hostAllowed: loopback always, any host without a list, else the list with .domain entries", () => {
  assert.equal(hostAllowed("127.0.0.1:8080", ["box.ts.net"]), true);
  assert.equal(hostAllowed("anything", []), true);
  assert.equal(hostAllowed("box.ts.net:443", ["box.ts.net"]), true);
  assert.equal(hostAllowed("a.share.example", ["box.ts.net", ".share.example"]), true);
  assert.equal(hostAllowed("evil.example", ["box.ts.net", ".share.example"]), false);
});

test("a folder of only images: / leads to the viewer, which lists them with their images", async (t) => {
  const dir = folderOf(t, { "01-list.png": png("a"), "02-edit@mobile.png": png("b"), "notes.txt": "private" });
  const { url } = await serve(t, dir);
  const root = await fetch(`${url}/`, { redirect: "manual" });
  assert.equal(root.status, 302);
  assert.equal(root.headers.get("location"), "/stills");
  const page = await fetch(`${url}/stills`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<html/i);

  const body = await reviewStills(url);
  assert.deepEqual(
    body.stills.map((s) => [s.name, s.variants.map((v) => v.key)]),
    [
      ["01-list", ["desktop"]],
      ["02-edit", ["mobile"]],
    ]
  );
  assert.equal(body.writable, true);
  assert.deepEqual(body.notes, []);
  assert.deepEqual(body.groups, []);
  assert.equal(body.me.name, "Dante");

  const image = await fetch(`${url}${fileUrl(body.stills[1].revs.at(-1).file)}`);
  assert.equal(image.status, 200);
  assert.equal(image.headers.get("content-type"), "image/png");
  assert.equal(image.headers.get("cache-control"), "no-store");
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), png("b"));
  assert.equal((await fetch(`${url}/notes.txt`)).status, 404);
  assert.equal((await fetch(`${url}/.review/revs.json`)).status, 404);
});

test("a request to a host the server does not accept is refused", async (t) => {
  const dir = folderOf(t, { "a.png": png("a") });
  const { url } = await serve(t, dir, ["box.ts.net"]);
  const ok = await fetch(`${url}/_review/threads`);
  assert.equal(ok.status, 200);
  const status = await new Promise((resolve, reject) => {
    const req = request(`${url}/_review/threads`, { headers: { Host: "evil.example" } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on("error", reject);
    req.end();
  });
  assert.equal(status, 403);
});

test("serving a writable folder keeps its images as rev 1, so a rewrite is rev 2 with the old bytes", async (t) => {
  const dir = folderOf(t, { "a.png": png("one") });
  const { url } = await serve(t, dir);
  assert.ok(existsSync(path.join(dir, ".review", "revs.json")));
  writeFileSync(path.join(dir, "a.png"), png("the second"));
  const [still] = (await reviewStills(url)).stills;
  assert.deepEqual(
    still.revs.map((r) => [r.n, r.file]),
    [
      [1, ".review/revs/a/desktop/1.png"],
      [2, "a.png"],
    ]
  );
  const before = await fetch(`${url}${fileUrl(still.revs[0].file)}`);
  assert.deepEqual(Buffer.from(await before.arrayBuffer()), png("one"));
  assert.match(before.headers.get("cache-control"), /immutable/);
});

test("rewrites with no viewer open are each kept as a revision", async (t) => {
  const dir = folderOf(t, { "a.png": png("one") });
  const { url } = await serve(t, dir);
  const kept = () => JSON.parse(readFileSync(path.join(dir, ".review", "revs.json"), "utf8")).a.desktop.length;
  for (const [n, tag] of [[2, "two"], [3, "three"]]) {
    writeFileSync(path.join(dir, "a.png"), png(tag));
    const start = Date.now();
    while (kept() < n && Date.now() - start < 5000) await new Promise((r) => setTimeout(r, 50));
  }
  const [still] = (await reviewStills(url)).stills;
  assert.deepEqual(still.revs.map((r) => r.n), [1, 2, 3]);
  const second = await fetch(`${url}${fileUrl(still.revs[1].file)}`);
  assert.deepEqual(Buffer.from(await second.arrayBuffer()), png("two"));
});

test("a remark lands in .review/events.jsonl, and only .review/ is added", async (t) => {
  const dir = folderOf(t, { "a.png": png("a") });
  const { url } = await serve(t, dir);
  const res = await post(url, { type: "thread", still: "a", rev: 1, body: "Too tight" });
  assert.equal(res.status, 201);
  const [line] = readFileSync(path.join(dir, ".review", "events.jsonl"), "utf8")
    .trim()
    .split("\n");
  assert.equal(JSON.parse(line).body, "Too tight");
  assert.deepEqual(readdirSync(dir).sort(), [".review", "a.png"]);
  const { threads } = await (await fetch(`${url}/_review/threads`)).json();
  assert.equal(threads[0].author.name, "Dante");
});

test("a changed image is announced to the open event streams as `stills`", async (t) => {
  const dir = folderOf(t, { "a.png": png("a") });
  const { url } = await serve(t, dir);
  const controller = new AbortController();
  t.after(() => controller.abort());
  const res = await fetch(`${url}/_review/events?since=0`, { signal: controller.signal });
  const reader = res.body.getReader();
  const seen = (async () => {
    let text = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return false;
      text += Buffer.from(value).toString();
      if (text.includes("event: stills")) return true;
    }
  })();
  await new Promise((r) => setTimeout(r, 100));
  writeFileSync(path.join(dir, "b.png"), png("b"));
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("no stills event")), 5000));
  assert.equal(await Promise.race([seen, timeout]), true);
});

test("a read-only folder is served with remarks off, and nothing is written in it", { skip: ROOT }, async (t) => {
  const dir = folderOf(t, { "a.png": png("a") });
  chmodSync(dir, 0o555);
  const { url } = await serve(t, dir);
  const body = await reviewStills(url);
  assert.equal(body.writable, false);
  assert.equal(body.stills.length, 1);
  const res = await post(url, { type: "thread", still: "a", rev: 1, body: "Hi" });
  assert.equal(res.status, 403);
  assert.match((await res.json()).error, /read-only folder: remarks off/);
  assert.equal(existsSync(path.join(dir, ".review")), false);
});
