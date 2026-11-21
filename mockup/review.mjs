/**
 * The review store of the /mockup runtime: stills with revisions and the review event log.
 *
 * Everything lives in the mockup's scratch dir (`<app>/.mockup/`, called `dir` below):
 *
 *   stills/manifest.json        [{ name, title, source: { path }, variants: [{ key, viewport, tags,
 *                                 revs: [{ n, file, at }] }] }]; a v1 entry, { source: { path,
 *                                 size }, revs }, is read as one variant (see `upgraded`)
 *   stills/<name>/<key>/<n>.png one file per revision of a variant, immutable; a v1 revision
 *                               stays at stills/<name>/<n>.png
 *   review/events.jsonl         append-only event log, one JSON event per line
 *   review/annotated/<id>.png   a thread's still with its mark drawn, written by the viewer
 *
 * The runtime and the `preview` CLI both write here, so every write takes a lock file next to
 * what it changes (`stills/.lock`, `review/.lock`). `docs/review-contract.md` is the contract:
 * a reader needs nothing else.
 *
 * Every function that reads or writes the review takes `dir` as that scratch dir or as a folder
 * source, the handle `folder` of `source.mjs` returns for any directory of images: its stills
 * come from the folder and its log, locks and annotated stills live in `<folder>/.review/`.
 */

import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { applyThread, applyWorking, markOf, reviewerOf, viewportOf, workingAt } from "./stills/state.js";

const EVENT_TYPES = ["thread", "reply", "resolve", "reopen", "viewed", "unviewed", "working", "idle"];

const FIELDS = {
  thread: ["still", "variant", "rev", "anchor", "body", "target"],
  reply: ["thread", "body"],
  resolve: ["thread"],
  reopen: ["thread"],
  viewed: ["still", "variant", "rev"],
  unviewed: ["still", "variant", "rev"],
  working: ["thread", "still", "variant", "note"],
  idle: ["thread"],
};
const OPTIONAL_FIELDS = new Set(["working", "idle"]);
const STORED = ["seq", "id", "at"];
const VIA = ["tailnet", "share", "cli"];
const NAME = /^[A-Za-z0-9][\w.-]{0,99}$/;
const ID = /^[\w-]{1,64}$/;
const SIZE = /^([1-9]\d{0,4})x([1-9]\d{0,4})$/;
const CUSTOM = /^([1-9]\d{0,4})x([1-9]\d{0,4})(?:@([1-9](?:\.\d{1,2})?))?(\+touch)?$/;
const TAG = /^[a-z0-9][a-z0-9_.-]{0,31}$/;
const KEY = /^[a-z0-9][\w.@-]{0,63}(\+[a-z0-9][\w.-]{0,31}){0,16}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_BODY = 10000;

/** The most characters an author's name may hold. */
export const MAX_AUTHOR = 100;

/**
 * The limits of a thread's `target`: the most elements it keeps, and the most characters of a
 * page path, an element's selector, its text and the cut of its HTML.
 */
export const TARGET_LIMITS = { elements: 20, page: 2000, selector: 500, text: 200, html: 1000 };

/** What a thread's `target` says of the marked elements on the shot, as `state`. */
export const TARGET_STATES = ["reproduced", "not-reproduced"];

const LOCK_WAIT_MS = 10000;
const LOCK_STALE_MS = 10000;

/**
 * The viewport presets a variant is shot at, by name: CSS size, device pixel ratio, and
 * `mobile`, which means touch, a mobile user agent and a phone's viewport handling.
 */
const VIEWPORTS = {
  mobile: { width: 390, height: 844, dpr: 3, mobile: true },
  "mobile-s": { width: 375, height: 812, dpr: 3, mobile: true },
  tablet: { width: 820, height: 1180, dpr: 2, mobile: true },
  desktop: { width: 1440, height: 900, dpr: 1, mobile: false },
};

const ALIASES = { web: "desktop" };

/** The stills manifest, relative to the scratch dir. */
export const MANIFEST_FILE = "stills/manifest.json";

/** The event log, relative to the scratch dir. */
export const EVENTS_FILE = "review/events.jsonl";

/** Paths of the store inside the scratch dir `dir`, or the paths a folder source gives. */
export function storePaths(dir) {
  if (typeof dir !== "string") return dir.paths;
  return {
    manifest: path.join(dir, MANIFEST_FILE),
    stillsLock: path.join(dir, "stills", ".lock"),
    events: path.join(dir, EVENTS_FILE),
    eventsLock: path.join(dir, "review", ".lock"),
    annotated: path.join(dir, "review", "annotated"),
  };
}

/** True when `bytes` starts with the PNG signature. */
export function isPng(bytes) {
  return bytes.subarray(0, PNG.length).equals(PNG);
}

/** True for a plain object, not an array or null. */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** The sorted field names of `o`, comma-joined, to compare an object's shape. */
function shape(o) {
  return Object.keys(o).sort().join(",");
}

/** A fresh name next to `file` with the suffix `ext`, private to this writer. */
export function sideFile(file, ext) {
  return `${file}.${process.pid}.${randomBytes(4).toString("hex")}.${ext}`;
}

/** True for a number in 0..1. */
function isUnit(v) {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
}

/** True for a revision number: an integer from 1. */
function isRev(v) {
  return Number.isInteger(v) && v >= 1;
}

/** Why `name` is not a valid still name, or null when it is. */
function nameProblem(name) {
  if (typeof name !== "string" || !NAME.test(name)) {
    return "a still name is 1-100 letters, digits, '.', '_' or '-', starting with a letter or digit";
  }
  return null;
}

/**
 * The viewport `spec` names: a preset (`mobile`, `mobile-s`, `tablet`, `desktop` or its alias
 * `web`) or a custom `WxH[@dpr][+touch]`. Returns `{ preset, width, height, dpr, mobile,
 * fullPage }`, `preset` being "custom" for a custom one; a custom one that is exactly a preset
 * (`1440x900` is `desktop`) is that preset. Throws on anything else.
 */
export function parseViewport(spec, fullPage = false) {
  const name = ALIASES[spec] ?? spec;
  if (typeof name === "string" && Object.hasOwn(VIEWPORTS, name)) {
    return { preset: name, ...VIEWPORTS[name], fullPage: Boolean(fullPage) };
  }
  const m = typeof spec === "string" ? CUSTOM.exec(spec) : null;
  if (!m) throw new Error(`a viewport is one of ${[...Object.keys(VIEWPORTS), "web"].join(", ")} or WxH[@dpr][+touch]`);
  const [, width, height, dpr = "1", touch] = m;
  const custom = { width: Number(width), height: Number(height), dpr: Number(dpr), mobile: Boolean(touch) };
  const preset = Object.keys(VIEWPORTS).find((k) => sameDevice(VIEWPORTS[k], custom));
  return { preset: preset ?? "custom", ...custom, fullPage: Boolean(fullPage) };
}

/** True when the viewports `a` and `b` have the same size, pixel ratio and touch. */
function sameDevice(a, b) {
  return a.width === b.width && a.height === b.height && a.dpr === b.dpr && a.mobile === b.mobile;
}

/** The key of `viewport`: its preset's name, or `custom-<W>x<H>[@<dpr>][-touch]`. */
function viewportKey(viewport) {
  if (viewport.preset !== "custom") return viewport.preset;
  const dpr = viewport.dpr === 1 ? "" : `@${viewport.dpr}`;
  return `custom-${viewport.width}x${viewport.height}${dpr}${viewport.mobile ? "-touch" : ""}`;
}

/** `tags` lowercased, checked, deduplicated and sorted; throws on a bad one. */
export function parseTags(tags = []) {
  const out = new Set();
  for (const tag of tags) {
    const t = typeof tag === "string" ? tag.trim().toLowerCase() : "";
    if (!TAG.test(t)) throw new Error(`tag '${tag}': 1-32 lowercase letters, digits, '.', '_' or '-'`);
    out.add(t);
  }
  return [...out].sort();
}

/** The key of the variant shot at `viewport` with `tags`: `<viewport>[+<tag>...]`, tags sorted. */
export function variantKey(viewport, tags = []) {
  return [viewportKey(viewport), ...parseTags(tags)].join("+");
}

/**
 * The viewport of a v1 still shot at `size` (`WxH`): `desktop` at the preset's size, else a
 * custom one at 1x. A still without a size is read as `desktop`.
 */
function legacyViewport(size) {
  return parseViewport(typeof size === "string" && SIZE.test(size) ? size : "desktop");
}

/** The viewport a variant key names, for a v2 variant stored without a readable one. */
export function keyViewport(key) {
  const head = viewportOf(key);
  const spec = head.startsWith("custom-") ? head.slice("custom-".length).replace(/-touch$/, "+touch") : head;
  return (spec === head ? Object.hasOwn(VIEWPORTS, spec) : CUSTOM.test(spec)) ? parseViewport(spec) : null;
}

/** The revisions of `revs` a reader can use: `{ n, file, at }` with a number and a file. */
function goodRevs(revs) {
  return Array.isArray(revs) ? revs.filter((r) => isObject(r) && isRev(r.n) && typeof r.file === "string") : [];
}

/**
 * The manifest entry `entry` in v2 shape, `{ name, title, source: { path }, variants }`, or
 * null when it has no name. A v1 entry, with top-level `revs` and `source.size`, becomes one
 * variant whose key comes from its size (see `legacyViewport`) and whose files stay where they
 * are. Unreadable variants and revisions are left out. `entry` is not changed.
 */
export function upgraded(entry) {
  if (!isObject(entry) || typeof entry.name !== "string") return null;
  const title = typeof entry.title === "string" && entry.title.trim() ? entry.title : entry.name;
  const source = { path: typeof entry.source?.path === "string" ? entry.source.path : null };
  let variants;
  if (Array.isArray(entry.variants)) {
    variants = entry.variants
      .filter((v) => isObject(v) && typeof v.key === "string" && KEY.test(v.key))
      .map((v) => ({
        key: v.key,
        viewport: isObject(v.viewport) ? v.viewport : keyViewport(v.key),
        tags: Array.isArray(v.tags) ? v.tags.filter((t) => typeof t === "string") : v.key.split("+").slice(1),
        revs: goodRevs(v.revs),
      }));
  } else if (Array.isArray(entry.revs)) {
    const viewport = legacyViewport(entry.source?.size);
    variants = [{ key: viewportKey(viewport), viewport, tags: [], revs: goodRevs(entry.revs) }];
  } else {
    variants = [];
  }
  return { name: entry.name, title, source, variants };
}

/** Why `anchor` is not a valid pin `{x,y}` or region `{x,y,w,h}`, or null when it is. */
function anchorProblem(anchor) {
  if (!isObject(anchor)) return "'anchor' must be an object";
  const keys = shape(anchor);
  if (keys !== "x,y" && keys !== "h,w,x,y") return "'anchor' is {x,y} for a pin or {x,y,w,h} for a region";
  if (!isUnit(anchor.x) || !isUnit(anchor.y)) return "'anchor' x and y must be numbers in 0..1";
  if (keys === "x,y") return null;
  if (!isUnit(anchor.w) || !isUnit(anchor.h) || anchor.w === 0 || anchor.h === 0) {
    return "'anchor' w and h must be numbers in 0..1, above 0";
  }
  if (anchor.x + anchor.w > 1 + 1e-9 || anchor.y + anchor.h > 1 + 1e-9) return "'anchor' region must fit in the image";
  return null;
}

/** True for a finite number of 0 or more. */
function isOffset(v) {
  return typeof v === "number" && Number.isFinite(v) && v >= 0;
}

/**
 * True for a page path of the mockup: starts with one `/` not followed by another `/` or a `\`
 * (which a URL parser reads as another host), no space or control character, and resolves on
 * the host it is given.
 */
export function isPagePath(v) {
  if (typeof v !== "string" || v.length > TARGET_LIMITS.page) return false;
  if (!/^\/(?![/\\])[^\s\0-\x1f\x7f]*$/.test(v)) return false;
  const base = "http://mockup.invalid";
  return new URL(v, base).origin === base;
}

/** Why `element`, a marked element `{selector, text, html}`, is not a valid one, or null. */
function elementProblem(element) {
  if (!isObject(element) || shape(element) !== "html,selector,text") return "must be {selector, text, html}";
  const { selector, text, html } = element;
  if (typeof selector !== "string" || !selector.trim() || selector.length > TARGET_LIMITS.selector) {
    return `'selector' must be a non-empty string of at most ${TARGET_LIMITS.selector} characters`;
  }
  if (typeof text !== "string" || text.length > TARGET_LIMITS.text) {
    return `'text' must be a string of at most ${TARGET_LIMITS.text} characters`;
  }
  if (typeof html !== "string" || html.length > TARGET_LIMITS.html) {
    return `'html' must be a string of at most ${TARGET_LIMITS.html} characters`;
  }
  return null;
}

/**
 * Why `target`, what a remark made on the live page points at, is not a valid one, or null:
 * `{page, elements, truncated?, viewport, scroll, state}` (see the contract).
 */
function targetProblem(target) {
  if (!isObject(target)) return "'target' must be an object";
  const allowed = new Set(["page", "elements", "truncated", "viewport", "scroll", "state"]);
  const extra = Object.keys(target).find((k) => !allowed.has(k));
  if (extra) return `'${extra}' is not a field of a target`;
  if (!isPagePath(target.page)) return "'target.page' must be a page path starting with /";
  if (!Array.isArray(target.elements) || target.elements.length > TARGET_LIMITS.elements) {
    return `'target.elements' must be a list of at most ${TARGET_LIMITS.elements} elements`;
  }
  for (const [i, element] of target.elements.entries()) {
    const problem = elementProblem(element);
    if (problem) return `'target.elements[${i}]': ${problem}`;
  }
  if (target.truncated !== undefined && typeof target.truncated !== "boolean") {
    return "'target.truncated' must be true or false";
  }
  try {
    if (typeof target.viewport !== "string") throw new Error();
    parseViewport(target.viewport);
  } catch {
    return "'target.viewport' must be a viewport, a preset or WxH[@dpr][+touch]";
  }
  const { scroll } = target;
  if (!isObject(scroll) || shape(scroll) !== "x,y" || !isOffset(scroll.x) || !isOffset(scroll.y)) {
    return "'target.scroll' must be {x, y}, numbers of 0 or more";
  }
  if (!TARGET_STATES.includes(target.state)) return `'target.state' must be one of ${TARGET_STATES.join(", ")}`;
  return null;
}

/**
 * Why `event` breaks the event schema, or null when it keeps it. `stored` also requires the
 * fields `appendEvent` assigns (`seq`, `id`, `at`), as on a line read back from the log.
 */
function eventProblem(event, stored) {
  if (!isObject(event)) return "an event must be an object";
  if (!EVENT_TYPES.includes(event.type)) return `'type' must be one of ${EVENT_TYPES.join(", ")}`;
  const allowed = new Set(["type", "author", ...FIELDS[event.type], ...(stored ? STORED : [])]);
  const extra = Object.keys(event).find((k) => !allowed.has(k));
  if (extra) return `'${extra}' is not a field of a ${event.type} event`;
  if (stored) {
    if (!Number.isInteger(event.seq) || event.seq < 1) return "'seq' must be an integer from 1";
    if (typeof event.id !== "string" || !ID.test(event.id)) return "'id' must be a short word";
    if (typeof event.at !== "string" || !ISO.test(event.at) || Number.isNaN(Date.parse(event.at))) {
      return "'at' must be an ISO 8601 time";
    }
  }
  const { author } = event;
  if (!isObject(author) || (shape(author) !== "kind,name" && shape(author) !== "kind,name,via")) {
    return "'author' must be {kind, name, via?}";
  }
  if (author.kind !== "human" && author.kind !== "agent") return "'author.kind' must be 'human' or 'agent'";
  if (typeof author.name !== "string" || !author.name.trim() || author.name.length > MAX_AUTHOR) {
    return `'author.name' must be a non-empty string of at most ${MAX_AUTHOR} characters`;
  }
  if (author.via !== undefined && !VIA.includes(author.via)) return `'author.via' must be one of ${VIA.join(", ")}`;
  const fields = FIELDS[event.type];
  const optional = OPTIONAL_FIELDS.has(event.type);
  for (const field of ["body", "note"]) {
    if (!fields.includes(field) || (optional && event[field] === undefined)) continue;
    if (typeof event[field] !== "string" || !event[field].trim()) return `'${field}' must be a non-empty string`;
    if (event[field].length > MAX_BODY) return `'${field}' must be at most ${MAX_BODY} characters`;
  }
  if (fields.includes("thread") && !(optional && event.thread === undefined)) {
    if (typeof event.thread !== "string" || !ID.test(event.thread)) return "'thread' must be the id of a thread event";
  }
  if (event.variant !== undefined && (typeof event.variant !== "string" || !KEY.test(event.variant))) {
    return "'variant' must be a variant key, such as mobile+dark";
  }
  if (event.type === "thread" && event.still === null) {
    if (["rev", "variant", "anchor", "target"].some((k) => event[k] !== undefined)) {
      return "a general thread (still: null) has no 'rev', 'variant', 'anchor' or 'target'";
    }
    return null;
  }
  if (optional) {
    if (event.still === undefined) return event.variant === undefined ? null : "'variant' goes with a 'still'";
    const problem = nameProblem(event.still);
    return problem ? `'still': ${problem}` : null;
  }
  if (fields.includes("still")) {
    const problem = nameProblem(event.still);
    if (problem) return `'still': ${problem}`;
    if (!isRev(event.rev)) return "'rev' must be an integer from 1";
  }
  if (event.target !== undefined) {
    const problem = targetProblem(event.target);
    if (problem) return problem;
  }
  if (event.anchor !== undefined) return anchorProblem(event.anchor);
  return null;
}

/** True when the file `file` was last modified more than LOCK_STALE_MS ago. */
function isStale(file) {
  return Date.now() - statSync(file).mtimeMs > LOCK_STALE_MS;
}

/**
 * Clear the lock file `file` when it is stale; true when it is gone, so taking it can be
 * retried. The lock is renamed aside before it is deleted, so of two writers that both saw it
 * stale only one moves it; one that moved a lock taken afresh in between links it back.
 */
function clearStale(file) {
  const aside = sideFile(file, "stale");
  try {
    if (!isStale(file)) return false;
    renameSync(file, aside);
  } catch (e) {
    if (e.code === "ENOENT") return true;
    throw e;
  }
  if (isStale(aside)) {
    rmSync(aside, { force: true });
    return true;
  }
  try {
    linkSync(aside, file);
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
  }
  rmSync(aside, { force: true });
  return false;
}

/**
 * Run `fn` while holding the lock file `file`, created exclusively and removed afterwards, but
 * only while it is still the one this call created. A lock older than LOCK_STALE_MS is left by
 * a writer that died and is taken over.
 */
export async function withLock(file, fn) {
  mkdirSync(path.dirname(file), { recursive: true });
  const deadline = Date.now() + LOCK_WAIT_MS;
  let ino;
  for (;;) {
    try {
      const fd = openSync(file, "wx");
      ino = fstatSync(fd).ino;
      closeSync(fd);
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
    }
    if (clearStale(file)) continue;
    if (Date.now() > deadline) throw new Error(`${file}: still locked after ${LOCK_WAIT_MS / 1000}s`);
    await sleep(2 + Math.random() * 8);
  }
  try {
    return fn();
  } finally {
    try {
      if (statSync(file).ino === ino) rmSync(file, { force: true });
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
  }
}

/**
 * The manifest of `dir` as written, a list of entries in v1 or v2 shape; empty when there is
 * none yet. A manifest that is not a JSON list throws: only `addStill` writes it.
 */
function readManifest(dir) {
  const file = storePaths(dir).manifest;
  if (!existsSync(file)) return [];
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`${file}: ${e.message}`);
  }
  if (!Array.isArray(manifest)) throw new Error(`${file}: must be a list`);
  return manifest;
}

/**
 * The stills of `dir`, as listed in `stills/manifest.json`, each in v2 shape (see `upgraded`)
 * whatever shape it is stored in; entries without a name are left out. A folder source gives
 * its own.
 */
export function stills(dir) {
  if (typeof dir !== "string") return dir.stills();
  return readManifest(dir).map(upgraded).filter(Boolean);
}

/**
 * Add a revision of a variant of the still `name`: the variant shot at `viewport` (a preset or
 * `WxH[@dpr][+touch]`, default `desktop`) with `tags`. The PNG `file` is copied to
 * `stills/<name>/<key>/<n>.png`, n one past the variant's last revision (1 for a new one), and
 * recorded in the manifest, written to a temp file and renamed over it; the still's entry is
 * written in v2 shape, the others as they were. A PNG whose bytes equal the variant's latest
 * revision adds no revision, so the reviewed marks on it hold, and leaves the manifest
 * untouched when nothing else of the entry changed either. `title` and `source` (the page
 * path shot) update the entry when given, `fullPage` the variant's viewport. Returns `{ entry,
 * variant, rev, unchanged }`, the still's entry, the variant, the revision added (or the latest
 * one, when `unchanged`) and whether the image was the same as that one.
 */
export async function addStill(dir, { file, name, title, source, viewport = "desktop", tags = [], fullPage = false }) {
  const problem = nameProblem(name);
  if (problem) throw new Error(problem);
  if (title !== undefined && (typeof title !== "string" || !title.trim())) {
    throw new Error("'title' must be a non-empty string");
  }
  if (source !== undefined && (typeof source !== "string" || !source)) throw new Error("'source' must be a page path");
  const vp = parseViewport(viewport, fullPage);
  const sorted = parseTags(tags);
  const key = variantKey(vp, sorted);
  if (!KEY.test(key)) throw new Error(`variant '${key}': at most 16 tags`);
  const head = Buffer.alloc(PNG.length);
  const fd = openSync(file, "r");
  try {
    if (!fstatSync(fd).isFile() || readSync(fd, head, 0, head.length, 0) !== head.length || !isPng(head)) {
      throw new Error(`${file}: not a PNG image`);
    }
  } finally {
    closeSync(fd);
  }
  const { manifest: manifestFile, stillsLock } = storePaths(dir);
  return withLock(stillsLock, () => {
    const manifest = readManifest(dir);
    const folded = name.toLowerCase();
    const clash = manifest.find(
      (s) => typeof s?.name === "string" && s.name !== name && s.name.toLowerCase() === folded
    );
    if (clash) throw new Error(`'${name}' differs from the still '${clash.name}' only in case`);
    const at = manifest.findIndex((s) => s && s.name === name);
    const entry =
      at === -1 ? { name, title: title || name, source: { path: null }, variants: [] } : upgraded(manifest[at]);
    if (at === -1) manifest.push(entry);
    else manifest[at] = entry;
    if (title !== undefined) entry.title = title;
    if (source !== undefined) entry.source.path = source;
    let variant = entry.variants.find((v) => v.key === key);
    if (!variant) {
      variant = { key, viewport: vp, tags: sorted, revs: [] };
      entry.variants.push(variant);
    }
    variant.viewport = vp;
    const latest = variant.revs.reduce((last, r) => (!last || r.n > last.n ? r : last), null);
    const unchanged = latest !== null && sameBytes(file, path.join(dir, latest.file));
    let rev = latest;
    if (!unchanged) {
      const n = (latest?.n ?? 0) + 1;
      const rel = `stills/${name}/${key}/${n}.png`;
      mkdirSync(path.join(dir, "stills", name, key), { recursive: true });
      copyFileSync(file, path.join(dir, rel));
      rev = { n, file: rel, at: new Date().toISOString() };
      variant.revs.push(rev);
    }
    const text = `${JSON.stringify(manifest, null, 2)}\n`;
    if (!unchanged || !existsSync(manifestFile) || readFileSync(manifestFile, "utf8") !== text) {
      const tmp = sideFile(manifestFile, "tmp");
      try {
        writeFileSync(tmp, text);
        renameSync(tmp, manifestFile);
      } catch (e) {
        rmSync(tmp, { force: true });
        throw e;
      }
    }
    return { entry, variant, rev, unchanged };
  });
}

/** True when the files `a` and `b` hold the same bytes; false when either is missing. */
function sameBytes(a, b) {
  try {
    if (statSync(a).size !== statSync(b).size) return false;
    return readFileSync(a).equals(readFileSync(b));
  } catch (e) {
    if (e.code === "ENOENT") return false;
    throw e;
  }
}

/**
 * Keep `png` as the annotated still of thread `id` in `dir`, `review/annotated/<id>.png`. It is
 * written beside its name and renamed onto it, so a reader never sees half of it. Returns the
 * file's path.
 */
export function storeAnnotated(dir, id, png) {
  const file = path.join(storePaths(dir).annotated, `${id}.png`);
  const partial = sideFile(file, "tmp");
  mkdirSync(path.dirname(file), { recursive: true });
  try {
    writeFileSync(partial, png);
    renameSync(partial, file);
  } catch (e) {
    rmSync(partial, { force: true });
    throw e;
  }
  return file;
}

/**
 * The events of `dir` with a `seq` above `since` (0 for all), in log order. Returns
 * `{ events, problems, cursor }`: `problems` lists each skipped line as `{ line, error }` (bad
 * JSON, a broken schema, a `seq` that does not grow); `cursor` is the highest `seq` read, or
 * `since` when there is nothing new, and is what the next call passes as `since`. A last line
 * without its newline is a write in progress and is left for the next read.
 */
export function readEvents(dir, since = 0) {
  const file = storePaths(dir).events;
  const events = [];
  const problems = [];
  let cursor = since;
  if (!existsSync(file)) return { events, problems, cursor };
  const lines = readFileSync(file, "utf8").split("\n");
  lines.pop();
  let last = 0;
  const ids = new Set();
  lines.forEach((text, i) => {
    if (!text.trim()) return;
    let event;
    try {
      event = JSON.parse(text);
    } catch (e) {
      problems.push({ line: i + 1, error: `bad JSON: ${e.message}` });
      return;
    }
    const problem = eventProblem(event, true);
    if (problem) {
      problems.push({ line: i + 1, error: problem });
      return;
    }
    if (event.seq <= last) {
      problems.push({ line: i + 1, error: `'seq' ${event.seq} does not follow ${last}` });
      return;
    }
    if (ids.has(event.id)) {
      problems.push({ line: i + 1, error: `'id' ${event.id} is not unique` });
      return;
    }
    ids.add(event.id);
    last = event.seq;
    if (event.seq <= since) return;
    events.push(event);
    cursor = event.seq;
  });
  return { events, problems, cursor };
}

/**
 * The variants of each still in the manifest of `dir`, by name: `{ first, variants }`, `first`
 * the key of its first variant (the one an event without `variant` means) and `variants` the
 * revision numbers of each variant, by key. Variants without a revision are left out, as the
 * viewer leaves them out, and so are stills without a variant left.
 */
export function revisions(dir) {
  const out = new Map();
  for (const s of stills(dir)) {
    const shot = s.variants.filter((v) => v.revs.length);
    if (!shot.length) continue;
    const variants = new Map(shot.map((v) => [v.key, new Set(v.revs.map((r) => r.n))]));
    out.set(s.name, { first: shot[0].key, variants });
  }
  return out;
}

/**
 * Append `event` to the log of `dir`: `{ type, author, ... }` with the fields of its type (see
 * the contract). Validates it, and that its thread, still and revision exist; assigns `seq`
 * (one past the log's last), `id` and `at`; and appends it as one line with a single write on
 * an `O_APPEND` descriptor, under the log's lock. Returns the stored event; throws on an
 * invalid one. A folder source first keeps the revisions of its images, the first write
 * creating its `.review/`.
 */
export async function appendEvent(dir, event) {
  const problem = eventProblem(event, false);
  if (problem) throw new Error(problem);
  if (typeof dir !== "string") await dir.keep();
  const { events: file, eventsLock } = storePaths(dir);
  return withLock(eventsLock, () => {
    const { events } = readEvents(dir);
    if (event.thread !== undefined && !events.some((e) => e.type === "thread" && e.id === event.thread)) {
      throw new Error(`no thread '${event.thread}'`);
    }
    if (typeof event.still === "string") {
      const still = revisions(dir).get(event.still);
      const revs = still?.variants.get(event.variant ?? still.first);
      const where = `still '${event.still}'${event.variant === undefined ? "" : ` [${event.variant}]`}`;
      if (!revs) throw new Error(`no ${where}`);
      if (event.rev !== undefined && !revs.has(event.rev)) throw new Error(`no ${where} at rev ${event.rev}`);
    }
    const ids = new Set(events.map((e) => e.id));
    let id;
    do id = randomBytes(4).toString("hex");
    while (ids.has(id));
    const stored = {
      seq: (events.at(-1)?.seq ?? 0) + 1,
      id,
      type: event.type,
      at: new Date().toISOString(),
      ...event,
    };
    const fd = openSync(file, constants.O_RDWR | constants.O_APPEND | constants.O_CREAT, 0o644);
    try {
      const size = fstatSync(fd).size;
      const end = Buffer.alloc(1);
      const torn = size > 0 && readSync(fd, end, 0, 1, size - 1) === 1 && end[0] !== 0x0a;
      writeSync(fd, `${torn ? "\n" : ""}${JSON.stringify(stored)}\n`);
    } finally {
      closeSync(fd);
    }
    return stored;
  });
}

/**
 * The threads of `dir`, folded from the log in the order they were opened. Each is
 * `{ id, still, variant, rev, anchor, target, body, author, at, seq, status, replies, updated }`:
 * `still`, `variant`, `rev`, `anchor` and `target` are null where the thread has none, `variant` being
 * the still's first variant when the event names none; `status` is "open" or "resolved" as the
 * last resolve or reopen left it, `replies` are `{ id, author, body, at, seq }`, and `updated`
 * is the `seq` of the last event on the thread.
 */
export function threads(dir) {
  const { events } = readEvents(dir);
  const out = [];
  for (const e of events) applyThread(out, e);
  const stillsByName = revisions(dir);
  return out.map((t) => ({
    ...t,
    variant: t.still === null ? null : (t.variant ?? stillsByName.get(t.still)?.first ?? null),
  }));
}

/**
 * The reviewed marks of the log of `dir`, per reviewer: `{ reviewers, marks }`. `marks` maps
 * a reviewer (the author's name, a guest's as `<name> (guest)`; see `reviewerOf`) to the marked
 * revision of each still and variant, `Map<reviewer, Map<still, Map<key, rev>>>`, set by that
 * reviewer's last `viewed` and cleared by an `unviewed` after it; an event without `variant`
 * marks the still's first variant. `reviewers` lists, sorted, every reviewer with a mark that
 * holds. `known` is `revisions(dir)`, when the caller has it already.
 */
export function reviewMarks(dir, known = revisions(dir)) {
  const marks = new Map();
  for (const e of readEvents(dir).events) {
    if (e.type !== "viewed" && e.type !== "unviewed") continue;
    const still = known.get(e.still);
    if (!still) continue;
    const by = reviewerOf(e.author);
    if (!marks.has(by)) marks.set(by, new Map());
    const byStill = marks.get(by);
    if (!byStill.has(e.still)) byStill.set(e.still, new Map());
    const key = e.variant ?? still.first;
    if (e.type === "viewed") byStill.get(e.still).set(key, e.rev);
    else byStill.get(e.still).delete(key);
  }
  const reviewers = [...marks].filter(([, byStill]) => [...byStill.values()].some((m) => m.size)).map(([name]) => name);
  return { reviewers: reviewers.sort(), marks };
}

/**
 * The reviewed mark of every still in the manifest of `dir` as the reviewer named `by` left
 * it, by name: the mark of its first variant, `{ rev, viewed, reviewed, changed }`, plus
 * `variants`, the mark of each variant by key. `rev` is the variant's latest revision;
 * `viewed` the revision `by` last marked, or null when they did not or an `unviewed` came
 * after; `reviewed` is true when that is the latest revision; `changed` when an older one was
 * marked, so a newer one has landed since and the mark no longer holds. Another reviewer's
 * marks count for nothing. `known` and `marks` are `revisions(dir)` and the `marks` of
 * `reviewMarks`, when the caller has them already.
 */
export function reviewed(dir, by, known = revisions(dir), marks = reviewMarks(dir, known).marks) {
  const mine = marks.get(by) ?? new Map();
  const out = {};
  for (const [name, still] of known) {
    const variants = {};
    for (const [key, revs] of still.variants) {
      variants[key] = markOf(Math.max(0, ...revs), mine.get(name)?.get(key) ?? null);
    }
    out[name] = { ...variants[still.first], variants };
  }
  return out;
}

/**
 * The agent's working state in the log of `dir` at `now` (ms): what it is working on, oldest
 * first, as `{ thread, still, variant, note, author, since, at, until }`, each field the agent
 * did not give being null; a `working` a human wrote counts for nothing. One state per
 * thread, or per still and variant, or one with neither: a `working` starts it or keeps it on;
 * it ends with the agent's next `reply` or `idle` on that thread (a reply ends only a state on
 * its thread; an `idle` without a thread ends them all), or WORKING_MS after its last
 * `working`. `since` is when it started, `at` its last `working`, `until` when it expires.
 */
export function working(dir, now = Date.now()) {
  const on = new Map();
  for (const e of readEvents(dir).events) applyWorking(on, e);
  return workingAt(on, now);
}
