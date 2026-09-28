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
 * A preview shared on the internet shows a "Shared" badge with its expiry and
 * public host.
 *
 * A right-click (or Delete on a focused card) or a left swipe slides the card
 * aside to reveal its actions: Stop, which retracts any share first, and, when
 * the hub has share settings, Share (a dialog picks the duration and confirms
 * credential files), or Copy link and Unshare for a shared preview. The link,
 * key included, is fetched only when Copy link is pressed. Open, busy and
 * failed states are kept by container id so they survive re-renders between
 * polls.
 */

const API_BASE = new URL("./", document.baseURI);
const CONFIG_URL = new URL("api/config", API_BASE).href;
const PREVIEWS_URL = new URL("api/previews", API_BASE).href;
const STOP_URL = new URL("api/previews/stop", API_BASE).href;
const SHARE_URL = new URL("api/previews/share", API_BASE).href;
const UNSHARE_URL = new URL("api/previews/unshare", API_BASE).href;
const LINK_URL = new URL("api/previews/share-link", API_BASE).href;
const DURATIONS = [1, 4, 24, 72];
const DEFAULT_HOURS = 4;
const TOAST_MS = 3600;
const DEFAULT_POLL_MS = 10000;
const MIN_POLL_MS = 1000;
const SVG_NS = "http://www.w3.org/2000/svg";
const ACTION_WIDTH = 84;
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
let shareOn = false;
let openId = null;
let toastTimer = null;
const busy = new Map();
const failed = new Map();

const ACTIONS = {
  share: { label: "Share", busyLabel: "Sharing…", tone: "accent" },
  copy: { label: "Copy link", busyLabel: "Copying…", tone: "accent" },
  unshare: { label: "Unshare", busyLabel: "Unsharing…", tone: "muted" },
  stop: { label: "Stop", busyLabel: "Stopping…", tone: "danger" },
};

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

/** Return the preview's share as { host, expires } while it is live, else null. */
function liveShare(value) {
  if (!value || typeof value !== "object") return null;
  const host = str(value.host);
  const expires = Number(value.expires);
  if (!host || !Number.isFinite(expires) || expires * 1000 <= Date.now()) return null;
  return { host, expires };
}

/** Format an epoch-seconds expiry as local time, with the weekday when not today. */
function untilText(expires) {
  const date = new Date(expires * 1000);
  const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (date.toDateString() === new Date().toDateString()) return time;
  return `${date.toLocaleDateString([], { weekday: "short" })} ${time}`;
}

function createCard(preview) {
  const source = preview && typeof preview === "object" ? preview : {};
  const url = safeUrl(source.url);
  const branch = str(source.branch) || "unknown";
  const worktree = str(source.worktree) || "Root Worktree";
  const desc = str(source.desc);
  const compose = str(source.composeProject);
  const share = liveShare(source.share);

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
  if (share) meta.appendChild(el("span", "chip chip--share", `Shared · until ${untilText(share.expires)}`));
  card.appendChild(meta);

  if (desc) card.appendChild(el("p", "card__desc", desc));
  if (share) card.appendChild(el("span", "card__share", share.host));
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
  const action = busy.get(id);
  const open = Boolean(action) || id === openId;
  const wasOpen = slot.hasAttribute("data-open");

  slot.toggleAttribute("data-open", open);
  slot.toggleAttribute("data-busy", Boolean(action));
  if (wasOpen && !open) settleAfterClose(slot);

  for (const button of slot.querySelectorAll(".slot__action")) {
    const key = button.dataset.action;
    button.disabled = Boolean(action);
    if (action === key) button.textContent = ACTIONS[key].busyLabel;
    else if (failed.get(id) === key) button.textContent = "Retry";
    else button.textContent = ACTIONS[key].label;
  }
}

function syncSlots() {
  for (const slot of appEl.querySelectorAll(".slot")) applySlotState(slot);
}

function setOpen(id) {
  if (openId !== null && openId !== id) failed.delete(openId);
  openId = id;
  syncSlots();
}

function toast(message) {
  let node = document.querySelector(".toast");
  if (!node) {
    node = el("div", "toast");
    node.setAttribute("role", "status");
    node.setAttribute("aria-live", "polite");
    document.body.appendChild(node);
  }
  node.textContent = message;
  node.setAttribute("data-show", "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.removeAttribute("data-show"), TOAST_MS);
}

/** POST a JSON body; resolve to the JSON answer, or throw its `error` with the HTTP status. */
async function postJson(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  let data = {};
  try {
    data = await res.json();
  } catch {}
  if (!res.ok) {
    const err = new Error(str(data && data.error) || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

/**
 * Open a modal dialog built from `body` nodes and `buttons`; resolve to the
 * value of the button pressed, or null when it is dismissed.
 */
function openDialog(title, body, buttons) {
  return new Promise((resolve) => {
    const dialog = el("dialog", "sheet");
    const form = el("form", "sheet__form");
    form.method = "dialog";
    form.appendChild(el("h2", "sheet__title", title));
    for (const node of body) form.appendChild(node);
    const row = el("div", "sheet__buttons");
    for (const button of buttons) {
      const node = el("button", `btn${button.tone ? ` btn--${button.tone}` : ""}`, button.label);
      node.value = button.value;
      row.appendChild(node);
    }
    form.appendChild(row);
    dialog.appendChild(form);
    dialog.addEventListener("close", () => {
      const pick = buttons.find((button) => button.value === dialog.returnValue);
      dialog.remove();
      resolve(pick ? pick.result : null);
    });
    document.body.appendChild(dialog);
    dialog.showModal();
  });
}

/** Ask how long to share for; resolve to the hours picked, or null. */
function askDuration(branch) {
  const picker = el("fieldset", "durations");
  picker.appendChild(el("legend", "sheet__label", "Share for"));
  for (const hours of DURATIONS) {
    const option = el("label", "durations__option");
    const input = el("input");
    input.type = "radio";
    input.name = "hours";
    input.value = String(hours);
    input.checked = hours === DEFAULT_HOURS;
    option.append(input, el("span", null, `${hours} h`));
    picker.appendChild(option);
  }
  const note = el(
    "p",
    "sheet__text",
    `${branch} will be public on the internet: anyone holding the link can open it until it expires.`
  );
  return openDialog("Share preview", [note, picker], [
    { label: "Cancel", value: "cancel", result: null },
    { label: "Share", value: "share", tone: "primary", result: "share" },
  ]).then((pick) => {
    if (!pick) return null;
    const checked = picker.querySelector("input:checked");
    return checked ? Number(checked.value) : DEFAULT_HOURS;
  });
}

/** Warn that the preview holds credential files; resolve to true to share anyway. */
function confirmCredentials(files) {
  const note = el(
    "p",
    "sheet__text",
    "This preview's containers mount credential files. A guest will be talking to a process that holds them:"
  );
  const list = el("ul", "sheet__files");
  for (const file of files) list.appendChild(el("li", null, str(file)));
  return openDialog("Credentials exposed", [note, list], [
    { label: "Cancel", value: "cancel", result: null },
    { label: "Share anyway", value: "share", tone: "danger", result: true },
  ]).then(Boolean);
}

/** Show a link selected for manual copying, when the clipboard is unavailable. */
function showLink(url) {
  const input = el("input", "sheet__link");
  input.readOnly = true;
  input.value = url;
  const note = el("p", "sheet__text", "Copy this link; it carries the key.");
  const shown = openDialog("Share link", [note, input], [
    { label: "Done", value: "done", tone: "primary", result: true },
  ]);
  input.select();
  return shown;
}

/**
 * Put text that is still being fetched on the clipboard. Must be called while
 * handling the click: a ClipboardItem holding a promise keeps the gesture
 * alive across the fetch where a later writeText would be refused.
 */
function copyText(textPromise) {
  if (window.ClipboardItem && navigator.clipboard && navigator.clipboard.write) {
    const blob = textPromise.then((text) => new Blob([text], { type: "text/plain" }));
    return navigator.clipboard.write([new ClipboardItem({ "text/plain": blob })]);
  }
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return textPromise.then((text) => navigator.clipboard.writeText(text));
  }
  return Promise.reject(new Error("clipboard unavailable"));
}

/**
 * Run one card action with its busy state: the action's button shows progress,
 * a failure keeps the actions open with Retry and a toast, and the list is
 * refreshed afterwards.
 */
async function runAction(id, key, work) {
  failed.delete(id);
  busy.set(id, key);
  syncSlots();
  try {
    await work();
    if (openId === id) openId = null;
  } catch (err) {
    failed.set(id, key);
    openId = id;
    toast(err && err.message ? err.message : "Something went wrong");
  } finally {
    busy.delete(id);
  }
  await refresh();
  syncSlots();
}

function stopPreview(id) {
  return runAction(id, "stop", async () => {
    try {
      const result = await postJson(STOP_URL, { id });
      if (result.warning) toast(result.warning);
    } catch (err) {
      if (err.status !== 404) throw err;
    }
  });
}

async function sharePreview(id, source) {
  if (!source.shareable) {
    toast("Restart this preview with a current launcher to share it");
    return;
  }
  const hours = await askDuration(str(source.branch) || "This preview");
  if (hours === null) return;
  await runAction(id, "share", async () => {
    let result = await postJson(SHARE_URL, { id, hours });
    if (result.needsConfirm) {
      if (!(await confirmCredentials(result.files || []))) return;
      result = await postJson(SHARE_URL, { id, hours, confirm: true });
    }
    toast(`Shared until ${untilText(Number(result.expires))} · Copy link to send it`);
  });
}

function unsharePreview(id) {
  return runAction(id, "unshare", async () => {
    const result = await postJson(UNSHARE_URL, { id });
    toast(result.warning || "No longer shared");
  });
}

function copyLink(id) {
  const link = postJson(LINK_URL, { id }).then((data) => str(data.url));
  const copied = copyText(link);
  copied.catch(() => {});
  return runAction(id, "copy", async () => {
    const url = await link;
    try {
      await copied;
      toast("Link copied");
    } catch {
      await showLink(url);
    }
  });
}

/** Pick the actions a card offers: share controls when this hub can share, then Stop. */
function actionsFor(source) {
  if (liveShare(source.share)) return shareOn ? ["copy", "unshare", "stop"] : ["unshare", "stop"];
  return shareOn ? ["share", "stop"] : ["stop"];
}

/**
 * Wire the reveal gestures onto a card: right-click toggles the actions,
 * Delete opens them and focuses the first, and a horizontal touch drag slides
 * the card, opening past half the actions' width. Vertical drags are left to
 * the browser so the page still scrolls, and the click that ends a swipe — or a
 * tap on an open card — is swallowed instead of following the link.
 */
function attachGestures(slot, card, id, width) {
  let drag = null;
  let suppressClick = false;

  card.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    if (!busy.has(id)) setOpen(openId === id ? null : id);
  });

  card.addEventListener("keydown", (event) => {
    if (event.key !== "Delete" || busy.has(id)) return;
    event.preventDefault();
    setOpen(id);
    slot.querySelector(".slot__action").focus();
  });

  card.addEventListener("click", (event) => {
    const swallow = suppressClick || openId === id || busy.has(id);
    const closing = !suppressClick && openId === id;
    suppressClick = false;
    if (!swallow) return;
    event.preventDefault();
    if (closing) setOpen(null);
  });

  card.addEventListener("pointerdown", (event) => {
    suppressClick = false;
    if (event.pointerType === "mouse" || busy.has(id)) return;
    drag = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      base: openId === id ? -width : 0,
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
    drag.dx = Math.min(0, Math.max(-width * 1.4, drag.base + mx));
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
    if (dx < -width / 2) setOpen(id);
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

  const keys = actionsFor(source);
  const width = keys.length * ACTION_WIDTH;
  const slot = el("div", "slot");
  slot.dataset.id = id;
  slot.style.setProperty("--action-w", `${width}px`);
  slot.style.setProperty("--action-each", `${ACTION_WIDTH}px`);

  const branch = str(source.branch) || "unknown";
  const handlers = {
    share: () => sharePreview(id, source),
    copy: () => copyLink(id),
    unshare: () => unsharePreview(id),
    stop: () => stopPreview(id),
  };
  const actions = el("div", "slot__actions");
  for (const key of keys) {
    const button = el("button", "slot__action", ACTIONS[key].label);
    button.type = "button";
    button.dataset.action = key;
    button.dataset.tone = ACTIONS[key].tone;
    button.setAttribute("aria-label", `${ACTIONS[key].label} preview ${branch}`);
    button.addEventListener("click", handlers[key]);
    actions.appendChild(button);
  }

  slot.append(actions, card);
  attachGestures(slot, card, id, width);
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
    shareOn = Boolean(cfg && cfg.share);
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
