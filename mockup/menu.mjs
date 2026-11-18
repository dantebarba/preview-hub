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
 * this image (`stills/` next to this file), and `/_review/` for what it reads and writes:
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

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { aboutPage, sourceExtras, sourceFile, watchSource } from "./extras.mjs";
import {
  appendEvent,
  EVENTS_FILE,
  isPng,
  MANIFEST_FILE,
  MAX_AUTHOR,
  readEvents,
  reviewed,
  reviewMarks,
  revisions,
  stills,
  storeAnnotated,
  threads,
  working,
} from "./review.mjs";
import { fileUrl, MAX_ANNOTATED_BYTES, MAX_NAME, PNG_URL } from "./stills/state.js";

const SLUG = /^\/([A-Za-z0-9][\w.-]*(?:\/[A-Za-z0-9][\w.-]*)*)\/?$/;
const RELATIVE_REF = /\b(src|href)=(["'])\.\/([^"'?#]+)([^"']*)\2/g;
const APP_REF = /\b(src|href)=(["'])\/app\//g;
const SHOT = /\.(png|jpe?g|webp)$/i;
const REV_IMAGE = /^\/stills\/[^/]+\/(?:[^/]+\/)?\d+\.png$/;
const SINCE = /^\d{1,15}$/;
const JSON_TYPE = "application/json";
const MAX_POST_BYTES = 64 * 1024;
const MAX_UPLOAD_BYTES = MAX_POST_BYTES + Math.ceil(MAX_ANNOTATED_BYTES / 3) * 4;
const POLL_MS = 1000;
const PING_TICKS = 20;
const ENCODED_WORD = /=\?utf-8\?([bq])\?([^?]*)\?=/gi;
const BETWEEN_WORDS = /(\?=)\s+(?==\?utf-8\?[bq]\?)/gi;
const OWNER_ONLY = ["resolve", "reopen"];
const VIEWER_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "stills");
const VIEWER_PAGE = { file: "index.html", type: "text/html; charset=utf-8" };
const VIEWER_ASSETS = {
  "viewer.js": { file: "viewer.js", type: "text/javascript; charset=utf-8" },
  "state.js": { file: "state.js", type: "text/javascript; charset=utf-8" },
  "annotate.js": { file: "annotate.js", type: "text/javascript; charset=utf-8" },
  "swipe.js": { file: "swipe.js", type: "text/javascript; charset=utf-8" },
  "viewer.css": { file: "viewer.css", type: "text/css; charset=utf-8" },
};

const STYLE =
  "body{font-family:system-ui;background:#111;color:#eee;margin:24px;max-width:960px}" +
  "h1{font-size:20px}h2{font-size:15px;margin:22px 0 8px;color:#aaa}a{color:#7dd3fc}" +
  "ul{padding-left:0;list-style:none;margin:0}" +
  "li a{display:block;padding:12px 14px;margin:6px 0;background:#1b1b1f;border:1px solid #333;" +
  "border-radius:10px;text-decoration:none;font-size:15px}li a:hover{background:#26262c}" +
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
 * The menu's HTML: every page and variant as a link, then the stills of `review` (as
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
      out.push(`<li><a href="${escapeHtml(href)}">${escapeHtml(v.label || href)}</a></li>`);
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
 * for the stills viewer at the reserved `/stills`, else the rewritten URL, or null to leave it
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
  const slug = SLUG.exec(pathname);
  if (!slug || path.extname(slug[1])) return null;
  const file = pageFile(slug[1]);
  return existsSync(path.join(scratchDir(app), file)) ? { url: `/${file}${search}` } : null;
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
function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": `${JSON_TYPE}; charset=utf-8` });
  res.end(JSON.stringify(body));
}

/** Answer 405, naming the methods the URL takes in `allow`. */
function methodNotAllowed(res, allow) {
  res.writeHead(405, { Allow: allow, "Content-Type": "text/plain; charset=utf-8" });
  res.end("Method Not Allowed");
}

/** Answer a GET with a file of the viewer (`{ file, type }`), read from this image. */
function sendViewerFile(req, res, { file, type }) {
  if (req.method !== "GET" && req.method !== "HEAD") return methodNotAllowed(res, "GET, HEAD");
  const body = readFileSync(path.join(VIEWER_DIR, file));
  res.writeHead(200, { "Content-Type": type, "Content-Length": body.length });
  res.end(req.method === "HEAD" ? undefined : body);
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
 * The live side of the review log of `scratch`: the open `GET /_review/events` responses, each
 * with the `seq` it has been sent up to. `push()` sends every client the events above its
 * cursor, and is safe to call at any time; while a client is connected the log's size is also
 * checked every second, for a write no watcher reported, and a read that failed is tried again.
 * `open(res, since)` adds a response, until it closes; `notify(name)` sends a named event
 * without data, and `close()` ends every response. A folder source, `scratch` as the handle
 * `folder(dir)` returns, is watched as well while a client is connected, and a change to it
 * sends `stills` (see `watchSource`).
 */
export function eventStream(scratch) {
  const folder = typeof scratch === "string" ? null : scratch;
  const file = folder ? folder.paths.events : path.join(scratch, EVENTS_FILE);
  const clients = new Set();
  let timer = null;
  let unwatch = null;
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
    unwatch?.();
    unwatch = null;
  };
  const notify = (name) => {
    for (const client of clients) client.res.write(`event: ${name}\ndata: {}\n\n`);
  };

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
        if (folder) unwatch = watchSource(folder.dir, () => notify("stills"));
      }
      res.on("close", () => {
        clients.delete(client);
        if (!clients.size) stop();
      });
      push();
    },
    close() {
      stop();
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
 * The rest of the body is at most 64 KiB (413), as it is without the PNG.
 */
async function postEvent(req, res, { scratch, stream, who }) {
  if (crossOrigin(req)) return sendJson(res, 403, { error: "posting from another origin is not allowed" });
  if (!(req.headers["content-type"] || "").toLowerCase().startsWith(JSON_TYPE)) {
    return sendJson(res, 415, { error: `the body must be ${JSON_TYPE}` });
  }
  const body = await readBody(req, MAX_UPLOAD_BYTES);
  if (!body) return sendJson(res, 413, { error: `the body must be at most ${MAX_UPLOAD_BYTES} bytes` });
  let event;
  try {
    event = JSON.parse(body.toString("utf8"));
  } catch {
    return sendJson(res, 400, { error: "invalid JSON" });
  }
  if (event === null || typeof event !== "object" || Array.isArray(event)) {
    return sendJson(res, 400, { error: "an event must be an object" });
  }
  const { annotated, author: given, ...fields } = event;
  if (body.length - (typeof annotated === "string" ? annotated.length : 0) > MAX_POST_BYTES) {
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
  const body = readFileSync(found.file);
  res.writeHead(200, {
    "Content-Type": found.type,
    "Content-Length": body.length,
    "X-Content-Type-Options": "nosniff",
  });
  return res.end(req.method === "HEAD" ? undefined : body);
}

/**
 * Answer a request under `/_review/`, sent by `who` (see `reviewer`); false when the URL is not
 * one, so the caller goes on. `scratch` is the scratch dir, or the handle of a folder source.
 */
export async function handleReview(req, res, { scratch, stream, who }) {
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
  } else {
    sendJson(res, 404, { error: "no such route" });
  }
  return true;
}

/**
 * The Vite plugin: menu at `/`, the stills viewer at `/stills` with its `/_review/` routes,
 * clean page URLs, the `/app/` prefix, no-store and reloads. `hosts` are the names the server
 * accepts, which tell a guest from a tailnet user (see `reviewer`).
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
          if (target.viewer) return sendViewerFile(req, res, VIEWER_PAGE);
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
