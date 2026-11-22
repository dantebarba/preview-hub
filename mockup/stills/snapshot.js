/**
 * The DOM snapshot of a live page: the document as the reviewer has it, written as one HTML
 * string the runtime renders in a Chromium of its own (`renderSnapshot` of `capture.mjs`), so a
 * remark's shot shows the state it was made on rather than a fresh load of the page's path.
 * Runs in the shell against the page's iframe, which shares its origin; no dependencies.
 *
 * What the HTML holds, and what it leaves out:
 *
 * - No `<script>`, `<noscript>`, inline event handler or `<meta http-equiv>`, and an `<iframe>`
 *   without its `src` and `srcdoc`: nothing runs or navigates when it is rendered.
 * - A `<base href>` first in the head, the page's base URL without its origin when it is the
 *   page's own, so assets load from whichever origin the snapshot is rendered on; URLs of an
 *   inlined style sheet are written the same way, as are the page's own absolute URLs in
 *   `src`, `srcset`, `href`, `poster` and `xlink:href`.
 * - Form state as attributes: `value`, `checked`, `selected`, a `<textarea>`'s text, and
 *   `data-pv-indeterminate` on a checkbox in that state.
 * - Open shadow roots as declarative shadow DOM (`<template shadowrootmode="open">`); a closed
 *   one cannot be read and is left out.
 * - Styles as the CSSOM holds them, rules added with `insertRule` included: each `<style>` and
 *   each readable `<link rel=stylesheet>` becomes a `<style>` of its rules, in place; a
 *   cross-origin sheet stays a `<link>`; a disabled sheet is dropped. `adoptedStyleSheets`
 *   become `<style data-pv-adopted>` at the end of the head or of the shadow root.
 * - A `<canvas>` as an `<img>` of its pixels, unless it is tainted.
 * - `data-pv-modal` on a dialog open as a modal and `data-pv-popover` on an open popover, for
 *   the renderer to put back in the top layer, backdrop included.
 * - `data-pv-scroll="x,y"` on every element scrolled away from 0 but the document's own
 *   scroller, and `data-pv-mark="<i>"` on the i-th marked element.
 */

/** The most bytes a snapshot's HTML may be, as UTF-8. */
export const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;

const DROPPED = new Set(["script", "noscript", "base"]);
const TOGGLES = new Set(["checkbox", "radio"]);
const URL_IN_CSS = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)"'\s]*))\s*\)/g;
const URL_ATTRIBUTES = new Set(["src", "href", "poster", "xlink:href"]);

/** True when `el` matches `selector`; false too where the browser does not know the selector. */
function matches(el, selector) {
  try {
    return el.matches(selector);
  } catch {
    return false;
  }
}

/** `url`, resolved against `from`, without its origin when that is `origin`. */
function rooted(url, from, origin) {
  let u;
  try {
    u = new URL(url, from);
  } catch {
    return url;
  }
  return u.origin === origin ? `${u.pathname}${u.search}${u.hash}` : u.href;
}

/** The absolute http(s) URL `url` without its origin when that is `origin`; anything else as it is. */
function local(url, origin) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return url;
  }
  return /^https?:$/.test(u.protocol) && u.origin === origin ? `${u.pathname}${u.search}${u.hash}` : url;
}

/**
 * Write each URL attribute of `clone` (`src`, `href`, `poster`, `xlink:href` and each URL of a
 * `srcset`) that names the page's own origin without it, so it loads from the origin the
 * snapshot is rendered on.
 */
function localAttributes(clone, origin) {
  for (const attr of clone.attributes) {
    if (attr.name === "srcset") {
      attr.value = attr.value.replace(/(^|,)(\s*)([^\s,]\S*)/g, (all, comma, space, url) => `${comma}${space}${local(url, origin)}`);
    } else if (URL_ATTRIBUTES.has(attr.name)) {
      attr.value = local(attr.value, origin);
    }
  }
}

/** `css` with each `url()` resolved against `from`, the sheet it was linked from. */
function rebased(css, from, origin) {
  return css.replace(URL_IN_CSS, (all, double, single, bare) => {
    const url = double ?? single ?? bare;
    if (!url || url.startsWith("#") || url.startsWith("data:")) return all;
    return `url("${rooted(url, from, origin)}")`;
  });
}

/**
 * The rules of `sheet` as CSS text that cannot close the `<style>` it is written in, or null
 * for a sheet whose rules cannot be read (another origin's).
 */
function cssOf(sheet, origin) {
  let rules;
  try {
    rules = sheet.cssRules;
  } catch {
    return null;
  }
  const css = Array.from(rules, (rule) => rule.cssText).join("\n");
  return (sheet.href ? rebased(css, sheet.href, origin) : css).replace(/<\/(style)/gi, "<\\/$1");
}

/** A `<style>` of `ctx.inert` holding `css`, for the media `sheet` is for. */
function styleOf(ctx, sheet, css) {
  const style = ctx.inert.createElement("style");
  if (sheet.media.mediaText) style.setAttribute("media", sheet.media.mediaText);
  style.textContent = css;
  return style;
}

/** Append to `into` a `<style data-pv-adopted>` for each sheet `root` has adopted. */
function appendAdopted(ctx, root, into) {
  for (const sheet of root.adoptedStyleSheets ?? []) {
    const css = sheet.disabled ? null : cssOf(sheet, ctx.origin);
    if (css === null) continue;
    const style = styleOf(ctx, sheet, css);
    style.setAttribute("data-pv-adopted", "");
    into.append(style);
  }
}

/** An `<img>` of `ctx.inert` with the attributes and the pixels of the canvas `el`. */
function canvasImage(ctx, el) {
  const img = ctx.inert.createElement("img");
  for (const { name, value } of el.attributes) img.setAttribute(name, value);
  try {
    img.setAttribute("src", el.toDataURL());
    ctx.inline.push({ img, el });
  } catch {
    img.removeAttribute("src");
  }
  return img;
}

/** Write the form state, open state and loading of `el` on its copy `clone`. */
function writeState(ctx, el, clone) {
  switch (el.localName) {
    case "input":
      if (TOGGLES.has(el.type)) {
        clone.toggleAttribute("checked", el.checked);
        clone.toggleAttribute("data-pv-indeterminate", Boolean(el.indeterminate));
      } else if (el.type !== "file") {
        clone.setAttribute("value", el.value);
      }
      break;
    case "option":
      clone.toggleAttribute("selected", el.selected);
      break;
    case "textarea":
      clone.textContent = el.value.startsWith("\n") ? `\n${el.value}` : el.value;
      break;
    case "iframe":
      clone.removeAttribute("src");
      clone.removeAttribute("srcdoc");
      clone.removeAttribute("loading");
      break;
    case "img":
      clone.removeAttribute("loading");
      if (/^data:/i.test(clone.getAttribute("src") ?? "")) ctx.inline.push({ img: clone, el });
      break;
    case "template":
      clone.removeAttribute("shadowrootmode");
      break;
    case "dialog":
      clone.toggleAttribute("data-pv-modal", matches(el, ":modal"));
      break;
    default:
  }
  if (el.hasAttribute("popover")) clone.toggleAttribute("data-pv-popover", matches(el, ":popover-open"));
}

/** Append to `into` the copies of the children of `parent`, an element or a shadow root. */
function appendChildren(ctx, parent, into) {
  for (const child of parent.childNodes) {
    const copy = copyOf(ctx, child);
    if (copy) into.append(copy);
  }
}

/**
 * The copy of `node` and what is under it in `ctx.inert`, a document where nothing loads or
 * runs, or null for a node the snapshot leaves out.
 */
function copyOf(ctx, node) {
  if (node.nodeType === 3) return ctx.inert.createTextNode(node.data);
  if (node.nodeType !== 1) return null;
  const el = node;
  const tag = el.localName;
  if (DROPPED.has(tag) || (tag === "meta" && el.hasAttribute("http-equiv"))) return null;
  const sheet = tag === "style" || tag === "link" ? el.sheet : null;
  if (sheet?.disabled) return null;
  const css = sheet ? cssOf(sheet, ctx.origin) : null;
  if (css !== null && tag === "link") return styleOf(ctx, sheet, css);
  const clone = tag === "canvas" ? canvasImage(ctx, el) : ctx.inert.importNode(el, false);
  for (const { name } of [...clone.attributes]) {
    if (/^on/i.test(name) || name.startsWith("data-pv-")) clone.removeAttribute(name);
  }
  localAttributes(clone, ctx.origin);
  writeState(ctx, el, clone);
  if (el !== ctx.scroller && (el.scrollLeft || el.scrollTop)) {
    clone.setAttribute("data-pv-scroll", `${el.scrollLeft},${el.scrollTop}`);
    ctx.scrollers += 1;
  }
  if (ctx.marks.has(el)) clone.setAttribute("data-pv-mark", String(ctx.marks.get(el)));
  if (css !== null) {
    clone.textContent = css;
    return clone;
  }
  if (tag === "canvas" || tag === "textarea" || tag === "template") return clone;
  if (el.shadowRoot) {
    const template = ctx.inert.createElement("template");
    template.setAttribute("shadowrootmode", "open");
    appendChildren(ctx, el.shadowRoot, template.content);
    appendAdopted(ctx, el.shadowRoot, template.content);
    clone.append(template);
  }
  appendChildren(ctx, el, clone);
  return clone;
}

/** The `<head>` of the copied `<html>` `root`, made first in it when the page has none. */
function headOf(ctx, root) {
  const head = [...root.children].find((child) => child.localName === "head");
  if (head) return head;
  const made = ctx.inert.createElement("head");
  root.prepend(made);
  return made;
}

/** The `<!DOCTYPE>` of a document whose doctype is `type`, empty without one, so the mode stays. */
function doctypeOf(type) {
  if (!type) return "";
  const system = type.systemId ? ` "${type.systemId}"` : "";
  const ids = type.publicId ? ` PUBLIC "${type.publicId}"${system}` : system && ` SYSTEM${system}`;
  return `<!DOCTYPE ${type.name}${ids}>`;
}

/** `bytes` in MiB, to one decimal. */
function mib(bytes) {
  return (bytes / (1024 * 1024)).toFixed(1);
}

/**
 * The snapshot of the document `doc` as it is now, `{ html, viewport, scroll, scrollers }`:
 * `html` as the module says, with `data-pv-mark="<i>"` on `marked[i]`, the elements of `doc` a
 * remark is on; `viewport` `{ width, height }`, the window's size, and `scroll` `{ x, y }`, its
 * scroll, in CSS pixels; `scrollers` how many elements carry `data-pv-scroll`. An HTML over
 * `MAX_SNAPSHOT_BYTES` is written again with its inline images (a canvas's pixels, an `<img>`
 * with a `data:` source) left out, each keeping its size; one still over throws, naming the size.
 */
export function snapshot(doc, marked = []) {
  const win = doc.defaultView;
  const ctx = {
    inert: doc.implementation.createHTMLDocument(""),
    origin: new URL(doc.baseURI).origin,
    scroller: doc.scrollingElement,
    marks: new Map(marked.map((el, i) => [el, i])),
    inline: [],
    scrollers: 0,
  };
  const root = copyOf(ctx, doc.documentElement);
  const head = headOf(ctx, root);
  const base = ctx.inert.createElement("base");
  base.setAttribute("href", rooted(doc.baseURI, doc.baseURI, doc.location.origin));
  head.prepend(base);
  appendAdopted(ctx, doc, head);
  const doctype = doctypeOf(doc.doctype);
  const write = () => `${doctype}${root.outerHTML}`;
  const size = (text) => new Blob([text]).size;
  let html = write();
  if (size(html) > MAX_SNAPSHOT_BYTES) {
    for (const { img, el } of ctx.inline) {
      img.removeAttribute("src");
      img.removeAttribute("srcset");
      img.setAttribute("width", String(el.offsetWidth));
      img.setAttribute("height", String(el.offsetHeight));
    }
    html = write();
  }
  const bytes = size(html);
  if (bytes > MAX_SNAPSHOT_BYTES) {
    throw new Error(`the page's snapshot is ${mib(bytes)} MiB, over the ${mib(MAX_SNAPSHOT_BYTES)} MiB a remark can carry`);
  }
  return {
    html,
    viewport: { width: win.innerWidth, height: win.innerHeight },
    scroll: { x: win.scrollX, y: win.scrollY },
    scrollers: ctx.scrollers,
  };
}
