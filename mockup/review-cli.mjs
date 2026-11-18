/**
 * The review CLI of the /mockup runtime: the agent's side of the stills review, over the store
 * in `review.mjs`. `preview stills|review` runs it inside the runtime image, so the viewer and
 * the CLI share one module.
 *
 *   node review-cli.mjs [--dir D] stills add <png|-> --name N [--title T] [--source P] [--size WxH]
 *   node review-cli.mjs [--dir D] stills ls [--json]
 *   node review-cli.mjs [--dir D] review ls [--open] [--json]
 *   node review-cli.mjs [--dir D] review show <thread> [--json]
 *   node review-cli.mjs [--dir D] review reply <thread> <text...>
 *   node review-cli.mjs [--dir D] review resolve|reopen <thread>
 *   node review-cli.mjs [--dir D] review watch [--since SEQ] [--json]
 *
 * `--dir` is the mockup scratch dir (`.mockup/`), default `$MOCKUP_DIR` or the working dir.
 * Paths are printed under `$MOCKUP_HOST_DIR` when set, so a CLI run in a container names files
 * as the host sees them. Agent events are written as `{kind: "agent", name: $REVIEW_AUTHOR}`
 * (default "agent"). Exit status: 0 done, 1 failed, 2 bad usage.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { addStill, appendEvent, readEvents, reviewed, stills, threads } from "./review.mjs";

const POLL_MS = 200;

const USAGE = `usage: preview stills add <png> --name N [--title T] [--source "/path?q"] [--size WxH]
       preview stills ls [--json]
       preview review ls [--open] [--json]
       preview review show <thread> [--json]
       preview review reply <thread> "<text>"
       preview review resolve|reopen <thread>
       preview review watch [--since SEQ] [--json]`;

const COMMANDS = {
  "stills add": {
    options: { name: { type: "string" }, title: { type: "string" }, source: { type: "string" }, size: { type: "string" } },
    args: [1, 1],
    run: stillsAdd,
  },
  "stills ls": { options: { json: { type: "boolean" } }, args: [0, 0], run: stillsLs },
  "review ls": { options: { open: { type: "boolean" }, json: { type: "boolean" } }, args: [0, 0], run: reviewLs },
  "review show": { options: { json: { type: "boolean" } }, args: [1, 1], run: reviewShow },
  "review reply": { options: {}, args: [2, Infinity], run: reviewReply },
  "review resolve": { options: {}, args: [1, 1], run: (ctx, args) => mark(ctx, "resolve", args[0]) },
  "review reopen": { options: {}, args: [1, 1], run: (ctx, args) => mark(ctx, "reopen", args[0]) },
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

/** Where a thread points: `<still> r<rev> <anchor>`, or `general` for a thread on no still. */
function target(thread) {
  return thread.still === null ? "general" : `${thread.still} r${thread.rev} ${anchorText(thread.anchor)}`;
}

/** `body` on one line, quoted, so newlines in it never split a line of output. */
function quote(body, max = Infinity) {
  return JSON.stringify(body.length > max ? `${body.slice(0, max - 1)}…` : body);
}

/** The line `watch` prints for `event`. */
export function eventLine(event) {
  const who = event.author.name;
  const head = `#${event.seq} ${event.type}`;
  switch (event.type) {
    case "thread":
      return `${head} ${event.id} ${target({ rev: null, anchor: null, ...event })} ${who}: ${quote(event.body)}`;
    case "reply":
      return `${head} ${event.thread} ${who}: ${quote(event.body)}`;
    case "resolve":
    case "reopen":
      return `${head} ${event.thread} ${who}`;
    default:
      return `${head} ${event.still} r${event.rev} ${who}`;
  }
}

/** The thread `id` of the review in `dir`; throws when the log never opened it. */
function findThread(dir, id) {
  const thread = threads(dir).find((t) => t.id === id);
  if (!thread) throw new CliError(`no thread '${id}'; see 'preview review ls'`);
  return thread;
}

/** Add a revision of a still from a PNG file, or from stdin when the file is `-`. */
async function stillsAdd({ dir, io }, [file], { name, title, source, size }) {
  if (!name) throw new CliError("--name is required", 2);
  let tmp = null;
  if (file === "-") {
    tmp = mkdtempSync(path.join(tmpdir(), "still-"));
    file = path.join(tmp, "still.png");
    writeFileSync(file, io.readStdin());
  } else if (!existsSync(file)) {
    throw new CliError(`${file}: no such file`);
  }
  try {
    const entry = await addStill(dir, { file, name, title, source, size });
    const rev = entry.revs.at(-1);
    io.out(`${entry.name} r${rev.n} ${path.join(io.hostDir, rev.file)}`);
  } finally {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  }
}

/** Each still's current revision, its reviewed state and its open threads. */
function stillsLs({ dir, io }, _args, { json }) {
  const marks = reviewed(dir);
  const open = threads(dir).filter((t) => t.status === "open");
  const rows = stills(dir).map((s) => {
    const mark = marks[s.name] ?? { rev: 0, viewed: null, reviewed: false, changed: false };
    const rev = s.revs.find((r) => r.n === mark.rev);
    return {
      name: s.name,
      title: s.title,
      source: s.source,
      ...mark,
      file: rev ? path.join(io.hostDir, rev.file) : null,
      open: open.filter((t) => t.still === s.name).length,
    };
  });
  if (json) return io.out(JSON.stringify(rows, null, 2));
  if (!rows.length) return io.out("no stills yet; add one with 'preview stills add'");
  for (const r of rows) {
    const state = r.reviewed ? "reviewed" : r.changed ? `changed since reviewed (r${r.viewed})` : "not reviewed";
    io.out(`${r.name}  r${r.rev}  ${state}  ${r.open} open  ${quote(r.title)}`);
  }
}

/** The threads of the review, all or only the open ones. */
function reviewLs({ dir, io }, _args, { open, json }) {
  const rows = threads(dir).filter((t) => !open || t.status === "open");
  if (json) return io.out(JSON.stringify(rows, null, 2));
  if (!rows.length) return io.out(open ? "no open threads" : "no threads yet");
  for (const t of rows) {
    const replies = `${t.replies.length} ${t.replies.length === 1 ? "reply" : "replies"}`;
    io.out(`${t.id}  ${t.status}  ${target(t)}  ${replies}  ${t.author.name}: ${quote(t.body, 80)}`);
  }
}

/** One thread in full: where it points, its body and replies, and the files to look at. */
function reviewShow({ dir, io }, [id], { json }) {
  const thread = findThread(dir, id);
  const rev = stills(dir)
    .find((s) => s.name === thread.still)
    ?.revs.find((r) => r.n === thread.rev);
  const annotated = path.join("review", "annotated", `${thread.id}.png`);
  const files = {
    image: rev ? path.join(io.hostDir, rev.file) : null,
    annotated: existsSync(path.join(dir, annotated)) ? path.join(io.hostDir, annotated) : null,
  };
  if (json) return io.out(JSON.stringify({ ...thread, ...files }, null, 2));
  io.out(`thread  ${thread.id}  ${thread.status}`);
  io.out(`on      ${target(thread)}`);
  if (files.image) io.out(`image   ${files.image}`);
  if (thread.still !== null) io.out(`marked  ${files.annotated ?? "(not drawn yet: the viewer draws it when the thread is opened)"}`);
  for (const e of [thread, ...thread.replies]) {
    io.out("");
    io.out(`#${e.seq} ${e.author.name} (${e.author.kind}) ${e.at}`);
    for (const line of e.body.split("\n")) io.out(`  ${line}`);
  }
}

/** Append an agent event, after checking the thread exists so the error names the command. */
async function agentEvent({ dir, io }, event) {
  findThread(dir, event.thread);
  const stored = await appendEvent(dir, { ...event, author: { kind: "agent", name: io.author } });
  io.out(`#${stored.seq} ${stored.type} ${stored.thread}`);
}

/** Reply to a thread as the agent. */
function reviewReply(ctx, [id, ...words]) {
  return agentEvent(ctx, { type: "reply", thread: id, body: words.join(" ") });
}

/** Resolve or reopen a thread as the agent. */
function mark(ctx, type, id) {
  return agentEvent(ctx, { type, thread: id });
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
    const s = statSync(path.join(dir, "review", "events.jsonl"));
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
async function reviewWatch({ dir, io }, _args, { since, json }) {
  if (since !== undefined && !/^\d+$/.test(since)) throw new CliError("--since must be a seq, 0 or more", 2);
  if (dirGone(dir)) throw new CliError(`${dir}: no such directory`);
  let cursor = since === undefined ? readEvents(dir).cursor : Number(since);
  const reported = new Set();
  let stamp = null;
  while (!io.signal?.aborted) {
    if (dirGone(dir)) throw new CliError(`${io.hostDir}: removed; stopped watching`);
    const now = logStamp(dir);
    if (now !== stamp) {
      stamp = now;
      const { events, problems, cursor: next } = readEvents(dir, cursor);
      for (const p of problems) {
        if (reported.has(p.line)) continue;
        reported.add(p.line);
        io.err(`events.jsonl line ${p.line} skipped: ${p.error}`);
      }
      for (const e of events) {
        if (e.author.kind === "human") io.out(json ? JSON.stringify(e) : eventLine(e));
      }
      cursor = next;
    }
    await sleep(io.pollMs ?? POLL_MS, undefined, { signal: io.signal }).catch(() => {});
  }
}

/**
 * Run the CLI on `argv` (without node and the script) and return its exit status. `io` carries
 * `out` and `err` (one line each), `readStdin`, `env` and an optional abort `signal`.
 */
export async function main(argv, io) {
  const env = io.env ?? {};
  let args = argv;
  let dirArg;
  if (args[0] === "--dir") [, dirArg, ...args] = args;
  else if (args[0]?.startsWith("--dir=")) [dirArg, ...args] = [args[0].slice(6), ...args.slice(1)];
  if (args[0] === "-h" || args[0] === "--help") {
    io.out(USAGE);
    return 0;
  }
  const command = COMMANDS[args.slice(0, 2).join(" ")];
  if (!command) {
    io.err(USAGE);
    return 2;
  }
  const dir = path.resolve(dirArg ?? env.MOCKUP_DIR ?? process.cwd());
  const ctx = {
    dir,
    io: { ...io, hostDir: env.MOCKUP_HOST_DIR || dir, author: env.REVIEW_AUTHOR?.trim() || "agent" },
  };
  try {
    let parsed;
    try {
      parsed = parseArgs({ args: args.slice(2), options: command.options, allowPositionals: true, strict: true });
    } catch (e) {
      throw new CliError(e.message, 2);
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
