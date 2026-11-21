/**
 * The menu plugin of the /mockup runtime, plus the manifest helpers it is built on.
 *
 * A mockup lives in `<frontend>/.mockup/`, mounted at `<app>/.mockup`:
 *
 *   manifest.json        { title, pages: [{ title, path, variants: [{ label, query }] }] }
 *   pages/<slug>.html    one page per screen, served at /<slug>
 *   stills/, review/     the review store: stills with revisions and the event log (review.mjs)
 *   shots/<name>.png     stills of a mockup made before the review store, listed on the menu
 *
 * The plugin owns the URL space in front of Vite: `/` is the menu, rendered per request from
 * the manifest and the stills; `/<slug>` serves `pages/<slug>.html`; `/app/<path>` is the
 * project's own file at `<app>/<path>`. `/stills` is reserved for the stills viewer, served from
 * this image (`stills/` next to this file), `/live/<slug>` for the live shell around the page
 * `/<slug>`, where a remark is marked on the page itself (`stills/live.js`), and `/_review/` for
 * what they read and write:
 *
 *   GET  /_review/stills               { stills: [{ name, title, source, variants, revs, mark }],
 *                                      marks, working, me, cursor }: every reviewer's marks, what
 *                                      the agent is working on and who is asking
 *   GET  /_review/threads              { threads }
 *   GET  /_review/events?since=<seq>   server-sent events: the log's events above `since`, then
 *                                      each new one as it lands, and `stills` when the stills change
 *   POST /_review/events               append one event (a JSON body), answered with the stored one;
 *                                      a `thread` may carry `annotated`, its still with the mark
 *                                      drawn as a `data:image/png;base64,` URL of at most 8 MiB,
 *                                      kept as `review/annotated/<id>.png`
 *   POST /_review/freeze               shoot a page the way a live mark saw it and keep the shot as
 *                                      a still for the remark: `{ still, variant, rev, anchor, state,
 *                                      target }` (see `freeze`)
 *
 * The review routes take the scratch dir or, for any folder of images, the handle `folder(dir)`
 * of `source.mjs` returns. A folder adds to them (see `extras.mjs`): `groups`, `notes`,
 * `writable` and `about` in the answer of `/_review/stills`, a `stills` event on the stream when
 * its images or extras change, and
 *
 *   GET  /_review/about                { file, html }: the folder's README as sanitized HTML
 *   GET  /_review/file/<path>          an image of the folder, for the About page
 *
 * Who writes is the server's to say, never the page's (see `reviewer`): a tailnet user is named
 * by the headers `tailscale serve` adds, anyone else is a guest, who gives a name with each
 * write and may not resolve or reopen a remark.
 *
 * Every response is `Cache-Control: no-store` but a still's revision, which never changes. An
 * edit to the manifest or a still reloads the open tabs, as Vite does for a page.
 */

import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { capture, colorScheme, expandRecipe, loadRecipe } from "./capture.mjs";
import { SHOTS_FILE } from "./export.mjs";
import { aboutPage, sourceExtras, sourceFile, watchSource } from "./extras.mjs";
import {
  addStill,
  appendEvent,
  EVENTS_FILE,
  isObject,
  isPng,
  MANIFEST_FILE,
  MAX_AUTHOR,
  MAX_NAME_LENGTH,
  MAX_TAGS,
  parseTags,
  parseViewport,
  readEvents,
  reviewed,
  reviewMarks,
  revisions,
  stills,
  storeAnnotated,
  storePaths,
  targetProblem,
  threads,
  variantKey,
  working,
} from "./review.mjs";
import {
  fileUrl,
  livePath,
  MAX_ANNOTATED_BYTES,
  MAX_NAME,
  pageOfLive,
  PNG_URL,
  TARGET_LIMITS,
} from "./stills/state.js";

const SLUG = /^\/([A-Za-z0-9][\w.-]*(?:\/[A-Za-z0-9][\w.-]*)*)\/?$/;
const RELATIVE_REF = /\b(src|href)=(["'])\.\/([^"'?#]+)([^"']*)\2/g;
const APP_REF = /\b(src|href)=(["'])\/app\//g;
const SHOT = /\.(png|jpe?g|webp)$/i;
const REV_IMAGE = /^\/stills\/[^/]+\/(?:[^/]+\/)?\d+\.png$/;
const SINCE = /^\d{1,15}$/;
const JSON_TYPE = "application/json";
const MAX_POST_BYTES = 64 * 1024;
const ELEMENT_CHARS = TARGET_LIMITS.selector + TARGET_LIMITS.text + TARGET_LIMITS.html;
const MAX_TARGET_BYTES = 3 * (TARGET_LIMITS.page + TARGET_LIMITS.elements * ELEMENT_CHARS);
const MAX_UPLOAD_BYTES = MAX_POST_BYTES + MAX_TARGET_BYTES + Math.ceil(MAX_ANNOTATED_BYTES / 3) * 4;
const MAX_FREEZE_BYTES = MAX_POST_BYTES + MAX_TARGET_BYTES;
const POLL_MS = 1000;
const PING_TICKS = 20;
const ENCODED_WORD = /=\?utf-8\?([bq])\?([^?]*)\?=/gi;
const BETWEEN_WORDS = /(\?=)\s+(?==\?utf-8\?[bq]\?)/gi;
const OWNER_ONLY = ["resolve", "reopen"];
const FREEZE_VIEWPORT = { side: 4096, dpr: 4 };
const MAX_FREEZES_WAITING = 4;
const VIEWER_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "stills");
const VIEWER_PAGE = { file: "index.html", type: "text/html; charset=utf-8" };
const LIVE_PAGE = { file: "live.html", type: "text/html; charset=utf-8" };
const VIEWER_ASSETS = {
  "viewer.js": { file: "viewer.js", type: "text/javascript; charset=utf-8" },
  "live.js": { file: "live.js", type: "text/javascript; charset=utf-8" },
  "state.js": { file: "state.js", type: "text/javascript; charset=utf-8" },
  "who.js": { file: "who.js", type: "text/javascript; charset=utf-8" },
  "annotate.js": { file: "annotate.js", type: "text/javascript; charset=utf-8" },
  "swipe.js": { file: "swipe.js", type: "text/javascript; charset=utf-8" },
  "viewer.css": { file: "viewer.css", type: "text/css; charset=utf-8" },
};

const STYLE =
  "body{font-family:system-ui;background:#111;color:#eee;margin:24px;max-width:960px}" +
  "h1{font-size:20px}h2{font-size:15px;margin:22px 0 8px;color:#aaa}a{color:#7dd3fc}" +
  "ul{padding-left:0;list-style:none;margin:0}" +
  "li{display:flex;gap:6px;margin:6px 0}" +
  "li a{flex:1;padding:12px 14px;background:#1b1b1f;border:1px solid #333;" +
  "border-radius:10px;text-decoration:none;font-size:15px}li a:hover{background:#26262c}" +
  "li a.live{flex:none;color:#fda4af}" +
  ".shots{display:flex;gap:16px;flex-wrap:wrap}figure{margin:0}" +
  "img{width:195px;border:1px solid #444;border-radius:12px;display:block}" +
  "figcaption{margin:6px 0;font-size:13px;color:#aaa}.err{color:#fca5a5}";

/** The mockup's scratch dir inside the project root `app`. */
export function scratchDir(app) {
  return path.join(app, ".mockup");
}

/** Escape a string for HTML text and attribute values. */
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** The page file a manifest path such as `/checkout` names, relative to the scratch dir. */
function pageFile(pagePath) {
  return `pages/${String(pagePath).replace(/^\/+|\/+$/g, "")}.html`;
}

/**
 * Read `<scratch>/manifest.json`. Returns `{ manifest, error }`; a missing file is an empty
 * manifest, an unreadable one is reported in `error` so the menu can show it.
 */
function readManifest(scratch) {
  const file = path.join(scratch, "manifest.json");
  if (!existsSync(file)) return { manifest: { pages: [] }, error: null };
  try {
    const manifest = JSON.parse(readFileSync(file, "utf8"));
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
      return { manifest: { pages: [] }, error: "manifest.json: must be an object" };
    }
    return { manifest, error: null };
  } catch (e) {
    return { manifest: { pages: [] }, error: `manifest.json: ${e.message}` };
  }
}

/** Image file names in `<scratch>/shots/`, sorted. */
export function listShots(scratch) {
  const dir = path.join(scratch, "shots");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => SHOT.test(f)).sort();
}

/**
 * Problems with a manifest, as human-readable lines; empty when it is valid. Every page needs
 * a title and a `/<slug>` path whose `pages/<slug>.html` exists in the scratch dir.
 */
export function checkManifest(scratch) {
  const { manifest, error } = readManifest(scratch);
  if (error) return [error];
  if (!existsSync(path.join(scratch, "manifest.json"))) return ["manifest.json is missing"];
  if (!Array.isArray(manifest.pages)) return ["manifest.json: 'pages' must be a list"];
  const problems = [];
  manifest.pages.forEach((page, i) => {
    const where = `pages[${i}]`;
    if (!page || typeof page.title !== "string" || !page.title) problems.push(`${where}: missing 'title'`);
    if (!page || typeof page.path !== "string" || !SLUG.test(page.path) || path.extname(page.path)) {
      problems.push(`${where}: 'path' must look like /<slug>`);
      return;
    }
    if (!existsSync(path.join(scratch, pageFile(page.path)))) {
      problems.push(`${where}: ${pageFile(page.path)} does not exist`);
    }
    if (page.variants !== undefined && !Array.isArray(page.variants)) {
      problems.push(`${where}: 'variants' must be a list`);
    }
  });
  return problems;
}

/**
 * `value`, a header that may hold RFC 2047 encoded words, which is how `tailscale serve` writes
 * a name that is not ASCII, as the text it stands for. A long name comes as several words, and
 * the space between two of them is not part of it.
 */
function decodeHeader(value) {
  return value.replace(BETWEEN_WORDS, "$1").replace(ENCODED_WORD, (all, kind, text) => {
    if (kind.toLowerCase() === "b") return Buffer.from(text, "base64").toString("utf8");
    const bytes = text.replace(/%/g, "%25").replace(/_/g, " ").replace(/=([0-9A-F]{2})/gi, "%$1");
    try {
      return decodeURIComponent(bytes);
    } catch {
      return all;
    }
  });
}

/**
 * Who sent the request with `headers`: `{ name, via: "tailnet" }` for a tailnet user, named by
 * the `Tailscale-User-Name` (else `Tailscale-User-Login`) header that `tailscale serve` adds,
 * or null for a guest. `hosts` are the names the server accepts, as `preview start` writes
 * them into `PREVIEW_ALLOWED_HOSTS`: the tailnet name, and the edge's domain with a leading
 * dot. A request to a host under that domain, or to one that is not the tailnet name when
 * there is one, did not come through `tailscale serve`, so it is a guest's whatever headers
 * it carries.
 */
export function reviewer(headers, hosts = []) {
  const login = String(headers["tailscale-user-login"] ?? "").trim();
  if (!login) return null;
  const host = String(headers.host ?? "").toLowerCase().replace(/:\d+$/, "");
  const names = hosts.filter((h) => typeof h === "string" && h).map((h) => h.toLowerCase());
  const tailnet = names.filter((h) => !h.startsWith("."));
  const shared = names.some((h) => h.startsWith(".") && (host === h.slice(1) || host.endsWith(h)));
  if (shared || (tailnet.length && !tailnet.includes(host))) return null;
  const name = decodeHeader(String(headers["tailscale-user-name"] ?? "")).trim() || login;
  return { name: name.slice(0, MAX_AUTHOR), via: "tailnet" };
}

/**
 * The author of an event posted by `who` (see `reviewer`): the tailnet user, else the guest
 * named by `given`, the `author` of the posted body, as `{ kind: "human", name, via }`. Throws
 * a refusal (400) for a guest without a name, or with one over `MAX_NAME` characters.
 */
export function authorOf(who, given) {
  if (who) return { kind: "human", ...who };
  const name = typeof given?.name === "string" ? given.name.trim() : "";
  if (!name) throw refusal(400, "name required");
  if (name.length > MAX_NAME) throw refusal(400, `a name is at most ${MAX_NAME} characters`);
  return { kind: "human", name, via: "share" };
}

/** `value` with every Map in it as a plain object. */
function plain(value) {
  if (!(value instanceof Map)) return value;
  return Object.fromEntries([...value].map(([k, v]) => [k, plain(v)]));
}

/**
 * What the viewer reads at `/_review/stills`: `{ stills, marks, working, cursor }`. Each still
 * is its manifest entry in v2 shape, `{ name, title, source, variants }`, plus `revs`, the
 * revisions of its first variant, and `mark`, the reviewed mark `{ rev, viewed, reviewed,
 * changed, variants }` the reviewer named `by` left on it, nobody's without `by`; stills
 * without a revision are left out, as are variants without one. `marks` are the marked
 * revisions of every reviewer, `{ reviewer: { still: { key: rev } } }`, and `working` what the
 * agent is working on (see `working` of the store). `cursor` is the log's last `seq`, read
 * before the rest, so following the events from it misses none. A folder source, `scratch` as
 * the handle `folder(dir)` returns, adds `groups`, `notes`, `writable` and `about` (see
 * `sourceExtras`).
 */
export function reviewStills(scratch, by = null) {
  const { cursor } = readEvents(scratch);
  const known = revisions(scratch);
  const { marks } = reviewMarks(scratch, known);
  const mine = reviewed(scratch, by, known, marks);
  const list = [];
  for (const s of stills(scratch)) {
    const variants = s.variants.filter((v) => v.revs.length);
    if (!variants.length || !mine[s.name]) continue;
    const marked = mine[s.name].variants;
    list.push({ ...s, variants, revs: variants[0].revs, mark: { ...marked[variants[0].key], variants: marked } });
  }
  return { stills: list, marks: plain(marks), working: working(scratch), cursor, ...sourceExtras(scratch) };
}

/**
 * `reviewStills` for the menu, as the reviewer named `by`: `{ stills, error }`, an unreadable
 * store reported in `error`.
 */
function readReview(scratch, by) {
  try {
    return { stills: reviewStills(scratch, by).stills, error: null };
  } catch (e) {
    return { stills: [], error: e.message };
  }
}

/**
 * The menu's HTML: every page and variant as a link, with a "Live" link beside it to the live
 * shell on it, where a remark is marked on the page itself; then the stills of `review` (as
 * `readReview` returns them) with a link to the viewer, or, for a mockup that has none, the
 * bare `shots`.
 */
export function renderMenu({ manifest, error }, shots, review = { stills: [], error: null }) {
  const title = manifest.title || "Mockup";
  const out = [
    `<!doctype html><html><head><meta charset="utf-8">`,
    `<meta name="viewport" content="width=device-width"><title>${escapeHtml(title)}</title>`,
    `<style>${STYLE}</style></head><body><h1>${escapeHtml(title)}</h1>`,
  ];
  if (error) out.push(`<p class="err">${escapeHtml(error)}</p>`);
  const pages = Array.isArray(manifest.pages) ? manifest.pages : [];
  for (const page of pages) {
    if (!page || typeof page.path !== "string") continue;
    const label = page.title || page.path;
    const variants = Array.isArray(page.variants) && page.variants.length ? page.variants : [{ label, query: "" }];
    out.push(`<h2>${escapeHtml(label)}</h2><ul>`);
    for (const v of variants.filter(Boolean)) {
      const href = page.path + (v.query || "");
      out.push(`<li><a href="${escapeHtml(href)}">${escapeHtml(v.label || href)}</a>`);
      out.push(`<a class="live" href="${escapeHtml(livePath(href))}" title="Mark on the live page">Live</a></li>`);
    }
    out.push("</ul>");
  }
  if (!pages.length) out.push("<p>No pages listed yet; add them to manifest.json.</p>");
  if (review.error) out.push(`<p class="err">${escapeHtml(review.error)}</p>`);
  if (review.stills.length) {
    const done = review.stills.filter((s) => s.mark.reviewed).length;
    out.push(`<h2>Stills</h2><ul><li><a href="/stills">Review the stills`);
    out.push(` · ${done} / ${review.stills.length} reviewed</a></li></ul><div class="shots">`);
    for (const s of review.stills) {
      const src = escapeHtml(fileUrl(s.revs.at(-1).file));
      const state = s.mark.reviewed ? " · reviewed" : s.mark.changed ? " · changed since reviewed" : "";
      out.push(`<figure><a href="/stills#${encodeURIComponent(s.name)}">`);
      out.push(`<img src="${src}" loading="lazy" alt=""></a>`);
      out.push(`<figcaption>${escapeHtml(s.title + state)}</figcaption></figure>`);
    }
    out.push("</div>");
  } else if (shots.length) {
    out.push(`<h2>Stills</h2><div class="shots">`);
    for (const f of shots) {
      const src = `/shots/${encodeURIComponent(f)}`;
      out.push(`<figure><a href="${src}"><img src="${src}" loading="lazy" alt=""></a>`);
      out.push(`<figcaption>${escapeHtml(f)}</figcaption></figure>`);
    }
    out.push("</div>");
  }
  out.push("</body></html>");
  return out.join("");
}

/**
 * Where a request goes before Vite sees it: `{ menu: true }` for the menu, `{ viewer: true }`
 * for the stills viewer at the reserved `/stills`, `{ live: true }` for the live shell at
 * `/live/<slug>` when the page `/<slug>` exists, else the rewritten URL, or null to leave it
 * alone. `/app/<path>` becomes `/@fs<app>/<path>`, and `/<slug>` becomes `/pages/<slug>.html`
 * when that page exists. A revision's image named with `%2B` or `%40`, as `fileUrl` writes the
 * `+` and `@` of a variant key, is named with the characters themselves, which is how Vite
 * finds the file.
 */
export function route(url, app) {
  const q = url.indexOf("?");
  const pathname = q === -1 ? url : url.slice(0, q);
  const search = q === -1 ? "" : url.slice(q);
  if (pathname === "/" || pathname === "/index.html") return { menu: true };
  if (pathname === "/stills" || pathname === "/stills/") return { viewer: true };
  if (REV_IMAGE.test(pathname) && /%2B|%40/i.test(pathname)) {
    return { url: `${pathname.replace(/%2B/gi, "+").replace(/%40/gi, "@")}${search}` };
  }
  if (pathname.startsWith("/app/")) return { url: `/@fs${app}${pathname.slice(4)}${search}` };
  if (pageAt(scratchDir(app), pageOfLive(pathname))) return { live: true };
  const file = pageAt(scratchDir(app), pathname);
  return file ? { url: `/${file}${search}` } : null;
}

/**
 * The page of the scratch dir `scratch` that the path `at` (`/<slug>`, its query and hash left
 * out) is served from, as `pages/<slug>.html`, or null when no page is there.
 */
function pageAt(scratch, at) {
  const slug = SLUG.exec((at ?? "").split(/[?#]/)[0]);
  const file = slug && !path.extname(slug[1]) ? pageFile(slug[1]) : null;
  return file && existsSync(path.join(scratch, file)) ? file : null;
}

/**
 * Rewrite a page's references to the URLs Vite tracks them by. A page is served at `/<slug>`,
 * so `./checkout.tsx` in `pages/<dir>/` becomes `/pages/<dir>/checkout.tsx` when that file
 * exists in `pageDir`, else a browser would resolve it against the slug's parent; and
 * `/app/<path>` becomes `/@fs<app>/<path>`, the URL a CSS update names, so a linked stylesheet
 * is swapped in place instead of left stale.
 */
export function rewriteRefs(html, { app, pageDir, pageUrlDir }) {
  return html
    .replace(RELATIVE_REF, (all, attr, quote, file, rest) =>
      existsSync(path.join(pageDir, file)) ? `${attr}=${quote}${pageUrlDir}/${file}${rest}${quote}` : all
    )
    .replace(APP_REF, (all, attr, quote) => `${attr}=${quote}/@fs${app}/`);
}

/** Force `Cache-Control: no-store` on every response, whatever a later middleware sets. */
function noStore(res) {
  const setHeader = res.setHeader.bind(res);
  res.setHeader = (name, value) =>
    setHeader(name, String(name).toLowerCase() === "cache-control" ? "no-store" : value);
  const writeHead = res.writeHead.bind(res);
  res.writeHead = (status, ...rest) => {
    const headers = rest.find((r) => r && typeof r === "object");
    if (headers) {
      for (const k of Object.keys(headers)) if (k.toLowerCase() === "cache-control") delete headers[k];
    }
    setHeader("Cache-Control", "no-store");
    return writeHead(status, ...rest);
  };
  setHeader("Cache-Control", "no-store");
}

/** Answer with `body` as JSON. */
export function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": `${JSON_TYPE}; charset=utf-8` });
  res.end(JSON.stringify(body));
}

/** Answer 405, naming the methods the URL takes in `allow`. */
function methodNotAllowed(res, allow) {
  res.writeHead(405, { Allow: allow, "Content-Type": "text/plain; charset=utf-8" });
  res.end("Method Not Allowed");
}

/**
 * Answer a GET or HEAD with the file `file` under `headers`, which name its Content-Type: 405 for
 * any other method, 404 when the file is gone.
 */
export function sendFile(req, res, file, headers) {
  if (req.method !== "GET" && req.method !== "HEAD") return methodNotAllowed(res, "GET, HEAD");
  let size;
  try {
    size = statSync(file).size;
  } catch {
    return sendJson(res, 404, { error: "no such file" });
  }
  res.writeHead(200, { ...headers, "Content-Length": size });
  if (req.method === "HEAD") return res.end();
  return createReadStream(file).pipe(res);
}

/** Answer a GET with a file of the viewer (`{ file, type }`), read from this image. */
function sendViewerFile(req, res, { file, type }) {
  sendFile(req, res, path.join(VIEWER_DIR, file), { "Content-Type": type });
}

/** Answer a GET of `/stills` with the viewer's page. */
export function sendViewerPage(req, res) {
  sendViewerFile(req, res, VIEWER_PAGE);
}

/** Answer a GET of `/live/<slug>` with the live shell's page. */
export function sendLivePage(req, res) {
  sendViewerFile(req, res, LIVE_PAGE);
}

/** The request's body as a Buffer, or null once it passes `limit` bytes. */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size <= limit) chunks.push(chunk);
    });
    req.on("end", () => resolve(size > limit ? null : Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/**
 * The live side of the review log of `scratch`, a scratch dir or a folder source: the open `GET /_review/events` responses, each
 * with the `seq` it has been sent up to. `push()` sends every client the events above its
 * cursor, and is safe to call at any time; while a client is connected the log's size is also
 * checked every second, for a write no watcher reported, and a read that failed is tried again.
 * `open(res, since)` adds a response, until it closes; `notify(name)` sends a named event
 * without data, and `close()` ends every response. A folder source, `scratch` as the handle
 * `folder(dir)` returns, is watched as well until `close()`, connected client or not, so a
 * change is kept as its next revision when it happens, and sends `stills` (see `watchSource`).
 */
export function eventStream(scratch) {
  const folder = typeof scratch === "string" ? null : scratch;
  const file = storePaths(scratch).events;
  const clients = new Set();
  let timer = null;
  let size = -1;
  let ticks = 0;

  const fileSize = () => {
    try {
      return statSync(file).size;
    } catch {
      return 0;
    }
  };
  const push = () => {
    size = fileSize();
    if (!clients.size) return;
    let events;
    try {
      events = readEvents(scratch, Math.min(...[...clients].map((c) => c.cursor))).events;
    } catch {
      size = -1;
      return;
    }
    for (const client of clients) {
      for (const event of events) {
        if (event.seq <= client.cursor) continue;
        client.res.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
        client.cursor = event.seq;
      }
    }
  };
  const tick = () => {
    if (fileSize() !== size) push();
    ticks += 1;
    if (ticks % PING_TICKS === 0) for (const client of clients) client.res.write(": ping\n\n");
  };
  const stop = () => {
    clearInterval(timer);
    timer = null;
  };
  const notify = (name) => {
    for (const client of clients) client.res.write(`event: ${name}\ndata: {}\n\n`);
  };
  const unwatch = folder ? watchSource(folder.dir, () => notify("stills")) : null;

  return {
    push,
    notify,
    open(res, since) {
      res.writeHead(200, { "Content-Type": "text/event-stream", "X-Accel-Buffering": "no" });
      res.write("retry: 2000\n\n");
      const client = { res, cursor: since };
      clients.add(client);
      if (!timer) {
        timer = setInterval(tick, POLL_MS);
        timer.unref();
      }
      res.on("close", () => {
        clients.delete(client);
        if (!clients.size) stop();
      });
      push();
    },
    close() {
      stop();
      unwatch?.();
      for (const client of clients) client.res.end();
      clients.clear();
    },
  };
}

/** True when the request names an `Origin` other than the host it was sent to. */
function crossOrigin(req) {
  const { origin, host } = req.headers;
  if (origin === undefined) return false;
  try {
    return new URL(origin).host !== host;
  } catch {
    return true;
  }
}

/** An error to answer with the HTTP status `status`. */
function refusal(status, message) {
  return Object.assign(new Error(message), { status });
}

/**
 * The PNG a posted thread carries in `annotated`, as a Buffer. Throws a refusal when `value` is
 * not a `data:image/png;base64,` URL (400), holds more than 8 MiB (413) or is not a PNG (400).
 */
export function annotatedPng(value) {
  if (typeof value !== "string" || !value.startsWith(PNG_URL)) {
    throw refusal(400, `'annotated' must be a ${PNG_URL} URL`);
  }
  const png = Buffer.from(value.slice(PNG_URL.length), "base64");
  if (png.length > MAX_ANNOTATED_BYTES) {
    throw refusal(413, `'annotated' must be at most ${MAX_ANNOTATED_BYTES} bytes`);
  }
  if (!isPng(png)) throw refusal(400, "'annotated' must be a PNG");
  return png;
}

/**
 * The JSON object a `POST` under `/_review/` carries, `{ value, size }`, `size` its bytes.
 * Throws a refusal for a post whose `Origin` is not this host (403), one that is not JSON
 * (415), a body over `limit` bytes (413), and one that is not a JSON object, `what` naming
 * what it should be (400).
 */
async function jsonPost(req, limit, what) {
  if (crossOrigin(req)) throw refusal(403, "posting from another origin is not allowed");
  if (!(req.headers["content-type"] || "").toLowerCase().startsWith(JSON_TYPE)) {
    throw refusal(415, `the body must be ${JSON_TYPE}`);
  }
  const body = await readBody(req, limit);
  if (!body) throw refusal(413, `the body must be at most ${limit} bytes`);
  let value;
  try {
    value = JSON.parse(body.toString("utf8"));
  } catch {
    throw refusal(400, "invalid JSON");
  }
  if (!isObject(value)) throw refusal(400, `${what} must be an object`);
  return { value, size: body.length };
}

/**
 * `POST /_review/events`: append the event in the JSON body to the log and answer 201 with the
 * stored one. Only a JSON content type is taken (415), so a page of another origin cannot post
 * without a preflight; Vite approves the preflight of a localhost origin, so a post whose
 * `Origin` is not this host is refused as well (403). A body that is not a JSON object, or an
 * event the store refuses, is a 400 with the reason. The event's author is `who` sent it (see
 * `reviewer` and `authorOf`), whatever `author` the body claims: a guest's write without a name
 * is a 400, `name required`, and a guest's `resolve` or `reopen` a 403, those being the owner's
 * and the agent's. `working` and `idle` are the agent's, written by the CLI, so they are
 * refused here (403).
 *
 * A `thread` on a still may carry `annotated`, which is not part of the event: the still with
 * the mark drawn, checked before the event is stored (see `annotatedPng`) and kept under the
 * thread's id once it is. A PNG that could not be written leaves the remark stored without it.
 * The rest of the body is at most 64 KiB (413), as it is without the PNG; a thread's `target`
 * is not counted in it, since the store holds it to the target's limits, which are characters
 * and so up to three bytes each.
 */
async function postEvent(req, res, { scratch, stream, who }) {
  let event;
  let size;
  try {
    ({ value: event, size } = await jsonPost(req, MAX_UPLOAD_BYTES, "an event"));
  } catch (e) {
    return sendJson(res, e.status ?? 400, { error: e.message });
  }
  const { annotated, author: given, ...fields } = event;
  const marked = fields.target === undefined ? 0 : Buffer.byteLength(JSON.stringify(fields.target));
  const drawn = typeof annotated === "string" ? annotated.length : 0;
  if (size - drawn - Math.min(marked, MAX_TARGET_BYTES) > MAX_POST_BYTES) {
    return sendJson(res, 413, { error: `an event must be at most ${MAX_POST_BYTES} bytes` });
  }
  if (fields.type === "working" || fields.type === "idle") {
    return sendJson(res, 403, { error: `a ${fields.type} event is the agent's; it writes it with 'preview review'` });
  }
  if (!who && OWNER_ONLY.includes(fields.type)) {
    return sendJson(res, 403, { error: `a guest cannot ${fields.type} a remark` });
  }
  let author;
  let png = null;
  try {
    author = authorOf(who, given);
  } catch (e) {
    return sendJson(res, e.status, { error: e.message });
  }
  if (annotated !== undefined) {
    if (fields.type !== "thread" || typeof fields.still !== "string") {
      return sendJson(res, 400, { error: "'annotated' goes with a thread on a still" });
    }
    try {
      png = annotatedPng(annotated);
    } catch (e) {
      return sendJson(res, e.status, { error: e.message });
    }
  }
  let stored;
  try {
    stored = await appendEvent(scratch, { ...fields, author });
  } catch (e) {
    const broken = Boolean(e.code) || /still locked/.test(e.message);
    if (broken) console.error(`[mockup] review event not stored: ${e.message}`);
    return sendJson(res, broken ? 500 : 400, { error: e.message });
  }
  if (png) {
    try {
      storeAnnotated(scratch, stored.id, png);
    } catch (e) {
      console.error(`[mockup] annotated still of thread ${stored.id} not stored: ${e.message}`);
    }
  }
  stream.push();
  return sendJson(res, 201, stored);
}

/**
 * The freeze asked for in `body`, the JSON of a `POST /_review/freeze` without its `author`:
 * `{ page, viewport, vp, tags, key, scroll, box, elements, truncated }`. `path` is the page's
 * path; `viewport` a preset or `WxH[@dpr][+touch]`; `tags` optional, as a still's; `scroll`
 * `{x, y}` and `box` `{x, y, w, h}` in CSS pixels, the box from the top left of the viewport;
 * the viewport at most `FREEZE_VIEWPORT.side` CSS pixels a side at a pixel ratio of
 * `FREEZE_VIEWPORT.dpr`; `elements` the marked `{selector, text, html}`, each text and html
 * cut to the target's limits and the list to its first `TARGET_LIMITS.elements`, `truncated`
 * then true. The rest is checked as the target its thread carries (see `targetProblem` of the
 * store), so a problem is named by the target's field. Throws a 400 refusal naming the first problem.
 */
export function freezeRequest(body) {
  const fields = ["path", "viewport", "tags", "scroll", "box", "elements", "truncated"];
  const extra = Object.keys(body).find((k) => !fields.includes(k));
  if (extra) throw refusal(400, `'${extra}' is not a field of a freeze`);
  const { path: page, viewport, tags: given = [], scroll, box, elements, truncated = false } = body;
  if (!Array.isArray(elements)) throw refusal(400, "'elements' must be a list of {selector, text, html}");
  const cut = (v, most) => (typeof v === "string" ? v.slice(0, most) : v);
  const kept = elements.slice(0, TARGET_LIMITS.elements).map((e) => {
    if (!isObject(e)) return e;
    const { selector, text = "", html = "" } = e;
    return { selector, text: cut(text, TARGET_LIMITS.text), html: cut(html, TARGET_LIMITS.html) };
  });
  const target = { page, elements: kept, truncated: truncated || elements.length > kept.length, viewport, scroll };
  const problem = targetProblem({ ...target, state: "reproduced" });
  if (problem) throw refusal(400, problem);
  const vp = parseViewport(viewport);
  if (vp.width > FREEZE_VIEWPORT.side || vp.height > FREEZE_VIEWPORT.side || vp.dpr > FREEZE_VIEWPORT.dpr) {
    const { side, dpr } = FREEZE_VIEWPORT;
    throw refusal(400, `a freeze's viewport is at most ${side}x${side}@${dpr}`);
  }
  let tags;
  try {
    if (!Array.isArray(given)) throw new Error("'tags' must be a list");
    tags = parseTags(given);
    if (tags.length > MAX_TAGS) throw new Error(`a variant has at most ${MAX_TAGS} tags`);
    colorScheme(tags);
  } catch (e) {
    throw refusal(400, e.message);
  }
  const sides = isObject(box) ? [box.x, box.y, box.w, box.h] : [];
  if (sides.length !== 4 || !sides.every(Number.isFinite) || !(box.w > 0 && box.h > 0)) {
    throw refusal(400, "'box' must be {x, y, w, h} in CSS pixels, w and h above 0");
  }
  const [x, y, w, h] = sides;
  return { ...target, vp, tags, key: variantKey(vp, tags), scroll: { x: scroll.x, y: scroll.y }, box: { x, y, w, h } };
}

let recipeLoaded = null;

/**
 * The recipe the shots module `file` exports, imported again only when the file's size or
 * mtime changed, so a server that freezes often does not keep a module per freeze.
 */
async function recipeOf(file) {
  const { size, mtimeMs } = statSync(file);
  const stamp = `${file}:${size}:${mtimeMs}`;
  if (recipeLoaded?.stamp !== stamp) recipeLoaded = { stamp, recipe: await loadRecipe(file) };
  return recipeLoaded.recipe;
}

/**
 * The shots of the mockup's `shots.mjs`, by `<name> <variant key>` (see `expandRecipe`): with
 * the steps that drive the page before its still is shot and the `maxHeight` it is shot whole
 * at. Empty without the file, null when it cannot be read.
 */
async function recipeShots(scratch) {
  const file = path.join(scratch, SHOTS_FILE);
  if (!existsSync(file)) return new Map();
  try {
    return new Map(expandRecipe(await recipeOf(file)).map((shot) => [`${shot.name} ${shot.key}`, shot]));
  } catch {
    return null;
  }
}

/**
 * The still of `scratch` a freeze of `page` at the variant `key` keeps its shot on, `{ still,
 * variant, maxHeight }`, or null: the first whose source is `page`, that has that variant shot,
 * and whose variant `shots.mjs` does not shoot after steps (none when the file cannot be read),
 * `maxHeight` the one `shots.mjs` shoots it whole at, if it shoots it. One shot only at its viewport `vp` is
 * taken only when the box `marked`, in CSS pixels of the page, is inside it.
 */
async function reusableStill(scratch, { page, key, vp, marked }) {
  const recipe = await recipeShots(scratch);
  if (!recipe) return null;
  for (const still of stills(scratch)) {
    const shot = recipe.get(`${still.name} ${key}`);
    if (still.source.path !== page || shot?.steps) continue;
    const variant = still.variants.find((v) => v.key === key && v.revs.length);
    const inside = marked.x + marked.w <= vp.width && marked.y + marked.h <= vp.height;
    if (variant && (variant.viewport?.fullPage || inside)) return { still, variant, maxHeight: shot?.maxHeight };
  }
  return null;
}

/**
 * The name of the still a freeze of `page` makes when no still is kept for it: `live-<slug>`,
 * the slug its path and query lowercased, with a run of anything but letters, digits, `.` and
 * `_` as one `-`. A name another page's still has already ends with a hash of `page`.
 */
export function liveName(scratch, page) {
  const slug = page.slice(1).toLowerCase().replace(/[^a-z0-9._]+/g, "-").replace(/^[-._]+|[-._]+$/g, "");
  const name = `live-${slug}`.slice(0, MAX_NAME_LENGTH);
  const taken = stills(scratch).some((s) => s.name.toLowerCase() === name && s.source.path !== page);
  const hash = createHash("sha256").update(page).digest("hex").slice(0, 6);
  return taken ? `${name.slice(0, MAX_NAME_LENGTH - hash.length - 1)}-${hash}` : name;
}

/** The part of the rect `r` (`{x, y, w, h}`) inside an image of `size` (`{w, h}`), or null. */
function clip(r, size) {
  const x = Math.max(0, r.x);
  const y = Math.max(0, r.y);
  const right = Math.min(size.w, r.x + r.w);
  const bottom = Math.min(size.h, r.y + r.h);
  return right > x && bottom > y ? { x, y, w: right - x, h: bottom - y } : null;
}

/**
 * Where a live mark lands on a shot of `size` CSS pixels, `{ anchor, state }`. With `rects`,
 * where each marked element is on the shot (null for one not found), all on it: the region
 * around them, `reproduced`. Else the box `marked` the browser sent, in CSS pixels of the page,
 * `not-reproduced`, and no anchor when that box is not on the shot either. A mark of no
 * element is never reproduced.
 */
export function placeMark(rects, marked, size) {
  const found = rects.map((r) => r && clip(r, size));
  let region = null;
  if (found.length && found.every(Boolean)) {
    const x = Math.min(...found.map((r) => r.x));
    const y = Math.min(...found.map((r) => r.y));
    const right = Math.max(...found.map((r) => r.x + r.w));
    const bottom = Math.max(...found.map((r) => r.y + r.h));
    region = { x, y, w: right - x, h: bottom - y };
  }
  const box = region ?? clip(marked, size);
  const anchor = box && { x: box.x / size.w, y: box.y / size.h, w: box.w / size.w, h: box.h / size.h };
  return { anchor, state: region ? "reproduced" : "not-reproduced" };
}

/**
 * Freeze a live mark of the scratch dir `scratch`: shoot the page `request` names (see
 * `freezeRequest`) from scratch at its viewport and tags with `shoot` (`capture`), measuring the
 * marked elements' selectors, from the server at `base`, and keep the shot as a revision of a
 * still. That is the still of that screen when one is kept (see `reusableStill`), shot as it
 * was, whole or not, so an image equal to its latest revision adds none; else `live-<slug>`
 * (see `liveName`), shot whole, with that variant. Resolves to `{ still, variant, rev, anchor,
 * state, target }`: the revision the remark goes on, its anchor and state (see `placeMark`),
 * and the `target` its thread carries.
 */
export async function freeze(scratch, request, { shoot = capture, base }) {
  const { page, viewport, vp, tags, key, scroll, box, elements, truncated } = request;
  const marked = { x: box.x + scroll.x, y: box.y + scroll.y, w: box.w, h: box.h };
  const kept = await reusableStill(scratch, { page, key, vp, marked });
  const tmp = mkdtempSync(path.join(tmpdir(), "freeze-"));
  try {
    const shot = await shoot({
      url: new URL(page, base).href,
      out: path.join(tmp, "shot.png"),
      viewport,
      tags,
      fullPage: kept ? Boolean(kept.variant.viewport?.fullPage) : true,
      maxHeight: kept?.maxHeight,
      measure: elements.map((e) => e.selector),
    });
    const { entry, rev } = await addStill(scratch, {
      file: shot.file,
      name: kept?.still.name ?? liveName(scratch, page),
      title: kept ? undefined : `${page} (live)`,
      source: page,
      viewport,
      tags,
      fullPage: shot.fullPage,
    });
    const size = { w: shot.width / vp.dpr, h: shot.height / vp.dpr };
    const { anchor, state } = placeMark(shot.rects ?? [], marked, size);
    const target = { page, elements, ...(truncated ? { truncated } : {}), viewport, scroll, state };
    return { still: entry.name, variant: key, rev: rev.n, anchor, state, target };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

let freezing = Promise.resolve();
let waiting = 0;

/**
 * Run `fn` once every freeze before it has ended, so one Chromium shoots at a time. Throws a
 * 503 refusal when `MAX_FREEZES_WAITING` freezes are in hand already, the one shooting among them.
 */
function oneAtATime(fn) {
  if (waiting >= MAX_FREEZES_WAITING) throw refusal(503, "busy shooting other marks; try again shortly");
  waiting += 1;
  const run = freezing.then(fn).finally(() => {
    waiting -= 1;
  });
  freezing = run.catch(() => {});
  return run;
}

/**
 * `POST /_review/freeze`: freeze the live mark the JSON body asks for (see `freezeRequest` and
 * `freeze`) and answer 200 with where its remark goes. It takes what `POST /_review/events`
 * takes: JSON only (415), from this host's origin only (403), a body of at most 64 KiB besides
 * what the target's limits let its path and elements take (413), and a guest's needs a name in
 * `author` (400), since it writes a still. A bad request is a 400; a shot that failed a 500; a
 * freeze while `MAX_FREEZES_WAITING` are in hand, one shooting and the rest waiting, a 503.
 * A folder source has no pages to mark, and a path that is no page of the mockup none (404). The page is shot from this server, at
 * `127.0.0.1` on the port the request came to.
 */
async function postFreeze(req, res, { scratch, stream, who, shoot }) {
  let request;
  try {
    const { value } = await jsonPost(req, MAX_FREEZE_BYTES, "a freeze");
    const { author: given, ...fields } = value;
    authorOf(who, given);
    if (typeof scratch !== "string") throw refusal(404, "a folder has no pages to mark");
    request = freezeRequest(fields);
    if (!pageAt(scratch, request.page)) throw refusal(404, `no page of the mockup at ${request.page}`);
  } catch (e) {
    return sendJson(res, e.status ?? 400, { error: e.message });
  }
  const base = `http://127.0.0.1:${req.socket.localPort}`;
  let frozen;
  try {
    frozen = await oneAtATime(() => freeze(scratch, request, { shoot, base }));
  } catch (e) {
    if (e.status) return sendJson(res, e.status, { error: e.message });
    console.error(`[mockup] freeze of ${request.page} failed: ${e.message}`);
    return sendJson(res, 500, { error: e.message });
  }
  stream.notify("stills");
  return sendJson(res, 200, frozen);
}

/**
 * Answer a GET of `/_review/about` or `/_review/file/<path>`, `name` being what follows
 * `/_review/`: the README of the folder source `scratch` as `{ file, html }`, or one of its
 * images. 404 when the folder has none, or for a plain scratch dir.
 */
function sendSource(req, res, scratch, name) {
  if (req.method !== "GET" && req.method !== "HEAD") return methodNotAllowed(res, "GET, HEAD");
  const dir = typeof scratch === "string" ? null : scratch.dir;
  if (name === "about") {
    const page = dir && aboutPage(dir);
    return page ? sendJson(res, 200, page) : sendJson(res, 404, { error: "no README here" });
  }
  let rel = "";
  try {
    rel = decodeURIComponent(name.slice("file/".length));
  } catch {
    rel = "";
  }
  const found = dir && sourceFile(dir, rel);
  if (!found) return sendJson(res, 404, { error: "no such image" });
  return sendFile(req, res, found.file, { "Content-Type": found.type, "X-Content-Type-Options": "nosniff" });
}

/**
 * Answer a request under `/_review/`, sent by `who` (see `reviewer`); false when the URL is not
 * one, so the caller goes on. `scratch` is the scratch dir, or the handle of a folder source;
 * `shoot` is what a freeze shoots with, `capture` unless given.
 */
export async function handleReview(req, res, { scratch, stream, who, shoot = capture }) {
  if (!req.url.startsWith("/_review/")) return false;
  const { pathname, searchParams } = new URL(req.url, "http://mockup");
  const name = pathname.slice("/_review/".length);
  if (Object.hasOwn(VIEWER_ASSETS, name)) {
    sendViewerFile(req, res, VIEWER_ASSETS[name]);
  } else if ((name === "stills" || name === "threads") && req.method !== "GET") {
    methodNotAllowed(res, "GET");
  } else if (name === "stills" || name === "threads") {
    try {
      const me = who ?? { name: null, via: "share" };
      sendJson(res, 200, name === "stills" ? { ...reviewStills(scratch, me.name), me } : { threads: threads(scratch) });
    } catch (e) {
      sendJson(res, 500, { error: e.message });
    }
  } else if (name === "about" || name.startsWith("file/")) {
    sendSource(req, res, scratch, name);
  } else if (name === "events" && req.method === "GET") {
    const since = req.headers["last-event-id"] ?? searchParams.get("since") ?? "0";
    if (SINCE.test(since)) stream.open(res, Number(since));
    else sendJson(res, 400, { error: "'since' must be the seq to resume after" });
  } else if (name === "events" && req.method === "POST") {
    await postEvent(req, res, { scratch, stream, who });
  } else if (name === "events") {
    methodNotAllowed(res, "GET, POST");
  } else if (name === "freeze" && req.method === "POST") {
    await postFreeze(req, res, { scratch, stream, who, shoot });
  } else if (name === "freeze") {
    methodNotAllowed(res, "POST");
  } else {
    sendJson(res, 404, { error: "no such route" });
  }
  return true;
}

/**
 * The Vite plugin: menu at `/`, the stills viewer at `/stills` with its `/_review/` routes,
 * the live shell at `/live/<slug>`, clean page URLs, the `/app/` prefix, no-store and reloads.
 * `hosts` are the names the server accepts, which tell a guest from a tailnet user (see
 * `reviewer`).
 */
export function menuPlugin({ app, hosts = [] }) {
  const scratch = scratchDir(app);
  return {
    name: "mockup-menu",
    enforce: "pre",
    resolveId(id, importer, options) {
      if (!id.startsWith("/app/")) return null;
      return this.resolve(path.join(app, id.slice(5)), importer, { ...options, skipSelf: true });
    },
    configureServer(server) {
      const stream = eventStream(scratch);
      server.httpServer?.once("close", stream.close);
      server.middlewares.use(async (req, res, next) => {
        if (!REV_IMAGE.test(req.url.split("?")[0])) noStore(res);
        try {
          const who = reviewer(req.headers, hosts);
          if (await handleReview(req, res, { scratch, stream, who })) return undefined;
          const target = route(req.url, app);
          if (!target) return next();
          if (target.viewer) return sendViewerPage(req, res);
          if (target.live) return sendLivePage(req, res);
          if (!target.menu) {
            req.url = target.url;
            return next();
          }
          const html = renderMenu(readManifest(scratch), listShots(scratch), readReview(scratch, who?.name ?? null));
          const body = await server.transformIndexHtml("/", html, req.originalUrl);
          res.setHeader("Content-Type", "text/html; charset=utf-8");
          return res.end(body);
        } catch (e) {
          return next(e);
        }
      });
      const reload = (file) => {
        const rel = path.relative(scratch, file).split(path.sep).join("/");
        if (rel === EVENTS_FILE) stream.push();
        if (rel === MANIFEST_FILE) stream.notify("stills");
        if (rel === "manifest.json" || rel === MANIFEST_FILE || rel.startsWith("shots/")) {
          server.ws.send({ type: "full-reload", path: "*" });
        }
      };
      server.watcher.on("change", reload);
      server.watcher.on("add", reload);
      server.watcher.on("unlink", reload);
    },
    transformIndexHtml: {
      order: "pre",
      handler(html, ctx) {
        if (!ctx.path.startsWith("/pages/")) return html;
        const pageUrlDir = path.posix.dirname(ctx.path);
        return rewriteRefs(html, { app, pageDir: path.join(scratch, pageUrlDir), pageUrlDir });
      },
    },
  };
}
