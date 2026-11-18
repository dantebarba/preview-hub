/**
 * The stills viewer of the /mockup runtime, served at `/stills#<name>`.
 *
 * It reads the stills and their reviewed marks from `GET /_review/stills`, follows the review
 * log over `GET /_review/events` (server-sent events) and writes the reviewed mark with
 * `POST /_review/events`. ←/→, Home/End, a swipe and the thumbnail strip step through the
 * stills, skipping the reviewed ones unless "show reviewed" is on; `v` toggles the reviewed
 * mark and `b` flips between a revision and the one before it. The hash keeps the position.
 *
 * A remark is a thread on an area of the revision on screen. Dragging on the still draws a box
 * and a tap drops a pin: with a mouse at any time, with a finger or a pen once "＋ Remark" (`c`)
 * is on, since a finger's drag otherwise scrolls. The mark is a draft until posted: it can be
 * dragged, and a box resized by its corners, while the comment is written in the composer,
 * next to the mark or, on a phone, in a sheet at the bottom. Posting sends the `thread` event
 * with the annotated still. The threads of the still are numbered marks on it and cards in the
 * remarks panel, where the selected one is answered, resolved and reopened; what the other
 * side writes arrives over the event stream.
 */

import { annotate } from "./annotate.js";
import { applyEvent, applyThread, counts, edge, fileUrl, moved, opposite, pin, region, step } from "./state.js";

const SHOW_REVIEWED_KEY = "stills.showReviewed";
const NAME_KEY = "review.name";
const SWIPE_PX = 60;
const TAP_PX = 8;
const NO_REMARKS = "No remarks on this still yet. Mark an area of it to start one.";
const PHONE = matchMedia("(max-width: 760px)");
const WHEN = { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" };

const state = {
  stills: [],
  at: -1,
  rev: null,
  compare: false,
  all: stored(SHOW_REVIEWED_KEY) === "1",
  applied: 0,
  late: [],
  threads: [],
  thread: null,
  panel: false,
  armed: false,
  draft: null,
  held: false,
};
let thumbs = [];
let source = null;
let loads = 0;
let settled = 0;
let shown = null;
let drag = null;

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

/** The URL of a revision's image. */
function imageUrl(rev) {
  return fileUrl(rev.file);
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

/** A new `tag` element of class `className` holding `text`. */
function node(tag, className, text = "") {
  const made = document.createElement(tag);
  made.className = className;
  made.textContent = text;
  return made;
}

/** Put `target` on the still where `anchor` is: at a pin's point, or over a region. */
function place(target, anchor) {
  target.style.left = `${anchor.x * 100}%`;
  target.style.top = `${anchor.y * 100}%`;
  target.style.width = anchor.w === undefined ? "" : `${anchor.w * 100}%`;
  target.style.height = anchor.h === undefined ? "" : `${anchor.h * 100}%`;
}

/** The threads of the still on screen, in the order they were opened: a thread's number is its place. */
function remarks() {
  const name = state.stills[state.at]?.name;
  return state.threads.filter((t) => t.still === name);
}

/** Draw the draft mark and its composer, hidden while there is none; the composer waits for a drag to end. */
function drawDraft() {
  const draft = state.draft;
  el("draft").hidden = !draft;
  el("composer").hidden = !draft || Boolean(drag);
  if (!draft) return;
  const box = draft.anchor.w !== undefined;
  el("draft").className = box ? "box" : "pin";
  place(el("draft"), draft.anchor);
  el("composer").style.setProperty("--x", `${draft.anchor.x * 100}%`);
  el("composer").style.setProperty("--y", `${(draft.anchor.y + (draft.anchor.h ?? 0)) * 100}%`);
  el("where").textContent = `${box ? "box" : "pin"} on rev ${draft.rev}`;
}

/**
 * One entry of a thread card: who wrote it, of which kind (human or agent) and when, then the
 * text as written.
 */
function entry({ author, at, body }) {
  const made = node("div", "entry");
  const who = node("div", "who");
  who.append(node("b", "", author.name), node("span", `kind ${author.kind}`, author.kind));
  who.append(new Date(at).toLocaleString([], WHEN));
  made.append(who, node("p", "text", body));
  return made;
}

/**
 * The card of thread `t`, number `n`: its remark and replies, and the revision it was made on
 * when that is not the one on screen, as a button that goes to it.
 */
function threadCard(t, n) {
  const card = node("article", `thread ${t.status}`);
  card.classList.toggle("on", t.id === state.thread);
  card.dataset.id = t.id;
  card.onclick = () => select(t.id);
  const head = node("div", "head");
  head.append(node("span", "n", n), t.status === "open" ? "open" : "resolved");
  if (t.rev !== null && t.rev !== shown.n) {
    const rev = node("button", "rev", `made on rev ${t.rev}`);
    rev.onclick = () => {
      state.rev = t.rev;
      state.compare = false;
    };
    head.append(rev);
  }
  card.append(head, entry(t), ...t.replies.map(entry));
  return card;
}

/**
 * Draw the remarks of the still on screen: the numbered marks made on the revision shown or an
 * older one (those dimmed, with "made on rev N"), a resolved one only while it is selected;
 * the draft; and the panel with every thread and the form that answers the selected one.
 */
function renderRemarks() {
  const list = remarks();
  const open = list.filter((t) => t.status === "open").length;
  const selected = list.find((t) => t.id === state.thread);
  el("remarks").textContent = list.length ? `Remarks · ${open} open` : "Remarks";
  el("remarks").setAttribute("aria-pressed", String(state.panel));
  el("remark").setAttribute("aria-pressed", String(state.armed));
  el("hint").hidden = !state.armed;
  el("stage").classList.toggle("armed", state.armed);
  el("marks").replaceChildren(
    ...list.flatMap((t, i) => {
      const on = t.id === state.thread;
      if (!t.anchor || t.rev > shown.n || (t.status !== "open" && !on)) return [];
      const mark = node("button", `mark ${t.anchor.w === undefined ? "pin" : "box"}`);
      mark.classList.toggle("on", on);
      mark.classList.toggle("dim", t.rev !== shown.n);
      mark.classList.toggle("done", t.status !== "open");
      if (t.rev !== shown.n) mark.dataset.note = `made on rev ${t.rev}`;
      mark.dataset.id = t.id;
      mark.setAttribute("aria-label", `Remark ${i + 1}: ${t.body}`);
      mark.append(node("span", "", i + 1));
      mark.onclick = () => select(t.id);
      place(mark, t.anchor);
      return [mark];
    })
  );
  drawDraft();
  el("panel").hidden = !state.panel;
  el("panel-title").textContent = list.length ? `Remarks · ${open} open of ${list.length}` : "Remarks";
  el("threads").replaceChildren(...list.map((t, i) => threadCard(t, i + 1)));
  if (!list.length) el("threads").append(node("p", "", NO_REMARKS));
  el("reply").hidden = !selected;
  if (selected) el("status").textContent = selected.status === "open" ? "Resolve" : "Reopen";
}

/** Draw the current still, its revision controls, the reviewed mark, the count, the strip and the remarks. */
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
    el("panel").hidden = true;
    el("hint").hidden = true;
    state.draft = null;
    return;
  }
  const s = stills[at];
  const latest = s.revs.at(-1).n;
  if (state.held && !state.draft) {
    state.held = false;
    state.rev = latest;
  }
  let index = s.revs.findIndex((r) => r.n === state.rev);
  if (index === -1) {
    index = s.revs.length - 1;
    state.rev = latest;
  }
  const before = state.compare && index > 0;
  shown = s.revs[before ? index - 1 : index];
  if (state.draft && (state.draft.still !== s.name || state.draft.rev !== shown.n)) dropDraft(false);
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
  renderRemarks();
}

/**
 * Open thread `id` in the panel and bring its card and its mark into view: on a phone the mark
 * goes to the top, clear of the sheet.
 */
function select(id) {
  if (id !== state.thread) el("answer").value = "";
  state.thread = id;
  state.panel = true;
  render();
  el("threads").querySelector(`[data-id="${id}"]`)?.scrollIntoView({ block: "nearest" });
  el("marks").querySelector(`[data-id="${id}"]`)?.scrollIntoView({ block: PHONE.matches ? "start" : "nearest" });
}

/**
 * Forget the draft mark, what was written for it and the revision held for it. With `follow`,
 * a still held on a revision for the draft goes on to its latest one; without it, as when the
 * reviewer picked another revision or still by hand, the choice on screen stays.
 */
function dropDraft(follow = true) {
  if (follow && state.held) state.rev = null;
  state.draft = null;
  state.held = false;
  el("body").value = "";
}

/** Drop the draft mark and leave "＋ Remark". */
function cancelDraft() {
  dropDraft();
  state.armed = false;
  render();
}

/** Go to the still at `i`, on its latest revision, scrolled to the top. */
function show(i) {
  if (i < 0 || i >= state.stills.length) return;
  state.at = i;
  state.rev = null;
  state.compare = false;
  state.thread = null;
  render();
  el("stage").parentElement.scrollTo(0, 0);
}

/** Step `delta` stills from the current one. */
function move(delta) {
  if (state.stills.length) show(step(state.stills, state.at, delta, state.all));
}

/** The JSON `url` answers; throws with the server's reason when it is not a 2xx. */
async function getJson(url) {
  const res = await fetch(url, { cache: "no-store" });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

/** Fold one log event into the marks and the threads. True when either changed. */
function apply(event) {
  const marked = applyEvent(state.stills, event);
  return applyThread(state.threads, event) || marked;
}

/**
 * Fetch the stills with their marks, then the threads, and draw them, keeping the still on
 * screen when it is still there, else the one in the hash, else the first one left to review.
 * A still shown on its latest revision follows a new one; an older revision picked by hand
 * stays, and the one a remark is being drawn on is held until the draft is gone. Of two loads
 * under way only the last one started is drawn, and the events that arrived over the stream
 * after the stills were read from the log are folded into the answer again.
 */
async function load() {
  const turn = ++loads;
  try {
    await refresh(turn);
  } finally {
    settled = Math.max(settled, turn);
    if (settled === loads) state.late = [];
  }
}

/** Load number `turn` of `load`: read the stills and the threads, and draw them unless a later load began. */
async function refresh(turn) {
  let data;
  let threads;
  try {
    data = await getJson("/_review/stills");
    ({ threads } = await getJson("/_review/threads"));
  } catch (e) {
    if (turn === loads) report(`Could not read the stills: ${e.message}`);
    return;
  }
  if (turn !== loads) return;
  report("");
  const was = state.stills[state.at];
  const current = was?.name;
  const latest = was && state.rev === was.revs.at(-1).n;
  state.held = Boolean(latest && state.draft) || state.held;
  const rev = latest && !state.draft ? null : state.rev;
  state.stills = data.stills;
  state.threads = threads;
  state.late = state.late.filter((e) => e.seq > data.cursor);
  for (const e of state.late) apply(e);
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

/** Follow the review log: fold each new event into the marks and the threads, and reload when the stills change. */
function follow() {
  let opened = false;
  source = new EventSource(`/_review/events?since=${state.applied}`);
  source.onmessage = (message) => {
    const event = JSON.parse(message.data);
    if (event.seq <= state.applied) return;
    state.applied = event.seq;
    if (settled < loads) state.late.push(event);
    if (apply(event)) render();
  };
  source.addEventListener("stills", load);
  source.onopen = () => {
    if (opened) load();
    opened = true;
  };
}

/**
 * Post `event` to the log, under the name this browser keeps when it has one. Returns the
 * stored event, which the stream then delivers; with the stream down, everything is read again.
 * Throws with the server's reason.
 */
async function send(event) {
  const name = (stored(NAME_KEY) || "").trim();
  const res = await fetch("/_review/events", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(name ? { ...event, author: { kind: "human", name } } : event),
  });
  const answer = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(answer.error || `HTTP ${res.status}`);
  report("");
  if (source?.readyState !== EventSource.OPEN) await load();
  return answer;
}

/** Write the reviewed mark of the current still's latest revision: set it, or clear it. */
async function setReviewed(on) {
  const s = state.stills[state.at];
  if (!s) return;
  try {
    await send({ type: on ? "viewed" : "unviewed", still: s.name, rev: s.revs.at(-1).n });
  } catch (e) {
    report(`Could not save the reviewed mark: ${e.message}`);
    render();
  }
}

/**
 * Post the draft as a thread: its still, revision, mark and comment in one event, with the
 * annotated still when it could be drawn, and a notice when it could not. The new thread is
 * then the selected one. The mark stays as it is while it is being posted.
 */
async function postRemark() {
  const draft = state.draft;
  const body = el("body").value.trim();
  if (!draft || !body || el("post").disabled) return;
  el("post").disabled = true;
  try {
    const annotated = await annotate(imageUrl(shown), draft.anchor).catch(() => null);
    const event = { type: "thread", still: draft.still, rev: draft.rev, anchor: draft.anchor, body };
    const thread = await send(annotated ? { ...event, annotated } : event);
    applyThread(state.threads, thread);
    if (state.draft === draft) dropDraft();
    select(thread.id);
    if (!annotated) report("The remark is posted, without its annotated still: it could not be drawn.");
  } catch (e) {
    report(`Could not post the remark: ${e.message}`);
  } finally {
    el("post").disabled = false;
  }
}

/** Post what is written in the reply form to the selected thread. */
async function postReply() {
  const body = el("answer").value.trim();
  const thread = state.thread;
  if (!thread || !body || el("send").disabled) return;
  el("send").disabled = true;
  try {
    await send({ type: "reply", thread, body });
    if (state.thread === thread) el("answer").value = "";
  } catch (e) {
    report(`Could not post the reply: ${e.message}`);
  } finally {
    el("send").disabled = false;
  }
}

/** Resolve the selected thread, or reopen it when it is resolved. */
async function toggleStatus() {
  const thread = state.threads.find((t) => t.id === state.thread);
  if (!thread || el("status").disabled) return;
  const type = thread.status === "open" ? "resolve" : "reopen";
  el("status").disabled = true;
  try {
    await send({ type, thread: thread.id });
  } catch (e) {
    report(`Could not ${type} the remark: ${e.message}`);
  } finally {
    el("status").disabled = false;
  }
}

/** Turn "＋ Remark" on or off: while on, a finger's drag on the still draws instead of scrolling. */
function toggleArmed() {
  if (!state.stills.length) return;
  state.armed = !state.armed;
  render();
}

/** Show or hide the remarks panel; hiding it lets go of the selected thread. */
function togglePanel() {
  state.panel = !state.panel;
  if (!state.panel) state.thread = null;
  render();
}

/** Where a pointer event is on the still, normalized to it: 0..1 inside it, past that outside. */
function pointOf(e) {
  const box = el("still").getBoundingClientRect();
  return { x: (e.clientX - box.left) / box.width, y: (e.clientY - box.top) / box.height };
}

/**
 * A press on the still starts a drag: on a corner of the draft it resizes it, on the draft it
 * moves it, elsewhere it draws a new mark, which a finger or a pen does only while "＋ Remark"
 * is on. `drag.tap` holds where a new mark was pressed until the pointer leaves that spot.
 */
function startDrag(e) {
  if (e.button !== 0 || el("post").disabled || e.target.closest("#composer, .mark")) return;
  const at = pointOf(e);
  const corner = e.target.dataset.corner;
  if (corner) drag = { fixed: opposite(state.draft.anchor, corner) };
  else if (e.target.closest("#draft")) drag = { from: state.draft.anchor, at };
  else if (e.pointerType === "mouse" || state.armed) drag = { fixed: at, tap: { x: e.clientX, y: e.clientY } };
  else return;
  el("stage").setPointerCapture(e.pointerId);
  e.preventDefault();
}

/** Follow the pointer of a drag: the draft moves, or stretches from its fixed corner to the pointer. */
function moveDrag(e) {
  if (!drag) return;
  if (drag.tap && Math.hypot(e.clientX - drag.tap.x, e.clientY - drag.tap.y) < TAP_PX) return;
  drag.tap = null;
  const at = pointOf(e);
  setDraft(drag.from ? moved(drag.from, at.x - drag.at.x, at.y - drag.at.y) : region(drag.fixed, at));
}

/**
 * End a drag: a press that never left its spot is a pin there. The composer opens, ready to
 * type; on a phone a mark its sheet would cover goes to the top.
 */
function endDrag() {
  if (!drag) return;
  const tap = drag.tap && drag.fixed;
  drag = null;
  if (tap) setDraft(pin(tap));
  state.armed = false;
  render();
  if (!state.draft) return;
  el("body").focus({ preventScroll: PHONE.matches });
  const covered = el("draft").getBoundingClientRect().bottom > el("composer").getBoundingClientRect().top;
  if (PHONE.matches && covered) el("draft").scrollIntoView({ block: "start" });
}

/** Make `anchor` the draft's mark, on the revision on screen. */
function setDraft(anchor) {
  state.draft = { still: state.stills[state.at].name, rev: shown.n, anchor };
  drawDraft();
}

/** Ctrl+Enter or ⌘+Enter in a form's text posts it. */
function submitOnEnter(e) {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) e.currentTarget.requestSubmit();
}

/** Keep the phone's bottom sheets above the on-screen keyboard, which the layout does not shrink for. */
function liftSheets() {
  const covered = Math.max(0, innerHeight - visualViewport.height - visualViewport.offsetTop);
  document.documentElement.style.setProperty("--keyboard", `${covered}px`);
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
el("remark").onclick = toggleArmed;
el("remarks").onclick = togglePanel;
el("close").onclick = togglePanel;
el("cancel").onclick = cancelDraft;
el("status").onclick = toggleStatus;
el("composer").onsubmit = (e) => {
  e.preventDefault();
  postRemark();
};
el("reply").onsubmit = (e) => {
  e.preventDefault();
  postReply();
};
el("composer").onkeydown = submitOnEnter;
el("reply").onkeydown = submitOnEnter;
el("stage").addEventListener("pointerdown", startDrag);
el("stage").addEventListener("pointermove", moveDrag);
el("stage").addEventListener("pointerup", endDrag);
el("stage").addEventListener("pointercancel", () => {
  drag = null;
  drawDraft();
});
window.visualViewport?.addEventListener("resize", liftSheets);
window.visualViewport?.addEventListener("scroll", liftSheets);
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
  if (e.key === "Escape" && (state.draft || state.armed)) return cancelDraft();
  if (e.key === "Escape" && state.panel) return togglePanel();
  if (e.ctrlKey || e.metaKey || e.altKey || /^(SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
  if (e.target.tagName === "INPUT" && e.target.type !== "checkbox") return;
  if (e.key === "ArrowRight") move(1);
  else if (e.key === "ArrowLeft") move(-1);
  else if (e.key === "Home") show(edge(state.stills, state.at, false, state.all));
  else if (e.key === "End") show(edge(state.stills, state.at, true, state.all));
  else if (e.key === "v" && !el("viewed").disabled) setReviewed(!el("viewed").checked);
  else if (e.key === "b") toggleCompare();
  else if (e.key === "c") toggleArmed();
  else return;
  e.preventDefault();
});

let touch = null;
el("stage").parentElement.addEventListener(
  "touchstart",
  (e) => {
    const free = e.touches.length === 1 && !state.armed && !state.draft;
    touch = free ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : null;
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
