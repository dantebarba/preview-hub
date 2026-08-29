/**
 * Preview Hub client.
 *
 * Fetches poll cadence once from the hub's api/config endpoint, then polls
 * api/previews and renders each project as a section of preview cards. The
 * endpoints are resolved relative to the page so the hub works unchanged whether
 * it is served at the tailnet root or under a subpath such as /previews. Label
 * values arrive as untrusted runtime data, so the DOM is built exclusively with
 * createElement, textContent and setAttribute — never innerHTML — and only
 * http(s) URLs are ever turned into a clickable link. Polling pauses while the
 * tab is hidden and resumes with an immediate refetch on return.
 */

const API_BASE = new URL("./", document.baseURI);
const CONFIG_URL = new URL("api/config", API_BASE).href;
const PREVIEWS_URL = new URL("api/previews", API_BASE).href;
const DEFAULT_POLL_MS = 10000;
const MIN_POLL_MS = 1000;
const SVG_NS = "http://www.w3.org/2000/svg";

const appEl = document.getElementById("app");
const statusDot = document.querySelector(".status__dot");
const statusText = document.getElementById("status-text");

let pollMs = DEFAULT_POLL_MS;
let pollTimer = null;
let tickTimer = null;
let loadingTimer = null;
let lastSignature = null;
let lastUpdated = null;
let hasData = false;
let currentState = "idle";

/** Return an absolute http(s) URL, or null when the value is unusable. */
function safeUrl(value) {
  if (typeof value !== "string" || value.trim() === "") return null;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  return parsed.href;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function str(value) {
  return typeof value === "string" ? value.trim() : "";
}

function arrowIcon() {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("class", "card__arrow");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", "M5.5 3.5H12.5V10.5 M12.5 3.5 4 12");
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "1.6");
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");
  svg.appendChild(path);
  return svg;
}

function createCard(preview) {
  const source = preview && typeof preview === "object" ? preview : {};
  const url = safeUrl(source.url);
  const branch = str(source.branch) || "unknown";
  const worktree = str(source.worktree) || "Root Worktree";
  const desc = str(source.desc);
  const compose = str(source.composeProject);

  let card;
  if (url) {
    card = el("a", "card");
    card.href = url;
    card.target = "_blank";
    card.rel = "noopener noreferrer";
    card.setAttribute("aria-label", `${branch} — ${worktree}`);
  } else {
    card = el("div", "card card--nolink");
    card.setAttribute("aria-disabled", "true");
  }

  const head = el("div", "card__head");
  head.appendChild(el("span", "card__branch", branch));
  if (url) head.appendChild(arrowIcon());
  card.appendChild(head);

  const meta = el("div", "card__meta");
  meta.appendChild(el("span", "chip", worktree));
  if (!url) meta.appendChild(el("span", "chip chip--warn", "URL unavailable"));
  card.appendChild(meta);

  if (desc) card.appendChild(el("p", "card__desc", desc));
  if (compose) card.appendChild(el("span", "card__compose", compose));

  return card;
}

function createSection(project) {
  const source = project && typeof project === "object" ? project : {};
  const name = str(source.project) || "Untitled";
  const previews = Array.isArray(source.previews) ? source.previews : [];

  const section = el("section", "project");
  const head = el("div", "project__head");
  head.appendChild(el("h2", "project__title", name));
  head.appendChild(el("span", "project__count", String(previews.length)));
  section.appendChild(head);

  const grid = el("div", "grid");
  for (const preview of previews) grid.appendChild(createCard(preview));
  section.appendChild(grid);

  return section;
}

function emptyState() {
  const wrap = el("div", "empty");
  wrap.appendChild(el("div", "empty__glyph"));
  wrap.appendChild(el("p", "empty__title", "No active previews"));
  wrap.appendChild(
    el("p", "empty__hint", "Spin up a preview and it will show up here on its own.")
  );
  return wrap;
}

function render(data) {
  const frag = document.createDocumentFragment();
  if (!Array.isArray(data) || data.length === 0) {
    frag.appendChild(emptyState());
  } else {
    for (const project of data) frag.appendChild(createSection(project));
  }
  appEl.replaceChildren(frag);
}

function signature(data) {
  try {
    return JSON.stringify(data);
  } catch {
    return null;
  }
}

function relativeTime(ts) {
  if (!ts) return "";
  const seconds = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

function updateStatusText() {
  if (currentState === "error") {
    statusText.textContent = hasData
      ? `Reconnecting · updated ${relativeTime(lastUpdated)}`
      : "Can’t reach the hub — retrying";
  } else if (currentState === "live") {
    statusText.textContent = `Live · updated ${relativeTime(lastUpdated)}`;
  } else {
    statusText.textContent = "Connecting…";
  }
}

function setStatus(state) {
  currentState = state;
  statusDot.setAttribute("data-state", state);
  updateStatusText();
}

function setLoading(on) {
  if (on) {
    clearTimeout(loadingTimer);
    loadingTimer = setTimeout(() => document.body.setAttribute("data-loading", ""), 260);
  } else {
    clearTimeout(loadingTimer);
    document.body.removeAttribute("data-loading");
  }
}

async function refresh() {
  setLoading(true);
  try {
    const res = await fetch(PREVIEWS_URL, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const sig = signature(data);
    if (sig === null || sig !== lastSignature) {
      lastSignature = sig;
      render(data);
    }
    hasData = true;
    lastUpdated = Date.now();
    setStatus("live");
  } catch {
    setStatus("error");
  } finally {
    setLoading(false);
  }
}

function startPolling() {
  stopPolling();
  pollTimer = setInterval(refresh, pollMs);
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function startTicker() {
  stopTicker();
  tickTimer = setInterval(() => {
    if (!document.hidden) updateStatusText();
  }, 1000);
}

function stopTicker() {
  if (tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
}

async function loadConfig() {
  try {
    const res = await fetch(CONFIG_URL, { cache: "no-store" });
    if (!res.ok) return;
    const cfg = await res.json();
    const value = Number(cfg && cfg.pollIntervalMs);
    if (Number.isFinite(value) && value >= MIN_POLL_MS) pollMs = value;
  } catch {}
}

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    stopPolling();
  } else {
    refresh();
    startPolling();
  }
});

async function init() {
  await loadConfig();
  startTicker();
  await refresh();
  startPolling();

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("sw.js").catch(() => {});
    });
  }
}

init();
