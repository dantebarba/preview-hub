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
 * Every text the shell shows is in the copy table of the epic (#58); what state it is in shows
 * by styling, not by sentences.
 */

import {
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

const kept = stored(DEVICE_KEY);
const state = {
  page: pageOfLive(location.pathname, location.search),
  device: DEVICES.includes(kept) ? kept : classOf(`custom-${innerWidth}x${innerHeight}`),
  marking: false,
  sel: null,
  composing: false,
  signing: false,
  me: null,
};
const root = document.documentElement;
const frame = el("frame");
const layer = el("layer");
const fingers = new Map();
const pending = new Map();
const heard = new Map();
const waiting = [];
let scale = 1;
let drag = null;
let pan = null;
let source = null;
let since = null;
let flying = 0;
let shown = null;
let hiding = null;

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
 * what was typed in the composer.
 */
function setMarking(on) {
  if (on && state.page === null) return;
  state.marking = on;
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
 * as it was. A change of page drops the mark, as does a load of the same one (see `adopt`).
 */
function track() {
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
 * Esc closes the name sheet, else the composer with what was typed in it, else leaves Mark mode;
 * `m` enters or leaves it, unless it is being typed somewhere.
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
  if (e.ctrlKey || e.metaKey || e.altKey || typing(e) || e.key.toLowerCase() !== "m") return undefined;
  e.preventDefault();
  return setMarking(!state.marking);
}

/**
 * A page loaded in the iframe: hear its keys and its scrolls, and read where it is. A mark made
 * on the page that was there goes, even when the new one has the same path.
 */
function adopt() {
  const doc = pageDocument();
  doc?.addEventListener("keydown", onKey);
  doc?.addEventListener("scroll", scrolled, { capture: true, passive: true });
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
 * Follow the review log above the event `since`, once it is known: the threads that land and the
 * remarks that failed. A stream the browser gave up on is opened again, from the same event, so
 * a thread that landed meanwhile is told again.
 */
function follow() {
  if (since === null || (source && source.readyState !== EventSource.CLOSED)) return;
  source = new EventSource(`/_review/events?since=${since}`);
  source.onmessage = (message) => {
    const event = JSON.parse(message.data);
    if (event.type === "thread") settle(event.id, null);
  };
  source.addEventListener("remark-failed", (message) => {
    const failed = JSON.parse(message.data);
    settle(failed.id, String(failed.error));
  });
}

/**
 * What a remark says of who posts it: nothing for a tailnet user, whom the server names, and
 * `{ author: { name } }` for a guest, asked for a name when this browser keeps none; null when
 * the guest gave none. Asking the server who is looking also tells where its log is, from where
 * the shell follows it. Throws when the server cannot be asked.
 */
async function writer() {
  if (!state.me) {
    const { me, cursor } = await answerOf(await fetch("/_review/stills", { cache: "no-store" }));
    since ??= cursor;
    state.me = me;
  }
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
 * `settle`), which may have been heard already. A remark refused, or a server not reached, fails
 * the draft, which is kept.
 */
async function send(draft) {
  draft.status = "shooting";
  show(draft);
  follow();
  flying += 1;
  try {
    const res = await fetch("/_review/remarks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...draft.request, ...draft.who }),
    });
    draft.id = (await answerOf(res)).id;
    pending.set(draft.id, draft);
    if (heard.has(draft.id)) settle(draft.id, heard.get(draft.id));
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
  const elements = there.map(describe).filter((e) => e.selector);
  let shot = null;
  try {
    shot = snapshot(doc, there);
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

layout();
render();
if (state.page !== null) frame.src = state.page + location.hash;
