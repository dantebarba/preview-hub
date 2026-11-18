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
 *
 * A remark's card shows its number, its title (the remark's first line), a status chip, the
 * latest message, a dot for replies not seen on this device and the reply count; resolved cards
 * sink into a collapsed group. In the desktop layout each card has Reply, which opens the reply
 * form under it, and Resolve or Reopen, and a click on its body unfolds the conversation in
 * place.
 *
 * The mobile layout is used below 600 px of width or with a coarse pointer, unless the layout
 * toggle forced one on this device. There the still fills the screen between two one-row bars,
 * fitted to the width: a pinch, a double tap or two fingers zoom and pan it, one finger pans it
 * when it does not fit, and a sideways swipe at fitted zoom changes still. The bar's other
 * controls are a sheet behind "⋯" and the strip is a grid behind the count. A card opens its
 * conversation full screen, with the marked area cropped from the still on top and the reply
 * form following the keyboard; swiped left it uncovers Resolve or Reopen, which can be undone
 * for five seconds, and swiped right Reply.
 */

import { annotate } from "./annotate.js";
import {
  ago,
  applyEvent,
  applyThread,
  chip,
  counts,
  cropOf,
  edge,
  fileUrl,
  fitted,
  latest,
  moved,
  opposite,
  pin,
  region,
  revealed,
  step,
  title,
  unread,
  viewOn,
  zoomed,
} from "./state.js";
import { swipeable } from "./swipe.js";

const SHOW_REVIEWED_KEY = "stills.showReviewed";
const LAYOUT_KEY = "stills.layout";
const SEEN_KEY = "stills.seen";
const NAME_KEY = "review.name";
const SWIPE_PX = 60;
const TAP_PX = 8;
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_PX = 30;
const DOUBLE_TAP_ZOOM = 2.5;
const WHEEL_ZOOM = 0.01;
const LEAST_ROOM_PX = 80;
const ACT_PX = 96;
const NEAR_PX = 24;
const PULL_PX = 90;
const UNDO_MS = 5000;
const MAX_ANSWER_PX = 160;
const FIT = { z: 1, x: 0, y: 0 };
const NO_REMARKS = "No remarks on this still yet. Mark an area of it to start one.";
const PHONE = matchMedia("(max-width: 760px)");
const SMALL = matchMedia("(max-width: 599.98px), (pointer: coarse)");
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
  replying: null,
  talk: null,
  sunk: false,
  swiped: null,
  more: false,
  overview: false,
};
const root = document.documentElement;
const room = document.querySelector("main");
const fingers = new Map();
const busy = new Set();
let thumbs = [];
let source = null;
let loads = 0;
let settled = 0;
let shown = null;
let drag = null;
let view = FIT;
let gesture = null;
let tapped = null;
let seen = readSeen();
let answerFor = null;
let stick = false;
let toastTimer = null;
let compact = false;
let leaving = false;
let aim = null;

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

/** True when the mobile layout is the one in use, as `applyLayout` last set it. */
function mobile() {
  return compact;
}

/** True when the mobile layout is the one to use: the one forced on this device, else by its screen. */
function wantsMobile() {
  const forced = stored(LAYOUT_KEY);
  return forced ? forced === "mobile" : SMALL.matches;
}

/** The `seq` of the last reply seen in each thread on this device, by thread id. */
function readSeen() {
  try {
    const kept = JSON.parse(stored(SEEN_KEY) || "{}");
    return kept && typeof kept === "object" && !Array.isArray(kept) ? kept : {};
  } catch {
    return {};
  }
}

/** Remember that every reply of thread `t` was seen on this device, forgetting threads that are gone. */
function markSeen(t) {
  const last = t.replies.at(-1)?.seq ?? 0;
  if (unread(t, seen) === 0) return;
  seen = Object.fromEntries(state.threads.filter((x) => Object.hasOwn(seen, x.id)).map((x) => [x.id, seen[x.id]]));
  seen[t.id] = last;
  store(SEEN_KEY, JSON.stringify(seen));
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
    t.onclick = () => {
      closeSheets();
      show(i);
    };
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
  const made = node("div", `entry ${author.kind}`);
  const who = node("div", "who");
  who.append(node("b", "", author.name), node("span", `kind ${author.kind}`, author.kind));
  who.append(new Date(at).toLocaleString([], WHEN));
  made.append(who, node("p", "text", body));
  return made;
}

/** The Reply and the Resolve or Reopen button of thread `t`, of class `className`. */
function actions(t, className) {
  const reply = node("button", `${className} reply`.trim(), "Reply");
  reply.onclick = (e) => {
    e.stopPropagation();
    answer(t.id);
  };
  const status = node("button", `${className} status`.trim(), t.status === "open" ? "Resolve" : "Reopen");
  status.disabled = busy.has(t.id);
  status.onclick = (e) => {
    e.stopPropagation();
    setStatus(t.id);
  };
  return [reply, status];
}

/**
 * The card of thread `t`, number `n`, in its slot: the number, the title and the status chip,
 * which for a remark made on an older revision is a button that goes to it; the latest message
 * with a dot when a reply is not seen yet; the reply count with Reply and Resolve or Reopen.
 * The selected card of the desktop layout shows the whole conversation instead of the latest
 * message. Behind the card are the two actions a swipe uncovers in the mobile layout.
 */
function threadCard(t, n) {
  const small = mobile();
  const on = t.id === state.thread;
  const slot = node("div", "slot");
  slot.dataset.id = t.id;
  slot.style.setProperty("--act", `${ACT_PX}px`);
  const card = node("article", `thread ${t.status}`);
  card.classList.toggle("on", on);
  card.tabIndex = 0;
  const kind = chip(t, state.stills[state.at].revs.at(-1).n);
  const older = kind === "moved";
  const tag = node(older ? "button" : "span", `chip ${kind}`, older ? `on rev ${t.rev}` : kind);
  if (older) {
    tag.onclick = (e) => {
      e.stopPropagation();
      state.rev = t.rev;
      state.compare = false;
      state.thread = t.id;
      render();
    };
  }
  const head = node("div", "head");
  head.append(node("span", "n", n), node("b", "title", title(t.body)), tag);
  const foot = node("div", "foot");
  const replies = t.replies.length;
  const count = node("span", "count", replies === 1 ? "1 reply" : `${replies} replies`);
  foot.append(count, ...actions(t, ""), node("span", "chev", "›"));
  card.append(head);
  if (on && !small) {
    const all = node("div", "entries");
    all.append(entry(t), ...t.replies.map(entry));
    all.onclick = (e) => e.stopPropagation();
    card.append(foot, all);
  } else {
    const m = latest(t);
    const last = node("div", "last");
    if (unread(t, seen)) last.append(node("span", "dot"));
    const said = node("span", "said");
    said.append(node("b", m.author.kind, m.author.name), ` · ${ago(Date.parse(m.at), Date.now())}: “${m.body}”`);
    last.append(said);
    card.append(last, foot);
  }
  card.onclick = () => {
    if (small) openTalk(t.id);
    else if (on) unselect();
    else select(t.id);
  };
  card.onkeydown = (e) => {
    if (e.key === "Enter" && e.target === card) card.click();
  };
  const acts = node("div", "acts");
  acts.append(...actions(t, "act"));
  slot.append(acts, card);
  if (small) {
    if (state.swiped?.id === t.id) slot.dataset.open = state.swiped.side;
    swipeable(slot, card, ACT_PX, (side) => {
      closeSwipe();
      state.swiped = side ? { id: t.id, side } : null;
      if (side) slot.dataset.open = side;
    });
  }
  return slot;
}

/** Slide back the card a swipe left open. */
function closeSwipe() {
  state.swiped = null;
  for (const slot of el("threads").querySelectorAll(".slot[data-open]")) delete slot.dataset.open;
}

/** The thread whose conversation is open full screen, when it is of the still on screen. */
function talking() {
  return remarks().find((t) => t.id === state.talk);
}

/**
 * Draw the marked area of thread `t` on top of its conversation, cropped from the revision it
 * was made on; nothing for a thread without a mark or whose revision is gone. The crop is
 * drawn again once its image has loaded.
 */
function drawCrop(t) {
  const rev = state.stills[state.at].revs.find((r) => r.n === t.rev);
  const crop = el("crop");
  crop.hidden = !t.anchor || !rev;
  if (crop.hidden) return;
  const image = el("crop-image");
  const url = imageUrl(rev);
  if (image.getAttribute("src") !== url) image.src = url;
  if (!image.complete || !image.naturalWidth) return;
  const frame = { w: crop.clientWidth, h: crop.clientHeight };
  const at = cropOf(t.anchor, { w: image.naturalWidth, h: image.naturalHeight }, frame);
  for (const side of ["width", "height", "left", "top"]) el("shot").style[side] = `${at[side]}px`;
  el("crop-mark").className = t.anchor.w === undefined ? "pin" : "box";
  place(el("crop-mark"), t.anchor);
}

/**
 * Draw the conversation open full screen in the mobile layout, or hide it. Opened, or already
 * at its end, it shows the newest message and its replies count as seen; scrolled up, a new
 * reply shows the "new reply" pill instead of moving it.
 */
function renderTalk() {
  const list = remarks();
  const at = list.findIndex((t) => t.id === state.talk);
  const talk = el("talk");
  if (at === -1 || !mobile()) {
    state.talk = null;
    talk.hidden = true;
    return;
  }
  const t = list[at];
  const entries = el("entries");
  const opened = talk.hidden || talk.dataset.id !== t.id;
  const low = opened || stick || entries.scrollHeight - entries.scrollTop - entries.clientHeight < NEAR_PX;
  const had = opened ? Infinity : entries.childElementCount;
  stick = false;
  talk.hidden = false;
  talk.dataset.id = t.id;
  talk.classList.toggle("resolved", t.status !== "open");
  el("talk-n").textContent = at + 1;
  el("talk-title").textContent = title(t.body);
  el("talk-status").textContent = t.status === "open" ? "Resolve" : "Reopen";
  el("talk-status").disabled = busy.has(t.id);
  entries.replaceChildren(entry(t), ...t.replies.map(entry));
  drawCrop(t);
  if (low) {
    entries.scrollTop = entries.scrollHeight;
    markSeen(t);
  }
  el("fresh").hidden = low || (el("fresh").hidden && entries.childElementCount <= had);
}

/**
 * Put the reply form where the thread being answered is: at the foot of the conversation in
 * the mobile layout, under the thread's card in the desktop one, hidden when there is none.
 * What was typed for another thread is dropped, and the form keeps the focus it had (`held`),
 * which it loses when the cards it sat among are drawn again.
 */
function placeReply(held) {
  const form = el("reply");
  const id = mobile() ? state.talk : state.replying;
  const home = mobile() ? el("talk") : el("threads").querySelector(`.slot[data-id="${id}"]`);
  form.hidden = !id || !home;
  if (form.hidden) return document.body.append(form);
  if (answerFor !== id) {
    answerFor = id;
    el("answer").value = "";
    grow();
  }
  if (form.parentElement !== home) home.append(form);
  if (held) el("answer").focus({ preventScroll: true });
}

/**
 * Draw the remarks of the still on screen: the numbered marks made on the revision shown or an
 * older one (those dimmed, with "made on rev N"), a resolved one only while it is selected;
 * the draft; the conversation open full screen; and the panel with a card per thread, the
 * resolved ones in a group that is closed until asked for or one of them is selected. The reply
 * form steps out of the cards while they are drawn again, so it is never lost with one.
 */
function renderRemarks() {
  const list = remarks();
  const small = mobile();
  const held = document.activeElement === el("answer");
  if (el("reply").parentElement !== el("talk")) document.body.append(el("reply"));
  const open = list.filter((t) => t.status === "open").length;
  const selected = list.find((t) => t.id === state.thread);
  if (selected && !small) markSeen(selected);
  renderTalk();
  const fresh = list.reduce((sum, t) => sum + unread(t, seen, "agent"), 0);
  el("remarks").textContent = list.length ? `Remarks · ${open} open` : "Remarks";
  el("badge").textContent = fresh;
  el("badge").hidden = !fresh;
  el("list").setAttribute("aria-label", fresh ? `Remarks, ${fresh} unread` : "Remarks");
  for (const id of ["remarks", "list"]) el(id).setAttribute("aria-pressed", String(state.panel));
  for (const id of ["remark", "arm"]) el(id).setAttribute("aria-pressed", String(state.armed));
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
  const cards = list.map((t, i) => [t, threadCard(t, i + 1)]);
  const done = cards.filter(([t]) => t.status !== "open");
  el("threads").replaceChildren(...cards.filter(([t]) => t.status === "open").map(([, card]) => card));
  if (!list.length) el("threads").append(node("p", "", NO_REMARKS));
  if (done.length) {
    const group = node("details", "sunk");
    group.open = state.sunk || done.some(([t]) => t.id === state.thread);
    const summary = node("summary", "", `Resolved (${done.length})`);
    summary.onclick = () => {
      state.sunk = !group.open;
    };
    group.append(summary, ...done.map(([, card]) => card));
    el("threads").append(group);
  }
  placeReply(held);
}

/**
 * The room the still has, as the box the view is kept in: the width of the stage's room, its
 * height down to the composer or the remarks sheet when one covers its foot, and the shape of
 * the image on screen.
 */
function box() {
  const rect = room.getBoundingClientRect();
  const sheets = [el("composer"), el("panel")].filter((s) => !s.hidden).map((s) => s.getBoundingClientRect().top);
  const still = el("still");
  return {
    vw: rect.width,
    vh: Math.max(LEAST_ROOM_PX, Math.min(rect.bottom, ...sheets) - rect.top),
    ratio: still.naturalWidth ? still.naturalHeight / still.naturalWidth : 0,
  };
}

/**
 * Lay the still out in its room at the view: in the mobile layout, as wide as the zoom says
 * and where the pan put it, kept inside the room; in the desktop one, as the stylesheet has it.
 */
function layoutStage() {
  const stage = el("stage");
  if (!mobile()) {
    for (const side of ["width", "left", "top"]) stage.style[side] = "";
    return;
  }
  view = fitted(view, box());
  stage.style.width = `${view.z * 100}%`;
  stage.style.left = `${view.x}px`;
  stage.style.top = `${view.y}px`;
}

/** Pan the still so the mark at `anchor` is in the part of the room no sheet covers. */
function reveal(anchor) {
  const free = box();
  view = revealed(fitted(view, free), anchor, free);
  layoutStage();
}

/** Draw the current still, its revision controls, the reviewed mark, the count, the strip and the remarks. */
function render() {
  const { stills, at } = state;
  const some = stills.length > 0;
  el("empty").hidden = some;
  el("stage").hidden = !some;
  for (const id of ["prev", "next", "mark", "bar", "place"]) el(id).hidden = !some;
  el("bar").classList.toggle("up", state.more);
  el("strip").classList.toggle("up", state.overview);
  el("shade").hidden = !state.more && !state.overview;
  el("more").setAttribute("aria-expanded", String(state.more));
  el("place").setAttribute("aria-expanded", String(state.overview));
  if (!some) {
    el("title").textContent = "Stills";
    el("count").textContent = "";
    el("flag").hidden = true;
    el("panel").hidden = true;
    el("hint").hidden = true;
    el("talk").hidden = true;
    el("reply").hidden = true;
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
  el("place").textContent = `${at + 1}/${total}`;
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
    t.hidden = !mobile() && !state.all && mark.reviewed && i !== at;
    t.classList.toggle("on", i === at);
    t.classList.toggle("done", mark.reviewed);
    t.classList.toggle("changed", mark.changed);
  });
  if (!mobile()) thumbs[at].scrollIntoView({ block: "nearest", inline: "center" });
  if (location.hash !== `#${s.name}`) history.replaceState(history.state, "", `#${s.name}`);
  for (const delta of [1, -1]) new Image().src = imageUrl(stills[step(stills, at, delta, state.all)].revs.at(-1));
  if (index > 0) new Image().src = imageUrl(s.revs[index - 1]);
  renderRemarks();
  layoutStage();
}

/**
 * Select thread `id`: open the panel on its card, unfolded in the desktop layout, and bring its
 * mark into view, on a phone clear of the sheet.
 */
function select(id) {
  state.thread = id;
  state.panel = true;
  closeSheets();
  render();
  el("threads").querySelector(`.slot[data-id="${id}"]`)?.scrollIntoView({ block: "nearest" });
  const anchor = state.threads.find((t) => t.id === id)?.anchor;
  if (mobile() && anchor) reveal(anchor);
  else el("marks").querySelector(`[data-id="${id}"]`)?.scrollIntoView({ block: PHONE.matches ? "start" : "nearest" });
}

/** Let go of the selected thread, folding its card. */
function unselect() {
  state.thread = null;
  render();
}

/**
 * Answer thread `id`: in the mobile layout its conversation opens with the keyboard up, in the
 * desktop one the reply form opens under its card, or closes when it was there.
 */
function answer(id) {
  if (mobile()) return openTalk(id, true);
  state.replying = state.replying === id ? null : id;
  state.thread = id;
  state.panel = true;
  render();
  if (state.replying) el("answer").focus();
}

/**
 * Open the conversation of thread `id` full screen, as a step of the browser's history so that
 * going back closes it; with `typing`, ready to write a reply.
 */
function openTalk(id, typing = false) {
  state.swiped = null;
  state.thread = id;
  state.talk = id;
  if (!history.state?.talk) history.pushState({ talk: true }, "");
  render();
  if (typing) el("answer").focus();
}

/**
 * Close the conversation open full screen, taking its step back out of the history; `leaving`
 * tells the `popstate` of that step to put the hash of the still on screen back.
 */
function closeTalk() {
  if (!state.talk) return;
  state.talk = null;
  el("answer").blur();
  if (history.state?.talk) {
    leaving = true;
    history.back();
  }
  render();
}

/**
 * Leave the conversation for the still, zoomed in on the mark of its thread, on the revision it
 * was made on; a revision whose image is still loading is zoomed once it has its shape.
 */
function jump() {
  const t = talking();
  if (!t?.anchor) return;
  closeTalk();
  state.panel = false;
  state.rev = t.rev;
  state.compare = false;
  render();
  const still = el("still");
  if (still.complete && still.naturalWidth) view = viewOn(t.anchor, box());
  else aim = t.anchor;
  layoutStage();
}

/** Lay the still out once its image has loaded, on the mark `jump` was waiting to show when there is one. */
function settleStill() {
  if (aim) view = viewOn(aim, box());
  aim = null;
  layoutStage();
}

/** Show `text` for five seconds with an Undo button that runs `undo`. */
function toast(text, undo) {
  const hide = () => {
    clearTimeout(toastTimer);
    el("toast").hidden = true;
  };
  hide();
  el("toast-text").textContent = text;
  el("undo").onclick = () => {
    hide();
    undo();
  };
  el("toast").hidden = false;
  toastTimer = setTimeout(hide, UNDO_MS);
}

/** Make the reply box as tall as what is written in it, up to a limit past which it scrolls. */
function grow() {
  const box = el("answer");
  box.style.height = "auto";
  box.style.height = `${Math.min(box.scrollHeight + 2, MAX_ANSWER_PX)}px`;
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

/** Go to the still at `i`, on its latest revision, scrolled to the top and at fitted zoom. */
function show(i) {
  if (i < 0 || i >= state.stills.length) return;
  state.at = i;
  state.rev = null;
  state.compare = false;
  state.thread = null;
  state.replying = null;
  state.swiped = null;
  view = FIT;
  aim = null;
  closeTalk();
  render();
  room.scrollTo(0, 0);
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

/**
 * Post what is written in the reply form to the thread it is for. The reply shows at once; the
 * desktop layout then closes the form, the mobile one keeps it and shows the reply.
 */
async function postReply() {
  const body = el("answer").value.trim();
  const thread = answerFor;
  if (el("reply").hidden || !body || el("send").disabled) return;
  el("send").disabled = true;
  try {
    const reply = await send({ type: "reply", thread, body });
    if (answerFor === thread) {
      el("answer").value = "";
      grow();
    }
    if (state.replying === thread) state.replying = null;
    stick = true;
    applyThread(state.threads, reply);
    render();
  } catch (e) {
    report(`Could not post the reply: ${e.message}`);
  } finally {
    el("send").disabled = false;
  }
}

/**
 * Resolve thread `id`, or reopen it when it is resolved; the change shows at once. In the
 * mobile layout, where a swipe gets here, it can be undone for five seconds.
 */
async function setStatus(id) {
  const thread = state.threads.find((t) => t.id === id);
  if (!thread || busy.has(id)) return;
  const type = thread.status === "open" ? "resolve" : "reopen";
  busy.add(id);
  state.swiped = null;
  render();
  try {
    applyThread(state.threads, await send({ type, thread: id }));
    if (mobile()) toast(type === "resolve" ? "Remark resolved" : "Remark reopened", () => setStatus(id));
  } catch (e) {
    report(`Could not ${type} the remark: ${e.message}`);
  } finally {
    busy.delete(id);
    render();
  }
}

/** Close the "⋯" sheet and the overview. */
function closeSheets() {
  state.more = false;
  state.overview = false;
}

/**
 * Turn "＋ Remark" on or off: while on, a finger's drag on the still draws instead of scrolling
 * or panning. In the mobile layout the sheets get out of the way of the still.
 */
function toggleArmed() {
  if (!state.stills.length) return;
  state.armed = !state.armed;
  closeSheets();
  if (state.armed && mobile()) state.panel = false;
  render();
}

/** Show or hide the remarks panel; hiding it lets go of the selected thread and of a reply being written. */
function togglePanel() {
  state.panel = !state.panel;
  closeSheets();
  if (!state.panel) {
    state.thread = null;
    state.replying = null;
    state.swiped = null;
  }
  render();
}

/**
 * Show or hide the sheet named `name`, "more" or "overview", closing the other; the overview
 * opens on the still on screen.
 */
function toggleSheet(name) {
  const up = !state[name];
  closeSheets();
  state[name] = up;
  render();
  if (state.overview) thumbs[state.at]?.scrollIntoView({ block: "center" });
}

/**
 * Use the mobile or the desktop layout, as `wantsMobile()` says, starting from a fitted still
 * with no sheet and no conversation open.
 */
function applyLayout() {
  closeTalk();
  compact = wantsMobile();
  const small = compact;
  root.classList.toggle("mobile", small);
  el("layout").textContent = small ? "desktop layout" : "phone layout";
  closeSheets();
  view = FIT;
  render();
}

/** Force the other layout on this device, or stop forcing one when that is what its screen gets anyway. */
function toggleLayout() {
  const next = mobile() ? "desktop" : "mobile";
  store(LAYOUT_KEY, (next === "mobile") === SMALL.matches ? "" : next);
  applyLayout();
}

/** Where a pointer event is on the still, normalized to it: 0..1 inside it, past that outside. */
function pointOf(e) {
  const box = el("still").getBoundingClientRect();
  return { x: (e.clientX - box.left) / box.width, y: (e.clientY - box.top) / box.height };
}

/**
 * A press on the still starts a drag: on a corner of the draft it resizes it, on the draft it
 * moves it, elsewhere it draws a new mark, which a finger or a pen does only while "＋ Remark"
 * is on, and never a second finger, which zooms. `drag.tap` holds where a new mark was pressed
 * until the pointer leaves that spot.
 */
function startDrag(e) {
  if (e.button !== 0 || fingers.size || el("post").disabled || e.target.closest("#composer, .mark")) return;
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
 * type; on a phone a mark its sheet would cover goes to the top, or in the mobile layout is
 * panned clear of it.
 */
function endDrag() {
  if (!drag) return;
  const tap = drag.tap && drag.fixed;
  drag = null;
  if (tap) setDraft(pin(tap));
  state.armed = false;
  render();
  if (!state.draft) return;
  el("body").focus({ preventScroll: PHONE.matches || mobile() });
  if (mobile()) return reveal(state.draft.anchor);
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

/**
 * Keep the phone's bottom sheets and the conversation above the on-screen keyboard, which the
 * layout does not shrink for, and the still, with a mark being drawn, in the room that leaves.
 */
function liftSheets() {
  const covered = Math.max(0, innerHeight - visualViewport.height - visualViewport.offsetTop);
  root.style.setProperty("--keyboard", `${covered}px`);
  root.style.setProperty("--top", `${visualViewport.offsetTop}px`);
  if (state.draft && mobile()) reveal(state.draft.anchor);
  else layoutStage();
}

/** Where a pointer event is in the still's room, in pixels from its top left corner. */
function local(e) {
  const rect = room.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

/** The point halfway between the first two fingers on the still, and how far apart they are. */
function span() {
  const [a, b] = [...fingers.values()];
  return { mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, wide: Math.hypot(a.x - b.x, a.y - b.y) };
}

/**
 * A finger lands on the still in the mobile layout. A second one starts a pinch, taking over
 * from a mark being drawn; the first one, when it draws nothing, starts a press that may turn
 * into a pan, a swipe or a tap.
 */
function startTouch(e) {
  if (!mobile() || e.pointerType === "mouse" || e.target.closest("#composer")) return;
  fingers.set(e.pointerId, local(e));
  if (fingers.size === 2) {
    drag = null;
    drawDraft();
    gesture = { kind: "pinch", view, ...span() };
  } else {
    gesture = fingers.size === 1 && !drag ? { kind: "press", at: local(e), view } : null;
  }
}

/**
 * A finger moves: two zoom and pan the still together. One, once it leaves the spot it pressed,
 * swipes when the still is at fitted zoom, the move is sideways and no mark is being made, and
 * else pans the still.
 */
function moveTouch(e) {
  if (!fingers.has(e.pointerId)) return;
  const at = local(e);
  fingers.set(e.pointerId, at);
  if (!gesture) return;
  if (gesture.kind === "pinch") {
    if (fingers.size < 2) return;
    const { mid, wide } = span();
    view = zoomed(gesture.view, gesture.mid, mid, gesture.wide ? wide / gesture.wide : 1, box());
    return layoutStage();
  }
  const dx = at.x - gesture.at.x;
  const dy = at.y - gesture.at.y;
  if (gesture.kind === "press") {
    if (Math.hypot(dx, dy) < TAP_PX) return;
    const free = view.z === 1 && !state.armed && !state.draft;
    gesture.kind = free && Math.abs(dx) > Math.abs(dy) ? "swipe" : "pan";
  }
  if (gesture.kind !== "pan") return;
  view = zoomed(gesture.view, gesture.at, at, 1, box());
  layoutStage();
}

/**
 * A finger lifts. After a pinch the one left goes on panning. A swipe far enough changes still,
 * and a second tap soon after the first, at the same spot and not on a mark, zooms in there, or
 * back out to fitted.
 */
function endTouch(e) {
  if (!fingers.delete(e.pointerId)) return;
  const was = gesture;
  gesture = null;
  if (!was) return;
  if (was.kind === "pinch") {
    if (fingers.size === 1) gesture = { kind: "pan", at: [...fingers.values()][0], view };
    return;
  }
  if (e.type === "pointercancel") return;
  const at = local(e);
  const dx = at.x - was.at.x;
  const dy = at.y - was.at.y;
  if (was.kind === "swipe" && Math.abs(dx) > SWIPE_PX && Math.abs(dx) > 2 * Math.abs(dy)) move(dx < 0 ? 1 : -1);
  if (was.kind !== "press") return;
  const near = tapped && Math.hypot(at.x - tapped.at.x, at.y - tapped.at.y) < DOUBLE_TAP_PX;
  const again = near && e.timeStamp - tapped.time < DOUBLE_TAP_MS;
  tapped = again || e.target.closest(".mark, #draft") ? null : { at, time: e.timeStamp };
  if (!again) return;
  view = zoomed(view, at, at, view.z > 1 ? 1 / view.z : DOUBLE_TAP_ZOOM, box());
  layoutStage();
}

/**
 * In the mobile layout a finger moving on the still, not on the composer, is the viewer's
 * alone: the browser neither scrolls or zooms the page with it nor takes it for a fling, which
 * would swallow the next tap.
 */
function holdPage(e) {
  if (mobile() && e.cancelable && !e.target.closest("#composer")) e.preventDefault();
}

/**
 * In the mobile layout a wheel on the still, not on the composer, pans it, and with Ctrl, as a
 * trackpad's pinch sends it, zooms it.
 */
function wheel(e) {
  if (!mobile() || e.target.closest("#composer")) return;
  e.preventDefault();
  const at = local(e);
  const to = e.ctrlKey ? at : { x: at.x - e.deltaX, y: at.y - e.deltaY };
  view = zoomed(view, at, to, e.ctrlKey ? Math.exp(-e.deltaY * WHEEL_ZOOM) : 1, box());
  layoutStage();
}

/** Flip between the chosen revision and the one before it. */
function toggleCompare() {
  if (el("compare").hidden || el("compare").disabled) return;
  state.compare = !state.compare;
  render();
}

for (const id of ["prev", "back"]) el(id).onclick = () => move(-1);
for (const id of ["next", "forth"]) el(id).onclick = () => move(1);
el("viewed").onchange = (e) => setReviewed(e.target.checked);
el("compare").onclick = toggleCompare;
for (const id of ["remark", "arm"]) el(id).onclick = toggleArmed;
for (const id of ["remarks", "list", "close"]) el(id).onclick = togglePanel;
el("cancel").onclick = cancelDraft;
el("more").onclick = () => toggleSheet("more");
el("place").onclick = () => toggleSheet("overview");
el("shade").onclick = () => {
  closeSheets();
  render();
};
el("layout").onclick = toggleLayout;
el("talk-back").onclick = closeTalk;
el("talk-status").onclick = () => setStatus(state.talk);
el("crop").onclick = jump;
el("crop-image").onload = () => {
  const t = talking();
  if (t) drawCrop(t);
};
el("fresh").onclick = () => {
  stick = true;
  render();
};
el("entries").onscroll = () => {
  const entries = el("entries");
  const t = talking();
  if (el("fresh").hidden || !t || entries.scrollHeight - entries.scrollTop - entries.clientHeight >= NEAR_PX) return;
  stick = true;
  render();
};
el("answer").oninput = grow;
el("send").onpointerdown = (e) => e.preventDefault();
el("threads").addEventListener("pointerdown", (e) => {
  if (state.swiped && e.target.closest(".slot")?.dataset.id !== state.swiped.id) closeSwipe();
});
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
room.addEventListener("pointerdown", startTouch);
room.addEventListener("pointermove", moveTouch);
room.addEventListener("pointerup", endTouch);
room.addEventListener("pointercancel", endTouch);
room.addEventListener("wheel", wheel, { passive: false });
room.addEventListener("touchmove", holdPage, { passive: false });
el("still").addEventListener("load", settleStill);
addEventListener("resize", layoutStage);
SMALL.addEventListener("change", applyLayout);
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
  if (e.key === "Escape" && state.talk) return closeTalk();
  if (e.key === "Escape" && (state.more || state.overview)) return el("shade").click();
  if (e.key === "Escape" && state.replying) return answer(state.replying);
  if (e.key === "Escape" && state.panel) return togglePanel();
  if (state.talk) return;
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

/**
 * Make one finger's swipe on `target` act: `free()` says at its start whether it may, and
 * `done(dx, dy)` hears how far it went when the finger lifts.
 */
function onSwipe(target, free, done) {
  let from = null;
  target.addEventListener(
    "touchstart",
    (e) => {
      from = e.touches.length === 1 && free(e) ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : null;
    },
    { passive: true }
  );
  target.addEventListener("touchend", (e) => {
    if (!from) return;
    const dx = e.changedTouches[0].clientX - from.x;
    const dy = e.changedTouches[0].clientY - from.y;
    from = null;
    done(dx, dy);
  });
}

onSwipe(
  room,
  () => !mobile() && !state.armed && !state.draft,
  (dx, dy) => {
    if (Math.abs(dx) > SWIPE_PX && Math.abs(dx) > 2 * Math.abs(dy)) move(dx < 0 ? 1 : -1);
  }
);
onSwipe(
  el("talk"),
  (e) => !e.target.closest("#reply") && (!e.target.closest("#entries") || el("entries").scrollTop <= 0),
  (dx, dy) => {
    if (dy > PULL_PX && dy > 2 * Math.abs(dx)) closeTalk();
  }
);

addEventListener("popstate", () => {
  if (!state.talk && !leaving) return;
  leaving = false;
  state.talk = null;
  render();
});

addEventListener("hashchange", () => {
  const i = hashIndex();
  if (i !== -1 && i !== state.at) show(i);
});

applyLayout();
await load();
follow();
