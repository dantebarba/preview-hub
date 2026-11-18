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
 *   GET  /_review/stills               { stills: [{ name, title, source, revs, mark }], cursor }
 *   GET  /_review/threads              { threads }
 *   GET  /_review/events?since=<seq>   server-sent events: the log's events above `since`, then
 *                                      each new one as it lands, and `stills` when the stills change
 *   POST /_review/events               append one event (a JSON body), answered with the stored one
 *
 * Every response is `Cache-Control: no-store` but a still's revision, which never changes. An
 * edit to the manifest or a still reloads the open tabs, as Vite does for a page.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appendEvent, readEvents, reviewed, stills, threads } from "./review.mjs";

const SLUG = /^\/([A-Za-z0-9][\w.-]*(?:\/[A-Za-z0-9][\w.-]*)*)\/?$/;
const RELATIVE_REF = /\b(src|href)=(["'])\.\/([^"'?#]+)([^"']*)\2/g;
const APP_REF = /\b(src|href)=(["'])\/app\//g;
const SHOT = /\.(png|jpe?g|webp)$/i;
const REV_IMAGE = /^\/stills\/[^/]+\/\d+\.png$/;
const SINCE = /^\d{1,15}$/;
const JSON_TYPE = "application/json";
const MAX_POST_BYTES = 64 * 1024;
const POLL_MS = 1000;
const PING_TICKS = 20;
const DEFAULT_AUTHOR = { kind: "human", name: "reviewer" };
const VIEWER_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "stills");
const VIEWER_PAGE = { file: "index.html", type: "text/html; charset=utf-8" };
const VIEWER_ASSETS = {
  "viewer.js": { file: "viewer.js", type: "text/javascript; charset=utf-8" },
  "state.js": { file: "state.js", type: "text/javascript; charset=utf-8" },
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

/** The URL of a file of the scratch dir, from its path relative to it. */
function fileUrl(rel) {
  return `/${String(rel).split("/").map(encodeURIComponent).join("/")}`;
}

/**
 * What the viewer reads at `/_review/stills`: `{ stills, cursor }`. Each still is its manifest
 * entry, `{ name, title, source, revs }`, plus `mark`, its reviewed mark `{ rev, viewed,
 * reviewed, changed }`; entries without a name or a revision are left out. `cursor` is the
 * log's last `seq`, read before the marks, so following the events from it misses none.
 */
export function reviewStills(scratch) {
  const { cursor } = readEvents(scratch);
  const marks = reviewed(scratch);
  const list = [];
  for (const s of stills(scratch)) {
    if (!s || typeof s.name !== "string" || !Array.isArray(s.revs) || !marks[s.name]) continue;
    const revs = s.revs.filter((r) => r && Number.isInteger(r.n) && typeof r.file === "string");
    if (!revs.length) continue;
    const title = typeof s.title === "string" && s.title ? s.title : s.name;
    list.push({ name: s.name, title, source: s.source ?? null, revs, mark: marks[s.name] });
  }
  return { stills: list, cursor };
}

/** `reviewStills` for the menu: `{ stills, error }`, an unreadable store reported in `error`. */
function readReview(scratch) {
  try {
    return { stills: reviewStills(scratch).stills, error: null };
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
 * when that page exists.
 */
export function route(url, app) {
  const q = url.indexOf("?");
  const pathname = q === -1 ? url : url.slice(0, q);
  const search = q === -1 ? "" : url.slice(q);
  if (pathname === "/" || pathname === "/index.html") return { menu: true };
  if (pathname === "/stills" || pathname === "/stills/") return { viewer: true };
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
 * checked every second, for a write no watcher reported. `notify(name)` sends a named event
 * without data, and `close()` ends every response.
 */
export function eventStream(scratch) {
  const file = path.join(scratch, "review", "events.jsonl");
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

  return {
    push,
    notify(name) {
      for (const client of clients) client.res.write(`event: ${name}\ndata: {}\n\n`);
    },
    open(req, res, since) {
      res.writeHead(200, { "Content-Type": "text/event-stream", "X-Accel-Buffering": "no" });
      res.write("retry: 2000\n\n");
      const client = { res, cursor: since };
      clients.add(client);
      if (!timer) {
        timer = setInterval(tick, POLL_MS);
        timer.unref();
      }
      req.on("close", () => {
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

/**
 * `POST /_review/events`: append the event in the JSON body to the log and answer 201 with the
 * stored one. Only a JSON content type is taken (415), so a page of another origin cannot post
 * without a preflight; Vite approves the preflight of a localhost origin, so a post whose
 * `Origin` is not this host is refused as well (403). A body that is not a JSON object, or an
 * event the store refuses, is a 400 with the reason. An event without an `author` is the
 * reviewer's.
 */
async function postEvent(req, res, { scratch, stream }) {
  if (crossOrigin(req)) return sendJson(res, 403, { error: "posting from another origin is not allowed" });
  if (!(req.headers["content-type"] || "").toLowerCase().startsWith(JSON_TYPE)) {
    return sendJson(res, 415, { error: `the body must be ${JSON_TYPE}` });
  }
  const body = await readBody(req, MAX_POST_BYTES);
  if (!body) return sendJson(res, 413, { error: `the body must be at most ${MAX_POST_BYTES} bytes` });
  let event;
  try {
    event = JSON.parse(body.toString("utf8"));
  } catch {
    return sendJson(res, 400, { error: "invalid JSON" });
  }
  if (event === null || typeof event !== "object" || Array.isArray(event)) {
    return sendJson(res, 400, { error: "an event must be an object" });
  }
  let stored;
  try {
    stored = await appendEvent(scratch, { author: DEFAULT_AUTHOR, ...event });
  } catch (e) {
    const broken = Boolean(e.code) || /still locked/.test(e.message);
    if (broken) console.error(`[mockup] review event not stored: ${e.message}`);
    return sendJson(res, broken ? 500 : 400, { error: e.message });
  }
  stream.push();
  return sendJson(res, 201, stored);
}

/** Answer a request under `/_review/`; false when the URL is not one, so the caller goes on. */
async function handleReview(req, res, { scratch, stream }) {
  const { pathname, searchParams } = new URL(req.url, "http://mockup");
  if (!pathname.startsWith("/_review/")) return false;
  const name = pathname.slice("/_review/".length);
  if (Object.hasOwn(VIEWER_ASSETS, name)) {
    sendViewerFile(req, res, VIEWER_ASSETS[name]);
  } else if ((name === "stills" || name === "threads") && req.method !== "GET") {
    methodNotAllowed(res, "GET");
  } else if (name === "stills" || name === "threads") {
    try {
      sendJson(res, 200, name === "stills" ? reviewStills(scratch) : { threads: threads(scratch) });
    } catch (e) {
      sendJson(res, 500, { error: e.message });
    }
  } else if (name === "events" && req.method === "GET") {
    const since = req.headers["last-event-id"] ?? searchParams.get("since") ?? "0";
    if (SINCE.test(since)) stream.open(req, res, Number(since));
    else sendJson(res, 400, { error: "'since' must be the seq to resume after" });
  } else if (name === "events" && req.method === "POST") {
    await postEvent(req, res, { scratch, stream });
  } else if (name === "events") {
    methodNotAllowed(res, "GET, POST");
  } else {
    sendJson(res, 404, { error: "no such route" });
  }
  return true;
}

/**
 * The Vite plugin: menu at `/`, the stills viewer at `/stills` with its `/_review/` routes,
 * clean page URLs, the `/app/` prefix, no-store and reloads.
 */
export function menuPlugin({ app }) {
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
          if (await handleReview(req, res, { scratch, stream })) return undefined;
          const target = route(req.url, app);
          if (!target) return next();
          if (target.viewer) return sendViewerFile(req, res, VIEWER_PAGE);
          if (!target.menu) {
            req.url = target.url;
            return next();
          }
          const html = renderMenu(readManifest(scratch), listShots(scratch), readReview(scratch));
          const body = await server.transformIndexHtml("/", html, req.originalUrl);
          res.setHeader("Content-Type", "text/html; charset=utf-8");
          return res.end(body);
        } catch (e) {
          return next(e);
        }
      });
      const reload = (file) => {
        const rel = path.relative(scratch, file).split(path.sep).join("/");
        if (rel === "review/events.jsonl") stream.push();
        if (rel === "stills/manifest.json") stream.notify("stills");
        if (rel === "manifest.json" || rel === "stills/manifest.json" || rel.startsWith("shots/")) {
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
