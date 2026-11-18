/**
 * What a folder source (see `source.mjs`) adds to the stills viewer, beyond its stills. A folder
 * is named here by the handle `folder(dir)` returns, the `scratch` the runtime's review routes
 * take; a mockup's own scratch dir, a plain path, adds nothing.
 *
 *   sourceExtras(scratch)   { groups, notes, writable, about } for `GET /_review/stills`
 *   aboutPage(dir)          the README as sanitized HTML, for `GET /_review/about`
 *   sourceFile(dir, rel)    an image of the folder, for `GET /_review/file/<rel>`
 *   watchSource(dir, fn)    calls `fn` when the folder's images or extras change
 *
 * The About page is rendered here, never in the browser, by the markdown-it vendored in
 * `vendor/` (14.1.0, pinned by its file name) with raw HTML off: tags in the README show as
 * text, apart from `<img>` and `<br>`, which are read as their markdown. What leaves is
 * sanitized by construction:
 *
 *   - no raw HTML and no scripts; `javascript:`, `vbscript:`, `file:` and `data:` links are not
 *     links (markdown-it's own `validateLink`);
 *   - an `http(s)` or `mailto` link opens in a new tab, `noopener noreferrer`;
 *   - a relative image is served from the folder by `/_review/file/<rel>`, and one that is a
 *     still links to it in the viewer, `#<name>[@<key>]`; so does a link to such an image;
 *   - an image from elsewhere is not loaded: it shows as a link, so reading About calls no
 *     third party;
 *   - any other relative link, a fragment or an absolute path keeps its text and loses its
 *     `href`, since the runtime serves nothing there.
 */

import { readFileSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { openSource, readSource, resolveRef } from "./source.mjs";
import { fileUrl } from "./stills/state.js";

const MarkdownIt = createRequire(import.meta.url)("./vendor/markdown-it-14.1.0.min.cjs");

/** The route an image of the folder is served at, before its path. */
export const FILE_ROUTE = "/_review/file";

const TYPES = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif" };
const IMG_TAG = /<img\b[^>]*>/gi;
const BREAK = /<br\s*\/?>/i;
const OUTSIDE = /^(https?:|mailto:)/i;
const WATCH_MS = 250;

/** The directory of the folder source `scratch`, or null for a plain scratch dir. */
function sourceDir(scratch) {
  return typeof scratch === "string" ? null : scratch.dir;
}

/**
 * What the folder source `scratch` adds to the answer of `/_review/stills`: `{ groups, notes,
 * writable, about }`, `about` being `{ file }` when it has a README and null when not. Empty
 * for a plain scratch dir.
 */
export function sourceExtras(scratch) {
  const dir = sourceDir(scratch);
  if (!dir) return {};
  const { groups, notes, writable, about } = readSource(dir);
  return { groups, notes, writable, about: about ? { file: about.file } : null };
}

/** The image type of the file name `rel`, or undefined when it is not an image. */
export function typeOf(rel) {
  return TYPES[path.posix.extname(rel).slice(1).toLowerCase()];
}

/**
 * The image `rel`, a path from the folder `dir` with forward slashes, as `{ file, type }`, or
 * null when it is not one the folder serves: not an image, a hidden entry, a path that leaves
 * the folder, by itself or through a link, or one that is not there.
 */
export function sourceFile(dir, rel) {
  const parts = String(rel).split("/");
  const type = typeOf(rel);
  if (!type || /[\\\0]/.test(rel) || parts.some((p) => !p || p.startsWith("."))) return null;
  try {
    const root = realpathSync(dir);
    const file = realpathSync(path.join(root, ...parts));
    return file.startsWith(root + path.sep) && statSync(file).isFile() ? { file, type } : null;
  } catch {
    return null;
  }
}

/** Escape a string for HTML text and attribute values. */
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** The markdown image an `<img>` tag stands for, or the tag as it is when it has no `src`. */
function imgMarkdown(tag) {
  const src = /\bsrc=["']([^"']+)["']/i.exec(tag)?.[1];
  if (!src) return tag;
  const alt = /\balt=["']([^"']*)["']/i.exec(tag)?.[1] ?? "";
  return `![${alt.replace(/[[\]\\]/g, "\\$&")}](<${src.replace(/[<>]/g, "")}>)`;
}

/** `markdown` with the `<img>` tags outside its fenced code as markdown images. */
function withImages(markdown) {
  let fence = null;
  return markdown
    .split(/\r?\n/)
    .map((line) => {
      const open = /^\s*(```|~~~)/.exec(line);
      if (open) {
        if (!fence) fence = open[1];
        else if (open[1] === fence) fence = null;
        return line;
      }
      return fence ? line : line.replace(IMG_TAG, imgMarkdown);
    })
    .join("\n");
}

/** A markdown-it rule that makes a line break of each `<br>` left in the text. */
function breaks(state) {
  for (const block of state.tokens) {
    if (block.type !== "inline" || !block.children) continue;
    block.children = block.children.flatMap((token) => {
      if (token.type !== "text" || !BREAK.test(token.content)) return [token];
      return token.content.split(new RegExp(BREAK, "gi")).flatMap((text, i) => {
        const piece = new state.Token("text", "", 0);
        piece.content = text;
        return i ? [new state.Token("hardbreak", "br", 0), piece] : [piece];
      });
    });
  }
}

/**
 * Where the images of `stills` (a source's, in the contract's shape) are in the viewer: a
 * function from an image's path in the folder to `{ hash, title }`, the still it is the current
 * revision of, or undefined. A manifest's still, whose files are not in the folder under their
 * own names, is found by its name, as the reader of the source finds it.
 */
function stillFinder(stills) {
  const byFile = new Map();
  const byName = new Map();
  for (const s of stills) {
    s.variants.forEach((v, i) => {
      if (!v.revs.length) return;
      const hash = `#${encodeURIComponent(s.name)}${i ? `@${encodeURIComponent(v.key)}` : ""}`;
      byFile.set(v.revs.at(-1).file, { hash, title: s.title });
      if (!byName.has(s.name)) byName.set(s.name, { hash, title: s.title });
    });
  }
  const stem = (rel) => path.posix.basename(rel).replace(/\.[^.]+$/, "").split("@")[0];
  return (rel) => byFile.get(rel) ?? byName.get(stem(rel));
}

/** Make the link token `token` open in a new tab, without handing the page to it. */
function outside(token) {
  token.attrSet("target", "_blank");
  token.attrSet("rel", "noopener noreferrer");
}

/**
 * `markdown` as sanitized HTML (see the top of this file), its relative images served from the
 * folder and linked to the still of `stills` each one is.
 */
export function renderMarkdown(markdown, stills = []) {
  const md = new MarkdownIt({ html: false, linkify: false });
  const find = stillFinder(stills);
  const depth = { links: 0 };
  md.core.ruler.after("inline", "breaks", breaks);
  md.renderer.rules.table_open = () => '<div class="table"><table>\n';
  md.renderer.rules.table_close = () => "</table></div>\n";
  md.renderer.rules.link_open = (tokens, i, options, env, self) => {
    const token = tokens[i];
    const href = token.attrGet("href") ?? "";
    const rel = OUTSIDE.test(href) ? null : resolveRef(href);
    const still = rel === null ? undefined : find(rel);
    depth.links += 1;
    if (OUTSIDE.test(href)) {
      outside(token);
    } else if (still && typeOf(rel)) {
      token.attrSet("href", still.hash);
      token.attrSet("class", "still");
    } else if (rel !== null && typeOf(rel)) {
      token.attrSet("href", FILE_ROUTE + fileUrl(rel));
      outside(token);
    } else {
      token.attrs = token.attrs.filter(([name]) => name !== "href");
    }
    return self.renderToken(tokens, i, options);
  };
  md.renderer.rules.link_close = (tokens, i, options, env, self) => {
    depth.links -= 1;
    return self.renderToken(tokens, i, options);
  };
  md.renderer.rules.image = (tokens, i, options, env, self) => {
    const token = tokens[i];
    const src = token.attrGet("src") ?? "";
    const alt = self.renderInlineAsText(token.children ?? [], options, env);
    if (OUTSIDE.test(src)) {
      const text = escapeHtml(alt || src);
      if (depth.links) return text;
      return `<a href="${escapeHtml(src)}" target="_blank" rel="noopener noreferrer">${text}</a>`;
    }
    const rel = resolveRef(src);
    if (rel === null || !typeOf(rel)) return escapeHtml(alt);
    const image = `<img src="${escapeHtml(FILE_ROUTE + fileUrl(rel))}" alt="${escapeHtml(alt)}" loading="lazy">`;
    const still = find(rel);
    if (!still || depth.links) return image;
    return `<a class="still" href="${escapeHtml(still.hash)}" title="${escapeHtml(still.title)}">${image}</a>`;
  };
  return md.render(withImages(markdown));
}

/**
 * The About page of the folder `dir`: `{ file, html }`, its README's name and the document as
 * sanitized HTML, or null when it has none.
 */
export function aboutPage(dir) {
  const { about, stills } = readSource(dir);
  return about ? { file: about.file, html: renderMarkdown(about.markdown, stills) } : null;
}

/**
 * Watch the folder `dir`: call `changed()` when what it reads as changes, an image rewritten,
 * added or removed, or its README or `stills.json` edited. It is looked at every `every`
 * milliseconds, and a change counts once two looks in a row agree on it, so a file still being
 * written is not taken half way. The folder is then read with `openSource`, which keeps a
 * changed image as its next revision once `.review/` exists, before `changed()` is called. A
 * look that fails is tried again. Returns the function that stops it.
 */
export function watchSource(dir, changed, every = WATCH_MS) {
  let last = null;
  let pending = null;
  let looking = false;
  const look = async () => {
    if (looking) return;
    looking = true;
    try {
      if (last === null) {
        last = JSON.stringify(await openSource(dir));
        return;
      }
      const now = JSON.stringify(readSource(dir));
      if (now === last || now !== pending) {
        pending = now === last ? null : now;
        return;
      }
      pending = null;
      last = JSON.stringify(await openSource(dir));
      changed();
    } catch {
      pending = null;
    } finally {
      looking = false;
    }
  };
  look();
  const timer = setInterval(look, every);
  timer.unref();
  return () => clearInterval(timer);
}
