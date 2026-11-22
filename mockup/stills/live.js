/**
 * The live shell of the /mockup runtime, served at `/live/<slug>`: the mockup page in an iframe
 * with a bar of its own outside it, where a reviewer marks what a remark is about on the page
 * itself. The page and the shell share an origin, so the shell reads the page's DOM and puts
 * nothing in it; it only listens to the page's keys and scrolls.
 *
 * The bar shows the page's path, which follows the page as it navigates and is kept in the
 * shell's own URL, a device picker (Mobile, Tablet, Desktop: the page is shown at that preset's
 * size, scaled down when the room is smaller) and the Mark button, which a small or touch screen
 * has in a dock at the bottom instead, in the thumb zone.
 *
 * There are two modes. In **Use**, the default, the page behaves as it does alone and nothing is
 * ever selected. **Mark** is entered only from the Mark button or `m`: a transparent layer covers
 * the page, so no tap reaches it, a coloured frame goes around it, the cursor is a crosshair and
 * the Mark button is pressed; no sentence says so. It ends with Esc, the same button or Cancel,
 * and by itself once the remark is posted.
 *
 * In Mark mode a drag draws a box, which can then be moved or resized by its corners, and marks
 * the visible elements inside it (see `markedIn`); a tap marks the innermost element under it,
 * and a breadcrumb row widens the mark to a parent, up to the section it is in. With a mouse the
 * element under the pointer is highlighted. One finger draws; two fingers, or the wheel, scroll
 * the page under the layer, which drops the mark since what it was on moved. The strip under the
 * page shows how many elements are marked, with Comment and Cancel.
 *
 * Comment opens the composer by the box, under it, or over it when there is no room, and over
 * the keyboard on a phone; the box can still be moved and resized. Post takes the snapshot of the
 * page (`snapshot.js`) at that instant and sends it with the mark and the text to `POST
 * /_review/remarks`, a guest's once they gave a name, then closes the composer and leaves Mark
 * mode. The page is never touched, reloaded or left.
 *
 * What became of the remark is said by one toast at the bottom: `Posted` with a spinner while the
 * runtime shoots, then a link that opens the thread in the viewer, in a new tab, once the
 * `thread` event with the remark's id comes on `/_review/events`. When the runtime refuses the
 * remark, cannot be reached or says `remark-failed`, the toast reads `Not posted: <reason>` with
 * Retry, which sends the same draft again: its box, elements, text and snapshot are kept in
 * memory until it is posted or the toast is dismissed.
 *
 * The conversation is on the live page too. The Remarks button, with the count of the page's open
 * threads, opens a panel beside the page, a sheet at the bottom on a phone: the threads whose
 * `target.page` is the page on screen, the open ones first, each with its number among them, its
 * author, body, time and replies, Reply, Resolve or Reopen (the owner's, so a guest has neither)
 * and Open, the thread in the viewer in a new tab; a thread shot from the page loaded again says
 * `not reproduced`. The shell reads the threads once and then follows `/_review/events` from the
 * load on, so a reply written elsewhere shows at once; Reply and Resolve post to `POST
 * /_review/events`, as the viewer does, and one the server refuses leaves its button outlined.
 *
 * Each open thread of the page has a numbered pin on its first marked element, found by its
 * stored selector, at the corner of what shows of it; the pin is gone while the element is out
 * of the page, hidden, scrolled out of sight or covered. Pins are drawn on the shell, over the
 * page and under the Mark layer, and follow the page's scrolls, its DOM and the room's size. A
 * tap on a pin opens its thread in the panel; a thread picked in the panel has its elements
 * outlined and its first one scrolled into view. Nothing of this is ever put in the page.
 *
 * Every text the shell shows is in the copy table of the epic (#58); what state it is in shows
 * by styling, not by sentences.
 */

import {
  ago,
  applyThread,
  classLabel,
  classOf,
  DEVICES,
  answerOf,
  elementsLabel,
  holds,
  livePath,
  markedIn,
  moved,
  opposite,
  pageOfLive,
  place,
  presetSize,
  region,
  scaleToFit,
  SMALL_SCREEN,
  store,
  stored,
  TAP_PX,
  TARGET_LIMITS,
} from "./state.js";
import { snapshot } from "./snapshot.js";
import { asking, askName, closeWho, keptName } from "./who.js";

const DEVICE_KEY = "live.device";
const ROOM_PAD_PX = 12;
const TRACK_MS = 400;
const LINE_PX = 16;
const SMALL = matchMedia(SMALL_SCREEN);
const SECTION =
  "section, article, main, nav, aside, header, footer, form, dialog, [role=dialog], [role=alertdialog], [aria-modal=true]";
const GAP_PX = 8;
const TOAST_MS = 6000;
const SYNC_MS = 5000;
const TIMES_MS = 30000;
const PIN_PX = 12;
const CHANGE_MS = 80;
const JSON_POST = { method: "POST", headers: { "Content-Type": "application/json" } };

const kept = stored(DEVICE_KEY);
const state = {
  page: pageOfLive(location.pathname, location.search),
  device: DEVICES.includes(kept) ? kept : classOf(`custom-${innerWidth}x${innerHeight}`),
  marking: false,
  sel: null,
  composing: false,
  signing: false,
  me: null,
  open: false,
  thread: null,
};
const root = document.documentElement;
const frame = el("frame");
const layer = el("layer");
const fingers = new Map();
const pending = new Map();
const heard = new Map();
const waiting = [];
const threads = [];
const cards = new Map();
const pins = new Map();
const lit = [];
const watch = new MutationObserver(changed);
let scale = 1;
let drag = null;
let pan = null;
let source = null;
let since = null;
let flying = 0;
let shown = null;
let hiding = null;
let loading = null;
let queued = 0;
let settling = 0;

/** The element with the id `id`. */
function el(id) {
  return document.getElementById(id);
}

/** The page's document, or null when the iframe left the mockup's origin. */
function pageDocument() {
  try {
    return frame.contentDocument;
  } catch {
    return null;
  }
}

/** The rect of `target` in the page's viewport, `{ x, y, w, h }` in CSS pixels. */
function rectOf(target) {
  const r = target.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
}

/** Where a pointer event is on the layer, normalized to it: 0..1 inside the page's viewport. */
function pointOf(e) {
  const box = layer.getBoundingClientRect();
  return { x: (e.clientX - box.left) / box.width, y: (e.clientY - box.top) / box.height };
}

/** The point `p`, normalized to the layer, in CSS pixels of the page's viewport. */
function toPage(p) {
  const { width, height } = presetSize(state.device);
  return { x: p.x * width, y: p.y * height };
}

/** The anchor, normalized to the page's viewport, of the rect `r` of the page, cut to the viewport. */
function anchorOf(r) {
  const { width, height } = presetSize(state.device);
  return region({ x: r.x / width, y: r.y / height }, { x: (r.x + r.w) / width, y: (r.y + r.h) / height });
}

/** The marked box in CSS pixels of the page's viewport, as a remark takes it. */
function boxOf(anchor) {
  const { width, height } = presetSize(state.device);
  return { x: anchor.x * width, y: anchor.y * height, w: anchor.w * width, h: anchor.h * height };
}

/** The element of the page under the point `p` of its viewport, null for none or the page's own root. */
function elementAt(p) {
  const doc = pageDocument();
  const hit = doc?.elementFromPoint(p.x, p.y);
  return hit && hit !== doc.documentElement && hit !== doc.body ? hit : null;
}

/**
 * True when `target`, whose rect in the viewport is `rect`, shows on the page: it has an area,
 * no style hides it, and what is on top at its centre is itself, something inside it or something
 * around it, so an element behind a dialog does not count.
 */
function visible(target, rect) {
  if (!(rect.w > 0 && rect.h > 0)) return false;
  const shown = target.checkVisibility
    ? target.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
    : target.ownerDocument.defaultView.getComputedStyle(target).visibility !== "hidden";
  if (!shown) return false;
  const hit = target.ownerDocument.elementFromPoint(rect.x + rect.w / 2, rect.y + rect.h / 2);
  return Boolean(hit) && (target.contains(hit) || hit.contains(target));
}

/**
 * The visible elements of the page inside the box `box` of its viewport: `{ elements,
 * truncated }` as `markedIn` picks them. What is drawn inside an `svg` is the `svg`'s, not
 * elements of its own.
 */
function elementsIn(box) {
  const doc = pageDocument();
  const index = new Map();
  const nodes = [];
  const found = [];
  for (const target of doc?.body?.querySelectorAll("*") ?? []) {
    if (target.ownerSVGElement) continue;
    const rect = rectOf(target);
    if (!holds(box, rect) || !visible(target, rect)) continue;
    let parent = target.parentElement;
    while (parent && !index.has(parent)) parent = parent.parentElement;
    index.set(target, nodes.length);
    nodes.push({ rect, parent: parent ? index.get(parent) : -1 });
    found.push(target);
  }
  const { picked, truncated } = markedIn(nodes);
  return { elements: picked.map((i) => found[i]), truncated };
}

/**
 * One step of a selector's path: the tag of `target`, with its place among its siblings of that
 * tag when it has any.
 */
function stepOf(target) {
  const tag = CSS.escape(target.localName);
  const twins = [...target.parentElement.children].filter((c) => c.localName === target.localName);
  return twins.length > 1 ? `${tag}:nth-of-type(${twins.indexOf(target) + 1})` : tag;
}

/**
 * A CSS selector that matches `target` and nothing else on its page, as a target names it: the
 * shortest path of child steps from an ancestor that is unique, or from the nearest ancestor
 * with an id of its own. Null when none fits a target's selector.
 */
function selectorOf(target) {
  const doc = target.ownerDocument;
  const fits = (selector) => selector.length <= TARGET_LIMITS.selector;
  const only = (selector) => fits(selector) && doc.querySelectorAll(selector).length === 1;
  let path = "";
  for (let at = target; at && at !== doc.documentElement; at = at.parentElement) {
    const name = at.getAttribute("id");
    const id = name ? `#${CSS.escape(name)}` : "";
    if (id && only(id)) {
      const selector = path ? `${id} > ${path}` : id;
      return fits(selector) ? selector : null;
    }
    path = path ? `${stepOf(at)} > ${path}` : stepOf(at);
    if (only(path)) return path;
  }
  return null;
}

/** What a target keeps of the marked element `target`: its selector, its visible text and a cut of its HTML. */
function describe(target) {
  const text = String(target.innerText ?? target.textContent ?? "").replace(/\s+/g, " ").trim();
  return {
    selector: selectorOf(target),
    text: text.slice(0, TARGET_LIMITS.text),
    html: target.outerHTML.slice(0, TARGET_LIMITS.html),
  };
}

/**
 * The elements a tap on `target` can mark, innermost first: itself, then each parent up to the
 * section it is in, or to the page's body when it is in none.
 */
function chainOf(target) {
  const chain = [target];
  const { body } = target.ownerDocument;
  for (let at = target; !at.matches(SECTION) && at.parentElement && at.parentElement !== body; ) {
    at = at.parentElement;
    chain.push(at);
  }
  return chain;
}

/** What a breadcrumb calls `target`: its tag with its id, else with its first class. */
function crumbLabel(target) {
  const id = target.getAttribute("id");
  if (id) return `${target.localName}#${id}`;
  return target.classList.length ? `${target.localName}.${target.classList[0]}` : target.localName;
}

/** Lay the page out at its device's size, scaled down to fit the room when the room is smaller. */
function layout() {
  const size = presetSize(state.device);
  const room = document.querySelector("main");
  const free = { width: room.clientWidth - 2 * ROOM_PAD_PX, height: room.clientHeight - 2 * ROOM_PAD_PX };
  scale = scaleToFit(size, free) || 1;
  el("screen").style.width = `${size.width * scale}px`;
  el("screen").style.height = `${size.height * scale}px`;
  frame.style.width = `${size.width}px`;
  frame.style.height = `${size.height}px`;
  frame.style.transform = `scale(${scale})`;
  const shrunk = scale < 1 ? ` · ${Math.round(scale * 100)}%` : "";
  el("size").textContent = `${size.width}×${size.height}${shrunk}`;
  queuePins();
}

/** The threads made on the page on screen, in the order they were opened; a thread's number is its place here. */
function pageThreads() {
  return state.page === null ? [] : threads.filter((thread) => thread.target?.page === state.page);
}

/** The element of the page the stored selector `selector` names now, null for none or for no selector. */
function find(selector) {
  if (!selector) return null;
  try {
    return pageDocument()?.querySelector(selector) ?? null;
  } catch {
    return null;
  }
}

/** Make `value` what `target` holds under `key`, written only when it is not already, so a page left alone is not touched. */
function write(target, key, value) {
  if (target[key] !== value) target[key] = value;
}

/** What the rects `a` and `b` share, null when it has no area. */
function cut(a, b) {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const w = Math.min(a.x + a.w, b.x + b.w) - x;
  const h = Math.min(a.y + a.h, b.y + b.h) - y;
  return w > 0 && h > 0 ? { x, y, w, h } : null;
}

/**
 * What shows of the element `target` in the page's viewport, as a rect of it, or null when
 * nothing does: it is not in the page, a style hides it, it is out of the viewport or of an
 * ancestor that clips its content, or something else is on top of what is left of it.
 */
function spot(target) {
  if (!target?.isConnected) return null;
  const doc = target.ownerDocument;
  const view = doc.defaultView;
  if (!view) return null;
  const style = view.getComputedStyle(target);
  const shows = target.checkVisibility
    ? target.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
    : style.visibility !== "hidden";
  if (!shows) return null;
  const { width, height } = presetSize(state.device);
  let seen = cut(rectOf(target), { x: 0, y: 0, w: width, h: height });
  const fixed = style.position === "fixed";
  for (let at = target.parentElement; seen && !fixed && at && at !== doc.body; at = at.parentElement) {
    const { overflowX, overflowY, position } = view.getComputedStyle(at);
    if (overflowX !== "visible" || overflowY !== "visible") seen = cut(seen, rectOf(at));
    if (position === "fixed") break;
  }
  if (!seen) return null;
  const hit = doc.elementFromPoint(seen.x + seen.w / 2, seen.y + seen.h / 2);
  return hit && (target.contains(hit) || hit.contains(target)) ? seen : null;
}

/**
 * Draw the pins and the outlines over the page as it is now: a pin with its number at the corner
 * of what shows of the first marked element of each open thread of the page, none for an element
 * that does not show (see `spot`), the pins in the order of their numbers, and an outline on what shows of each element of the thread
 * picked in the panel.
 */
function placePins() {
  queued = 0;
  const { width, height } = presetSize(state.device);
  const mine = pageThreads();
  const shown = new Set();
  mine.forEach((thread, at) => {
    const seen = thread.status === "open" ? spot(find(thread.target.elements[0]?.selector)) : null;
    if (!seen) return;
    shown.add(thread.id);
    let pin = pins.get(thread.id);
    if (!pin) {
      pin = document.createElement("button");
      pin.type = "button";
      pin.onclick = () => select(thread.id, false);
      pins.set(thread.id, pin);
      el("pins").append(pin);
    }
    write(pin, "textContent", String(at + 1));
    write(pin, "ariaPressed", String(thread.id === state.thread));
    write(pin.style, "left", `${Math.max(PIN_PX, Math.min(seen.x * scale, width * scale - PIN_PX)).toFixed(2)}px`);
    write(pin.style, "top", `${Math.max(PIN_PX, Math.min(seen.y * scale, height * scale - PIN_PX)).toFixed(2)}px`);
  });
  for (const [id, pin] of pins) {
    if (shown.has(id)) continue;
    pin.remove();
    pins.delete(id);
  }
  const order = mine.map((thread) => pins.get(thread.id)).filter(Boolean);
  const drawn = el("pins").querySelectorAll("button");
  if (order.some((pin, at) => pin !== drawn[at])) el("pins").append(...order);
  const picked = mine.find((thread) => thread.id === state.thread);
  const rects = (picked?.target.elements ?? []).map((marked) => spot(find(marked.selector))).filter(Boolean);
  while (lit.length > rects.length) lit.pop().remove();
  rects.forEach((seen, at) => {
    if (!lit[at]) {
      lit[at] = document.createElement("i");
      el("pins").prepend(lit[at]);
    }
    const sides = { left: seen.x / width, top: seen.y / height, width: seen.w / width, height: seen.h / height };
    for (const [side, part] of Object.entries(sides)) write(lit[at].style, side, `${Math.round(part * 1e4) / 100}%`);
  });
}

/** Draw the pins again at the next frame: the page scrolled, changed or was laid out, or the threads did. */
function queuePins() {
  queued ||= requestAnimationFrame(placePins);
}

/**
 * The page's DOM changed: draw the pins again, `CHANGE_MS` after the first change of a run at
 * the latest, so a page that changes on every frame costs a few redraws a second.
 */
function changed() {
  settling ||= setTimeout(() => {
    settling = 0;
    queuePins();
  }, CHANGE_MS);
}

/** Write how long ago each time the panel shows was. */
function drawTimes() {
  for (const time of el("cards").querySelectorAll("time")) write(time, "textContent", ago(Date.parse(time.dateTime), Date.now()));
}

/** A `time` element for the ISO time `at`, which `drawTimes` fills. */
function timeOf(at) {
  const time = document.createElement("time");
  time.dateTime = at;
  return time;
}

/** A new element `tag` of the class `name` that says `text`. */
function make(tag, name, text = "") {
  const made = document.createElement(tag);
  made.className = name;
  made.textContent = text;
  return made;
}

/** The name of `author` as the panel writes it, an agent's told apart by its colour. */
function byline(author) {
  return make("b", author.kind === "agent" ? "by agent" : "by", author.name);
}

/**
 * The card of `thread` in the panel, made once and kept while the thread is on the page on
 * screen, so what is being typed in its reply field stays: its number, author and time, its
 * body, its replies, the reply field, closed until Reply is pressed, and Reply, Resolve or
 * Reopen and Open. A click on the card itself picks the thread, or lets go of the picked one.
 */
function cardOf(thread) {
  if (cards.has(thread.id)) return cards.get(thread.id);
  const card = make("article", "thread");
  const head = make("div", "head");
  head.append(make("span", "n"), byline(thread.author), timeOf(thread.at));
  if (thread.target.state === "not-reproduced") head.append(make("span", "chip", "not reproduced"));
  const field = make("textarea", "answer");
  field.rows = 2;
  field.hidden = true;
  field.setAttribute("aria-label", "Reply");
  const foot = make("div", "foot");
  const reply = make("button", "send", "Reply");
  const status = make("button", "settle");
  const link = make("a", "", "Open");
  link.target = "_blank";
  link.rel = "noopener";
  link.href = `/stills#thread=${encodeURIComponent(thread.id)}`;
  status.hidden = state.me?.via !== "tailnet";
  foot.append(reply, status, link);
  card.append(head, make("p", "text", thread.body), make("div", "entries"), field, foot);
  reply.onclick = () => answer(thread, reply, field);
  status.onclick = () => {
    const now = threads.find((one) => one.id === thread.id) ?? thread;
    return say(status, { type: now.status === "open" ? "resolve" : "reopen", thread: thread.id });
  };
  field.onkeydown = (e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      field.hidden = true;
      reply.focus();
    } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      answer(thread, reply, field);
    }
  };
  card.onclick = (e) => {
    if (!e.target.closest("button, a, textarea")) select(state.thread === thread.id ? null : thread.id, true);
  };
  cards.set(thread.id, card);
  return card;
}

/** Bring the card of `thread`, the `n`th of its page, up to date: its number, its status, whether it is picked and the replies it lacks. */
function fill(thread, n) {
  const card = cardOf(thread);
  const entries = card.querySelector(".entries");
  write(card.querySelector(".n"), "textContent", String(n));
  card.classList.toggle("resolved", thread.status !== "open");
  card.classList.toggle("on", thread.id === state.thread);
  write(card.querySelector(".settle"), "textContent", thread.status === "open" ? "Resolve" : "Reopen");
  for (const reply of thread.replies.slice(entries.children.length)) {
    const entry = make("div", "entry");
    const who = make("div", "who");
    who.append(byline(reply.author), timeOf(reply.at));
    entry.append(who, make("p", "text", reply.body));
    entries.append(entry);
  }
  return card;
}

/**
 * Draw the Remarks buttons, the panel and the pins for the page on screen: the count of its open
 * threads, its threads with the open ones first, or that it has none. A picked thread that is
 * not of this page is let go. On a small or touch screen the buttons are off in Mark mode, where
 * the sheet would lie over the strip.
 */
function drawThreads() {
  const mine = pageThreads();
  const open = mine.filter((thread) => thread.status === "open");
  if (!mine.some((thread) => thread.id === state.thread)) state.thread = null;
  for (const button of document.querySelectorAll(".lister")) {
    button.setAttribute("aria-pressed", String(state.open));
    button.disabled = state.marking && SMALL.matches;
    write(button.querySelector(".tally"), "textContent", open.length ? String(open.length) : "");
  }
  el("side").hidden = !state.open;
  el("none").hidden = mine.length > 0;
  for (const id of [...cards.keys()]) if (!mine.some((thread) => thread.id === id)) cards.delete(id);
  const order = [...open, ...mine.filter((thread) => thread.status !== "open")];
  const made = order.map((thread) => fill(thread, mine.indexOf(thread) + 1));
  const list = el("cards");
  if (made.length !== list.children.length || made.some((card, at) => list.children[at] !== card)) {
    const held = document.activeElement;
    list.replaceChildren(...made);
    if (list.contains(held)) held.focus();
  }
  drawTimes();
  queuePins();
}

/** Open or close the panel; closing it lets go of the picked thread, so its outlines go. */
function setOpen(on) {
  state.open = on;
  if (!on) state.thread = null;
  drawThreads();
}

/**
 * Pick the thread `id` in the panel, which opens for it, its card brought into sight and its
 * elements outlined; with `reveal`, its first element is scrolled into view when the page has
 * it, to the top of the page on a small or touch screen, where the sheet covers the bottom. Null
 * lets go of the picked one.
 */
function select(id, reveal) {
  state.thread = id;
  if (id) state.open = true;
  drawThreads();
  const thread = threads.find((one) => one.id === state.thread);
  if (!thread) return;
  cards.get(thread.id).scrollIntoView({ block: "nearest" });
  const block = SMALL.matches ? "start" : "nearest";
  if (reveal) find(thread.target.elements[0]?.selector)?.scrollIntoView({ block, inline: "nearest", behavior: "instant" });
}

/**
 * Post `event`, a reply or a change of status, to the review log for the button `button`, a
 * guest's under the name they give. True when the log took it, the threads then drawn with it
 * before the stream tells; false when the guest gave no name, or with the button outlined when
 * the server refused it or could not be reached.
 */
async function say(button, event) {
  if (button.disabled) return false;
  button.disabled = true;
  button.classList.remove("failed");
  try {
    const who = await writer();
    if (!who) return false;
    const stored = await answerOf(await fetch("/_review/events", { ...JSON_POST, body: JSON.stringify({ ...event, ...who }) }));
    if (applyThread(threads, stored)) drawThreads();
    return true;
  } catch {
    button.classList.add("failed");
    return false;
  } finally {
    button.disabled = false;
  }
}

/**
 * Reply was pressed on the card of `thread`: open its reply field, or with something typed in it
 * post that as a reply and close the field. A reply that was not posted stays in the field.
 */
async function answer(thread, button, field) {
  const body = field.value.trim();
  if (field.hidden || !body) {
    field.hidden = false;
    return field.focus();
  }
  if (!(await say(button, { type: "reply", thread: thread.id, body }))) return undefined;
  if (field.value.trim() !== body) return undefined;
  field.value = "";
  field.hidden = true;
  return undefined;
}

/**
 * Put the composer by the mark: under it, over it when there is no room under, else at the
 * bottom of the window, and never past the window's sides. A small or touch screen has it at
 * the bottom, over the keyboard, by its style sheet.
 */
function placeComposer() {
  const box = el("composer");
  if (box.hidden) return;
  if (SMALL.matches) {
    box.style.left = "";
    box.style.top = "";
    return;
  }
  const mark = el("draft").getBoundingClientRect();
  const { offsetWidth: wide, offsetHeight: high } = box;
  const under = mark.bottom + GAP_PX;
  const over = mark.top - GAP_PX - high;
  const last = innerHeight - GAP_PX - high;
  const top = under <= last ? under : over >= GAP_PX ? over : last;
  box.style.left = `${Math.max(GAP_PX, Math.min(mark.left, innerWidth - GAP_PX - wide))}px`;
  box.style.top = `${Math.max(GAP_PX, top)}px`;
}

/** Draw the composer: open while a mark is being commented, Post ready once it has elements and a text. */
function drawComposer() {
  const { sel, composing, signing } = state;
  el("composer").hidden = !(composing && sel);
  el("post").disabled = !sel?.elements || signing || !el("say").value.trim();
  placeComposer();
}

/** Open the composer on the mark, with the keyboard up. */
function compose() {
  if (!state.sel?.elements) return;
  state.composing = true;
  drawComposer();
  el("say").focus();
}

/** Close the composer, the mark kept; with `drop`, what was typed in it goes. */
function closeComposer(drop) {
  state.composing = false;
  if (drop) el("say").value = "";
  el("say").blur();
  drawComposer();
}

/** Draw the mark: its box, the breadcrumbs of a tapped element, the count, whether Comment can go, and the composer. */
function drawSel() {
  const { sel } = state;
  el("draft").hidden = !sel;
  if (sel) place(el("draft"), sel.anchor);
  const chain = sel?.chain ?? [];
  el("crumbs").hidden = chain.length < 2;
  el("crumbs").replaceChildren(
    ...chain
      .map((target, at) => {
        const crumb = document.createElement("button");
        crumb.textContent = crumbLabel(target);
        crumb.setAttribute("aria-pressed", String(at === sel.at));
        crumb.onclick = () => pick(chain, at);
        return crumb;
      })
      .reverse()
  );
  el("found").textContent = sel?.elements ? elementsLabel(sel) : "";
  el("comment").disabled = !sel?.elements;
  drawComposer();
}

/** Draw the bar and the page's frame for the mode the shell is in, then the mark. */
function render() {
  const { marking } = state;
  const outside = state.page === null;
  root.classList.toggle("marking", marking);
  el("path").textContent = outside ? "" : state.page;
  document.title = outside ? "live" : `${state.page} · live`;
  for (const button of document.querySelectorAll(".marker")) {
    button.setAttribute("aria-pressed", String(marking));
    button.disabled = outside;
  }
  for (const button of el("devices").children) {
    button.setAttribute("aria-pressed", String(button.dataset.device === state.device));
  }
  layer.hidden = !marking;
  el("pick").hidden = !marking;
  frame.tabIndex = marking ? -1 : 0;
  drawSel();
  drawThreads();
}

/** Forget the mark and any gesture under way; the composer closes, what was typed in it kept for the next mark. */
function clearSel() {
  state.sel = null;
  state.composing = false;
  drag = null;
  el("hover").hidden = true;
}

/**
 * Enter Mark mode or go back to Use, with no mark either way. Entering takes the focus out of
 * the page, so keys stop reaching it; a page outside the mockup cannot be marked. Leaving drops
 * what was typed in the composer. On a small or touch screen entering closes the panel, whose
 * sheet would lie over the strip, and lets go of the picked thread, as closing it does.
 */
function setMarking(on) {
  if (on && state.page === null) return;
  state.marking = on;
  if (on && SMALL.matches) {
    state.open = false;
    state.thread = null;
  }
  if (!on) el("say").value = "";
  clearSel();
  fingers.clear();
  pan = null;
  render();
  if (on) (SMALL.matches ? el("arm") : el("marking")).focus();
}

/**
 * Show the page as the device class `name`, remembered on this device; the mark goes, since the
 * page lays out again.
 */
function setDevice(name) {
  state.device = name;
  store(DEVICE_KEY, name);
  clearSel();
  layout();
  render();
}

/** Mark the element at `at` of `chain` (see `chainOf`): the box is its rect, cut to the viewport. */
function pick(chain, at) {
  state.sel = { anchor: anchorOf(rectOf(chain[at])), chain, at, elements: [chain[at]], truncated: false };
  drawSel();
}

/** Make `anchor` the box of a free mark, its elements unknown until the drag ends. */
function setBox(anchor) {
  state.sel = { anchor, chain: null, at: 0, elements: null, truncated: false };
  drawSel();
}

/** Highlight the element of the page under a mouse, when no drag is under way and it is not on the mark. */
function hover(e) {
  const target = e.pointerType === "mouse" && !e.target.closest("#draft") ? elementAt(toPage(pointOf(e))) : null;
  el("hover").hidden = !target;
  if (target) place(el("hover"), anchorOf(rectOf(target)));
}

/**
 * Scroll what is under the point `p` of the page's viewport by `dx` and `dy`: the nearest
 * element around it that scrolls its content and has room left that way, else the page itself,
 * so a list at its end or a row that only scrolls sideways hands the scroll on.
 */
function scrollAt(p, dx, dy) {
  const doc = pageDocument();
  const page = doc?.scrollingElement ?? null;
  for (let at = elementAt(p); at && at !== page; at = at.parentElement) {
    const { overflowX, overflowY } = doc.defaultView.getComputedStyle(at);
    const left = /auto|scroll/.test(overflowX) ? dx : 0;
    const top = /auto|scroll/.test(overflowY) ? dy : 0;
    if (!left && !top) continue;
    const { scrollLeft, scrollTop } = at;
    at.scrollBy({ left, top, behavior: "instant" });
    if (at.scrollLeft !== scrollLeft || at.scrollTop !== scrollTop) return;
  }
  page?.scrollBy({ left: dx, top: dy, behavior: "instant" });
}

/** The point halfway between the first two fingers on the layer. */
function middle() {
  const [a, b] = [...fingers.values()];
  return { clientX: (a.clientX + b.clientX) / 2, clientY: (a.clientY + b.clientY) / 2 };
}

/**
 * A press on the layer. A second finger turns the gesture into a scroll of the page, dropping a
 * box being drawn. Else, on a corner of the mark it resizes it, on the mark it moves it, and
 * elsewhere it starts a new one; `drag.tap` holds where it was pressed until the pointer leaves
 * that spot, and `drag.corner` says the press is on a corner.
 */
function startDrag(e) {
  if (e.pointerType !== "mouse") fingers.set(e.pointerId, { clientX: e.clientX, clientY: e.clientY });
  if (fingers.size > 1) {
    if (drag) clearSel();
    if (fingers.size === 2) pan = { at: middle(), point: toPage(pointOf(middle())) };
    return drawSel();
  }
  if (e.button !== 0) return undefined;
  const at = pointOf(e);
  const tap = { x: e.clientX, y: e.clientY };
  const corner = e.target.dataset.corner;
  if (corner) drag = { fixed: opposite(state.sel.anchor, corner), tap, corner: true };
  else if (e.target.closest("#draft")) drag = { from: state.sel.anchor, at, tap };
  else drag = { fixed: at, tap };
  el("hover").hidden = true;
  e.preventDefault();
  try {
    return layer.setPointerCapture(e.pointerId);
  } catch {
    return undefined;
  }
}

/**
 * Follow a pointer on the layer: two fingers scroll the page by how far their middle went, a
 * drag moves the mark or stretches it from its fixed corner, and a mouse that drags nothing
 * highlights the element under it.
 */
function moveDrag(e) {
  if (fingers.has(e.pointerId)) fingers.set(e.pointerId, { clientX: e.clientX, clientY: e.clientY });
  if (pan) {
    if (fingers.size < 2) return;
    const at = middle();
    scrollAt(pan.point, (pan.at.clientX - at.clientX) / scale, (pan.at.clientY - at.clientY) / scale);
    pan.at = at;
    return;
  }
  if (!drag) return hover(e);
  if (drag.tap && Math.hypot(e.clientX - drag.tap.x, e.clientY - drag.tap.y) < TAP_PX) return;
  drag.tap = null;
  const at = pointOf(e);
  setBox(drag.from ? moved(drag.from, at.x - drag.at.x, at.y - drag.at.y) : region(drag.fixed, at));
}

/**
 * A pointer lifts. A press that never left its spot is a tap: it marks the innermost element
 * under it, except on a corner of the mark, which leaves the mark as it was. A drag that ended
 * marks the elements inside its box. A scroll ends with its last finger.
 */
function endDrag(e) {
  fingers.delete(e.pointerId);
  if (pan) {
    if (!fingers.size) pan = null;
    return;
  }
  if (!drag) return;
  const tapped = Boolean(drag.tap);
  const { corner } = drag;
  drag = null;
  if (tapped && corner) return;
  if (tapped) {
    const target = elementAt(toPage(pointOf(e)));
    if (target) pick(chainOf(target), 0);
  } else if (state.sel) {
    state.sel = { ...state.sel, chain: null, ...elementsIn(boxOf(state.sel.anchor)) };
    drawSel();
  }
}

/** A gesture the browser took away: the box being drawn goes, a mark that was there with it. */
function cancelDrag(e) {
  fingers.delete(e.pointerId);
  if (!fingers.size) pan = null;
  if (!drag) return;
  clearSel();
  drawSel();
}

/** The wheel on the layer scrolls the page under it. */
function wheel(e) {
  e.preventDefault();
  const lines = e.deltaMode === 1 ? LINE_PX : 1;
  scrollAt(toPage(pointOf(e)), e.deltaX * lines, e.deltaY * lines);
}

/**
 * Something scrolled in the page: the highlight goes, and so does a mark that moved with it, one
 * of the page itself or of an element that holds a marked one, or a box still being drawn. A
 * mark stays when what scrolled is elsewhere on the page.
 */
function scrolled(e) {
  queuePins();
  el("hover").hidden = true;
  const { sel } = state;
  if (!sel) return;
  const whole = e.target.nodeType === Node.DOCUMENT_NODE;
  if (!whole && sel.elements && !sel.elements.some((marked) => e.target.contains(marked))) return;
  clearSel();
  drawSel();
}

/**
 * Read where the page is: its path and query, shown in the bar and kept in the shell's URL so a
 * mark uses it and a reload comes back to it. A page that left the mockup's origin cannot be
 * read or marked, and one whose path no shell URL holds, such as the menu's `/`, leaves the URL
 * as it was. A change of page drops the mark, as does a load of the same one (see `adopt`), and
 * swaps the panel's threads and the pins for the new page's. The pins are drawn again each time,
 * for what moved the page without a scroll or a change of its DOM.
 */
function track() {
  queuePins();
  let page = null;
  let shell = null;
  try {
    const at = frame.contentWindow.location;
    if (at.protocol === "about:") return;
    page = at.pathname + at.search;
    shell = pageOfLive(livePath(at.pathname)) && livePath(page);
  } catch {
    page = null;
  }
  if (page === state.page) return;
  state.page = page;
  clearSel();
  if (page === null) state.marking = false;
  if (shell) history.replaceState(history.state, "", shell);
  render();
}

/**
 * True when the key event `e` is text being typed, not a shortcut: its innermost target, inside
 * a component's shadow tree too, is a field or editable.
 */
function typing(e) {
  const [target = e.target] = e.composedPath();
  return /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || Boolean(target.isContentEditable);
}

/**
 * Esc closes the name sheet, else the composer with what was typed in it, else leaves Mark mode,
 * else, pressed in the shell and not in the page, closes the panel; `m` enters or leaves Mark
 * mode, unless it is being typed somewhere.
 */
function onKey(e) {
  if (e.key === "Escape" && asking()) return closeWho(false);
  if (asking()) return undefined;
  if (e.key === "Escape" && state.composing) {
    e.preventDefault();
    return closeComposer(true);
  }
  if (e.key === "Escape" && state.marking) {
    e.preventDefault();
    return setMarking(false);
  }
  if (e.key === "Escape" && state.open && e.currentTarget === window) {
    e.preventDefault();
    return setOpen(false);
  }
  if (e.ctrlKey || e.metaKey || e.altKey || typing(e) || e.key.toLowerCase() !== "m") return undefined;
  e.preventDefault();
  return setMarking(!state.marking);
}

/**
 * A page loaded in the iframe: hear its keys and its scrolls, watch its DOM for the pins, and
 * read where it is. A mark made on the page that was there goes, even when the new one has the
 * same path.
 */
function adopt() {
  const doc = pageDocument();
  doc?.addEventListener("keydown", onKey);
  doc?.addEventListener("scroll", scrolled, { capture: true, passive: true });
  watch.disconnect();
  if (doc) watch.observe(doc, { subtree: true, childList: true, attributes: true, characterData: true });
  queuePins();
  if (state.sel || drag) {
    clearSel();
    drawSel();
  }
  track();
}

/** Draw the toast for the draft it shows: what became of it, and the link or Retry that goes with it. */
function drawToast() {
  el("toast").hidden = !shown;
  if (!shown) return;
  const failed = shown.status === "failed";
  el("toast").classList.toggle("failed", failed);
  el("toast-text").textContent = failed ? `Not posted: ${shown.error}` : "Posted";
  el("spin").hidden = shown.status !== "shooting";
  el("open").hidden = shown.status !== "posted";
  if (shown.status === "posted") el("open").href = `/stills#thread=${encodeURIComponent(shown.id)}`;
  el("retry").hidden = !failed;
}

/**
 * Make `draft` the one the toast shows, null for the next that failed unseen or none. A failed
 * draft it takes the place of waits for its turn, so its Retry is not lost; a posted one hides
 * by itself after `TOAST_MS`.
 */
function show(draft) {
  clearTimeout(hiding);
  if (shown && shown !== draft && shown.status === "failed" && !waiting.includes(shown)) waiting.push(shown);
  shown = draft ?? waiting.shift() ?? null;
  if (shown?.status === "posted") hiding = setTimeout(() => show(null), TOAST_MS);
  drawToast();
}

/** Take the toast away: a failed draft on it is given up, one still being shot goes on unseen. */
function dismiss() {
  shown = null;
  show(null);
}

/** The draft `draft` was not posted, for the reason `error`: say so, now or after the failure on screen. */
function fail(draft, error) {
  draft.status = "failed";
  draft.error = error;
  pending.delete(draft.id);
  if (shown !== draft && shown?.status === "failed") {
    if (!waiting.includes(draft)) waiting.push(draft);
  } else show(draft);
}

/**
 * The stream said what became of the remark `id`: its thread is there, or with `error` it was
 * not posted. One the shell does not wait for is not its own, or is told twice, and is left;
 * while a remark is being sent its id is not known yet, so what is heard is kept for it.
 */
function settle(id, error) {
  const draft = pending.get(id);
  if (!draft) {
    if (flying) heard.set(id, error);
    return;
  }
  if (error !== null) return fail(draft, error);
  pending.delete(id);
  draft.status = "posted";
  if (shown?.status !== "failed") show(draft);
}

/**
 * Follow the review log above the event `since`: each event is folded into the threads, which
 * are drawn again when one changed them, and a thread that lands or a remark that failed
 * settles the draft that waits for it.
 */
function follow() {
  source?.close();
  source = new EventSource(`/_review/events?since=${since}`);
  source.onmessage = (message) => {
    const event = JSON.parse(message.data);
    if (applyThread(threads, event)) drawThreads();
    if (event.type === "thread") settle(event.id, null);
  };
  source.addEventListener("remark-failed", (message) => {
    const failed = JSON.parse(message.data);
    settle(failed.id, String(failed.error));
  });
}

/**
 * Read who is looking, where the log is and its threads, then follow the log from there and
 * draw the panel. A draft whose thread is among them was posted while nothing was heard.
 */
async function read() {
  const { me, cursor } = await answerOf(await fetch("/_review/stills", { cache: "no-store" }));
  const list = (await answerOf(await fetch("/_review/threads", { cache: "no-store" }))).threads;
  state.me = me;
  since = cursor;
  threads.splice(0, threads.length, ...list);
  follow();
  for (const id of [...pending.keys()]) if (threads.some((thread) => thread.id === id)) settle(id, null);
  drawThreads();
}

/**
 * Keep the shell in step with the review log: read it (see `read`) when it never was, or when
 * the browser gave up on the stream, one read at a time. Rejects when the server cannot be
 * asked.
 */
function sync() {
  if (state.me && source && source.readyState !== EventSource.CLOSED) return Promise.resolve();
  loading ??= read().finally(() => {
    loading = null;
  });
  return loading;
}

/**
 * What a post says of who writes it: nothing for a tailnet user, whom the server names, and
 * `{ author: { name } }` for a guest, asked for a name when this browser keeps none; null when
 * the guest gave none. Throws when the server cannot be asked who is looking.
 */
async function writer() {
  if (!state.me) await sync();
  if (state.me.via === "tailnet") return {};
  const name = keptName() || (await askName());
  return name ? { author: { name } } : null;
}

/**
 * Give `draft` its writer when it has none (see `writer`). True once it has one; false when the
 * guest gave no name, or with `draft.error` set when the server could not be asked.
 */
async function sign(draft) {
  draft.error = "";
  try {
    draft.who ??= await writer();
  } catch (e) {
    draft.error = e.message;
  }
  return Boolean(draft.who);
}

/**
 * Send `draft` to `POST /_review/remarks`, the toast on it. The runtime answers with the
 * remark's id at once and shoots in the background; the stream says what became of it (see
 * `settle`), which may have been heard already, or its thread read. A remark refused, or a
 * server not reached, fails the draft, which is kept.
 */
async function send(draft) {
  draft.status = "shooting";
  show(draft);
  sync().catch(() => {});
  flying += 1;
  try {
    const res = await fetch("/_review/remarks", { ...JSON_POST, body: JSON.stringify({ ...draft.request, ...draft.who }) });
    draft.id = (await answerOf(res)).id;
    pending.set(draft.id, draft);
    if (heard.has(draft.id)) settle(draft.id, heard.get(draft.id));
    else if (threads.some((thread) => thread.id === draft.id)) settle(draft.id, null);
  } catch (e) {
    fail(draft, e.message);
  } finally {
    flying -= 1;
    if (!flying) heard.clear();
  }
}

/**
 * Post the remark being composed: take the snapshot of the page as it is at this instant, the
 * marked elements stamped in it, then close the composer, leave Mark mode and send it. An
 * element no selector names alone, or that the page took out since it was marked, is left out of
 * the remark's elements, the mark then truncated; a page whose snapshot cannot be written is
 * posted without one, to be shot loaded again. A guest who gives no name stays in the composer,
 * and a Post whose composer was closed or whose mark changed while the writer was asked sends
 * nothing.
 */
async function post() {
  const { sel } = state;
  const doc = pageDocument();
  const view = doc?.defaultView;
  const body = el("say").value.trim();
  if (!sel?.elements || state.signing || !view || !body) return;
  const there = sel.elements.filter((target) => target.isConnected && target.ownerDocument === doc);
  const described = there.map(describe);
  const elements = described.filter((e) => e.selector);
  let shot = null;
  try {
    shot = snapshot(doc, there.filter((target, at) => described[at].selector));
  } catch {
    shot = null;
  }
  const request = {
    page: state.page,
    viewport: state.device,
    scroll: { x: Math.max(0, view.scrollX), y: Math.max(0, view.scrollY) },
    box: boxOf(sel.anchor),
    elements,
    ...(sel.truncated || elements.length < sel.elements.length ? { truncated: true } : {}),
    snapshot: shot,
    body,
  };
  const draft = { request, who: null, id: null, status: "shooting", error: "" };
  state.signing = true;
  drawComposer();
  const signed = await sign(draft);
  state.signing = false;
  if (state.sel !== sel || !state.composing) return drawComposer();
  if (!signed && !draft.error) {
    drawComposer();
    return el("say").focus();
  }
  setMarking(false);
  return signed ? send(draft) : fail(draft, draft.error);
}

/** Send the failed draft on the toast again, as it was; a guest who still gives no name leaves it failed. */
async function retry() {
  const draft = shown;
  if (draft?.status !== "failed" || state.signing) return undefined;
  const was = draft.error;
  state.signing = true;
  drawComposer();
  const signed = await sign(draft);
  state.signing = false;
  drawComposer();
  return signed ? send(draft) : fail(draft, draft.error || was);
}

/** Tell the style sheet how much of the window the on-screen keyboard covers, and keep the composer by the mark. */
function liftSheets() {
  const covered = Math.max(0, innerHeight - visualViewport.height - visualViewport.offsetTop);
  root.style.setProperty("--keyboard", `${covered}px`);
  placeComposer();
}

el("devices").replaceChildren(
  ...DEVICES.map((name) => {
    const button = document.createElement("button");
    button.textContent = classLabel(name);
    button.dataset.device = name;
    button.onclick = () => setDevice(name);
    return button;
  })
);
for (const button of document.querySelectorAll(".marker")) button.onclick = () => setMarking(!state.marking);
el("cancel").onclick = () => setMarking(false);
el("comment").onclick = compose;
el("discard").onclick = () => closeComposer(true);
el("say").oninput = drawComposer;
el("say").onkeydown = (e) => {
  if (e.key !== "Enter" || !(e.ctrlKey || e.metaKey)) return;
  e.preventDefault();
  post();
};
el("composer").onsubmit = (e) => {
  e.preventDefault();
  post();
};
for (const button of document.querySelectorAll(".lister")) button.onclick = () => setOpen(!state.open);
el("shut").onclick = () => setOpen(false);
el("retry").onclick = retry;
el("dismiss").onclick = dismiss;
layer.addEventListener("pointerdown", startDrag);
layer.addEventListener("pointermove", moveDrag);
layer.addEventListener("pointerup", endDrag);
layer.addEventListener("pointercancel", cancelDrag);
layer.addEventListener("pointerleave", () => {
  el("hover").hidden = true;
});
layer.addEventListener("wheel", wheel, { passive: false });
layer.addEventListener("contextmenu", (e) => e.preventDefault());
frame.addEventListener("load", adopt);
addEventListener("keydown", onKey);
new ResizeObserver(() => {
  layout();
  placeComposer();
}).observe(document.querySelector("main"));
window.visualViewport?.addEventListener("resize", liftSheets);
window.visualViewport?.addEventListener("scroll", liftSheets);
setInterval(track, TRACK_MS);
setInterval(drawTimes, TIMES_MS);
setInterval(() => sync().catch(() => {}), SYNC_MS);

layout();
render();
if (state.page !== null) frame.src = state.page + location.hash;
sync().catch(() => {});
