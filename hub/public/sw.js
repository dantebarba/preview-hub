/**
 * Preview Hub service worker.
 *
 * Precaches the app shell under a versioned cache so the PWA opens offline, and
 * drops older cache versions on activate. API traffic is always network-only so
 * preview data is never stale; shell assets are served cache-first with a
 * network fallback, and navigations fall back to the cached shell when offline.
 */

const CACHE = "preview-hub-v1";

const SCOPE_PATH = new URL("./", self.location).pathname;

const SHELL_ASSETS = [
  "./",
  "index.html",
  "styles.css",
  "app.js",
  "manifest.webmanifest",
  "icons/icon.svg",
  "icons/maskable.svg",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/maskable-512.png",
  "icons/apple-touch-icon.png",
];

async function precache() {
  const cache = await caches.open(CACHE);
  await Promise.allSettled(
    SHELL_ASSETS.map(async (asset) => {
      const request = new Request(asset, { cache: "reload" });
      const response = await fetch(request);
      if (response.ok) await cache.put(asset, response);
    })
  );
}

async function dropOldCaches() {
  const keys = await caches.keys();
  await Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)));
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request, { ignoreSearch: true });
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok && response.type === "basic") cache.put(request, response.clone());
    return response;
  } catch (error) {
    if (request.mode === "navigate") {
      const fallback = await cache.match("index.html");
      if (fallback) return fallback;
    }
    throw error;
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil(precache().then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(dropOldCaches().then(() => self.clients.claim()));
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname.startsWith(`${SCOPE_PATH}api/`)) {
    event.respondWith(fetch(request));
    return;
  }

  event.respondWith(cacheFirst(request));
});
