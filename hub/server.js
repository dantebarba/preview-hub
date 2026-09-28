/**
 * Preview Hub backend (Bun).
 *
 * Serves the JSON discovery API and the static PWA:
 *   GET /api/previews  -> grouped/deduped preview list, a shared preview carrying
 *                         share: { host, expires } (200; [] on Docker error)
 *   POST /api/previews/stop {id} -> retract its share, then stop that preview's
 *                         compose project (200 {stopped, warning?}; 404 unknown/not a
 *                         preview; 502 Docker error)
 *   POST /api/previews/share {id, hours, confirm} -> share it on the internet
 *                         (200 {shared, host, expires} or {needsConfirm, files})
 *   POST /api/previews/unshare {id} -> retract its share (200 {unshared, warning?})
 *   POST /api/previews/share-link {id} -> its link, key included (200 {url, expires})
 *   GET /api/config    -> { pollIntervalMs, share }
 *
 * The share endpoints answer 409 when this hub has no share settings, 404 for
 * an unknown preview or share, 400 for a bad duration and 502 when the edge or
 * Docker fails, each as { error }.
 *   GET /health        -> "ok"
 *   everything else     -> a file from ./public (path-traversal safe), else 404
 *
 * All configuration comes from the environment only: HUB_PORT (default 8788),
 * POLL_INTERVAL_MS (default 10000) and DOCKER_HOST (consumed by ./docker.js).
 */

import { statSync } from "node:fs";
import { basename, extname, resolve } from "node:path";
import { listPreviews } from "./docker.js";
import { ShareError, shareEnabled, sharing } from "./share.js";

const PUBLIC_DIR = resolve(import.meta.dir, "public");

const NO_CACHE_FILES = new Set(["index.html", "sw.js", "manifest.webmanifest"]);

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

/**
 * Read a positive integer from the environment, falling back when unset or
 * not a valid positive number.
 */
function intFromEnv(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const PORT = intFromEnv("HUB_PORT", 8788);
const POLL_INTERVAL_MS = intFromEnv("POLL_INTERVAL_MS", 10000);

/**
 * Map a request path to an absolute file path inside PUBLIC_DIR, or null when
 * the path is malformed or would escape PUBLIC_DIR.
 */
function resolveStaticPath(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded === "/" || decoded === "") decoded = "/index.html";
  const full = resolve(PUBLIC_DIR, "." + decoded);
  if (full !== PUBLIC_DIR && !full.startsWith(PUBLIC_DIR + "/")) return null;
  return full;
}

function serveStatic(pathname) {
  const full = resolveStaticPath(pathname);
  if (!full) return new Response("Not Found", { status: 404 });

  let stat;
  try {
    stat = statSync(full);
  } catch {
    return new Response("Not Found", { status: 404 });
  }
  if (!stat.isFile()) return new Response("Not Found", { status: 404 });

  const headers = {
    "Content-Type": MIME_TYPES[extname(full).toLowerCase()] || "application/octet-stream",
  };
  if (NO_CACHE_FILES.has(basename(full))) headers["Cache-Control"] = "no-cache";

  return new Response(Bun.file(full), { headers });
}

async function handlePreviews() {
  try {
    return Response.json(await listPreviews());
  } catch (err) {
    console.error("[preview-hub] /api/previews failed:", err?.message ?? err);
    return Response.json([]);
  }
}

/**
 * Run one preview action from a POST with a JSON body. The body must be JSON so
 * a cross-origin page cannot send it without a CORS preflight, which this
 * server never approves. A ShareError answers with its own status and message;
 * anything else is logged and answered 502.
 */
async function handleAction(req, name, action) {
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
  }
  if (!(req.headers.get("content-type") || "").startsWith("application/json")) {
    return new Response("Unsupported Media Type", { status: 415 });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }

  try {
    return Response.json(await action(body || {}));
  } catch (err) {
    if (err instanceof ShareError) {
      if (err.status >= 500) console.error(`[preview-hub] ${name} failed:`, err.message);
      return Response.json({ error: err.message }, { status: err.status });
    }
    console.error(`[preview-hub] ${name} failed:`, err?.message ?? err);
    return Response.json({ error: "docker engine unavailable" }, { status: 502 });
  }
}

async function stopAction({ id }) {
  const result = await sharing.stop(id);
  if (result.status === "not-found") throw new ShareError("no such preview", 404);
  return result.warning ? { stopped: result.count, warning: result.warning } : { stopped: result.count };
}

const ACTIONS = {
  "/api/previews/stop": stopAction,
  "/api/previews/share": ({ id, hours, confirm }) => sharing.share(id, hours, confirm === true),
  "/api/previews/unshare": ({ id }) => sharing.unshare(id),
  "/api/previews/share-link": ({ id }) => sharing.link(id),
};

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const { pathname } = new URL(req.url);

    if (pathname === "/api/previews") return handlePreviews();
    if (Object.hasOwn(ACTIONS, pathname)) return handleAction(req, pathname, ACTIONS[pathname]);
    if (pathname === "/api/config") {
      return Response.json({ pollIntervalMs: POLL_INTERVAL_MS, share: shareEnabled });
    }
    if (pathname === "/health") {
      return new Response("ok", {
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }

    return serveStatic(pathname);
  },
});

console.log(`[preview-hub] listening on http://localhost:${server.port}`);
console.log(`[preview-hub] sharing ${shareEnabled ? "enabled" : "disabled (no share settings)"}`);
