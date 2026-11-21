/**
 * The name sheet of the stills viewer and the live shell: a guest, whom the tailnet did not
 * name, is asked once what to write under, and this browser keeps the answer. The page has the
 * sheet's markup, `#who` with its form, `#who-name`, `#continue` and `#who-close`; this module
 * wires it when it loads.
 */

import { MAX_NAME, store, stored } from "./state.js";

const NAME_KEY = "review.name";

let done = null;

/** The element with the id `id`. */
function el(id) {
  return document.getElementById(id);
}

/** The name a guest gave in this browser, empty when it keeps none. */
export function keptName() {
  return (stored(NAME_KEY) || "").trim().slice(0, MAX_NAME);
}

/** True while the name sheet is open. */
export function asking() {
  return Boolean(done);
}

/**
 * Open the name sheet on the name this browser keeps, with the keyboard up. Resolves to the
 * name when it is continued, which keeps it, and to null when it is cancelled.
 */
export function askName() {
  closeWho(false);
  el("who-name").value = keptName();
  el("continue").disabled = !el("who-name").value;
  el("who").hidden = false;
  el("who-name").focus();
  return new Promise((resolve) => {
    done = resolve;
  });
}

/** Close the name sheet: with `ok`, keeping the name typed in it, which it then needs; else as cancelled. */
export function closeWho(ok) {
  const resolve = done;
  const name = el("who-name").value.trim().slice(0, MAX_NAME);
  if (!resolve || (ok && !name)) return;
  done = null;
  el("who").hidden = true;
  el("who-name").blur();
  if (ok) store(NAME_KEY, name);
  resolve(ok ? name : null);
}

el("who-name").maxLength = MAX_NAME;
el("who-form").onsubmit = (e) => {
  e.preventDefault();
  closeWho(true);
};
el("who-name").oninput = () => {
  el("continue").disabled = !el("who-name").value.trim();
};
el("who-close").onclick = () => closeWho(false);
el("who").onclick = (e) => {
  if (e.target === el("who")) closeWho(false);
};
