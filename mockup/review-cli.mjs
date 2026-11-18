/**
 * The review CLI of the /mockup runtime: the agent's side of the stills review, over the store
 * in `review.mjs`. `preview stills|review` runs it inside the runtime image, so the viewer and
 * the CLI share one module.
 *
 *   node review-cli.mjs [--dir D] stills add <png|-> --name N [--viewport V] [--tag T]... [--full-page]
 *                                            [--title T] [--source P]
 *   node review-cli.mjs [--dir D] stills ls [--as NAME] [--json]
 *   node review-cli.mjs [--dir D] review ls [--open] [--json]
 *   node review-cli.mjs [--dir D] review show <thread> [--json]
 *   node review-cli.mjs [--dir D] review reply <thread> <text...>
 *   node review-cli.mjs [--dir D] review resolve|reopen <thread>
 *   node review-cli.mjs [--dir D] review working <thread|still> [--variant K] [--note T]
 *   node review-cli.mjs [--dir D] review idle [thread]
 *   node review-cli.mjs [--dir D] review watch [--since SEQ] [--json]
 *   node review-cli.mjs [--dir D] stills export <folder> [--readme]
 *   node review-cli.mjs --folder F stills ls | review ...
 *
 * `--dir` is the mockup scratch dir (`.mockup/`), default `$MOCKUP_DIR` or the working dir.
 * `--folder` is any directory of images instead, read as a stills source (`source.mjs`), its
 * review in `<folder>/.review/`; `stills add` and `stills export` are a mockup's only.
 * Paths are printed under `$MOCKUP_HOST_DIR` when set, so a CLI run in a container names files
 * as the host sees them. Agent events are written as `{kind: "agent", name:
 * $REVIEW_AUTHOR, via: "cli"}` (name default "agent"). Exit status: 0 done, 1 failed, 2 bad usage.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  addStill,
  appendEvent,
  readEvents,
  reviewMarks,
  revisions,
  stills,
  storePaths,
  threads,
} from "./review.mjs";
import { exportStills } from "./export.mjs";
import { folder, readSource } from "./source.mjs";
import { markOf, READ_ONLY } from "./stills/state.js";

const POLL_MS = 200;

const VIA_LABEL = { tailnet: "tailnet", share: "guest", cli: "cli" };

const USAGE = `usage: preview stills add <png> --name N [--viewport mobile|mobile-s|tablet|desktop|WxH[@dpr][+touch]]
                         [--tag T]... [--full-page] [--title T] [--source "/path?q"]
       preview stills ls [--as NAME] [--json]
       preview review ls [--open] [--json]
       preview review show <thread> [--json]
       preview review reply <thread> "<text>"
       preview review resolve|reopen <thread>
       preview review working <thread|still> [--variant K] [--note "<text>"]
       preview review idle [thread]
       preview review watch [--since SEQ] [--json]
       preview stills export <dir> [--readme]
       preview stills serve|stop|status [<dir>]
       preview stills share [<dir>] [--hours N] [--yes] | unshare [<dir>]

'stills ls' and every 'review' command take --dir <dir> to work on any folder of images
instead of the mockup; its review lives in <dir>/.review/.`;

const COMMANDS = {
  "stills add": {
    options: {
      name: { type: "string" },
      title: { type: "string" },
      source: { type: "string" },
      viewport: { type: "string" },
      size: { type: "string" },
      tag: { type: "string", multiple: true },
      "full-page": { type: "boolean" },
    },
    args: [1, 1],
    mockup: true,
    run: stillsAdd,
  },
  "stills ls": { options: { as: { type: "string" }, json: { type: "boolean" } }, args: [0, 0], run: stillsLs },
  "stills export": { options: { readme: { type: "boolean" } }, args: [1, 1], mockup: true, run: stillsExport },
  "review ls": { options: { open: { type: "boolean" }, json: { type: "boolean" } }, args: [0, 0], run: reviewLs },
  "review show": { options: { json: { type: "boolean" } }, args: [1, 1], run: reviewShow },
  "review reply": { options: {}, args: [2, Infinity], raw: true, run: reviewReply },
  "review resolve": { options: {}, args: [1, 1], run: (ctx, args) => setStatus(ctx, "resolve", args[0]) },
  "review reopen": { options: {}, args: [1, 1], run: (ctx, args) => setStatus(ctx, "reopen", args[0]) },
  "review working": {
    options: { variant: { type: "string" }, note: { type: "string" } },
    args: [1, 1],
    run: reviewWorking,
  },
  "review idle": { options: {}, args: [0, 1], run: reviewIdle },
  "review watch": { options: { since: { type: "string" }, json: { type: "boolean" } }, args: [0, 0], run: reviewWatch },
};

/** An error whose message is printed as is, with the exit status `code`. */
class CliError extends Error {
  constructor(message, code = 1) {
    super(message);
    this.code = code;
  }
}

/** `anchor` in words: a pin, a box or the whole still. */
function anchorText(anchor) {
  if (!anchor) return "whole";
  const xy = `${anchor.x.toFixed(2)},${anchor.y.toFixed(2)}`;
  if (anchor.w === undefined) return `pin ${xy}`;
  return `box ${xy} ${anchor.w.toFixed(2)}x${anchor.h.toFixed(2)}`;
}

/** `author` as printed: the name, then `(guest)`, `(tailnet)` or `(cli)` when it says how it came. */
export function who(author) {
  return author.via ? `${author.name} (${VIA_LABEL[author.via]})` : author.name;
}

/** `still`, then its variant in brackets when it is known: `05-invite [mobile+dark]`. */
function stillText(still, variant) {
  return variant ? `${still} [${variant}]` : still;
}

/**
 * Where a thread points: `<still> [<variant>] r<rev> <anchor>`, or `general` for a thread on no
 * still. The variant is left out when it is not known.
 */
function target(thread) {
  if (thread.still === null) return "general";
  return `${stillText(thread.still, thread.variant)} r${thread.rev} ${anchorText(thread.anchor)}`;
}

/** `body` on one line, quoted, so newlines in it never split a line of output. */
function quote(body, max = Infinity) {
  return JSON.stringify(body.length > max ? `${body.slice(0, max - 1)}…` : body);
}

/** What a `working` or `idle` event is about: its thread, else its still and `variant`, else nothing. */
function aboutText(event, variant = event.variant) {
  return event.thread ?? (event.still ? stillText(event.still, variant) : "");
}

/**
 * The line `watch` prints for `event`. `first` maps a still's name to its first variant, the
 * one an event without `variant` means.
 */
export function eventLine(event, first = new Map()) {
  const by = who(event.author);
  const head = `#${event.seq} ${event.type}`;
  const variant = event.variant ?? first.get(event.still) ?? null;
  switch (event.type) {
    case "thread": {
      const where = target({ rev: null, anchor: null, ...event, variant });
      return `${head} ${event.id} ${where} ${by}: ${quote(event.body)}`;
    }
    case "reply":
      return `${head} ${event.thread} ${by}: ${quote(event.body)}`;
    case "resolve":
    case "reopen":
      return `${head} ${event.thread} ${by}`;
    case "working":
    case "idle": {
      const about = aboutText(event, variant);
      return `${head}${about ? ` ${about}` : ""} ${by}`;
    }
    default:
      return `${head} ${stillText(event.still, variant)} r${event.rev} ${by}`;
  }
}

/** The thread `id` of the review in `dir`; throws when the log never opened it. */
function findThread(dir, id) {
  const thread = threads(dir).find((t) => t.id === id);
  if (!thread) throw new CliError(`no thread '${id}'; see 'preview review ls'`);
  return thread;
}

/**
 * Add a revision of a variant of a still from a PNG file, or from stdin when the file is `-`.
 * `--size WxH`, from before viewports, is a custom viewport at 1x.
 */
async function stillsAdd({ dir, io }, [file], { name, title, source, viewport, size, tag, "full-page": fullPage }) {
  if (!name) throw new CliError("--name is required", 2);
  if (viewport !== undefined && size !== undefined) throw new CliError("give --viewport or --size, not both", 2);
  let tmp = null;
  if (file === "-") {
    tmp = mkdtempSync(path.join(tmpdir(), "still-"));
    file = path.join(tmp, "still.png");
    writeFileSync(file, io.readStdin());
  } else if (!existsSync(file)) {
    throw new CliError(`${file}: no such file`);
  }
  try {
    const { entry, variant, rev, unchanged } = await addStill(dir, {
      file,
      name,
      title,
      source,
      viewport: viewport ?? size,
      tags: tag,
      fullPage,
    });
    io.out(`${entry.name} [${variant.key}] r${rev.n} ${io.host(rev.file)}${unchanged ? " unchanged" : ""}`);
  } finally {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * The reviewed state of a variant in words: as `as` left it when given, else whose marks
 * hold on its latest revision (`marks` maps a reviewer to their mark of it).
 */
function stateText(marks, as) {
  if (as !== undefined) {
    const m = marks.get(as);
    if (m.reviewed) return "reviewed";
    return m.changed ? `changed since reviewed (r${m.viewed})` : "not reviewed";
  }
  const holds = [...marks].filter(([, m]) => m.reviewed).map(([name]) => name);
  const changed = [...marks].filter(([, m]) => m.changed).map(([name]) => name);
  if (holds.length) return `reviewed by ${holds.join(", ")}`;
  return changed.length ? `changed since reviewed by ${changed.join(", ")}` : "not reviewed";
}

/**
 * Each variant of each still: its current revision, its reviewed state and its open threads.
 * The state is the one `--as` left, else whose marks hold; the JSON carries every reviewer's.
 */
function stillsLs({ dir, io }, _args, { as, json }) {
  const { reviewers, marks } = reviewMarks(dir);
  const names = as === undefined ? reviewers : [as];
  const open = threads(dir).filter((t) => t.status === "open");
  const rows = stills(dir).map((s) => ({
    name: s.name,
    title: s.title,
    source: s.source,
    variants: s.variants.map((v) => {
      const rev = v.revs.at(-1) ?? null;
      const byReviewer = new Map(
        names.map((n) => [n, markOf(rev?.n ?? 0, marks.get(n)?.get(s.name)?.get(v.key) ?? null)])
      );
      return {
        key: v.key,
        viewport: v.viewport,
        tags: v.tags,
        rev: rev?.n ?? 0,
        file: rev ? io.host(rev.file) : null,
        ...(as === undefined ? {} : byReviewer.get(as)),
        marks: Object.fromEntries(byReviewer),
        state: stateText(byReviewer, as),
        open: open.filter((t) => t.still === s.name && t.variant === v.key).length,
      };
    }),
  }));
  if (json) return io.out(JSON.stringify(rows, null, 2));
  if (!rows.length && typeof dir !== "string") return io.out(`no images in ${io.host(".")}`);
  if (!rows.length) return io.out("no stills yet; add one with 'preview stills add'");
  for (const r of rows) {
    for (const v of r.variants) {
      io.out(`${r.name} [${v.key}]  r${v.rev}  ${v.state}  ${v.open} open  ${quote(r.title)}`);
    }
  }
}

/**
 * Copy the mockup's stills and review into the folder `dest` (see `export.mjs`), which
 * `--folder` and `preview stills serve` then read as the same stills with the same remarks.
 * The folder is printed, and a README without a mockup title is headed, by its name under
 * `$MOCKUP_EXPORT_HOST_DIR` when set.
 */
function stillsExport({ dir, io }, [dest], { readme }) {
  const shown = io.env.MOCKUP_EXPORT_HOST_DIR || path.resolve(dest);
  let done;
  try {
    done = exportStills(dir, dest, { readme, title: path.basename(shown) });
  } catch (e) {
    throw new CliError(`${shown}: ${e.message}`);
  }
  if (!done.stills) throw new CliError("no stills to export; add one with 'preview stills add'");
  for (const name of done.wrote) io.out(`wrote ${path.join(shown, name)}`);
  for (const name of done.skipped) io.out(`kept ${path.join(shown, name)} (exists)`);
  const events = `${done.events} ${done.events === 1 ? "event" : "events"}`;
  io.out(
    `exported ${done.stills} stills (${done.images} images, ${done.revisions} revisions) and ${events} to ${shown}`
  );
}

/** The threads of the review, all or only the open ones. */
function reviewLs({ dir, io }, _args, { open, json }) {
  const rows = threads(dir).filter((t) => !open || t.status === "open");
  if (json) return io.out(JSON.stringify(rows, null, 2));
  if (!rows.length) return io.out(open ? "no open threads" : "no threads yet");
  for (const t of rows) {
    const replies = `${t.replies.length} ${t.replies.length === 1 ? "reply" : "replies"}`;
    io.out(`${t.id}  ${t.status}  ${target(t)}  ${replies}  ${who(t.author)}: ${quote(t.body, 80)}`);
  }
}

/** One thread in full: where it points, its body and replies, and the files to look at. */
function reviewShow({ dir, root, io }, [id], { json }) {
  const thread = findThread(dir, id);
  const rev = stills(dir)
    .find((s) => s.name === thread.still)
    ?.variants.find((v) => v.key === thread.variant)
    ?.revs.find((r) => r.n === thread.rev);
  const annotated = path.relative(root, path.join(storePaths(dir).annotated, `${thread.id}.png`));
  const files = {
    image: rev ? io.host(rev.file) : null,
    annotated: existsSync(path.join(root, annotated)) ? io.host(annotated) : null,
  };
  if (json) return io.out(JSON.stringify({ ...thread, ...files }, null, 2));
  io.out(`thread  ${thread.id}  ${thread.status}`);
  io.out(`on      ${target(thread)}`);
  if (files.image) io.out(`image   ${files.image}`);
  const notDrawn = "(none: not written yet, or the viewer could not draw it; read image at the anchor above)";
  if (files.annotated || thread.anchor) io.out(`marked  ${files.annotated ?? notDrawn}`);
  for (const e of [thread, ...thread.replies]) {
    io.out("");
    const via = e.author.via ? `, ${VIA_LABEL[e.author.via]}` : "";
    io.out(`#${e.seq} ${e.author.name} (${e.author.kind}${via}) ${e.at}`);
    for (const line of e.body.split("\n")) io.out(`  ${line}`);
  }
}

/** Append `event` as the agent and print its seq, its type and what it is about. */
async function agentEvent({ dir, root, io }, event) {
  if (typeof dir !== "string" && !readSource(root).writable) {
    throw new CliError(`${io.host(".")}: ${READ_ONLY}`);
  }
  const stored = await appendEvent(dir, { ...event, author: { kind: "agent", name: io.author, via: "cli" } });
  const about = aboutText(stored);
  io.out(`#${stored.seq} ${stored.type}${about ? ` ${about}` : ""}`);
}

/** Reply to a thread as the agent. */
function reviewReply(ctx, [id, ...words]) {
  findThread(ctx.dir, id);
  return agentEvent(ctx, { type: "reply", thread: id, body: words.join(" ") });
}

/** Resolve or reopen a thread as the agent. */
function setStatus(ctx, type, id) {
  findThread(ctx.dir, id);
  return agentEvent(ctx, { type, thread: id });
}

/**
 * Report the agent working on a thread, or on a still (a variant of it with `--variant`),
 * named by `on`. Sending it again keeps the state on; a reply or `idle` ends it.
 */
function reviewWorking(ctx, [on], { variant, note }) {
  const { dir } = ctx;
  const event = { type: "working" };
  if (threads(dir).some((t) => t.id === on)) {
    if (variant !== undefined) throw new CliError("--variant goes with a still, not a thread", 2);
    event.thread = on;
  } else if (revisions(dir).has(on)) {
    event.still = on;
    if (variant !== undefined) event.variant = variant;
  } else {
    throw new CliError(`no thread or still '${on}'; see 'preview review ls' and 'preview stills ls'`);
  }
  if (note !== undefined) event.note = note;
  return agentEvent(ctx, event);
}

/** End the agent's working state on a thread, or every one without a thread. */
function reviewIdle(ctx, [id]) {
  if (id === undefined) return agentEvent(ctx, { type: "idle" });
  findThread(ctx.dir, id);
  return agentEvent(ctx, { type: "idle", thread: id });
}

/** True when the scratch dir is gone, also when it was deleted under a bind mount. */
function dirGone(dir) {
  try {
    return statSync(dir).nlink === 0;
  } catch {
    return true;
  }
}

/** The size and mtime of the log, to skip a re-read when it has not changed. */
function logStamp(dir) {
  try {
    const s = statSync(storePaths(dir).events);
    return `${s.size}:${s.mtimeMs}`;
  } catch {
    return "";
  }
}

/**
 * Print one line per new human event until `io.signal` aborts: from `--since` (a seq) or else
 * from the end of the log. Malformed lines are reported once on stderr. Fails when the scratch
 * dir disappears.
 */
async function reviewWatch({ dir, root, io }, _args, { since, json }) {
  if (since !== undefined && !/^\d+$/.test(since)) throw new CliError("--since must be a seq, 0 or more", 2);
  if (dirGone(root)) throw new CliError(`${io.host(".")}: no such directory`);
  let cursor = since === undefined ? readEvents(dir).cursor : Number(since);
  const reported = new Set();
  let stamp = null;
  while (!io.signal?.aborted) {
    if (dirGone(root)) throw new CliError(`${io.host(".")}: removed; stopped watching`);
    const now = logStamp(dir);
    if (now !== stamp) {
      stamp = now;
      const { events, problems, cursor: next } = readEvents(dir, cursor);
      for (const p of problems) {
        if (reported.has(p.line)) continue;
        reported.add(p.line);
        io.err(`events.jsonl line ${p.line} skipped: ${p.error}`);
      }
      const human = events.filter((e) => e.author.kind === "human");
      const first = human.length && !json ? new Map([...revisions(dir)].map(([n, v]) => [n, v.first])) : null;
      for (const e of human) io.out(json ? JSON.stringify(e) : eventLine(e, first));
      cursor = next;
    }
    await sleep(io.pollMs ?? POLL_MS, undefined, { signal: io.signal }).catch(() => {});
  }
}

/**
 * Run the CLI on `argv` (without node and the script) and return its exit status. `io` carries
 * `out` and `err` (one line each), `readStdin`, `env` and an optional abort `signal`. A `raw`
 * command takes its arguments verbatim, so a reply may start with '-'; one `--` is dropped.
 */
export async function main(argv, io) {
  const env = io.env ?? {};
  let args = argv;
  let dirArg;
  let folderArg;
  if (args[0] === "--dir") [, dirArg, ...args] = args;
  else if (args[0]?.startsWith("--dir=")) [dirArg, ...args] = [args[0].slice(6), ...args.slice(1)];
  else if (args[0] === "--folder") [, folderArg, ...args] = args;
  else if (args[0]?.startsWith("--folder=")) [folderArg, ...args] = [args[0].slice(9), ...args.slice(1)];
  if (args[0] === "-h" || args[0] === "--help") {
    io.out(USAGE);
    return 0;
  }
  const key = args.slice(0, 2).join(" ");
  const command = Object.hasOwn(COMMANDS, key) ? COMMANDS[key] : null;
  if (!command) {
    io.err(USAGE);
    return 2;
  }
  const root = path.resolve(folderArg ?? dirArg ?? env.MOCKUP_DIR ?? process.cwd());
  const ctx = {
    dir: folderArg === undefined ? root : folder(root),
    root,
    io: {
      ...io,
      env,
      host: (rel) => path.join(env.MOCKUP_HOST_DIR || root, rel),
      author: env.REVIEW_AUTHOR?.trim() || "agent",
    },
  };
  try {
    if (command.mockup && folderArg !== undefined) {
      throw new CliError(`'${key}' works on a mockup; a folder's stills are its images`, 2);
    }
    let parsed;
    if (command.raw) {
      const rest = args.slice(2);
      const end = rest.indexOf("--");
      if (end !== -1) rest.splice(end, 1);
      parsed = { positionals: rest, values: {} };
    } else {
      try {
        parsed = parseArgs({ args: args.slice(2), options: command.options, allowPositionals: true, strict: true });
      } catch (e) {
        throw new CliError(e.message, 2);
      }
    }
    const [min, max] = command.args;
    if (parsed.positionals.length < min || parsed.positionals.length > max) throw new CliError(USAGE, 2);
    await command.run(ctx, parsed.positionals, parsed.values);
    return 0;
  } catch (e) {
    if (e instanceof CliError) {
      io.err(e.message);
      return e.code;
    }
    io.err(`error: ${e.message}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const controller = new AbortController();
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => controller.abort());
  process.stdout.on("error", () => controller.abort());
  const code = await main(process.argv.slice(2), {
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
    readStdin: () => readFileSync(0),
    env: process.env,
    signal: controller.signal,
  });
  process.exitCode = code;
}
