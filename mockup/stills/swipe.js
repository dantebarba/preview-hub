/**
 * The swipe that slides a card aside to uncover an action behind it, the gesture of the hub's
 * preview cards with a second side: a horizontal touch drag moves the card with the finger and,
 * let go past half of `width`, leaves it open to that side.
 *
 * The open side is the slot's `data-open`, "left" after a swipe to the left and "right" after
 * one to the right; while the finger is down the slot has `data-dragging` and the distance in
 * `--dx`. Vertical drags are left to the browser so the list still scrolls, a mouse does not
 * swipe, and the click that ends a swipe, or a tap on an open card, which closes it, never
 * reaches the card. The touch moves of a swipe are kept from the browser, which would take a
 * quick one for a fling and swallow the tap on the action it uncovered.
 */

const SLOP_PX = 8;
const OVERSHOOT = 1.4;

/**
 * Make `card` swipe inside `slot`, uncovering actions `width` pixels wide on either side.
 * `changed(side)` hears the side it was left open to, or null when it closed.
 */
export function swipeable(slot, card, width, changed) {
  let drag = null;
  let swallow = false;

  const open = (side) => {
    if (side) slot.dataset.open = side;
    else delete slot.dataset.open;
    changed(side);
  };

  card.addEventListener(
    "click",
    (event) => {
      const closing = !swallow && slot.dataset.open;
      if (!swallow && !closing) return;
      swallow = false;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (closing) open(null);
    },
    true
  );

  card.addEventListener("pointerdown", (event) => {
    swallow = false;
    if (event.pointerType === "mouse") return;
    const side = slot.dataset.open;
    drag = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      base: side === "left" ? -width : side === "right" ? width : 0,
      dx: 0,
      swiping: false,
    };
  });

  card.addEventListener("pointermove", (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const mx = event.clientX - drag.x;
    const my = event.clientY - drag.y;
    if (!drag.swiping) {
      if (Math.abs(mx) < SLOP_PX && Math.abs(my) < SLOP_PX) return;
      if (Math.abs(my) >= Math.abs(mx)) {
        drag = null;
        return;
      }
      drag.swiping = true;
      card.setPointerCapture(event.pointerId);
      slot.setAttribute("data-dragging", "");
    }
    drag.dx = Math.min(width * OVERSHOOT, Math.max(-width * OVERSHOOT, drag.base + mx));
    slot.style.setProperty("--dx", `${drag.dx}px`);
  });

  card.addEventListener(
    "touchmove",
    (event) => {
      if (drag?.swiping && event.cancelable) event.preventDefault();
    },
    { passive: false }
  );

  const end = (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const { swiping, dx } = drag;
    drag = null;
    if (!swiping) return;
    slot.removeAttribute("data-dragging");
    slot.style.removeProperty("--dx");
    if (event.type === "pointercancel") return;
    swallow = true;
    open(dx < -width / 2 ? "left" : dx > width / 2 ? "right" : null);
  };
  card.addEventListener("pointerup", end);
  card.addEventListener("pointercancel", end);
}
