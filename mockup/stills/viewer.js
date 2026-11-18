/**
 * The stills viewer of the /mockup runtime, served at `/stills#<name>`.
 *
 * It reads the stills and their reviewed marks from `GET /_review/stills`, follows the review
 * log over `GET /_review/events` (server-sent events) and writes the reviewed mark with
 * `POST /_review/events`. ←/→, Home/End, a swipe and the thumbnail strip step through the
 * stills, skipping the reviewed ones unless "show reviewed" is on; `v` toggles the reviewed
 * mark and `b` flips between a revision and the one before it. The hash keeps the position.
 */

import { applyEvent, counts, edge, step } from "./state.js";

const SHOW_REVIEWED_KEY = "stills.showReviewed";
const NAME_KEY = "review.name";
const SWIPE_PX = 60;

const state = {
  stills: [],
  at: -1,
  rev: null,
  compare: false,
  all: stored(SHOW_REVIEWED_KEY) === "1",
  applied: 0,
  late: [],
};
let thumbs = [];
let source = null;
let loads = 0;

/** The element with the id `id`. */
function el(id) {
  return document.getElementById(id);
}

/** The value kept under `key` in this browser, or null when there is none or no storage. */
function stored(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Keep `value` under `key` in this browser, when it has storage. */
function store(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    return;
  }
}

/** The URL of a revision's image, from its path relative to the scratch dir. */
function imageUrl(rev) {
  return `/${rev.file.split("/").map(encodeURIComponent).join("/")}`;
}

/** The still named in the hash, as an index, or -1 when it names none or is not valid encoding. */
function hashIndex() {
  let name;
  try {
    name = decodeURIComponent(location.hash.slice(1));
  } catch {
    return -1;
  }
  return state.stills.findIndex((s) => s.name === name);
}

/** Show `message` in the error line, or hide the line when it is empty. */
function report(message) {
  el("error").textContent = message || "";
  el("error").hidden = !message;
}

/** Build the thumbnail strip, one image per still showing its latest revision. */
function buildStrip() {
  const strip = el("strip");
  strip.replaceChildren();
  thumbs = state.stills.map((s, i) => {
    const t = document.createElement("img");
    t.src = imageUrl(s.revs.at(-1));
    t.alt = s.title;
    t.title = s.title;
    t.loading = "lazy";
    t.onclick = () => show(i);
    strip.appendChild(t);
    return t;
  });
}

/** Draw the current still, its revision controls, the reviewed mark, the count and the strip. */
function render() {
  const { stills, at } = state;
  const some = stills.length > 0;
  el("empty").hidden = some;
  el("stage").hidden = !some;
  for (const id of ["prev", "next", "mark", "bar"]) el(id).hidden = !some;
  if (!some) {
    el("title").textContent = "Stills";
    el("count").textContent = "";
    el("flag").hidden = true;
    return;
  }
  const s = stills[at];
  const latest = s.revs.at(-1).n;
  let index = s.revs.findIndex((r) => r.n === state.rev);
  if (index === -1) {
    index = s.revs.length - 1;
    state.rev = latest;
  }
  const before = state.compare && index > 0;
  const shown = s.revs[before ? index - 1 : index];
  const url = imageUrl(shown);
  if (el("still").getAttribute("src") !== url) el("still").src = url;
  el("still").alt = s.title;
  el("title").textContent = s.title;
  document.title = `${s.title} · stills`;
  el("flag").hidden = !s.mark.changed;
  const { reviewed, total } = counts(stills);
  el("count").textContent = `${reviewed} / ${total} reviewed`;
  el("viewed").checked = s.mark.reviewed;
  el("viewed").disabled = state.rev !== latest;
  const own = state.rev === latest;
  el("mark").title = own ? "Mark this still reviewed (v)" : `The mark is for rev ${latest}, the latest`;
  el("revs").hidden = s.revs.length < 2;
  el("compare").hidden = s.revs.length < 2;
  el("rev").replaceChildren(...s.revs.map((r) => new Option(`${r.n} of ${latest}`, r.n, false, r.n === state.rev)));
  el("compare").disabled = index === 0;
  el("compare").setAttribute("aria-pressed", String(before));
  const which = s.revs.length > 1 ? `showing rev ${shown.n}` : "";
  el("shown").textContent = before ? `${which}, before` : which;
  el("all").checked = state.all;
  el("open").href = url;
  thumbs.forEach((t, i) => {
    const mark = stills[i].mark;
    t.hidden = !state.all && mark.reviewed && i !== at;
    t.classList.toggle("on", i === at);
    t.classList.toggle("done", mark.reviewed);
    t.classList.toggle("changed", mark.changed);
  });
  thumbs[at].scrollIntoView({ block: "nearest", inline: "center" });
  if (location.hash !== `#${s.name}`) history.replaceState(null, "", `#${s.name}`);
  for (const delta of [1, -1]) new Image().src = imageUrl(stills[step(stills, at, delta, state.all)].revs.at(-1));
  if (index > 0) new Image().src = imageUrl(s.revs[index - 1]);
}

/** Go to the still at `i`, on its latest revision, scrolled to the top. */
function show(i) {
  if (i < 0 || i >= state.stills.length) return;
  state.at = i;
  state.rev = null;
  state.compare = false;
  render();
  el("stage").parentElement.scrollTo(0, 0);
}

/** Step `delta` stills from the current one. */
function move(delta) {
  if (state.stills.length) show(step(state.stills, state.at, delta, state.all));
}

/**
 * Fetch the stills and their marks and draw them, keeping the still on screen when it is still
 * there, else the one in the hash, else the first one left to review. A still shown on its
 * latest revision follows a new one; an older revision picked by hand stays. Of two loads under
 * way only the last one started is drawn, and the mark events that arrived over the stream
 * after the answer was read from the log are folded into it again.
 */
async function load() {
  const turn = ++loads;
  let data;
  try {
    const res = await fetch("/_review/stills", { cache: "no-store" });
    data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  } catch (e) {
    if (turn === loads) report(`Could not read the stills: ${e.message}`);
    return;
  }
  if (turn !== loads) return;
  report("");
  const was = state.stills[state.at];
  const current = was?.name;
  const rev = was && state.rev === was.revs.at(-1).n ? null : state.rev;
  state.stills = data.stills;
  state.late = state.late.filter((e) => e.seq > data.cursor);
  for (const e of state.late) applyEvent(state.stills, e);
  state.applied = Math.max(state.applied, data.cursor);
  buildStrip();
  let at = state.stills.findIndex((s) => s.name === current);
  if (at === -1) at = hashIndex();
  if (at === -1) at = edge(state.stills, 0, false, false);
  if (state.stills[at]?.name === current) {
    state.at = at;
    state.rev = rev;
    render();
  } else {
    state.at = -1;
    if (state.stills.length) show(at);
    else render();
  }
}

/** Follow the review log: fold each new event into the marks, and reload when the stills change. */
function follow() {
  let opened = false;
  source = new EventSource(`/_review/events?since=${state.applied}`);
  source.onmessage = (message) => {
    const event = JSON.parse(message.data);
    if (event.seq <= state.applied) return;
    state.applied = event.seq;
    if (event.type === "viewed" || event.type === "unviewed") state.late.push(event);
    if (applyEvent(state.stills, event)) render();
  };
  source.addEventListener("stills", load);
  source.onopen = () => {
    if (opened) load();
    opened = true;
  };
}

/** Write the reviewed mark of the current still's latest revision: set it, or clear it. */
async function setReviewed(on) {
  const s = state.stills[state.at];
  if (!s) return;
  const event = { type: on ? "viewed" : "unviewed", still: s.name, rev: s.revs.at(-1).n };
  const name = (stored(NAME_KEY) || "").trim();
  if (name) event.author = { kind: "human", name };
  try {
    const res = await fetch("/_review/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(event),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
    report("");
    if (source?.readyState !== EventSource.OPEN) await load();
  } catch (e) {
    report(`Could not save the reviewed mark: ${e.message}`);
    render();
  }
}

/** Flip between the chosen revision and the one before it. */
function toggleCompare() {
  if (el("compare").hidden || el("compare").disabled) return;
  state.compare = !state.compare;
  render();
}

el("prev").onclick = () => move(-1);
el("next").onclick = () => move(1);
el("viewed").onchange = (e) => setReviewed(e.target.checked);
el("compare").onclick = toggleCompare;
el("rev").onchange = (e) => {
  state.rev = Number(e.target.value);
  state.compare = false;
  render();
};
el("all").onchange = (e) => {
  state.all = e.target.checked;
  store(SHOW_REVIEWED_KEY, state.all ? "1" : "0");
  render();
};

addEventListener("keydown", (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey || /^(SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
  if (e.target.tagName === "INPUT" && e.target.type !== "checkbox") return;
  if (e.key === "ArrowRight") move(1);
  else if (e.key === "ArrowLeft") move(-1);
  else if (e.key === "Home") show(edge(state.stills, state.at, false, state.all));
  else if (e.key === "End") show(edge(state.stills, state.at, true, state.all));
  else if (e.key === "v" && !el("viewed").disabled) setReviewed(!el("viewed").checked);
  else if (e.key === "b") toggleCompare();
  else return;
  e.preventDefault();
});

let touch = null;
el("stage").parentElement.addEventListener(
  "touchstart",
  (e) => {
    touch = e.touches.length === 1 ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : null;
  },
  { passive: true }
);
el("stage").parentElement.addEventListener("touchend", (e) => {
  if (!touch) return;
  const dx = e.changedTouches[0].clientX - touch.x;
  const dy = e.changedTouches[0].clientY - touch.y;
  touch = null;
  if (Math.abs(dx) > SWIPE_PX && Math.abs(dx) > 2 * Math.abs(dy)) move(dx < 0 ? 1 : -1);
});

addEventListener("hashchange", () => {
  const i = hashIndex();
  if (i !== -1 && i !== state.at) show(i);
});

await load();
follow();
