/**
 * Folder mode of the /mockup runtime: any directory of images served for review, with no
 * frontend project, no `node_modules` and no pages, only the stills viewer. `server.mjs` starts
 * it instead of Vite when `STILLS_DIR` names the directory, which `preview stills serve` mounts
 * read-write, or read-only when the host cannot write it.
 *
 * The directory is read as a stills source (`source.mjs`), its review kept in `<dir>/.review/`:
 *
 *   GET  /, /stills                    the viewer (`/` redirects to `/stills`)
 *   GET  /_review/stills               as in a mockup, plus the folder's `groups`, `notes`,
 *                                      `about` and `writable`
 *   GET  /_review/threads, /_review/events, viewer assets   as in a mockup (`menu.mjs`)
 *   POST /_review/events               as in a mockup; 403 on a read-only folder
 *   GET  /<file>                       an image of a revision of a still, and nothing else
 *
 * A writable folder keeps the revisions of its images when the server starts, so the first
 * rewrite of an image already shows as rev 2 with before/after; a changed image is kept again
 * as it is seen. Every response is `Cache-Control: no-store` but a kept revision's image, which
 * never changes. A request whose `Host` is not one the server accepts is refused, as Vite does.
 */

import { createReadStream, statSync, watch } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { eventStream, handleReview, reviewer, reviewStills, sendViewerPage } from "./menu.mjs";
import { folder, keepRevisions, openSource, readSource } from "./source.mjs";

const TYPES = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};
const LOCAL = new Set(["localhost", "127.0.0.1", "[::1]"]);
const KEPT = ".review/revs/";
const SETTLE_MS = 150;
const READ_ONLY = "read-only folder: remarks off";

/**
 * True when a request to `host` may be answered: a loopback name, any host when `hosts` is
 * empty, else one of `hosts`, a leading '.' standing for a domain and its subdomains.
 */
export function hostAllowed(host, hosts = []) {
  const name = String(host ?? "")
    .toLowerCase()
    .replace(/:\d+$/, "");
  if (LOCAL.has(name) || !hosts.length) return true;
  return hosts.some((h) => {
    const entry = h.toLowerCase();
    return entry.startsWith(".") ? name === entry.slice(1) || name.endsWith(entry) : name === entry;
  });
}

/** The files of every revision of the stills of `source`, relative to its folder. */
export function revisionFiles(source) {
  const files = new Set();
  for (const s of source.stills) for (const v of s.variants) for (const r of v.revs) files.add(r.file);
  return files;
}

/** Answer with `body` as JSON. */
function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

/** Answer a GET of `rel`, an image of a revision of the folder `root`, or 404. */
function sendImage(req, res, root, rel) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { Allow: "GET, HEAD" });
    return res.end();
  }
  if (!revisionFiles(readSource(root)).has(rel)) return sendJson(res, 404, { error: "no such still" });
  const file = path.join(root, rel);
  let size;
  try {
    size = statSync(file).size;
  } catch {
    return sendJson(res, 404, { error: "no such still" });
  }
  res.writeHead(200, {
    "Content-Type": TYPES[path.extname(rel).toLowerCase()] ?? "application/octet-stream",
    "Content-Length": size,
    "Cache-Control": rel.startsWith(KEPT) ? "max-age=31536000, immutable" : "no-store",
  });
  if (req.method === "HEAD") return res.end();
  return createReadStream(file).pipe(res);
}

/**
 * Watch the folder `root` for changed images and extras, and call `onChange` once they settle;
 * the review's own files are left out, the event log being followed by the event stream.
 * Returns a function that stops watching, a no-op when the platform cannot watch.
 */
function watchFolder(root, onChange) {
  let timer = null;
  let watcher;
  try {
    watcher = watch(root, { recursive: true }, (_type, name) => {
      const rel = String(name ?? "")
        .split(path.sep)
        .join("/");
      if (rel === ".review" || rel.startsWith(".review/")) return;
      clearTimeout(timer);
      timer = setTimeout(onChange, SETTLE_MS);
    });
  } catch (e) {
    console.warn(`[mockup] not watching ${root}: ${e.message}`);
    return () => {};
  }
  watcher.on("error", (e) => console.warn(`[mockup] stopped watching ${root}: ${e.message}`));
  return () => {
    clearTimeout(timer);
    watcher.close();
  };
}

/**
 * The request handler of the folder `root`, with `hosts` the names it accepts. `stream` is the
 * live side of its review log (see `eventStream`).
 */
export function folderHandler({ root, hosts = [], stream }) {
  const store = folder(root);
  return async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    if (!hostAllowed(req.headers.host, hosts)) return sendJson(res, 403, { error: "host not allowed" });
    const { pathname } = new URL(req.url, "http://stills");
    const who = reviewer(req.headers, hosts);
    try {
      if (pathname === "/" || pathname === "/index.html") {
        res.writeHead(302, { Location: "/stills" });
        return res.end();
      }
      if (pathname === "/stills" || pathname === "/stills/") return sendViewerPage(req, res);
      if (pathname === "/_review/stills" && req.method === "GET") {
        const source = await openSource(root);
        const me = who ?? { name: null, via: "share" };
        const { groups, notes, writable, about } = source;
        return sendJson(res, 200, { ...reviewStills(store, me.name), me, groups, notes, writable, about });
      }
      if (pathname === "/_review/events" && req.method === "POST" && !readSource(root).writable) {
        return sendJson(res, 403, { error: READ_ONLY });
      }
      if (await handleReview(req, res, { scratch: store, stream, who })) return undefined;
      let rel;
      try {
        rel = decodeURIComponent(pathname.slice(1));
      } catch {
        return sendJson(res, 400, { error: "bad path" });
      }
      return sendImage(req, res, root, rel);
    } catch (e) {
      console.error(`[mockup] ${req.method} ${pathname}: ${e.message}`);
      if (!res.headersSent) return sendJson(res, 500, { error: e.message });
      return res.end();
    }
  };
}

/**
 * Serve the folder `dir` on `port`. Resolves once it listens to `{ server, close }`, `close()`
 * ending the open event streams too. A writable folder keeps the revisions of its images first
 * (see `keepRevisions` of `source.mjs`).
 */
export async function startFolder({ dir, port, hosts = [], host = "0.0.0.0" }) {
  const root = path.resolve(dir);
  if (!statSync(root).isDirectory()) throw new Error(`${root}: not a directory`);
  if (readSource(root).writable) await keepRevisions(root);
  const stream = eventStream(folder(root));
  const server = createServer(folderHandler({ root, hosts, stream }));
  const unwatch = watchFolder(root, async () => {
    try {
      await openSource(root);
    } catch (e) {
      console.warn(`[mockup] ${root}: ${e.message}`);
    }
    stream.notify("stills");
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  const { notes, writable } = readSource(root);
  for (const note of notes) console.warn(`[mockup] ${note}`);
  if (!writable) console.warn(`[mockup] ${READ_ONLY}`);
  const close = () =>
    new Promise((resolve) => {
      unwatch();
      stream.close();
      server.close(() => resolve());
      server.closeAllConnections();
    });
  return { server, close };
}
