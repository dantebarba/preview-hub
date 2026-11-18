/**
 * The state of the stills viewer, free of the DOM so the runtime's tests can import it.
 *
 * A still is an entry of `GET /_review/stills`: `{ name, title, source, revs, mark }`, with
 * `mark` its reviewed mark `{ rev, viewed, reviewed, changed }` as `reviewed()` of the review
 * store folds it. The functions here keep those marks in step with the event log, decide
 * where ←/→, Home/End and a swipe land, shape the anchor of a remark being drawn (a pin or a
 * region, in coordinates normalized to the still) and fold the log's threads. The runtime and
 * the viewer share from here the URL of a file of the scratch dir and the limit of an annotated
 * still's upload.
 *
 * For the mobile layout they also hold the zoom and pan of the still. A view is `{ z, x, y }`:
 * the zoom, 1 being the still fitted to the width of its room, and where the still's top left
 * corner is in the room, in pixels. A box is the room and the still in it: `{ vw, vh, ratio }`,
 * the room's width and height in pixels and the still's height over its width. And for the
 * conversation cards: a card's title, latest message, status chip, unread replies and the crop
 * of the still around its mark.
 */

/** The prefix of the data URL an annotated still is posted as. */
export const PNG_URL = "data:image/png;base64,";

/** The most bytes an annotated still's PNG may hold. */
export const MAX_ANNOTATED_BYTES = 8 * 1024 * 1024;

/** The URL of a file of the scratch dir, from its path relative to it. */
export function fileUrl(rel) {
  return `/${String(rel).split("/").map(encodeURIComponent).join("/")}`;
}

/** The reviewed mark of a still whose latest revision is `rev` and whose marked one is `viewed`. */
export function markOf(rev, viewed) {
  return { rev, viewed, reviewed: viewed !== null && viewed === rev, changed: viewed !== null && viewed < rev };
}

/**
 * Fold one log event into `stills`: a `viewed` sets the marked revision of its still, an
 * `unviewed` clears it. True when a mark changed, so the caller knows to draw again.
 */
export function applyEvent(stills, event) {
  if (event.type !== "viewed" && event.type !== "unviewed") return false;
  const still = stills.find((s) => s.name === event.still);
  if (!still) return false;
  still.mark = markOf(still.mark.rev, event.type === "viewed" ? event.rev : null);
  return true;
}

/** True when the still at `i` is one to step onto: any still with `all`, else one not reviewed. */
function stop(stills, i, all) {
  return all || !stills[i].mark.reviewed;
}

/**
 * The index `delta` (1 or -1) steps to from `at`, wrapping around: the next still that is not
 * reviewed, or just the next one with `all`. `at` itself when there is nowhere else to go.
 */
export function step(stills, at, delta, all) {
  const n = stills.length;
  for (let k = 1; k < n; k++) {
    const i = (((at + delta * k) % n) + n) % n;
    if (stop(stills, i, all)) return i;
  }
  return at;
}

/** The first (or with `last`, the last) still to step onto, or `at` when there is none. */
export function edge(stills, at, last, all) {
  const order = stills.map((_, i) => i);
  if (last) order.reverse();
  const i = order.find((j) => stop(stills, j, all));
  return i === undefined ? at : i;
}

/** How many stills are reviewed, of how many: `{ reviewed, total }`. */
export function counts(stills) {
  return { reviewed: stills.filter((s) => s.mark.reviewed).length, total: stills.length };
}

const MIN_SIDE = 0.01;
const STEP = 0.0001;

/** `v` kept inside 0..1. */
function unit(v) {
  return Math.min(1, Math.max(0, v));
}

/** `v` rounded to the four decimals an anchor is stored with. */
function round(v) {
  return Math.round(v / STEP) / (1 / STEP);
}

/**
 * One side of an anchor, `[start, size]` rounded, with `start + size` never past 1: a start
 * that rounding pushed over the edge steps back.
 */
function side(start, size) {
  let lo = round(start);
  const length = round(size);
  while (lo + length > 1) lo = round(lo - STEP);
  return [Math.max(0, lo), length];
}

/** The pin anchor `{ x, y }` at the point `p`, kept inside the still. */
export function pin(p) {
  return { x: round(unit(p.x)), y: round(unit(p.y)) };
}

/**
 * The region anchor `{ x, y, w, h }` between the points `a` and `b`, two opposite corners in
 * any order, kept inside the still and at least a hundredth of it on each side.
 */
export function region(a, b) {
  const between = (p, q) => {
    const lo = unit(Math.min(p, q));
    const size = Math.max(MIN_SIDE, unit(Math.max(p, q)) - lo);
    return side(Math.min(lo, 1 - size), size);
  };
  const [x, w] = between(a.x, b.x);
  const [y, h] = between(a.y, b.y);
  return { x, y, w, h };
}

/** `anchor`, a pin or a region, moved by `dx` and `dy` without leaving the still or changing size. */
export function moved(anchor, dx, dy) {
  if (anchor.w === undefined) return pin({ x: anchor.x + dx, y: anchor.y + dy });
  const [x, w] = side(Math.min(1 - anchor.w, Math.max(0, anchor.x + dx)), anchor.w);
  const [y, h] = side(Math.min(1 - anchor.h, Math.max(0, anchor.y + dy)), anchor.h);
  return { x, y, w, h };
}

/**
 * The corner of the region `anchor` opposite the one named `name` ("nw", "ne", "sw" or "se"):
 * the point that stays put while that corner is dragged, to pass to `region` with the pointer.
 */
export function opposite(anchor, name) {
  return {
    x: anchor.x + (name.includes("w") ? anchor.w : 0),
    y: anchor.y + (name.includes("n") ? anchor.h : 0),
  };
}

/**
 * Fold one log event into `threads`, the list `GET /_review/threads` answers, as `threads()`
 * of the review store does: a `thread` opens one, a `reply` joins its thread, a `resolve` or a
 * `reopen` sets its status. An event the list already holds (a thread of that id, or a `seq`
 * not above the thread's last) changes nothing, so events may be folded again in log order;
 * threads stay in the order they were opened even when one is folded early.
 * True when the list changed.
 */
export function applyThread(threads, event) {
  if (event.type === "thread") {
    if (threads.some((t) => t.id === event.id)) return false;
    threads.push({
      id: event.id,
      still: event.still,
      rev: event.rev ?? null,
      anchor: event.anchor ?? null,
      body: event.body,
      author: event.author,
      at: event.at,
      seq: event.seq,
      status: "open",
      replies: [],
      updated: event.seq,
    });
    threads.sort((a, b) => a.seq - b.seq);
    return true;
  }
  if (event.type !== "reply" && event.type !== "resolve" && event.type !== "reopen") return false;
  const thread = threads.find((t) => t.id === event.thread);
  if (!thread || event.seq <= thread.updated) return false;
  thread.updated = event.seq;
  if (event.type === "reply") {
    thread.replies.push({ id: event.id, author: event.author, body: event.body, at: event.at, seq: event.seq });
  } else {
    thread.status = event.type === "resolve" ? "resolved" : "open";
  }
  return true;
}

/** The most a still zooms in, as a multiple of its fitted size. */
export const MAX_ZOOM = 8;

const FOCUS_ZOOM = 4;
const PIN_ZOOM = 2;
const FOCUS_WIDTH = 0.6;
const FOCUS_HEIGHT = 0.7;

/** `z` kept between the fitted size and `max` times it. */
function zoom(z, max = MAX_ZOOM) {
  return Math.min(max, Math.max(1, z));
}

/**
 * Where something `size` long starts in a room `room` long when it is wanted at `at`: in the
 * middle when it is shorter than the room, else as near `at` as leaves no gap at either end.
 */
function within(at, size, room) {
  return size <= room ? (room - size) / 2 : Math.min(0, Math.max(room - size, at));
}

/**
 * `view` kept in `box`: the zoom within 1..MAX_ZOOM, and the still never pulled away from an
 * edge of the room it reaches past; along a side where it is smaller than the room it sits in
 * the middle.
 */
export function fitted(view, box) {
  const z = zoom(view.z);
  return { z, x: within(view.x, box.vw * z, box.vw), y: within(view.y, box.vw * box.ratio * z, box.vh) };
}

/**
 * `view` zoomed by `factor` and dragged so that the spot of the still that was under the point
 * `from` of the room is under `to`: a pinch between two finger midpoints, a pan with a factor
 * of 1, a zoom in place with `from` equal to `to`. Kept in `box`.
 */
export function zoomed(view, from, to, factor, box) {
  const z = zoom(view.z * factor);
  const k = z / view.z;
  return fitted({ z, x: to.x - (from.x - view.x) * k, y: to.y - (from.y - view.y) * k }, box);
}

/** The view at zoom `z` with the middle of `anchor` in the middle of the room, kept in `box`. */
function centered(anchor, box, z) {
  const width = box.vw * z;
  const cx = (anchor.x + (anchor.w ?? 0) / 2) * width;
  const cy = (anchor.y + (anchor.h ?? 0) / 2) * width * box.ratio;
  return fitted({ z, x: box.vw / 2 - cx, y: box.vh / 2 - cy }, box);
}

/**
 * The view that shows `anchor` up close: a region zoomed until it takes most of the room, a pin
 * at twice the fitted size, in the middle of the room as far as the still's edges allow.
 */
export function viewOn(anchor, box) {
  if (anchor.w === undefined) return centered(anchor, box, PIN_ZOOM);
  const tall = anchor.h * box.vw * box.ratio;
  const z = Math.min(FOCUS_WIDTH / anchor.w, tall ? (FOCUS_HEIGHT * box.vh) / tall : FOCUS_ZOOM);
  return centered(anchor, box, zoom(z, FOCUS_ZOOM));
}

/** `view` when all of `anchor` is in the room, else the view at the same zoom with it in the middle. */
export function revealed(view, anchor, box) {
  const width = box.vw * view.z;
  const height = width * box.ratio;
  const left = view.x + anchor.x * width;
  const top = view.y + anchor.y * height;
  const right = left + (anchor.w ?? 0) * width;
  const bottom = top + (anchor.h ?? 0) * height;
  return left >= 0 && top >= 0 && right <= box.vw && bottom <= box.vh ? view : centered(anchor, box, view.z);
}

const CROP_MARGIN = 1.5;
const CROP_LEAST = 0.35;

/**
 * Where to put an image of size `image` (`{ w, h }`) in a frame of size `frame` so the frame
 * shows the area of `anchor` with some of what is around it: `{ width, height, left, top }` of
 * the scaled image, in the frame's pixels. A pin, or a small region, shows at least a third of
 * the image's width; the image never leaves a gap in the frame it could fill.
 */
export function cropOf(anchor, image, frame) {
  const w = (anchor.w ?? 0) * image.w;
  const h = (anchor.h ?? 0) * image.h;
  const least = CROP_LEAST * image.w;
  const across = frame.w / Math.max(w * CROP_MARGIN, least);
  const scale = Math.min(across, frame.h / Math.max(h * CROP_MARGIN, (least * frame.h) / frame.w));
  const width = image.w * scale;
  const height = image.h * scale;
  return {
    width,
    height,
    left: within(frame.w / 2 - (anchor.x * image.w + w / 2) * scale, width, frame.w),
    top: within(frame.h / 2 - (anchor.y * image.h + h / 2) * scale, height, frame.h),
  };
}

/** The title of a remark: the first line of `body` that says something. */
export function title(body) {
  return body.split("\n").map((line) => line.trim()).find(Boolean) ?? "";
}

/** The latest message of `thread`: its last reply, or the remark itself while it has none. */
export function lastMessage(thread) {
  return thread.replies.at(-1) ?? thread;
}

/** How long ago `then` was at `now`, both in milliseconds, in a few characters: "now", "2m", "3h", "4d". */
export function ago(then, now) {
  const minutes = Math.floor((now - then) / 60000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h`;
  return `${Math.floor(minutes / 1440)}d`;
}

/**
 * The status chip of `thread` on a still whose latest revision is `rev`: "resolved", "moved"
 * for an open one made on a revision the still has moved on from, else "open".
 */
export function chip(thread, rev) {
  if (thread.status !== "open") return "resolved";
  return thread.rev !== null && thread.rev !== rev ? "moved" : "open";
}

/**
 * How many replies of `thread` came after the last one seen on this device, `seen` mapping a
 * thread's id to that reply's `seq`; with `kind`, only those written by an author of that kind.
 */
export function unread(thread, seen, kind) {
  const last = Object.hasOwn(seen, thread.id) ? seen[thread.id] : 0;
  return thread.replies.filter((r) => r.seq > last && (!kind || r.author.kind === kind)).length;
}
