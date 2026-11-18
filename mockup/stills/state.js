/**
 * The state of the stills viewer, free of the DOM so the runtime's tests can import it.
 *
 * A still is an entry of `GET /_review/stills`: `{ name, title, source, revs, mark }`, with
 * `mark` its reviewed mark `{ rev, viewed, reviewed, changed }` as `reviewed()` of the review
 * store folds it. The functions here keep those marks in step with the event log and decide
 * where ←/→, Home/End and a swipe land.
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
