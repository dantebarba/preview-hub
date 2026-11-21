/**
 * The stills viewer of the /mockup runtime, served at `/stills#<name>`.
 *
 * It reads the stills and their reviewed marks from `GET /_review/stills`, follows the review
 * log over `GET /_review/events` (server-sent events) and writes the reviewed mark with
 * `POST /_review/events`. ←/→, Home/End, a swipe and the thumbnail strip step through the
 * stills, skipping the reviewed ones unless "show reviewed" is on; `v` toggles the reviewed
 * mark and `b` flips between a revision and the one before it. The hash keeps the position,
 * and `#thread=<id>` opens a remark.
 *
 * A still has variants, a viewport with tags. A viewport is of a device class, Mobile, Tablet or
 * Desktop: a switcher of the classes and a row of tags show when the stills have more than one
 * of either, and the size of the variant on screen is a muted label next to them, or a size
 * picker when the still has several of that class and tags. The pick is kept across stills by
 * class and tags, and by size where the next still has it; a still without that class and tags
 * shows its first of the class, else its first, with a note. The hash, `#<name>@<key>`, names
 * the variant on screen. Revisions, remarks and the reviewed mark are the shown variant's, and
 * the count is of the marks of whoever is looking on the stills that have the picked class and
 * tags; the other reviewers' progress has a line.
 * The desktop layout shows a still no wider than its viewport, so one shot at 3x is not three
 * times the size.
 *
 * Who is looking is the server's to say: a tailnet user has a name, a guest is asked for one,
 * by the name sheet, on the first write, which then goes on by itself, or is dropped with its
 * draft kept when the sheet is cancelled. A guest's name is kept in this browser, "as <name>"
 * next to Post and Send changes it, and a guest gets no Resolve or Reopen.
 *
 * What the agent is working on shows as dots: on the card and at the end of the conversation of
 * that remark, whose mark pulses, or in the top bar for a still or for everything.
 *
 * A remark is a thread on an area of the revision on screen. Dragging on the still draws a box
 * and a tap drops a pin: with a mouse at any time, with a finger or a pen once "＋ Remark" (`c`)
 * is on, since a finger's drag otherwise scrolls. The mark is a draft until posted: it can be
 * dragged, and a box resized by its corners, while the comment is written in the composer,
 * next to the mark or, on a phone, in a sheet at the bottom. Posting sends the `thread` event
 * with the annotated still. The threads of the still are numbered marks on it and cards in the
 * remarks panel; what the other side writes arrives over the event stream.
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
 *
 * A remark made on the live page (`live.js`) is posted there, and the runtime shoots the page
 * for it. Its card names its page, a link back to the live shell, its elements and, when the
 * shot is of the page loaded again, "not reproduced". `/stills#thread=<id>` opens a thread: its
 * still, on the revision it was made on, with the conversation unfolded. A thread that is not
 * there yet, as one whose shot is still being taken, is opened when the stream brings it.
 *
 * A folder of images as the source may add to that, each only when it is there:
 *
 *   - groups: a heading before each group in the strip and in the grid, the group's name by the
 *     title and a group picker, in the bar and so in the "⋯" sheet; the stills come in group
 *     order, so stepping runs through the groups;
 *   - About, in the top bar or the "⋯" sheet: the folder's README, read from
 *     `GET /_review/about` as HTML the runtime sanitized, where an image that is a still goes to
 *     it;
 *   - notes, what an optional file of the folder got wrong, as one line that can be dismissed
 *     and comes back only when the notes change;
 *   - a folder that cannot be written: Remark, Reply, Resolve and Reviewed are disabled and a
 *     line says "read-only folder: remarks off";
 *   - live changes: the stream's `stills` event reads everything again, so a rewritten image
 *     shows as its next revision, a new one appears and a removed one goes. An image of a
 *     folder is rewritten in place, so its URL carries when it was.
 */

import { annotate } from "./annotate.js";
import {
  ago,
  answerOf,
  applyEvent,
  applyThread,
  applyWorking,
  chip,
  choices,
  choose,
  chosen,
  classLabel,
  classOf,
  counts,
  cropOf,
  edge,
  elementsLabel,
  fileUrl,
  fitted,
  keyOf,
  lastMessage,
  linkedKey,
  livePath,
  moved,
  notesLine,
  opposite,
  pickOf,
  pin,
  place,
  progress,
  READ_ONLY,
  region,
  revealed,
  reviewerOf,
  sameChoice,
  sectionAt,
  sections,
  sectionStart,
  sizeLabel,
  sizesOf,
  SMALL_SCREEN,
  step,
  store,
  stored,
  tagsLabel,
  tagsOf,
  TAP_PX,
  title,
  unread,
  viewOn,
  viewportOf,
  workingAt,
  workingKey,
  zoomed,
} from "./state.js";
import { swipeable } from "./swipe.js";
import { asking, askName as askForName, closeWho, keptName } from "./who.js";

const SHOW_REVIEWED_KEY = "stills.showReviewed";
const LAYOUT_KEY = "stills.layout";
const SEEN_KEY = "stills.seen";
const THREAD_HASH = /^#thread=([\w-]{1,64})$/;
const SWIPE_PX = 60;
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
const REMARK_TITLE = "Mark an area of the still and comment on it (c)";
const PHONE = matchMedia("(max-width: 760px)");
const SMALL = matchMedia(SMALL_SCREEN);
const WHEN = { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" };

const MAX_TIMER_MS = 2 ** 31 - 1;

const state = {
  stills: [],
  marks: {},
  me: { name: null, via: "share" },
  working: new Map(),
  pick: null,
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
  groups: [],
  notes: [],
  folder: false,
  readonly: false,
  about: null,
  reading: false,
};
const root = document.documentElement;
const room = document.querySelector("main");
const fingers = new Map();
const busy = new Set();
let thumbs = [];
let heads = [];
let parts = [];
let dismissed = "";
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
let pinned = true;
let tall = 0;
let toastTimer = null;
let mobile = false;
let leaving = false;
let aim = null;
let awaited = null;
let workTimer = null;
let guestName = keptName();

/** The element with the id `id`. */
function el(id) {
  return document.getElementById(id);
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

/** True when whoever is looking is a guest: someone the tailnet did not name. */
function guest() {
  return state.me.via !== "tailnet";
}

/** The name whoever is looking writes under: the tailnet's, or the one a guest gave, empty until then. */
function me() {
  return guest() ? guestName : state.me.name;
}

/** The reviewer whose marks are those of whoever is looking (see `reviewerOf`), empty until a guest gives a name. */
function markedAs() {
  return me() ? reviewerOf({ name: me(), via: state.me.via }) : "";
}

/** Give every still the variant the pick lands on, with its revisions and the mark of whoever is looking. */
function derive() {
  choose(state.stills, state.pick, state.marks, markedAs());
}

/** What the agent is working on now. */
function workingNow() {
  return workingAt(state.working, Date.now());
}

/** The agent's working state on thread `id`, when it has one. */
function busyOn(id) {
  return workingNow().find((w) => w.thread === id);
}

/** The dots of the working state `w`: who is working, and on what when the agent said. */
function dots(w) {
  const made = node("span", "working");
  const three = node("span", "dots");
  three.append(node("i", ""), node("i", ""), node("i", ""));
  made.append(three, node("span", "what", `${w.author.name} is working…${w.note ? ` ${w.note}` : ""}`));
  return made;
}

/** The dots of the working state `w` as a list to spread into a parent, empty without one. */
function dotsOf(w) {
  return w ? [dots(w)] : [];
}

/**
 * The URL of a revision's image. The current image of a folder is rewritten in place, so its
 * URL also says when it was, and a changed one is fetched again.
 */
function imageUrl(rev) {
  const url = fileUrl(rev.file);
  return state.folder ? `${url}?t=${Date.parse(rev.at)}` : url;
}

/** The still and the variant key the hash names, `#<name>[@<key>]`, each null when it names none. */
function hashParts() {
  let text;
  try {
    text = decodeURIComponent(location.hash.slice(1));
  } catch {
    return { name: null, key: null };
  }
  const at = text.indexOf("@");
  return at === -1 ? { name: text, key: null } : { name: text.slice(0, at), key: text.slice(at + 1) || null };
}

/** The still named in the hash, as an index, or -1 when it names none. */
function hashIndex() {
  const { name } = hashParts();
  return state.stills.findIndex((s) => s.name === name);
}

/** Show `message` in the error line, or hide the line when it is empty. */
function report(message) {
  el("error").textContent = message || "";
  el("error").hidden = !message;
}

/**
 * Build the thumbnail strip, one image per still showing its latest revision, with a heading
 * before the first still of each group when the source has groups.
 */
function buildStrip() {
  const strip = el("strip");
  strip.replaceChildren();
  heads = parts.map((part) => ({ part, head: node("span", "group", part.title) }));
  thumbs = state.stills.map((s, i) => {
    const first = heads.find((h) => h.part.at === i);
    if (first) strip.appendChild(first.head);
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

/**
 * The threads of the variant on screen, in the order they were opened: a thread's number is its
 * place. A thread that names no variant is on its still's first.
 */
function remarks() {
  const s = state.stills[state.at];
  if (!s) return [];
  return state.threads.filter((t) => t.still === s.name && (t.variant ?? s.variants[0].key) === s.variant.key);
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
 * One entry of a thread card: who wrote it, as a guest or else of which kind (human or agent),
 * and when, then the text as written.
 */
function entry({ author, at, body }) {
  const made = node("div", `entry ${author.kind}`);
  const who = node("div", "who");
  const kind = author.via === "share" ? "guest" : author.kind;
  who.append(node("b", "", author.name), node("span", `kind ${kind}`, kind));
  who.append(new Date(at).toLocaleString([], WHEN));
  made.append(who, node("p", "text", body));
  return made;
}

/** What the button that resolves thread `t`, or reopens it, says. */
function statusLabel(t) {
  return t.status === "open" ? "Resolve" : "Reopen";
}

/** True when the image element `image` has its picture. */
function loaded(image) {
  return image.complete && image.naturalWidth > 0;
}

/** True when the conversation open full screen is scrolled to its end, or nearly. */
function atEnd() {
  const entries = el("entries");
  return entries.scrollHeight - entries.scrollTop - entries.clientHeight < NEAR_PX;
}

/** Step to the next or the previous still when a finger went `dx` by `dy`: far enough, and sideways. */
function flick(dx, dy) {
  if (Math.abs(dx) > SWIPE_PX && Math.abs(dx) > 2 * Math.abs(dy)) move(dx < 0 ? 1 : -1);
}

/**
 * The Reply and the Resolve or Reopen button of thread `t`; with `swiped`, the pair a swipe
 * uncovers, whose resolve can be undone.
 */
function actions(t, swiped) {
  const className = swiped ? "act" : "";
  const reply = node("button", `${className} reply`.trim(), "Reply");
  reply.disabled = state.readonly;
  reply.onclick = (e) => {
    e.stopPropagation();
    answer(t.id);
  };
  const status = node("button", `${className} status`.trim(), statusLabel(t));
  status.disabled = busy.has(t.id) || state.readonly;
  status.onclick = (e) => {
    e.stopPropagation();
    setStatus(t.id, swiped);
  };
  return [reply, status];
}

/**
 * What the card of thread `t` says of a remark made on the live page, as a list to spread into
 * it: the page, a link to the live shell on it, how many elements it marks and "not reproduced"
 * when the shot does not show them. Empty for a remark made on the still.
 */
function targetLine(t) {
  if (!t.target) return [];
  const line = node("div", "target");
  const page = node("a", "", t.target.page);
  page.href = livePath(t.target.page);
  page.title = "Open the live page";
  page.onclick = (e) => e.stopPropagation();
  line.append("on ", page, ` · ${elementsLabel(t.target)}`);
  if (t.target.state === "not-reproduced") line.append(" · ", node("span", "lost", "not reproduced"));
  return [line];
}

/**
 * The card of thread `t`, number `n`, in its slot: the number, the title and the status chip,
 * which for a remark made on an older revision is a button that goes to it; what a remark made
 * on the live page marks (see `targetLine`); the latest message
 * with a dot when a reply is not seen yet; the agent's dots while it works on the remark; the
 * reply count with Reply and Resolve or Reopen. The selected card of the desktop layout shows
 * the whole conversation instead of the latest message. Behind the card are the two actions a
 * swipe uncovers in the mobile layout, of which a guest has only Reply.
 */
function threadCard(t, n) {
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
  foot.append(count, ...actions(t, false), node("span", "chev", "›"));
  card.append(head, ...targetLine(t));
  if (on && !mobile) {
    const all = node("div", "entries");
    all.append(entry(t), ...t.replies.map(entry), ...dotsOf(busyOn(t.id)));
    all.onclick = (e) => e.stopPropagation();
    card.append(foot, all);
  } else {
    const m = lastMessage(t);
    const last = node("div", "last");
    if (unread(t, seen)) last.append(node("span", "dot"));
    const said = node("span", "said");
    const how = m.author.via === "share" ? " · guest" : "";
    const when = ago(Date.parse(m.at), Date.now());
    said.append(node("b", m.author.kind, m.author.name), `${how} · ${when}: “${m.body}”`);
    last.append(said);
    const busy = dotsOf(busyOn(t.id));
    card.append(...(busy.length ? busy : [last]), foot);
  }
  card.onclick = () => {
    if (mobile) openTalk(t.id);
    else if (on) unselect();
    else select(t.id);
  };
  card.onkeydown = (e) => {
    if (e.key === "Enter" && e.target === card) card.click();
  };
  const acts = node("div", "acts");
  acts.append(...actions(t, true));
  slot.append(acts, card);
  if (mobile) {
    if (state.swiped?.id === t.id) slot.dataset.open = state.swiped.side;
    swipeable(slot, card, ACT_PX, (side) => {
      const kept = side === "left" && guest() ? null : side;
      if (!kept) delete slot.dataset.open;
      closeSwipe(slot);
      state.swiped = kept ? { id: t.id, side: kept } : null;
    });
  }
  return slot;
}

/** Slide back the card a swipe left open, but for the one in the slot `keep`. */
function closeSwipe(keep) {
  state.swiped = null;
  for (const slot of el("threads").querySelectorAll(".slot[data-open]")) if (slot !== keep) delete slot.dataset.open;
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
  if (!loaded(image)) return;
  const frame = { w: crop.clientWidth, h: crop.clientHeight };
  const at = cropOf(t.anchor, { w: image.naturalWidth, h: image.naturalHeight }, frame);
  for (const side of ["width", "height", "left", "top"]) el("shot").style[side] = `${at[side]}px`;
  el("crop-mark").className = t.anchor.w === undefined ? "pin" : "box";
  place(el("crop-mark"), t.anchor);
}

/**
 * Draw the conversation open full screen in the mobile layout, or hide it. Opened, or already
 * at its end (`pinned`, which also keeps it there when the keyboard or the reply box resize
 * it: a scroll the browser reports before that resize is seen, at a height other than `tall`,
 * does not count as the reader's), it shows the newest message and its replies count as seen;
 * scrolled up, a new reply shows the "new reply" pill instead of moving it. The agent's dots
 * close it while it works on the remark.
 */
function renderTalk() {
  const list = remarks();
  const at = list.findIndex((t) => t.id === state.talk);
  const talk = el("talk");
  if (at === -1 || !mobile) {
    state.talk = null;
    talk.hidden = true;
    return;
  }
  const t = list[at];
  const entries = el("entries");
  const opened = talk.hidden || talk.dataset.id !== t.id;
  const low = opened || stick || pinned;
  const count = () => entries.querySelectorAll(".entry").length;
  const had = opened ? Infinity : count();
  stick = false;
  talk.hidden = false;
  talk.dataset.id = t.id;
  talk.classList.toggle("resolved", t.status !== "open");
  el("talk-n").textContent = at + 1;
  el("talk-title").textContent = title(t.body);
  el("talk-status").textContent = statusLabel(t);
  el("talk-status").disabled = busy.has(t.id) || state.readonly;
  entries.replaceChildren(entry(t), ...t.replies.map(entry), ...dotsOf(busyOn(t.id)));
  drawCrop(t);
  pinned = low;
  if (low) {
    entries.scrollTop = entries.scrollHeight;
    markSeen(t);
  }
  el("fresh").hidden = low || (el("fresh").hidden && count() <= had);
}

/**
 * Put the reply form where the thread being answered is: at the foot of the conversation in
 * the mobile layout, under the thread's card in the desktop one, hidden when there is none.
 * What was typed for another thread is dropped, and the form keeps the focus it had (`held`),
 * which it loses when the cards it sat among are drawn again. A read-only folder has no form.
 */
function placeReply(held) {
  const form = el("reply");
  const id = mobile ? state.talk : state.replying;
  const home = mobile ? el("talk") : el("threads").querySelector(`.slot[data-id="${id}"]`);
  form.hidden = !id || !home || state.readonly;
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
 * Draw the remarks of the variant on screen: the numbered marks made on the revision shown or an
 * older one (those dimmed, with "made on rev N"), a resolved one only while it is selected, one
 * the agent is working on pulsing;
 * the draft; the conversation open full screen; and the panel with a card per thread, the
 * resolved ones in a group that is closed until asked for or one of them is selected, and
 * that lets go of the selected one when it is folded. The reply form steps out of the cards
 * while they are drawn again, so it is never lost with one, and is in the conversation before
 * that is scrolled to its end.
 */
function renderRemarks() {
  const list = remarks();
  const held = document.activeElement === el("answer");
  if (el("reply").parentElement !== el("talk")) document.body.append(el("reply"));
  const open = list.filter((t) => t.status === "open").length;
  const selected = list.find((t) => t.id === state.thread);
  if (selected && !mobile) markSeen(selected);
  if (mobile) placeReply(held);
  renderTalk();
  const unseen = list.reduce((sum, t) => sum + unread(t, seen, "agent"), 0);
  el("remarks").textContent = list.length ? `Remarks · ${open} open` : "Remarks";
  el("badge").textContent = unseen;
  el("badge").hidden = !unseen;
  el("list").setAttribute("aria-label", unseen ? `Remarks, ${unseen} unread` : "Remarks");
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
      mark.classList.toggle("busy", Boolean(busyOn(t.id)));
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
  if (!list.length) el("threads").append(node("p", "", state.readonly ? READ_ONLY : NO_REMARKS));
  if (done.length) {
    const group = node("details", "sunk");
    group.open = state.sunk || done.some(([t]) => t.id === state.thread);
    const summary = node("summary", "", `Resolved (${done.length})`);
    summary.onclick = (e) => {
      e.preventDefault();
      state.sunk = !group.open;
      if (!state.sunk && selected && selected.status !== "open") unselect();
      else render();
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
  if (!mobile) {
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

/**
 * Fill the switcher `group` with a button per value of `values`, called what `label` says, the
 * one equal to `current` pressed; a click hands the value to `pick`. Hidden when there is
 * nothing to switch between.
 */
function fillSwitcher(group, values, current, label, pick) {
  group.hidden = values.length < 2;
  group.replaceChildren(
    ...values.map((value) => {
      const button = node("button", "", label(value));
      button.setAttribute("aria-pressed", String(value === current));
      button.onclick = () => pick(value);
      return button;
    })
  );
}

/**
 * Draw the switchers for the still `s`: its variant's device class and tags pressed, its size
 * as a label, or as a picker when the still has several of that class and tags, the chip of
 * the mobile top bar, and the note that says which variant shows when the still has none of
 * the picked class and tags. A switch to the picked variant's own class keeps the pick, any
 * other prefers a variant of this still, and one to a class and tags no still was shot at
 * together picks the first variant at what was switched to.
 */
function renderSwitchers(s) {
  const { classes, viewports, tags } = choices(state.stills);
  const { key } = s.variant;
  const wanted = state.pick ?? key;
  const fell = !sameChoice(key, wanted);
  const near = [s, ...state.stills];
  const toClass = (c) => {
    const there = (k) => classOf(k) === c;
    const kept = (k) => k === wanted && there(k);
    setPick(pickOf(near, [kept, (k) => there(k) && tagsOf(k) === tagsOf(wanted), there]));
  };
  const toTags = (t) => {
    const sized = keyOf(viewportOf(wanted), t);
    setPick(pickOf(near, [(k) => k === sized, (k) => sameChoice(k, sized), (k) => tagsOf(k) === t]));
  };
  fillSwitcher(el("viewports"), classes, classOf(key), classLabel, toClass);
  fillSwitcher(el("tags"), tags, tagsOf(key), tagsLabel, toTags);
  const sizes = sizesOf(s, key);
  el("size").hidden = viewports.length < 2 || sizes.length > 1;
  el("size").textContent = sizeLabel(s.variant);
  el("sizes").hidden = sizes.length < 2;
  el("size-pick").replaceChildren(...sizes.map((v) => new Option(sizeLabel(v, true), v.key, false, v.key === key)));
  el("variant").hidden = classes.length < 2 && tags.length < 2;
  el("variant").textContent = [classLabel(classOf(key)), tagsOf(key)].filter(Boolean).join(" · ");
  el("variant").classList.toggle("fell", fell);
  el("fallback").hidden = !fell;
  el("fallback").textContent = `showing ${key}`;
}

/** Show the variant `key` names on every still that has it, from its latest revision and at fitted zoom. */
function setPick(key) {
  state.pick = key;
  state.rev = null;
  state.compare = false;
  state.thread = null;
  state.replying = null;
  state.swiped = null;
  view = FIT;
  aim = null;
  closeTalk();
  derive();
  buildStrip();
  render();
}

/** Draw again when the first of the agent's working states expires. */
function watchWorking() {
  clearTimeout(workTimer);
  const next = Math.min(...workingNow().map((w) => Date.parse(w.until)));
  if (Number.isFinite(next)) workTimer = setTimeout(render, Math.min(next - Date.now() + 50, MAX_TIMER_MS));
}

/**
 * Draw what a folder source adds whether or not it has stills: the About entries and the page
 * when it is open, the read-only line with Remark disabled, and the notes line until that very
 * set of notes is dismissed.
 */
function renderSource() {
  for (const button of document.querySelectorAll(".about")) button.hidden = !state.about;
  el("readme").hidden = !state.reading;
  root.classList.toggle("readonly", state.readonly);
  el("readonly").hidden = !state.readonly;
  for (const id of ["remark", "arm"]) el(id).disabled = state.readonly;
  el("remark").title = state.readonly ? READ_ONLY : REMARK_TITLE;
  el("notes").hidden = !state.notes.length || state.notes.join("\n") === dismissed;
  el("notes-text").textContent = notesLine(state.notes);
  el("notes-text").title = state.notes.join("\n");
}

/**
 * Draw the current still with its group and latest revision, its switchers and revision
 * controls, the reviewed mark, the count, the agent's dots for the still, the strip with its
 * group headings and the remarks.
 */
function render() {
  const { stills, at } = state;
  const some = stills.length > 0;
  renderSource();
  el("empty").hidden = some;
  el("stage").hidden = !some;
  for (const id of ["prev", "next", "mark", "bar", "place", "dock"]) el(id).hidden = !some;
  el("bar").classList.toggle("up", state.more);
  el("strip").classList.toggle("up", state.overview);
  el("shade").hidden = !state.more && !state.overview;
  el("more").setAttribute("aria-expanded", String(state.more));
  el("place").setAttribute("aria-expanded", String(state.overview));
  root.classList.toggle("guest", guest());
  for (const button of document.querySelectorAll(".as")) {
    button.hidden = !guest() || !me();
    button.textContent = `as ${me()}`;
  }
  if (!some) {
    el("title").textContent = "Stills";
    el("count").textContent = "";
    el("flag").hidden = true;
    el("panel").hidden = true;
    el("hint").hidden = true;
    el("talk").hidden = true;
    el("reply").hidden = true;
    const gone = [
      ...["variant", "busy", "viewports", "size", "sizes", "tags"],
      ...["fallback", "others", "group", "revn", "groups"],
    ];
    for (const id of gone) el(id).hidden = true;
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
  const { key } = s.variant;
  const elsewhere = state.draft && (state.draft.still !== s.name || state.draft.variant !== key);
  if (elsewhere || (state.draft && state.draft.rev !== shown.n)) dropDraft(false);
  const url = imageUrl(shown);
  if (el("still").getAttribute("src") !== url) el("still").src = url;
  const wide = s.variant.viewport?.width;
  el("still").style.width = !mobile && wide ? `${wide}px` : "";
  el("still").alt = s.title;
  el("title").textContent = s.title;
  el("group").hidden = !s.group;
  el("group").textContent = s.group ?? "";
  el("revn").hidden = latest < 2;
  el("revn").textContent = `rev ${latest}`;
  const part = sectionAt(parts, at);
  el("groups").hidden = !parts.length;
  el("group-pick").replaceChildren(...parts.map((p, i) => new Option(`${p.title} (${p.count})`, i, false, i === part)));
  document.title = `${s.title} · stills`;
  el("flag").hidden = !s.mark.changed;
  const counted = chosen(stills, state.pick);
  const { reviewed, total } = counts(counted);
  el("count").textContent = `${reviewed} / ${total} reviewed`;
  el("place").textContent = `${at + 1}/${stills.length}`;
  const others = progress(state.marks, counted, markedAs());
  el("others").hidden = !others.length;
  el("others").textContent = others.map((p) => `${p.name} reviewed ${p.reviewed}/${total}`).join(" · ");
  const over = workingNow().find((w) => !w.thread && (!w.still || (w.still === s.name && (w.variant ?? key) === key)));
  el("busy").hidden = !over;
  el("busy").replaceChildren(...dotsOf(over));
  renderSwitchers(s);
  el("viewed").checked = s.mark.reviewed;
  el("viewed").disabled = state.readonly || state.rev !== latest;
  const own = state.rev === latest;
  const marking = own ? "Mark this still reviewed (v)" : `The mark is for rev ${latest}, the latest`;
  el("mark").title = state.readonly ? READ_ONLY : marking;
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
    t.hidden = !mobile && !state.all && mark.reviewed && i !== at;
    t.classList.toggle("on", i === at);
    t.classList.toggle("done", mark.reviewed);
    t.classList.toggle("changed", mark.changed);
  });
  for (const { head, part: p } of heads) head.hidden = thumbs.slice(p.at, p.at + p.count).every((t) => t.hidden);
  if (!mobile) thumbs[at].scrollIntoView({ block: "nearest", inline: "center" });
  const hash = state.pick ? `#${s.name}@${sameChoice(key, state.pick) ? key : state.pick}` : `#${s.name}`;
  if (location.hash !== hash) history.replaceState(history.state, "", hash);
  for (const delta of [1, -1]) new Image().src = imageUrl(stills[step(stills, at, delta, state.all)].revs.at(-1));
  if (index > 0) new Image().src = imageUrl(s.revs[index - 1]);
  renderRemarks();
  layoutStage();
  watchWorking();
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
  if (mobile && anchor) reveal(anchor);
  else el("marks").querySelector(`[data-id="${id}"]`)?.scrollIntoView({ block: PHONE.matches ? "start" : "nearest" });
}

/** Let go of the selected thread and of a reply being written, folding its card. */
function unselect() {
  state.thread = null;
  state.replying = null;
  render();
}

/**
 * Answer thread `id`: in the mobile layout its conversation opens with the keyboard up, in the
 * desktop one the reply form opens under its card, or closes when it was there. Not in a
 * read-only folder.
 */
function answer(id) {
  if (state.readonly) return undefined;
  if (mobile) return openTalk(id, true);
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
  if (loaded(el("still"))) view = viewOn(t.anchor, box());
  else aim = t.anchor;
  layoutStage();
}

/**
 * Lay the still out once its image has loaded, on the mark `jump` was waiting to show when there
 * is one.
 */
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
  const field = el("answer");
  field.style.height = "auto";
  field.style.height = `${Math.min(field.scrollHeight + 2, MAX_ANSWER_PX)}px`;
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
  return answerOf(await fetch(url, { cache: "no-store" }));
}

/** Fold one log event into the marks, the agent's working states and the threads. True when any changed. */
function apply(event) {
  const marked = applyEvent(state.marks, state.stills, event);
  if (marked) derive();
  const worked = applyWorking(state.working, event);
  return applyThread(state.threads, event) || marked || worked;
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
  state.groups = data.groups ?? [];
  state.notes = data.notes ?? [];
  state.folder = data.writable !== undefined;
  state.readonly = data.writable === false;
  state.about = data.about ?? null;
  if (state.readonly) {
    dropDraft();
    state.armed = false;
    state.replying = null;
  }
  if (state.reading && state.about) loadAbout();
  else state.reading = false;
  state.marks = data.marks;
  state.me = data.me;
  state.working = new Map(data.working.map((w) => [workingKey(w), w]));
  state.threads = threads;
  state.late = state.late.filter((e) => e.seq > data.cursor);
  for (const e of state.late) apply(e);
  state.pick = state.pick && linkedKey(state.stills, state.pick);
  derive();
  state.applied = Math.max(state.applied, data.cursor);
  parts = sections(state.stills, state.groups);
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
  openAwaited();
}

/**
 * Follow the review log: fold each new event into the marks and the threads, reload when the
 * stills change, open the thread a link asked for once it lands, and say so when the runtime
 * could not post it.
 */
function follow() {
  let opened = false;
  source = new EventSource(`/_review/events?since=${state.applied}`);
  source.onmessage = (message) => {
    const event = JSON.parse(message.data);
    if (event.seq <= state.applied) return;
    state.applied = event.seq;
    if (settled < loads) state.late.push(event);
    if (apply(event)) render();
    openAwaited();
  };
  source.addEventListener("stills", load);
  source.addEventListener("remark-failed", (message) => {
    const failed = JSON.parse(message.data);
    if (failed.id !== awaited) return;
    awaited = null;
    report(`The remark was not posted: ${failed.error}`);
  });
  source.onopen = () => {
    if (opened) load();
    opened = true;
  };
}

/**
 * Read the folder's About page into its sheet: the README's name and the HTML the runtime made
 * of it, or why it could not be read. Dropped when the sheet was closed meanwhile.
 */
async function loadAbout() {
  let page;
  try {
    page = await getJson("/_review/about");
  } catch (e) {
    if (state.reading) el("readme-body").textContent = `Could not read it: ${e.message}`;
    return;
  }
  if (!state.reading) return;
  el("readme-title").textContent = page.file;
  el("readme-body").innerHTML = page.html;
}

/** Open the About page over the viewer, when the source has one. */
function openAbout() {
  if (!state.about) return;
  closeSheets();
  state.reading = true;
  render();
  loadAbout();
}

/** Close the About page. */
function closeAbout() {
  state.reading = false;
  render();
}

/**
 * A click in the About page on an image that is a still closes the page and goes to that
 * still, and to the variant the image is of when it is not the still's first.
 */
function followAbout(e) {
  const link = e.target.closest("a.still");
  if (!link) return;
  e.preventDefault();
  closeAbout();
  if (location.hash !== link.hash) location.hash = link.hash;
}

/** Go to the group the picker names: its first still left to review, else its first. */
function pickGroup(e) {
  const part = parts[Number(e.target.value)];
  if (!part) return;
  closeSheets();
  show(sectionStart(state.stills, part, state.all));
}

/**
 * True once whoever is looking has a name to write under: at once for a tailnet user and for a
 * guest who gave one, else when the name sheet is continued; false when it is cancelled.
 */
function named() {
  return !guest() || me() ? Promise.resolve(true) : askName();
}

/**
 * Ask a guest for a name with the name sheet (see `who.js`). Resolves to true when it is
 * continued, the name then the one whoever is looking writes under, and to false when it is
 * cancelled.
 */
async function askName() {
  const name = await askForName();
  if (!name) return false;
  guestName = name;
  derive();
  render();
  return true;
}

/**
 * Post `event` to the log, a guest's under the name they gave. Returns the stored event, which
 * the stream then delivers; with the stream down, everything is read again. Throws with the
 * server's reason.
 */
async function send(event) {
  const name = guest() ? me() : "";
  const res = await fetch("/_review/events", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(name ? { ...event, author: { name } } : event),
  });
  const answer = await answerOf(res);
  report("");
  if (source?.readyState !== EventSource.OPEN) await load();
  return answer;
}

/**
 * Write the reviewed mark of the latest revision of the variant on screen: set it, or clear it,
 * once whoever is looking has a name.
 */
async function setReviewed(on) {
  const s = state.stills[state.at];
  if (!s || state.readonly) return;
  const event = { type: on ? "viewed" : "unviewed", still: s.name, variant: s.variant.key, rev: s.revs.at(-1).n };
  if (!(await named())) return render();
  try {
    await send(event);
  } catch (e) {
    report(`Could not save the reviewed mark: ${e.message}`);
    render();
  }
}

/**
 * Post the draft as a thread, once whoever is looking has a name: its still, variant, revision,
 * mark and comment in one event, with the annotated still when it could be drawn, and a notice
 * when it could not. The new thread is then the selected one. The mark stays as it is while it
 * is being posted.
 */
async function postRemark() {
  const draft = state.draft;
  const body = el("body").value.trim();
  if (!draft || !body || el("post").disabled || !(await named()) || state.draft !== draft) return;
  el("post").disabled = true;
  try {
    const annotated = await annotate(imageUrl(shown), draft.anchor).catch(() => null);
    const event = { type: "thread", ...draft, body };
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
 * Post what is written in the reply form to the thread it is for, once whoever is looking has a
 * name. The reply shows at once; the desktop layout then closes the form, the mobile one keeps
 * it and shows the reply.
 */
async function postReply() {
  const body = el("answer").value.trim();
  const thread = answerFor;
  if (el("reply").hidden || !body || el("send").disabled || !(await named())) return;
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
 * Resolve thread `id`, or reopen it when it is resolved; the change shows at once, and a reply
 * being written under its card is let go. With `undoable`, a resolve can be undone for five
 * seconds. Not for a guest.
 */
async function setStatus(id, undoable = false) {
  const thread = state.threads.find((t) => t.id === id);
  if (!thread || busy.has(id) || guest() || state.readonly) return;
  const type = thread.status === "open" ? "resolve" : "reopen";
  busy.add(id);
  state.swiped = null;
  if (state.replying === id) state.replying = null;
  render();
  try {
    applyThread(state.threads, await send({ type, thread: id }));
    if (undoable && type === "resolve") toast("Remark resolved", () => setStatus(id));
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
 * or panning. Turning it on waits for whoever is looking to have a name. In the mobile layout
 * the sheets get out of the way of the still.
 */
async function toggleArmed() {
  if (!state.stills.length || state.readonly) return;
  const on = !state.armed;
  if (on && !(await named())) return;
  state.armed = on;
  closeSheets();
  if (state.armed && mobile) state.panel = false;
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
  mobile = wantsMobile();
  root.classList.toggle("mobile", mobile);
  el("layout").textContent = mobile ? "desktop layout" : "phone layout";
  closeSheets();
  view = FIT;
  render();
}

/** Force the other layout on this device, or stop forcing one when that is what its screen gets anyway. */
function toggleLayout() {
  const next = mobile ? "desktop" : "mobile";
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
  if (state.readonly) return;
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
 * End a drag: a press that never left its spot is a pin there. The composer opens (see
 * `openComposer`).
 */
function endDrag() {
  if (!drag) return;
  const tap = drag.tap && drag.fixed;
  drag = null;
  if (tap) setDraft(pin(tap));
  state.armed = false;
  render();
  openComposer();
}

/**
 * Bring the draft's composer up, ready to type; on a phone a mark its sheet would cover goes to
 * the top, or in the mobile layout is panned clear of it.
 */
function openComposer() {
  if (!state.draft) return undefined;
  el("body").focus({ preventScroll: PHONE.matches || mobile });
  if (mobile) return reveal(state.draft.anchor);
  const covered = el("draft").getBoundingClientRect().bottom > el("composer").getBoundingClientRect().top;
  if (PHONE.matches && covered) el("draft").scrollIntoView({ block: "start" });
  return undefined;
}

/** Make `anchor` the draft's mark, on the revision on screen. */
function setDraft(anchor) {
  const s = state.stills[state.at];
  state.draft = { still: s.name, variant: s.variant.key, rev: shown.n, anchor };
  drawDraft();
}

/** The thread the hash asks for, `#thread=<id>`, or null when it names a still or nothing. */
function hashThread() {
  return THREAD_HASH.exec(location.hash)?.[1] ?? null;
}

/**
 * Open the thread a `#thread=<id>` link asked for: go to its still, on its variant and the
 * revision it was made on, with its conversation unfolded, full screen in the mobile layout.
 * Until the thread is among the threads and its revision among the stills it stays awaited,
 * and this is called again as the stream brings them; a thread on no still is let go of. A
 * conversation open full screen gives its step of the history to the one that opens.
 */
function openAwaited() {
  const t = awaited && state.threads.find((thread) => thread.id === awaited);
  if (!t) return;
  if (t.still === null) {
    awaited = null;
    return;
  }
  const at = state.stills.findIndex((s) => s.name === t.still);
  const key = t.variant ?? state.stills[at]?.variants[0].key;
  const variant = state.stills[at]?.variants.find((v) => v.key === key);
  if (!variant?.revs.some((r) => r.n === t.rev)) return;
  awaited = null;
  if (mobile) state.talk = null;
  state.pick = key;
  derive();
  buildStrip();
  show(at);
  state.rev = t.rev;
  if (mobile) openTalk(t.id);
  else select(t.id);
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
  if (state.draft && mobile) reveal(state.draft.anchor);
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
  if (!mobile || e.pointerType === "mouse" || e.target.closest("#composer")) return;
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
  if (was.kind === "swipe") flick(at.x - was.at.x, at.y - was.at.y);
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
  if (mobile && e.cancelable && !e.target.closest("#composer")) e.preventDefault();
}

/**
 * In the mobile layout a wheel on the still, not on the composer, pans it, and with Ctrl, as a
 * trackpad's pinch sends it, zooms it.
 */
function wheel(e) {
  if (!mobile || e.target.closest("#composer")) return;
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
for (const button of document.querySelectorAll(".about")) button.onclick = openAbout;
el("readme-close").onclick = closeAbout;
el("readme").onclick = (e) => {
  if (e.target === el("readme")) closeAbout();
};
el("readme-body").onclick = followAbout;
el("group-pick").onchange = pickGroup;
el("size-pick").onchange = (e) => setPick(e.target.value);
el("notes-close").onclick = () => {
  dismissed = state.notes.join("\n");
  render();
};
el("variant").onclick = () => toggleSheet("more");
for (const button of document.querySelectorAll(".as")) button.onclick = askName;
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
  if (el("entries").clientHeight !== tall) return;
  pinned = atEnd();
  if (el("fresh").hidden || !talking() || !pinned) return;
  stick = true;
  render();
};
new ResizeObserver(() => {
  tall = el("entries").clientHeight;
  if (pinned) el("entries").scrollTop = el("entries").scrollHeight;
}).observe(el("entries"));
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
  if (e.key === "Escape" && asking()) return closeWho(false);
  if (asking()) return;
  if (e.key === "Escape" && state.reading) return closeAbout();
  if (state.reading) return;
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

onSwipe(room, () => !mobile && !state.armed && !state.draft, flick);
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

onSwipe(
  el("who-form"),
  () => true,
  (dx, dy) => {
    if (dy > SWIPE_PX && dy > 2 * Math.abs(dx)) closeWho(false);
  }
);

addEventListener("hashchange", () => {
  const asked = hashThread();
  if (asked) {
    awaited = asked;
    return openAwaited();
  }
  const i = hashIndex();
  const { key } = hashParts();
  const pick = key && linkedKey(state.stills, key);
  if (pick && pick !== state.pick) setPick(pick);
  if (i !== -1 && i !== state.at) show(i);
});

awaited = hashThread();
state.pick = awaited ? null : hashParts().key;

applyLayout();
await load();
follow();
