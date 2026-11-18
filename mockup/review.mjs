/**
 * The review store of the /mockup runtime: stills with revisions and the review event log.
 *
 * Everything lives in the mockup's scratch dir (`<app>/.mockup/`, called `dir` below):
 *
 *   stills/manifest.json        [{ name, title, source: { path, size }, revs: [{ n, file, at }] }]
 *   stills/<name>/<n>.png       one file per revision, immutable
 *   review/events.jsonl         append-only event log, one JSON event per line
 *   review/annotated/<id>.png   a thread's still with its mark drawn, written by the viewer
 *
 * The runtime and the `preview` CLI both write here, so every write takes a lock file next to
 * what it changes (`stills/.lock`, `review/.lock`). `docs/review-contract.md` is the contract:
 * a reader needs nothing else.
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

export const EVENT_TYPES = ["thread", "reply", "resolve", "reopen", "viewed", "unviewed"];

const FIELDS = {
  thread: ["still", "rev", "anchor", "body"],
  reply: ["thread", "body"],
  resolve: ["thread"],
  reopen: ["thread"],
  viewed: ["still", "rev"],
  unviewed: ["still", "rev"],
};
const STORED = ["seq", "id", "at"];
const NAME = /^[A-Za-z0-9][\w.-]{0,99}$/;
const ID = /^[\w-]{1,64}$/;
const SIZE = /^[1-9]\d{0,4}x[1-9]\d{0,4}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_BODY = 10000;
const MAX_AUTHOR = 100;
const LOCK_WAIT_MS = 10000;
const LOCK_STALE_MS = 10000;

/** Paths of the store inside the scratch dir `dir`. */
function paths(dir) {
  return {
    manifest: path.join(dir, "stills", "manifest.json"),
    stillsLock: path.join(dir, "stills", ".lock"),
    events: path.join(dir, "review", "events.jsonl"),
    eventsLock: path.join(dir, "review", ".lock"),
  };
}

/** True for a plain object, not an array or null. */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
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

/** Why `anchor` is not a valid pin `{x,y}` or region `{x,y,w,h}`, or null when it is. */
function anchorProblem(anchor) {
  if (!isObject(anchor)) return "'anchor' must be an object";
  const keys = Object.keys(anchor).sort().join(",");
  if (keys !== "x,y" && keys !== "h,w,x,y") return "'anchor' is {x,y} for a pin or {x,y,w,h} for a region";
  if (!isUnit(anchor.x) || !isUnit(anchor.y)) return "'anchor' x and y must be numbers in 0..1";
  if (keys === "x,y") return null;
  if (!isUnit(anchor.w) || !isUnit(anchor.h) || anchor.w === 0 || anchor.h === 0) {
    return "'anchor' w and h must be numbers in 0..1, above 0";
  }
  if (anchor.x + anchor.w > 1 + 1e-9 || anchor.y + anchor.h > 1 + 1e-9) return "'anchor' region must fit in the image";
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
  if (!isObject(author) || Object.keys(author).sort().join(",") !== "kind,name") {
    return "'author' must be {kind, name}";
  }
  if (author.kind !== "human" && author.kind !== "agent") return "'author.kind' must be 'human' or 'agent'";
  if (typeof author.name !== "string" || !author.name.trim() || author.name.length > MAX_AUTHOR) {
    return `'author.name' must be a non-empty string of at most ${MAX_AUTHOR} characters`;
  }
  const fields = FIELDS[event.type];
  if (fields.includes("body")) {
    if (typeof event.body !== "string" || !event.body.trim()) return "'body' must be a non-empty string";
    if (event.body.length > MAX_BODY) return `'body' must be at most ${MAX_BODY} characters`;
  }
  if (fields.includes("thread") && (typeof event.thread !== "string" || !ID.test(event.thread))) {
    return "'thread' must be the id of a thread event";
  }
  if (event.type === "thread" && event.still === null) {
    if (event.rev !== undefined || event.anchor !== undefined) return "a general thread (still: null) has no 'rev' or 'anchor'";
    return null;
  }
  if (fields.includes("still")) {
    const problem = nameProblem(event.still);
    if (problem) return `'still': ${problem}`;
    if (!isRev(event.rev)) return "'rev' must be an integer from 1";
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
  const aside = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.stale`;
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
async function withLock(file, fn) {
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
 * The stills of `dir`, as listed in `stills/manifest.json`; empty when there is none yet. A
 * manifest that is not a JSON list throws: only `addStill` writes it.
 */
export function stills(dir) {
  const file = paths(dir).manifest;
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
 * Add a revision of the still `name`: copy the PNG `file` to `stills/<name>/<n>.png`, n one past
 * the still's last revision (1 for a new still), and record it in the manifest, written to a
 * temp file and renamed over it. `title`, `source` (the page path shot) and `size` (`WxH`)
 * update the still's entry when given. Returns the still's manifest entry.
 */
export async function addStill(dir, { file, name, title, source, size }) {
  const problem = nameProblem(name);
  if (problem) throw new Error(problem);
  if (title !== undefined && (typeof title !== "string" || !title.trim())) throw new Error("'title' must be a non-empty string");
  if (source !== undefined && (typeof source !== "string" || !source)) throw new Error("'source' must be a page path");
  if (size !== undefined && (typeof size !== "string" || !SIZE.test(size))) throw new Error("'size' must look like 390x844");
  const head = Buffer.alloc(PNG.length);
  const fd = openSync(file, "r");
  try {
    if (!fstatSync(fd).isFile() || readSync(fd, head, 0, head.length, 0) !== head.length || !head.equals(PNG)) {
      throw new Error(`${file}: not a PNG image`);
    }
  } finally {
    closeSync(fd);
  }
  const { manifest: manifestFile, stillsLock } = paths(dir);
  return withLock(stillsLock, () => {
    const manifest = stills(dir);
    let entry = manifest.find((s) => s && s.name === name);
    const folded = name.toLowerCase();
    const clash = manifest.find((s) => typeof s?.name === "string" && s.name !== name && s.name.toLowerCase() === folded);
    if (clash) throw new Error(`'${name}' differs from the still '${clash.name}' only in case`);
    if (!entry) {
      entry = { name, title: title || name, source: { path: null, size: null }, revs: [] };
      manifest.push(entry);
    }
    if (title !== undefined) entry.title = title;
    if (!isObject(entry.source)) entry.source = { path: null, size: null };
    if (source !== undefined) entry.source.path = source;
    if (size !== undefined) entry.source.size = size;
    if (!Array.isArray(entry.revs)) entry.revs = [];
    const n = entry.revs.reduce((max, r) => (r && isRev(r.n) && r.n > max ? r.n : max), 0) + 1;
    const rel = `stills/${name}/${n}.png`;
    mkdirSync(path.join(dir, "stills", name), { recursive: true });
    copyFileSync(file, path.join(dir, rel));
    entry.revs.push({ n, file: rel, at: new Date().toISOString() });
    const tmp = `${manifestFile}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    try {
      writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`);
      renameSync(tmp, manifestFile);
    } catch (e) {
      rmSync(tmp, { force: true });
      throw e;
    }
    return entry;
  });
}

/**
 * The events of `dir` with a `seq` above `since` (0 for all), in log order. Returns
 * `{ events, problems, cursor }`: `problems` lists each skipped line as `{ line, error }` (bad
 * JSON, a broken schema, a `seq` that does not grow); `cursor` is the highest `seq` read, or
 * `since` when there is nothing new, and is what the next call passes as `since`. A last line
 * without its newline is a write in progress and is left for the next read.
 */
export function readEvents(dir, since = 0) {
  const file = paths(dir).events;
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

/** The revision numbers of each still in the manifest, by name. */
function revisions(dir) {
  const revs = new Map();
  for (const s of stills(dir)) {
    if (s && typeof s.name === "string" && Array.isArray(s.revs)) {
      revs.set(s.name, new Set(s.revs.filter((r) => r && isRev(r.n)).map((r) => r.n)));
    }
  }
  return revs;
}

/**
 * Append `event` to the log of `dir`: `{ type, author, ... }` with the fields of its type (see
 * the contract). Validates it, and that its thread, still and revision exist; assigns `seq`
 * (one past the log's last), `id` and `at`; and appends it as one line with a single write on
 * an `O_APPEND` descriptor, under the log's lock. Returns the stored event; throws on an
 * invalid one.
 */
export async function appendEvent(dir, event) {
  const problem = eventProblem(event, false);
  if (problem) throw new Error(problem);
  const { events: file, eventsLock } = paths(dir);
  return withLock(eventsLock, () => {
    const { events } = readEvents(dir);
    if (event.thread !== undefined && !events.some((e) => e.type === "thread" && e.id === event.thread)) {
      throw new Error(`no thread '${event.thread}'`);
    }
    if (typeof event.still === "string" && !revisions(dir).get(event.still)?.has(event.rev)) {
      throw new Error(`no still '${event.still}' at rev ${event.rev}`);
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
 * `{ id, still, rev, anchor, body, author, at, seq, status, replies, updated }`: `still`,
 * `rev` and `anchor` are null where the thread has none, `status` is "open" or "resolved" as
 * the last resolve or reopen left it, `replies` are `{ id, author, body, at, seq }`, and
 * `updated` is the `seq` of the last event on the thread.
 */
export function threads(dir) {
  const byId = new Map();
  for (const e of readEvents(dir).events) {
    if (e.type === "thread") {
      byId.set(e.id, {
        id: e.id,
        still: e.still,
        rev: e.rev ?? null,
        anchor: e.anchor ?? null,
        body: e.body,
        author: e.author,
        at: e.at,
        seq: e.seq,
        status: "open",
        replies: [],
        updated: e.seq,
      });
      continue;
    }
    const thread = byId.get(e.thread);
    if (!thread) continue;
    thread.updated = e.seq;
    if (e.type === "reply") thread.replies.push({ id: e.id, author: e.author, body: e.body, at: e.at, seq: e.seq });
    if (e.type === "resolve") thread.status = "resolved";
    if (e.type === "reopen") thread.status = "open";
  }
  return [...byId.values()];
}

/**
 * The reviewed mark of every still in the manifest of `dir`, by name: `{ rev, viewed,
 * reviewed, changed }`. `rev` is the still's latest revision; `viewed` the revision the last
 * `viewed` event marked, or null when none did or an `unviewed` came after; `reviewed` is true
 * when that is the latest revision; `changed` when an older revision was marked, so a newer
 * one has landed since and the mark no longer holds.
 */
export function reviewed(dir) {
  const marks = new Map();
  for (const e of readEvents(dir).events) {
    if (e.type === "viewed") marks.set(e.still, e.rev);
    if (e.type === "unviewed") marks.delete(e.still);
  }
  const out = {};
  for (const [name, revs] of revisions(dir)) {
    const rev = Math.max(0, ...revs);
    const viewed = marks.get(name) ?? null;
    out[name] = { rev, viewed, reviewed: viewed !== null && viewed === rev, changed: viewed !== null && viewed < rev };
  }
  return out;
}
