/**
 * Any local directory as a stills source: a folder of images, git or not, read into the shape
 * the viewer reads from `/_review/stills`, so a mockup's `.mockup/` is just one more source.
 *
 * Images (`png`, `jpg`, `jpeg`, `webp`, `gif`) are the only requirement. Everything else is
 * optional and only adds to what the images give, highest priority first, each filling only
 * what it knows:
 *
 *   stills/manifest.json   the contract's format: stills, variants and revisions as declared
 *   stills.json            [{ name, title, group?, file? }]: titles, order, groups
 *   README.md / index.md   order of appearance, groups from the nearest #/##/### heading,
 *                          titles from a table row's text cells or the alt text, and the
 *                          document itself as the viewer's About page
 *   subfolders             each one a group, when nothing above gives groups
 *   name@<key>.png         a variant of the still `name`, `<key>` a variant key (mobile+dark)
 *
 * A missing extra falls back silently; a broken one is used for what it gives and its problem
 * is returned as a note, never thrown. Scanning skips `.review/`, hidden entries and
 * `node_modules`.
 *
 * Without a manifest a still's revision is its content hash. The review of a folder lives in
 * `<dir>/.review/`, created by the first write (a remark, a reviewed mark, `keepRevisions`) and
 * never by reading:
 *
 *   .review/events.jsonl            the event log, as in the contract
 *   .review/annotated/<id>.png      thread <id>'s still with its mark drawn
 *   .review/revs.json               { name: { key: [{ n, hash, ext, size, mtimeMs, at }] } }
 *   .review/revs/<name>/<key>/<n>.<ext>  the bytes of every revision kept
 *
 * Once `.review/` exists, a read that finds an image changed records it as the next revision
 * and keeps its bytes, so before/after and remarks on old revisions keep working; the folder
 * itself only ever holds the current images. A folder with `stills/manifest.json` is a scratch
 * dir in the contract's layout and keeps its log in `review/`.
 */

import { createHash } from "node:crypto";
import {
  accessSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  keyViewport,
  MANIFEST_FILE,
  parseTags,
  parseViewport,
  sideFile,
  upgraded,
  variantKey,
  withLock,
} from "./review.mjs";

const IMAGE = /\.(png|jpe?g|webp|gif)$/i;
const SKIP = new Set(["node_modules"]);
export const READMES = ["README.md", "readme.md", "Readme.md", "index.md"];
const PRESETS = new Set(["mobile", "mobile-s", "tablet", "desktop", "web"]);
const NAME = /^[A-Za-z0-9][\w.-]{0,99}$/;
export const REVIEW_DIR = ".review";
export const DEFAULT_KEY = "desktop";
const natural = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

/** `rel` with forward slashes, as files are named in a source. */
function posix(rel) {
  return rel.split(path.sep).join("/");
}

/** The paths of the review of the folder `dir`, in the shape `review.mjs` reads them. */
function reviewPaths(dir) {
  const root = path.join(dir, REVIEW_DIR);
  return {
    root,
    events: path.join(root, "events.jsonl"),
    eventsLock: path.join(root, ".lock"),
    annotated: path.join(root, "annotated"),
    revs: path.join(root, "revs.json"),
    revsLock: path.join(root, "revs.lock"),
  };
}

/** True when this process may write `file`, which exists. */
function canWrite(file) {
  try {
    accessSync(file, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** True when the review of `dir` can be written: the folder, and its `.review/` when it exists. */
function isWritable(dir) {
  const root = path.join(dir, REVIEW_DIR);
  return canWrite(dir) && (!existsSync(root) || canWrite(root));
}

/**
 * The images under `dir`, depth first: a folder's files in natural order, then its subfolders
 * in natural order. Each is `{ rel, folder }`, `rel` its path from `dir` and `folder` the
 * subfolder it is in ("" at the top).
 */
function scan(dir, sub = "") {
  let entries;
  try {
    entries = readdirSync(path.join(dir, sub), { withFileTypes: true });
  } catch {
    return [];
  }
  const visible = entries.filter((e) => !e.name.startsWith(".") && !SKIP.has(e.name));
  const byName = (a, b) => natural.compare(a.name, b.name) || (a.name < b.name ? -1 : 1);
  const files = visible.filter((e) => e.isFile() && IMAGE.test(e.name)).sort(byName);
  const folders = visible.filter((e) => e.isDirectory()).sort(byName);
  return [
    ...files.map((e) => ({ rel: posix(path.join(sub, e.name)), folder: posix(sub) })),
    ...folders.flatMap((e) => scan(dir, path.join(sub, e.name))),
  ];
}

/**
 * The variant key `spec` names, after the `@` of an image's name: a preset (or `web`), a
 * `custom-<W>x<H>[@<dpr>][-touch]` or a `WxH[@dpr]`, then `+<tag>`s. Returns `{ key, viewport,
 * tags }`, or null when it is no key.
 */
function parseKey(spec) {
  const [head, ...rest] = spec.toLowerCase().split("+");
  try {
    const viewport = PRESETS.has(head)
      ? parseViewport(head)
      : head.startsWith("custom-")
        ? keyViewport(head)
        : parseViewport(head);
    if (!viewport) return null;
    const tags = parseTags(rest);
    return { key: variantKey(viewport, tags), viewport, tags };
  } catch {
    return null;
  }
}

/** `text` made a still name: runs of other characters as `-`, starting with a letter or digit. */
function cleanName(text) {
  return text
    .replace(/[^\w.-]+/g, "-")
    .replace(/^[^A-Za-z0-9]+/, "")
    .slice(0, 100);
}

/** The title a name gives: `05-invite-user` is "05 invite user". */
function titleOf(base) {
  return base.replace(/[-_\s]+/g, " ").trim() || base;
}

/**
 * The stills the images of `dir` make, in scan order: `name@<key>.<ext>` is the variant
 * `<key>` of the still `name`, a plain `name.<ext>` its `desktop` one. A still in a subfolder
 * is named by its path, `admin/01-list.png` being `admin.01-list`. Each still is `{ name, base,
 * title, folder, variants: [{ key, viewport, tags, rel, ext }] }`, the plain image's variant
 * first and the rest in natural order of their keys.
 */
function scanStills(dir, notes) {
  const byName = new Map();
  const folded = new Map();
  for (const { rel, folder } of scan(dir)) {
    const file = path.posix.basename(rel);
    const ext = path.posix.extname(file).slice(1).toLowerCase();
    const stem = file.slice(0, -(ext.length + 1));
    const at = stem.indexOf("@");
    let base = stem;
    let variant = { key: DEFAULT_KEY, viewport: parseViewport(DEFAULT_KEY), tags: [] };
    if (at > 0) {
      const parsed = parseKey(stem.slice(at + 1));
      if (parsed) {
        base = stem.slice(0, at);
        variant = parsed;
      } else {
        notes.push(`${rel}: '${stem.slice(at + 1)}' is not a variant key, read as its own still`);
      }
    }
    const name = cleanName([...(folder ? folder.split("/") : []), base].join("."));
    if (!NAME.test(name)) {
      notes.push(`${rel}: no still name can be made from it, skipped`);
      continue;
    }
    const clash = folded.get(name.toLowerCase());
    if (clash && clash !== name) {
      notes.push(`${rel}: '${name}' differs from the still '${clash}' only in case, skipped`);
      continue;
    }
    folded.set(name.toLowerCase(), name);
    let still = byName.get(name);
    if (!still) {
      still = { name, base, title: titleOf(base), folder, variants: [] };
      byName.set(name, still);
    }
    const same = still.variants.find((v) => v.key === variant.key);
    if (same) {
      notes.push(`${rel}: the still '${name}' [${variant.key}] is ${same.rel} already, skipped`);
      continue;
    }
    still.variants.push({ ...variant, rel, ext });
  }
  const tagged = (v) => Number(path.posix.basename(v.rel).includes("@"));
  for (const still of byName.values()) {
    still.variants.sort((a, b) => tagged(a) - tagged(b) || natural.compare(a.key, b.key));
  }
  return [...byName.values()];
}

/** The line a JSON.parse error of `text` is on, as "line N: <message>". */
function jsonProblem(text, error) {
  const line = /line (\d+)/.exec(error.message)?.[1];
  const at = /position (\d+)/.exec(error.message)?.[1];
  const n = line ?? (at === undefined ? null : text.slice(0, Number(at)).split("\n").length);
  const message = error.message.replace(/\s*\(line \d+ column \d+\)/, "").replace(/ in JSON at position \d+/, "");
  return n === null ? message : `line ${n}: ${message}`;
}

/** The JSON file `rel` of `dir`: `{ value }`, `{ problem }` when broken, or null when missing. */
function readJson(dir, rel) {
  let text;
  try {
    text = readFileSync(path.join(dir, rel), "utf8");
  } catch {
    return null;
  }
  try {
    return { value: JSON.parse(text) };
  } catch (e) {
    return { problem: `${rel}: ${jsonProblem(text, e)}` };
  }
}

/**
 * `text` without its markdown emphasis, code ticks, links and HTML tags, a `\|` or `\\` of a
 * table cell unescaped, spaces collapsed.
 */
function plainText(text) {
  return text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/(\*\*|__|`)/g, "")
    .replace(/(^|\W)[*_](\S[^*_]*?)[*_](?=\W|$)/g, "$1$2")
    .replace(/\\([\\|])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/** The image references in the markdown `line`: `{ target, alt }`, in order. */
function imageRefs(line) {
  const refs = [];
  const patterns = [
    [/!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+["'][^"']*["'])?\s*\)/g, (m) => ({ alt: m[1], target: m[2] })],
    [/(?<!!)\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+["'][^"']*["'])?\s*\)/g, (m) => ({ alt: m[1], target: m[2] })],
    [
      /<img\b[^>]*>/gi,
      (m) => ({
        alt: /\balt=["']([^"']*)["']/i.exec(m[0])?.[1] ?? "",
        target: /\bsrc=["']([^"']+)["']/i.exec(m[0])?.[1],
      }),
    ],
  ];
  for (const [pattern, read] of patterns) {
    for (const m of line.matchAll(pattern)) {
      const ref = read(m);
      if (!ref.target) continue;
      const image = IMAGE.test(ref.target.replace(/[?#].*$/, ""));
      if (pattern.source.startsWith("(?<!!)") && !image) continue;
      refs.push({ ...ref, index: m.index });
    }
  }
  return refs.sort((a, b) => a.index - b.index);
}

/** The path from `dir` an image reference `target` of a file in `dir` names, or null for a URL. */
export function resolveRef(target) {
  if (/^[a-z][\w+.-]*:/i.test(target) || target.startsWith("/") || target.startsWith("#")) return null;
  let clean = target.replace(/[?#].*$/, "");
  try {
    clean = decodeURIComponent(clean);
  } catch {
    return null;
  }
  const rel = path.posix.normalize(clean);
  return rel.startsWith("../") || rel === ".." ? null : rel;
}

/** The cells of the markdown table row `line`, split on its unescaped `|`. */
function cells(line) {
  const inner = line
    .trim()
    .replace(/^\|/, "")
    .replace(/(?<!\\)\|$/, "");
  return inner.split(/(?<!\\)\|/).map((c) => c.trim());
}

/**
 * What the README of `dir` says about its images: `{ file, markdown, refs }`, `refs` the
 * images it references in order of appearance, each `{ rel, group, title }`: `group` the
 * nearest #, ## or ### heading above it, `title` the text cells of its table row (less one
 * the image's name starts with, such as its number) or else its alt text. Null when there is
 * no README.
 */
function readReadme(dir) {
  for (const file of READMES) {
    let markdown;
    try {
      markdown = readFileSync(path.join(dir, file), "utf8");
    } catch {
      continue;
    }
    const refs = [];
    let group = null;
    let fence = null;
    for (const line of markdown.split(/\r?\n/)) {
      const open = /^\s*(```|~~~)/.exec(line);
      if (open) {
        if (!fence) fence = open[1];
        else if (open[1] === fence) fence = null;
        continue;
      }
      if (fence) continue;
      const heading = /^(#{1,3})\s+(.*?)\s*#*\s*$/.exec(line);
      if (heading) {
        group = plainText(heading[2]) || null;
        continue;
      }
      const found = imageRefs(line);
      if (!found.length) continue;
      const row = line.trim().startsWith("|") ? cells(line) : null;
      const texts = row
        ? row
            .filter((c) => !imageRefs(c).length)
            .map(plainText)
            .filter(Boolean)
        : [];
      for (const { target, alt } of found) {
        const rel = resolveRef(target);
        if (rel === null) continue;
        const stem = path.posix
          .basename(rel)
          .replace(/\.[^.]+$/, "")
          .toLowerCase();
        const own = texts.filter(
          (t) => !new RegExp(`^${t.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([-_@. ]|$)`).test(stem),
        );
        const title = (own.length ? own.join(" · ") : plainText(alt)) || null;
        refs.push({ rel, target, group, title });
      }
    }
    return { file, markdown, refs };
  }
  return null;
}

/**
 * The entries of `stills.json` in `dir`, `[{ name?, title?, group?, file? }]`, each with what
 * of it is usable; problems go to `notes`. Empty when there is none.
 */
function readStillsJson(dir, notes) {
  const read = readJson(dir, "stills.json");
  if (!read) return [];
  if (read.problem) {
    notes.push(read.problem);
    return [];
  }
  if (!Array.isArray(read.value)) {
    notes.push("stills.json: must be a list of { name, title, group?, file? }");
    return [];
  }
  const out = [];
  read.value.forEach((entry, i) => {
    const text = (k) => (typeof entry?.[k] === "string" && entry[k].trim() ? entry[k].trim() : undefined);
    const usable = { name: text("name"), title: text("title"), group: text("group"), file: text("file") };
    if (entry === null || typeof entry !== "object" || Array.isArray(entry) || (!usable.name && !usable.file)) {
      notes.push(`stills.json: entry ${i + 1}: needs a 'name' or a 'file'`);
      return;
    }
    out.push(usable);
  });
  return out;
}

/** Stills of a manifest, in the shape `scanStills` gives, from the contract's v2 entries. */
function manifestStills(dir, notes) {
  const read = readJson(dir, MANIFEST_FILE);
  if (read?.problem) notes.push(read.problem);
  if (!read?.value) return [];
  if (!Array.isArray(read.value)) {
    notes.push(`${MANIFEST_FILE}: must be a list`);
    return [];
  }
  return read.value
    .map(upgraded)
    .filter(Boolean)
    .map((s) => ({ ...s, base: s.name, declared: s.title !== s.name, folder: "" }));
}

/**
 * Apply `stills.json` and the README to `list`, the stills in scan or manifest order: titles
 * where nothing above gave one, order (stills.json's, then the README's, then the rest as they
 * were, unless the manifest declared it) and groups (from the first of stills.json, the README
 * and the subfolders that gives any). Returns `{ list, groups, about }`.
 */
function enrich(dir, list, notes, { manifest }) {
  const byRel = new Map();
  const byName = new Map(list.map((s) => [s.name, s]));
  for (const s of list) for (const v of s.variants) if (v.rel) byRel.set(v.rel, s);
  const rank = new Map();
  const groupOf = new Map();
  const titled = new Set(list.filter((s) => s.declared).map((s) => s.name));

  const entries = readStillsJson(dir, notes);
  let jsonGroups = false;
  for (const entry of entries) {
    const file = entry.file === undefined ? null : resolveRef(entry.file);
    const still = file !== null ? byRel.get(file) : byName.get(entry.name);
    if (!still) {
      notes.push(`stills.json: '${entry.file ?? entry.name}' has no image, left out`);
      continue;
    }
    if (rank.has(still.name)) continue;
    if (entry.name && file !== null && entry.name !== still.name && !manifest) {
      if (!NAME.test(entry.name) || byName.has(entry.name)) {
        notes.push(`stills.json: '${entry.name}' cannot name ${entry.file}, kept as '${still.name}'`);
      } else {
        byName.delete(still.name);
        still.name = entry.name;
        byName.set(still.name, still);
      }
    }
    rank.set(still.name, rank.size);
    if (entry.title && !titled.has(still.name)) {
      still.title = entry.title;
      titled.add(still.name);
    }
    if (entry.group) {
      groupOf.set(still.name, entry.group);
      jsonGroups = true;
    }
  }

  const readme = readReadme(dir);
  let readmeGroups = false;
  for (const ref of readme?.refs ?? []) {
    const still = byRel.get(ref.rel) ?? (manifest ? byName.get(ref.rel.replace(/\.[^.]+$/, "").split("@")[0]) : null);
    if (!still) {
      notes.push(`${readme.file}: '${ref.target}' is not an image here, left out`);
      continue;
    }
    if (!rank.has(still.name)) rank.set(still.name, rank.size);
    if (ref.title && !titled.has(still.name)) {
      still.title = ref.title;
      titled.add(still.name);
    }
    if (!jsonGroups && ref.group && !groupOf.has(still.name)) {
      groupOf.set(still.name, ref.group);
      readmeGroups = true;
    }
  }

  if (!jsonGroups && !readmeGroups) for (const s of list) if (s.folder) groupOf.set(s.name, s.folder);

  const at = new Map(list.map((s, i) => [s, i]));
  const ordered = manifest
    ? list
    : [...list].sort(
        (a, b) => (rank.get(a.name) ?? Infinity) - (rank.get(b.name) ?? Infinity) || at.get(a) - at.get(b),
      );

  const groups = [];
  if (groupOf.size) {
    const byTitle = new Map();
    for (const s of ordered) {
      const title = groupOf.get(s.name) ?? null;
      if (!byTitle.has(title)) {
        byTitle.set(title, { title, stills: [] });
        groups.push(byTitle.get(title));
      }
      byTitle.get(title).stills.push(s.name);
    }
  }
  const final = groups.length ? groups.flatMap((g) => g.stills.map((n) => byName.get(n))) : ordered;
  const about = readme ? { file: readme.file, markdown: readme.markdown } : undefined;
  return { list: final, groups, about };
}

/** The hex SHA-256 of the file `file`. */
export function hashOf(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/** The kept revision `n` of a variant of `name`, relative to the folder. */
export function keptFile(name, key, n, ext) {
  return `${REVIEW_DIR}/revs/${name}/${key}/${n}.${ext}`;
}

/** The revision record of the folder `dir`, `{ name: { key: [rev] } }`, empty when there is none. */
function readRecord(dir, notes) {
  const read = readJson(dir, `${REVIEW_DIR}/revs.json`);
  if (read?.problem) notes.push(read.problem);
  const value = read?.value;
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}

/**
 * The revisions of each variant of the scanned `list`, set on it as `revs: [{ n, file, at }]`:
 * the ones `record` kept, the current image being the last one while its content is the one
 * last kept, else one past it. With `keep`, a revision not kept yet is copied to
 * `.review/revs/` and recorded in `record`; returns true when `record` changed.
 */
function applyRevisions(dir, list, record, keep) {
  let changed = false;
  for (const still of list) {
    for (const v of still.variants) {
      const file = path.join(dir, v.rel);
      const stat = statSync(file);
      const at = new Date(stat.mtimeMs).toISOString();
      const kept = Array.isArray(record[still.name]?.[v.key]) ? record[still.name][v.key] : [];
      const last = kept.at(-1);
      let hash = null;
      if (last && last.size === stat.size && last.mtimeMs === stat.mtimeMs) hash = last.hash;
      else if (last || keep) hash = hashOf(file);
      const revs = kept.map((r) => ({ n: r.n, file: keptFile(still.name, v.key, r.n, r.ext), at: r.at }));
      if (last && last.hash === hash) {
        revs[revs.length - 1].file = v.rel;
        if (keep && (last.size !== stat.size || last.mtimeMs !== stat.mtimeMs)) {
          Object.assign(last, { size: stat.size, mtimeMs: stat.mtimeMs });
          changed = true;
        }
      } else {
        const n = (last?.n ?? 0) + 1;
        revs.push({ n, file: v.rel, at });
        if (keep) {
          const dest = path.join(dir, keptFile(still.name, v.key, n, v.ext));
          mkdirSync(path.dirname(dest), { recursive: true });
          copyFileSync(file, dest);
          record[still.name] ??= {};
          record[still.name][v.key] = [...kept, { n, hash, ext: v.ext, size: stat.size, mtimeMs: stat.mtimeMs, at }];
          changed = true;
        }
      }
      v.revs = revs;
    }
  }
  return changed;
}

/** `still` in the contract's shape, `{ name, title, source, variants: [{ key, viewport, tags, revs }] }`. */
function contractStill(still) {
  return {
    name: still.name,
    title: still.title,
    source: still.source ?? { path: null },
    variants: still.variants.map(({ key, viewport, tags, revs }) => ({ key, viewport, tags, revs })),
  };
}

/** The folder `dir` read with `keep` (see `applyRevisions`), with what to persist. */
function build(dir, keep) {
  const notes = [];
  const manifest = existsSync(path.join(dir, MANIFEST_FILE));
  const base = manifest ? manifestStills(dir, notes) : scanStills(dir, notes);
  const { list, groups, about } = enrich(dir, base, notes, { manifest });
  const record = manifest ? {} : readRecord(dir, notes);
  const changed = manifest ? false : applyRevisions(dir, list, record, keep);
  const source = { stills: list.map(contractStill), groups, notes, writable: isWritable(dir) };
  if (about) source.about = about;
  return { source, record, changed };
}

/**
 * The folder `dir` as a stills source, without writing anything: `{ stills, groups, about?,
 * notes, writable }`. `stills` are in the contract's shape, in order; `groups` are
 * `[{ title, stills: [name] }]` in that same order, a still in no group in the one titled
 * null, or empty when nothing gives groups; `about` is `{ file, markdown }`, the README;
 * `notes` say what an extra got wrong; `writable` is false when the review cannot be written.
 * A changed image shows as its next revision, not yet kept.
 */
export function readSource(dir) {
  return build(dir, false).source;
}

/**
 * Keep the revisions of the images of the folder `dir`: create `.review/` when it is missing,
 * copy every revision not kept yet to `.review/revs/` and record it in `.review/revs.json`,
 * under its lock. Returns the source as `readSource` does. A folder with a manifest has its
 * revisions already and is only read.
 */
export async function keepRevisions(dir) {
  if (existsSync(path.join(dir, MANIFEST_FILE))) return readSource(dir);
  const { root, revs, revsLock } = reviewPaths(dir);
  mkdirSync(root, { recursive: true });
  return withLock(revsLock, () => {
    const { source, record, changed } = build(dir, true);
    if (changed) {
      const tmp = sideFile(revs, "tmp");
      try {
        writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`);
        renameSync(tmp, revs);
      } catch (e) {
        rmSync(tmp, { force: true });
        throw e;
      }
    }
    return source;
  });
}

/**
 * The folder `dir` as a stills source (see `readSource`). Once its `.review/` exists and can be
 * written, a changed image is kept as its next revision first; reading never creates it.
 */
export async function openSource(dir) {
  const manifest = existsSync(path.join(dir, MANIFEST_FILE));
  if (manifest || !existsSync(path.join(dir, REVIEW_DIR)) || !isWritable(dir)) return readSource(dir);
  return keepRevisions(dir);
}

/**
 * The folder `dir` as the `dir` the functions of `review.mjs` take: its stills from the
 * folder, its log, locks and annotated stills in `.review/`. A folder with a manifest is a
 * scratch dir and keeps them in `review/`. The first write creates `.review/` and keeps the
 * revisions of its images (see `keepRevisions`).
 */
export function folder(dir) {
  const root = path.resolve(dir);
  const manifest = existsSync(path.join(root, MANIFEST_FILE));
  const review = reviewPaths(root);
  const paths = manifest
    ? {
        manifest: path.join(root, MANIFEST_FILE),
        stillsLock: path.join(root, "stills", ".lock"),
        events: path.join(root, "review", "events.jsonl"),
        eventsLock: path.join(root, "review", ".lock"),
        annotated: path.join(root, "review", "annotated"),
      }
    : { events: review.events, eventsLock: review.eventsLock, annotated: review.annotated };
  return {
    dir: root,
    paths,
    stills: () => readSource(root).stills,
    keep: async () => {
      if (!isWritable(root)) throw new Error(`${root}: read-only, the review cannot be written`);
      await keepRevisions(root);
    },
  };
}
