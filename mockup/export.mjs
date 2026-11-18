/**
 * `preview stills export`: a live mockup's stills and review copied into a plain folder, which
 * `source.mjs` then reads as the same stills with the same remarks.
 *
 * Each variant's current revision is copied as `<name>.png` when it is the still's only variant
 * and that variant is `desktop`, the one a plain name means, else as `<name>@<key>.png`. So the
 * revision numbers and before/after carry over, every revision is also kept in the folder's
 * `.review/revs/` and recorded in `.review/revs.json`, the way the folder would have kept them
 * itself; the event log and the annotated stills go to `.review/`. An event on a still that
 * relied on the still's first variant gets that variant written in, since the folder may order
 * the variants differently.
 *
 * `stills.json` keeps the titles and the order, and with `readme` a `README.md` lists them as a
 * table of titles and images when the folder has no README or `index.md`. Neither is ever
 * overwritten. The export refuses a folder that
 * holds a review already or an image it would replace.
 */

import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { annotatedFile, EVENTS_FILE, readEvents, revisions, stills } from "./review.mjs";

const REVIEW_DIR = ".review";
const DEFAULT_KEY = "desktop";
const READMES = ["README.md", "readme.md", "Readme.md", "index.md"];

/** The hex SHA-256 of the file `file`. */
function hashOf(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/** The file name the variant `key` of the still `name` is exported as, `single` when it is its only one. */
export function exportName(name, key, single) {
  return single && key === DEFAULT_KEY ? `${name}.png` : `${name}@${key}.png`;
}

/** `text` on one line, its `\` and `|` escaped, as a markdown table cell or heading. */
function cell(text) {
  return String(text)
    .replace(/\s+/g, " ")
    .replace(/([\\|])/g, "\\$1");
}

/**
 * The README of the exported stills `rows`, `[{ name, title, files }]`, under the heading
 * `heading`: a table row per still, its title then its images, alt text being its name.
 */
export function readmeOf(heading, rows) {
  const lines = [`# ${cell(heading)}`, "", "| Still | Image |", "| --- | --- |"];
  for (const { name, title, files } of rows) {
    const images = files.map((f) => `![${name}](${encodeURI(f)})`).join(" ");
    lines.push(`| ${cell(title)} | ${images} |`);
  }
  return `${lines.join("\n")}\n`;
}

/** The title of the mockup in the scratch dir `dir`, from its `manifest.json`, or null. */
function mockupTitle(dir) {
  try {
    const { title } = JSON.parse(readFileSync(path.join(dir, "manifest.json"), "utf8"));
    return typeof title === "string" && title.trim() ? title.trim() : null;
  } catch {
    return null;
  }
}

/**
 * The events of the log of `dir` as lines to write, an event on a still without `variant`
 * given the still's first variant from `first` (a name to key map).
 */
function eventLines(dir, first) {
  const { events } = readEvents(dir);
  return events.map((e) => {
    const out =
      typeof e.still === "string" && e.variant === undefined && first.has(e.still)
        ? { ...e, variant: first.get(e.still) }
        : e;
    return `${JSON.stringify(out)}\n`;
  });
}

/**
 * Export the stills and review of the mockup scratch dir `dir` into the folder `dest`, made when
 * missing; `readme` also writes a README. Returns `{ stills, images, revisions, events, wrote,
 * skipped }`: counts, and the extras written or left alone because they existed. Throws when
 * `dest` holds a review already or one of the images to write.
 */
export function exportStills(dir, dest, { readme = false } = {}) {
  const list = stills(dir)
    .map((s) => ({ ...s, variants: s.variants.filter((v) => v.revs.length) }))
    .filter((s) => s.variants.length);
  const plan = list.map((s) => ({
    still: s,
    files: s.variants.map((v) => ({ variant: v, file: exportName(s.name, v.key, s.variants.length === 1) })),
  }));
  mkdirSync(dest, { recursive: true });
  if (existsSync(path.join(dest, REVIEW_DIR))) {
    throw new Error(`${REVIEW_DIR}/ exists already; export into a folder without a review`);
  }
  for (const { files } of plan) {
    for (const { file } of files) {
      if (existsSync(path.join(dest, file))) throw new Error(`${file} exists already; export into another folder`);
    }
  }

  const record = {};
  let revCount = 0;
  for (const { still, files } of plan) {
    for (const { variant, file } of files) {
      const kept = [];
      for (const rev of variant.revs) {
        const from = path.join(dir, rev.file);
        const rel = `${REVIEW_DIR}/revs/${still.name}/${variant.key}/${rev.n}.png`;
        mkdirSync(path.dirname(path.join(dest, rel)), { recursive: true });
        copyFileSync(from, path.join(dest, rel));
        kept.push({ n: rev.n, hash: hashOf(from), ext: "png", at: rev.at, rel });
        revCount += 1;
      }
      const current = path.join(dest, file);
      copyFileSync(path.join(dir, variant.revs.at(-1).file), current);
      const stat = statSync(current);
      record[still.name] ??= {};
      record[still.name][variant.key] = kept.map(({ rel, ...r }, i) => {
        const at = statSync(path.join(dest, rel));
        const last = i === kept.length - 1;
        return { ...r, size: last ? stat.size : at.size, mtimeMs: last ? stat.mtimeMs : at.mtimeMs };
      });
    }
  }
  writeFileSync(path.join(dest, REVIEW_DIR, "revs.json"), `${JSON.stringify(record, null, 2)}\n`);

  const first = new Map([...revisions(dir)].map(([name, v]) => [name, v.first]));
  const lines = existsSync(path.join(dir, EVENTS_FILE)) ? eventLines(dir, first) : [];
  if (lines.length) writeFileSync(path.join(dest, REVIEW_DIR, "events.jsonl"), lines.join(""));
  const annotated = path.dirname(path.join(dir, annotatedFile("x")));
  if (existsSync(annotated)) {
    const to = path.join(dest, REVIEW_DIR, "annotated");
    mkdirSync(to, { recursive: true });
    for (const f of readdirSync(annotated).filter((n) => n.endsWith(".png"))) {
      copyFileSync(path.join(annotated, f), path.join(to, f));
    }
  }

  const wrote = [];
  const skipped = [];
  const extra = (name, body) => {
    const file = path.join(dest, name);
    if (existsSync(file)) return skipped.push(name);
    writeFileSync(file, body);
    return wrote.push(name);
  };
  const entries = plan.map(({ still, files }) => ({ name: still.name, title: still.title, file: files[0].file }));
  extra(
    "stills.json",
    `${JSON.stringify(
      entries.map(({ name, title }) => ({ name, title })),
      null,
      2
    )}\n`
  );
  const hasReadme = READMES.some((f) => existsSync(path.join(dest, f)));
  if (readme && hasReadme) skipped.push(READMES.find((f) => existsSync(path.join(dest, f))));
  else if (readme) {
    const heading = mockupTitle(dir) ?? path.basename(path.resolve(dest));
    const rows = plan.map(({ still, files }) => ({
      name: still.name,
      title: still.title,
      files: files.map((f) => f.file),
    }));
    extra("README.md", readmeOf(heading, rows));
  }
  return {
    stills: plan.length,
    images: plan.reduce((n, p) => n + p.files.length, 0),
    revisions: revCount,
    events: lines.length,
    wrote,
    skipped,
  };
}
