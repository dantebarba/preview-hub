/**
 * The menu plugin of the /mockup runtime, plus the manifest helpers it is built on.
 *
 * A mockup lives in `<frontend>/.mockup/`, mounted at `<app>/.mockup`:
 *
 *   manifest.json        { title, pages: [{ title, path, variants: [{ label, query }] }] }
 *   pages/<slug>.html    one page per screen, served at /<slug>
 *   shots/<name>.png     stills, listed on the menu
 *
 * The plugin owns the URL space in front of Vite: `/` is the menu, rendered per request from
 * the manifest and the `shots/` listing; `/<slug>` serves `pages/<slug>.html`; `/app/<path>`
 * is the project's own file at `<app>/<path>`. Every response is `Cache-Control: no-store`, and
 * an edit to the manifest or a still reloads the open tabs, as Vite does for a page.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const SLUG = /^\/([A-Za-z0-9][\w.-]*(?:\/[A-Za-z0-9][\w.-]*)*)\/?$/;
const RELATIVE_REF = /\b(src|href)=(["'])\.\/([^"'?#]+)([^"']*)\2/g;
const APP_REF = /\b(src|href)=(["'])\/app\//g;
const SHOT = /\.(png|jpe?g|webp)$/i;

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

/** The menu's HTML: every page and variant as a link, then the stills. */
export function renderMenu({ manifest, error }, shots) {
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
  if (shots.length) {
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
 * Where a request goes before Vite sees it: `{ menu: true }` for the menu, else the rewritten
 * URL, or null to leave it alone. `/app/<path>` becomes `/@fs<app>/<path>`, and `/<slug>`
 * becomes `/pages/<slug>.html` when that page exists.
 */
export function route(url, app) {
  const q = url.indexOf("?");
  const pathname = q === -1 ? url : url.slice(0, q);
  const search = q === -1 ? "" : url.slice(q);
  if (pathname === "/" || pathname === "/index.html") return { menu: true };
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

/** The Vite plugin: menu at `/`, clean page URLs, the `/app/` prefix, no-store and reloads. */
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
      server.middlewares.use(async (req, res, next) => {
        noStore(res);
        const target = route(req.url, app);
        if (!target) return next();
        if (!target.menu) {
          req.url = target.url;
          return next();
        }
        try {
          const html = renderMenu(readManifest(scratch), listShots(scratch));
          const body = await server.transformIndexHtml("/", html, req.originalUrl);
          res.setHeader("Content-Type", "text/html; charset=utf-8");
          res.end(body);
        } catch (e) {
          next(e);
        }
      });
      const reload = (file) => {
        const rel = path.relative(scratch, file);
        if (rel === "manifest.json" || rel.startsWith(`shots${path.sep}`)) {
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
