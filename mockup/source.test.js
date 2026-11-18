/**
 * Unit tests for folder sources: any directory of images read as stills, with the optional
 * stills.json, README, subfolders and `@variant` names, revisions by content hash and remarks
 * kept in `.review/`. Run with `npm test` from mockup/.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { addStill, appendEvent, reviewed, threads } from "./review.mjs";
import { folder, keepRevisions, openSource, readSource } from "./source.mjs";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const HUMAN = { kind: "human", name: "dante" };

/** The 43 still numbers of a folder in the foodshed shape: 01 to 40, plus 20b, 35b and 35c. */
const NUMBERS = [...Array.from({ length: 40 }, (_, i) => String(i + 1).padStart(2, "0")), "20b", "35b", "35c"].sort(
  (a, b) => a.localeCompare(b, "en", { numeric: true }),
);

/** The groups of the foodshed-shaped README, in its order, each with its stills' numbers. */
const GROUPS = [
  [
    "Buyer, owner",
    ["01", "02", "03", "04", "05", "06", "07", "08", "09", "10", "11", "12", "13", "14", "15", "16", "17", "38", "40"],
  ],
  ["Buyer, member and viewer", ["18", "39", "19"]],
  ["Invitation and onboarding", ["20", "20b", "21", "22", "23", "36", "37"]],
  ["Farm, owner", ["24", "25", "26", "27", "28", "29"]],
  ["Admin", ["30", "31", "32", "33", "34", "35", "35b", "35c"]],
];

/** An empty directory, removed when the test ends. */
function scratch(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "mockup-source-"));
  t.after(() => {
    chmodSync(dir, 0o755);
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

/** Write an image `rel` in `dir` whose bytes end with `tag`; returns its path. */
function image(dir, rel, tag = rel) {
  const file = path.join(dir, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, Buffer.concat([SIGNATURE, Buffer.from(tag)]));
  return file;
}

/** The file name of still number `n` in the foodshed shape. */
function shot(n) {
  return `${n}-screen-${n}.png`;
}

/** A folder holding the 43 images of the foodshed shape. */
function foodshed(t) {
  const dir = scratch(t);
  for (const n of NUMBERS) image(dir, shot(n));
  return dir;
}

/** A README in the foodshed shape: prose and its sections, then a table of stills per group. */
function foodshedReadme() {
  const sections = GROUPS.map(
    ([group, numbers]) =>
      `## ${group}\n\n| # | Screen | Still |\n|---|---|---|\n` +
      numbers.map((n) => `| ${n} | Screen **${n}**: what it shows | ![](${shot(n)}) |`).join("\n"),
  );
  return [
    "# Organizations and locations: mockup stills",
    "",
    "Stills of an epic, drawn from the webapp. The source is in [`source/`](source/).",
    "",
    "## Decisions captured",
    "",
    "- **One default location** per organization.",
    "",
    sections.join("\n\n"),
    "",
    "## Running the mockup",
    "",
    "```sh",
    "![](not-an-image-ref.png)",
    "```",
    "",
  ].join("\n");
}

test("a folder of images alone gives a still per image, in natural order, titled from the name", (t) => {
  const dir = foodshed(t);
  const source = readSource(dir);
  assert.equal(source.stills.length, 43);
  assert.deepEqual(
    source.stills.map((s) => s.name),
    NUMBERS.map((n) => `${n}-screen-${n}`),
  );
  assert.equal(source.stills[1].name, "02-screen-02");
  assert.equal(source.stills.at(-1).name, "40-screen-40");
  assert.equal(source.stills[4].title, "05 screen 05");
  assert.deepEqual(source.groups, []);
  assert.deepEqual(source.notes, []);
  assert.equal(source.writable, true);
  assert.equal(source.about, undefined);
  const [still] = source.stills;
  assert.deepEqual(still.source, { path: null });
  assert.equal(still.variants.length, 1);
  assert.equal(still.variants[0].key, "desktop");
  assert.deepEqual(
    still.variants[0].revs.map((r) => [r.n, r.file]),
    [[1, "01-screen-01.png"]],
  );
});

test("every image kind counts, and .review, hidden entries and node_modules are skipped", (t) => {
  const dir = scratch(t);
  for (const rel of ["a.png", "b.JPG", "c.jpeg", "d.webp", "e.gif", "f.svg", "notes.txt"]) image(dir, rel);
  for (const rel of [".review/revs/a/desktop/1.png", ".hidden.png", ".cache/x.png", "node_modules/pkg/y.png"]) {
    image(dir, rel);
  }
  assert.deepEqual(
    readSource(dir).stills.map((s) => s.name),
    ["a", "b", "c", "d", "e"],
  );
});

test("reading never creates .review/", async (t) => {
  const dir = foodshed(t);
  writeFileSync(path.join(dir, "README.md"), foodshedReadme());
  readSource(dir);
  await openSource(dir);
  folder(dir).stills();
  assert.equal(existsSync(path.join(dir, ".review")), false);
});

test("a README in the foodshed shape gives its groups, order, titles and About", (t) => {
  const dir = foodshed(t);
  writeFileSync(path.join(dir, "README.md"), foodshedReadme());
  const source = readSource(dir);
  assert.deepEqual(source.notes, []);
  assert.deepEqual(
    source.groups.map((g) => g.title),
    GROUPS.map(([group]) => group),
  );
  assert.deepEqual(
    source.groups.map((g) => g.stills),
    GROUPS.map(([, numbers]) => numbers.map((n) => `${n}-screen-${n}`)),
  );
  assert.deepEqual(
    source.stills.map((s) => s.name),
    GROUPS.flatMap(([, numbers]) => numbers.map((n) => `${n}-screen-${n}`)),
  );
  const byName = new Map(source.stills.map((s) => [s.name, s]));
  assert.equal(byName.get("38-screen-38").title, "Screen 38: what it shows");
  assert.equal(byName.get("20b-screen-20b").title, "Screen 20b: what it shows");
  assert.equal(source.about.file, "README.md");
  assert.equal(source.about.markdown, foodshedReadme());
});

test("a README referencing some images orders those, the rest follow by name, missing ones noted", (t) => {
  const dir = foodshed(t);
  const listed = ["10", "03", "07"];
  const readme = [
    "# Stills",
    "",
    ...listed.map((n) => `![The ${n} screen](${shot(n)})`),
    "![](./99-gone.png)",
    '<img src="05-screen-05.png" alt="Five">',
    "[a link to a page](other.md) and [the 06 shot](06-screen-06.png)",
    "![remote](https://example.com/x.png)",
  ].join("\n");
  writeFileSync(path.join(dir, "README.md"), readme);
  const source = readSource(dir);
  assert.deepEqual(source.notes, ["README.md: './99-gone.png' is not an image here, left out"]);
  const names = source.stills.map((s) => s.name);
  assert.deepEqual(names.slice(0, 5), ["10-screen-10", "03-screen-03", "07-screen-07", "05-screen-05", "06-screen-06"]);
  assert.equal(names.length, 43);
  assert.deepEqual(names.slice(5, 8), ["01-screen-01", "02-screen-02", "04-screen-04"]);
  assert.equal(source.stills[0].title, "The 10 screen");
  assert.equal(source.stills[3].title, "Five");
  assert.equal(source.stills[4].title, "the 06 shot");
  assert.deepEqual(
    source.groups.map((g) => [g.title, g.stills.length]),
    [
      ["Stills", 5],
      [null, 38],
    ],
  );
});

test("index.md stands in for a missing README", (t) => {
  const dir = scratch(t);
  image(dir, "a.png");
  image(dir, "b.png");
  writeFileSync(path.join(dir, "index.md"), "![Bee](b.png)\n");
  const source = readSource(dir);
  assert.deepEqual(
    source.stills.map((s) => [s.name, s.title]),
    [
      ["b", "Bee"],
      ["a", "a"],
    ],
  );
  assert.equal(source.about.file, "index.md");
});

test("stills.json gives titles, order and groups, and names a still by its file", (t) => {
  const dir = scratch(t);
  for (const rel of ["01-a.png", "02-b.png", "03-c.png", "04-d.png"]) image(dir, rel);
  writeFileSync(
    path.join(dir, "stills.json"),
    JSON.stringify([
      { name: "03-c", title: "Third", group: "Late" },
      { name: "welcome", file: "01-a.png", title: "Welcome", group: "Early" },
      { name: "gone", title: "Nowhere" },
    ]),
  );
  writeFileSync(path.join(dir, "README.md"), "## Ignored group\n\n![Bee from README](02-b.png)\n![C](03-c.png)\n");
  const source = readSource(dir);
  assert.deepEqual(source.notes, ["stills.json: 'gone' has no image, left out"]);
  assert.deepEqual(
    source.stills.map((s) => [s.name, s.title]),
    [
      ["03-c", "Third"],
      ["welcome", "Welcome"],
      ["02-b", "Bee from README"],
      ["04-d", "04 d"],
    ],
  );
  assert.deepEqual(source.groups, [
    { title: "Late", stills: ["03-c"] },
    { title: "Early", stills: ["welcome"] },
    { title: null, stills: ["02-b", "04-d"] },
  ]);
  assert.equal(source.stills[1].variants[0].revs[0].file, "01-a.png");
});

test("a broken stills.json is a note and the folder still reads", (t) => {
  const dir = scratch(t);
  image(dir, "b.png");
  image(dir, "a.png");
  writeFileSync(path.join(dir, "stills.json"), '[\n  {"name": "a"},\n  {"name": "b",}\n]\n');
  const source = readSource(dir);
  assert.equal(source.notes.length, 1);
  assert.match(source.notes[0], /^stills\.json: line 3: /);
  assert.deepEqual(
    source.stills.map((s) => s.name),
    ["a", "b"],
  );
});

test("a partial stills.json is used for what it gives", (t) => {
  const dir = scratch(t);
  image(dir, "a.png");
  image(dir, "b.png");
  writeFileSync(path.join(dir, "stills.json"), JSON.stringify([{ title: "no name" }, { name: "b", title: "Bee" }, 7]));
  const source = readSource(dir);
  assert.deepEqual(source.notes, [
    "stills.json: entry 1: needs a 'name' or a 'file'",
    "stills.json: entry 3: needs a 'name' or a 'file'",
  ]);
  assert.deepEqual(
    source.stills.map((s) => [s.name, s.title]),
    [
      ["b", "Bee"],
      ["a", "a"],
    ],
  );
});

test("subfolders become groups when nothing else gives them", (t) => {
  const dir = scratch(t);
  for (const rel of ["top.png", "buyer/02-users.png", "buyer/01-org.png", "admin/01-list.png", "admin/deep/x.png"]) {
    image(dir, rel);
  }
  const source = readSource(dir);
  assert.deepEqual(
    source.stills.map((s) => s.name),
    ["top", "admin.01-list", "admin.deep.x", "buyer.01-org", "buyer.02-users"],
  );
  assert.equal(source.stills[1].title, "01 list");
  assert.deepEqual(source.groups, [
    { title: null, stills: ["top"] },
    { title: "admin", stills: ["admin.01-list"] },
    { title: "admin/deep", stills: ["admin.deep.x"] },
    { title: "buyer", stills: ["buyer.01-org", "buyer.02-users"] },
  ]);
  writeFileSync(path.join(dir, "README.md"), "## Mine\n\n![](buyer/02-users.png)\n");
  assert.deepEqual(readSource(dir).groups, [
    { title: "Mine", stills: ["buyer.02-users"] },
    { title: null, stills: ["top", "admin.01-list", "admin.deep.x", "buyer.01-org"] },
  ]);
});

test("name@<key> images are variants of one still, the plain one first", (t) => {
  const dir = scratch(t);
  for (const rel of ["onboarding@mobile+dark.png", "onboarding.png", "onboarding@web.png", "onboarding@tablet.png"]) {
    image(dir, rel);
  }
  image(dir, "icon@2x.png");
  image(dir, "card@360x740@2+RTL.png");
  const source = readSource(dir);
  const [card, icon, onboarding] = source.stills;
  assert.deepEqual(
    source.stills.map((s) => s.name),
    ["card", "icon-2x", "onboarding"],
  );
  assert.deepEqual(
    onboarding.variants.map((v) => [v.key, v.revs[0].file]),
    [
      ["desktop", "onboarding.png"],
      ["mobile+dark", "onboarding@mobile+dark.png"],
      ["tablet", "onboarding@tablet.png"],
    ],
  );
  assert.deepEqual(onboarding.variants[1].tags, ["dark"]);
  assert.equal(onboarding.variants[1].viewport.preset, "mobile");
  assert.equal(card.variants[0].key, "custom-360x740@2+rtl");
  assert.equal(icon.variants[0].key, "desktop");
  assert.deepEqual(source.notes, [
    "icon@2x.png: '2x' is not a variant key, read as its own still",
    "onboarding@web.png: the still 'onboarding' [desktop] is onboarding.png already, skipped",
  ]);
});

test("a changed image becomes rev 2 once the review is kept, with rev 1's bytes kept", async (t) => {
  const dir = scratch(t);
  const file = image(dir, "invite.png", "one");
  const source = await keepRevisions(dir);
  assert.deepEqual(
    source.stills[0].variants[0].revs.map((r) => [r.n, r.file]),
    [[1, "invite.png"]],
  );
  assert.ok(existsSync(path.join(dir, ".review/revs/invite/desktop/1.png")));

  writeFileSync(file, Buffer.concat([SIGNATURE, Buffer.from("two")]));
  utimesSync(file, new Date(), new Date(Date.now() + 5000));
  assert.deepEqual(
    readSource(dir).stills[0].variants[0].revs.map((r) => [r.n, r.file]),
    [
      [1, ".review/revs/invite/desktop/1.png"],
      [2, "invite.png"],
    ],
  );
  const opened = await openSource(dir);
  const revs = opened.stills[0].variants[0].revs;
  assert.deepEqual(
    revs.map((r) => [r.n, r.file]),
    [
      [1, ".review/revs/invite/desktop/1.png"],
      [2, "invite.png"],
    ],
  );
  assert.equal(readFileSync(path.join(dir, revs[0].file)).subarray(SIGNATURE.length).toString(), "one");
  assert.equal(
    readFileSync(path.join(dir, ".review/revs/invite/desktop/2.png")).subarray(SIGNATURE.length).toString(),
    "two",
  );
  const record = JSON.parse(readFileSync(path.join(dir, ".review/revs.json"), "utf8"));
  assert.deepEqual(
    record.invite.desktop.map((r) => r.n),
    [1, 2],
  );

  utimesSync(file, new Date(), new Date(Date.now() + 9000));
  assert.deepEqual(
    (await openSource(dir)).stills[0].variants[0].revs.map((r) => r.n),
    [1, 2],
  );
});

test("a folder's remarks live in .review/, the first one keeping the revisions", async (t) => {
  const dir = scratch(t);
  const file = image(dir, "invite.png", "one");
  const src = folder(dir);
  const remark = await appendEvent(src, { type: "thread", author: HUMAN, still: "invite", rev: 1, body: "Bigger" });
  assert.ok(existsSync(path.join(dir, ".review/events.jsonl")));
  assert.ok(existsSync(path.join(dir, ".review/revs/invite/desktop/1.png")));
  await appendEvent(src, { type: "viewed", author: HUMAN, still: "invite", rev: 1 });
  assert.equal(reviewed(src, "dante").invite.reviewed, true);

  writeFileSync(file, Buffer.concat([SIGNATURE, Buffer.from("two")]));
  utimesSync(file, new Date(), new Date(Date.now() + 5000));
  await appendEvent(src, { type: "reply", author: { kind: "agent", name: "claude" }, thread: remark.id, body: "Done" });
  await appendEvent(src, { type: "thread", author: HUMAN, still: "invite", rev: 2, body: "Better" });
  assert.deepEqual(
    threads(src).map((th) => [th.rev, th.variant, th.replies.length]),
    [
      [1, "desktop", 1],
      [2, "desktop", 0],
    ],
  );
  assert.equal(reviewed(src, "dante").invite.changed, true);
  await assert.rejects(
    appendEvent(src, { type: "thread", author: HUMAN, still: "nope", rev: 1, body: "x" }),
    /no still 'nope'/,
  );
});

test("a read-only folder reads fine and reports writable: false", { skip: process.getuid?.() === 0 }, async (t) => {
  const dir = scratch(t);
  image(dir, "a.png");
  chmodSync(dir, 0o555);
  const source = await openSource(dir);
  assert.equal(source.writable, false);
  assert.deepEqual(
    source.stills.map((s) => s.name),
    ["a"],
  );
  await assert.rejects(
    appendEvent(folder(dir), { type: "thread", author: HUMAN, still: "a", rev: 1, body: "x" }),
    /read-only/,
  );
  assert.equal(existsSync(path.join(dir, ".review")), false);
});

test("a folder with stills/manifest.json is read as declared, with the README's extras", async (t) => {
  const dir = scratch(t);
  const shots = scratch(t);
  await addStill(dir, { file: image(shots, "b.png"), name: "b" });
  await addStill(dir, { file: image(shots, "a.png"), name: "a", title: "Declared A" });
  await addStill(dir, { file: image(shots, "a2.png"), name: "a", viewport: "mobile", tags: ["dark"] });
  writeFileSync(path.join(dir, "README.md"), "## Group\n\n![Bee](b.png)\n![Ay](a.png)\n");
  const source = await openSource(dir);
  assert.deepEqual(
    source.stills.map((s) => [s.name, s.title]),
    [
      ["b", "Bee"],
      ["a", "Declared A"],
    ],
  );
  assert.deepEqual(
    source.stills[1].variants.map((v) => [v.key, v.revs[0].file]),
    [
      ["desktop", "stills/a/desktop/1.png"],
      ["mobile+dark", "stills/a/mobile+dark/1.png"],
    ],
  );
  assert.deepEqual(source.groups, [{ title: "Group", stills: ["b", "a"] }]);
  const src = folder(dir);
  await appendEvent(src, { type: "thread", author: HUMAN, still: "a", variant: "mobile+dark", rev: 1, body: "x" });
  assert.ok(existsSync(path.join(dir, "review/events.jsonl")));
  assert.equal(existsSync(path.join(dir, ".review")), false);
});
