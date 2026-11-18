/**
 * The state of the stills viewer, free of the DOM so the runtime's tests can import it.
 *
 * A still is an entry of `GET /_review/stills`: `{ name, title, source, revs, mark }`, with
 * `mark` its reviewed mark `{ rev, viewed, reviewed, changed }` as `reviewed()` of the review
 * store folds it. The functions here keep those marks in step with the event log, decide
 * where ←/→, Home/End and a swipe land, shape the anchor of a remark being drawn (a pin or a
 * region, in coordinates normalized to the still) and fold the log's threads.
 */

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
