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
 *
 * Each card can stop its preview: a right-click (or Delete on a focused card)
 * or a left swipe slides the card aside to reveal a Stop button, and pressing
 * it asks the hub to stop that preview's containers. Open, stopping and failed
 * states are kept by container id so they survive re-renders between polls.
 */

const API_BASE = new URL("./", document.baseURI);
const CONFIG_URL = new URL("api/config", API_BASE).href;
const PREVIEWS_URL = new URL("api/previews", API_BASE).href;
const STOP_URL = new URL("api/previews/stop", API_BASE).href;
const DEFAULT_POLL_MS = 10000;
const MIN_POLL_MS = 1000;
const SVG_NS = "http://www.w3.org/2000/svg";
const ACTION_WIDTH = 96;
const SWIPE_SLOP = 8;

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
let openId = null;
const stoppingIds = new Set();
const failedIds = new Set();

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

function openSlot() {
  if (openId === null) return null;
  return [...appEl.querySelectorAll(".slot")].find((slot) => slot.dataset.id === openId) || null;
}

function settleAfterClose(slot) {
  const card = slot.querySelector(".card");
  slot.setAttribute("data-closing", "");
  const done = (event) => {
    if (event.propertyName !== "translate") return;
    slot.removeAttribute("data-closing");
    card.removeEventListener("transitionend", done);
  };
  card.addEventListener("transitionend", done);
}

function applySlotState(slot) {
  const id = slot.dataset.id;
  const stopping = stoppingIds.has(id);
  const open = stopping || id === openId;
  const wasOpen = slot.hasAttribute("data-open");

  slot.toggleAttribute("data-open", open);
  slot.toggleAttribute("data-stopping", stopping);
  if (wasOpen && !open) settleAfterClose(slot);

  const button = slot.querySelector(".slot__stop");
  button.disabled = stopping;
  button.textContent = stopping ? "Stopping…" : failedIds.has(id) ? "Retry" : "Stop";
}

function syncSlots() {
  for (const slot of appEl.querySelectorAll(".slot")) applySlotState(slot);
}

function setOpen(id) {
  if (openId !== null && openId !== id) failedIds.delete(openId);
  openId = id;
  syncSlots();
}

async function stopPreview(id) {
  failedIds.delete(id);
  stoppingIds.add(id);
  syncSlots();
  try {
    const res = await fetch(STOP_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    if (!res.ok && res.status !== 404) throw new Error(`HTTP ${res.status}`);
    if (openId === id) openId = null;
  } catch {
    failedIds.add(id);
    openId = id;
  } finally {
    stoppingIds.delete(id);
  }
  await refresh();
  syncSlots();
}

/**
 * Wire the reveal gestures onto a card: right-click toggles the Stop action,
 * Delete opens it and focuses the button, and a horizontal touch drag slides
 * the card, opening past half the action width. Vertical drags are left to the
 * browser so the page still scrolls, and the click that ends a swipe — or a tap
 * on an open card — is swallowed instead of following the link.
 */
function attachGestures(slot, card, id) {
  let drag = null;
  let suppressClick = false;

  card.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    if (!stoppingIds.has(id)) setOpen(openId === id ? null : id);
  });

  card.addEventListener("keydown", (event) => {
    if (event.key !== "Delete" || stoppingIds.has(id)) return;
    event.preventDefault();
    setOpen(id);
    slot.querySelector(".slot__stop").focus();
  });

  card.addEventListener("click", (event) => {
    const swallow = suppressClick || openId === id || stoppingIds.has(id);
    const closing = !suppressClick && openId === id;
    suppressClick = false;
    if (!swallow) return;
    event.preventDefault();
    if (closing) setOpen(null);
  });

  card.addEventListener("pointerdown", (event) => {
    suppressClick = false;
    if (event.pointerType === "mouse" || stoppingIds.has(id)) return;
    drag = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      base: openId === id ? -ACTION_WIDTH : 0,
      dx: 0,
      swiping: false,
    };
  });

  card.addEventListener("pointermove", (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const mx = event.clientX - drag.x;
    const my = event.clientY - drag.y;
    if (!drag.swiping) {
      if (Math.abs(mx) < SWIPE_SLOP && Math.abs(my) < SWIPE_SLOP) return;
      if (Math.abs(my) >= Math.abs(mx)) {
        drag = null;
        return;
      }
      drag.swiping = true;
      card.setPointerCapture(event.pointerId);
      slot.setAttribute("data-dragging", "");
    }
    drag.dx = Math.min(0, Math.max(-ACTION_WIDTH * 1.4, drag.base + mx));
    slot.style.setProperty("--dx", `${drag.dx}px`);
  });

  const endDrag = (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const { swiping, dx } = drag;
    drag = null;
    if (!swiping) return;
    slot.removeAttribute("data-dragging");
    slot.style.removeProperty("--dx");
    if (event.type === "pointercancel") return;
    suppressClick = true;
    if (dx < -ACTION_WIDTH / 2) setOpen(id);
    else if (openId === id) setOpen(null);
  };
  card.addEventListener("pointerup", endDrag);
  card.addEventListener("pointercancel", endDrag);
}

function createSlot(preview) {
  const card = createCard(preview);
  const source = preview && typeof preview === "object" ? preview : {};
  const id = str(source.id);
  if (!id) return card;

  const slot = el("div", "slot");
  slot.dataset.id = id;
  slot.style.setProperty("--action-w", `${ACTION_WIDTH}px`);

  const stop = el("button", "slot__stop");
  stop.type = "button";
  stop.setAttribute("aria-label", `Stop preview ${str(source.branch) || "unknown"}`);
  stop.addEventListener("click", () => stopPreview(id));

  slot.append(stop, card);
  attachGestures(slot, card, id);
  applySlotState(slot);
  return slot;
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
  for (const preview of previews) grid.appendChild(createSlot(preview));
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

document.addEventListener("pointerdown", (event) => {
  const slot = openSlot();
  if (slot && !slot.contains(event.target)) setOpen(null);
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  const slot = openSlot();
  if (!slot) return;
  const hadFocus = slot.contains(document.activeElement);
  setOpen(null);
  if (hadFocus) slot.querySelector(".card").focus();
});

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
