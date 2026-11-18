/**
 * Tests of `stills export`: a mockup's stills and review copied into a folder read back by
 * `source.mjs` as the same stills, revisions and remarks; the file names of variants; the
 * README and stills.json never overwritten; a folder with a review refused. Also the CLI's
 * `--folder`, on the exported folder. Run with `npm test` from mockup/.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { exportName, exportStills } from "./export.mjs";
import { main } from "./review-cli.mjs";
import { addStill, appendEvent, storeAnnotated, threads } from "./review.mjs";
import { folder, readSource } from "./source.mjs";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const HUMAN = { kind: "human", name: "Ana", via: "share" };

/** An empty temporary directory, removed when the test ends. */
function tmp(t, prefix) {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A PNG file in `dir` whose bytes end with `tag`. */
function png(dir, tag) {
  const file = path.join(dir, `${tag}.png`);
  writeFileSync(file, Buffer.concat([PNG, Buffer.from(tag)]));
  return file;
}

/**
 * A mockup scratch dir: `invite` at two revisions of `mobile` and one of `desktop`, `list` at
 * one `desktop` revision, a remark on invite's first variant without naming it, and an
 * annotated still.
 */
async function mockup(t) {
  const dir = tmp(t, "mockup-export-src-");
  writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ title: "Org locations", pages: [] }));
  await addStill(dir, { file: png(dir, "m1"), name: "invite", title: "Invite | a user", viewport: "mobile" });
  await addStill(dir, { file: png(dir, "m2"), name: "invite", viewport: "mobile" });
  await addStill(dir, { file: png(dir, "d1"), name: "invite", viewport: "desktop" });
  await addStill(dir, { file: png(dir, "l1"), name: "list", title: "The list" });
  const remark = await appendEvent(dir, { type: "thread", author: HUMAN, still: "invite", rev: 1, body: "Too tight" });
  await appendEvent(dir, { type: "reply", author: { kind: "agent", name: "agent" }, thread: remark.id, body: "Fixed" });
  storeAnnotated(dir, remark.id, Buffer.concat([PNG, Buffer.from("marked")]));
  return { dir, remark };
}

/** Run the CLI in-process; returns `{ code, out, err }` with the lines joined. */
async function cli(args, env = {}) {
  const out = [];
  const err = [];
  const code = await main(args, { out: (l) => out.push(l), err: (l) => err.push(l), readStdin: () => null, env });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

test("exportName: name.png only for a still whose one variant is desktop", () => {
  assert.equal(exportName("list", "desktop", true), "list.png");
  assert.equal(exportName("list", "mobile", true), "list@mobile.png");
  assert.equal(exportName("invite", "desktop", false), "invite@desktop.png");
  assert.equal(exportName("invite", "mobile+dark", false), "invite@mobile+dark.png");
});

test("an exported mockup reads back as the same stills, revisions and remarks", async (t) => {
  const { dir, remark } = await mockup(t);
  const dest = path.join(tmp(t, "mockup-export-dest-"), "kept");
  const done = exportStills(dir, dest);
  assert.deepEqual(
    { stills: done.stills, images: done.images, revisions: done.revisions, events: done.events },
    { stills: 2, images: 3, revisions: 4, events: 2 }
  );
  assert.deepEqual(readdirSync(dest).sort(), [
    ".review",
    "invite@desktop.png",
    "invite@mobile.png",
    "list.png",
    "stills.json",
  ]);

  const source = readSource(dest);
  assert.deepEqual(source.notes, []);
  assert.deepEqual(
    source.stills.map((s) => [s.name, s.title, s.variants.map((v) => [v.key, v.revs.map((r) => r.n)])]),
    [
      [
        "invite",
        "Invite | a user",
        [
          ["desktop", [1]],
          ["mobile", [1, 2]],
        ],
      ],
      ["list", "The list", [["desktop", [1]]]],
    ]
  );
  const mobile = source.stills[0].variants[1];
  assert.equal(mobile.revs[1].file, "invite@mobile.png");
  assert.deepEqual(readFileSync(path.join(dest, mobile.revs[0].file)), Buffer.concat([PNG, Buffer.from("m1")]));

  const [thread] = threads(folder(dest));
  assert.equal(thread.id, remark.id);
  assert.equal(thread.variant, "mobile");
  assert.equal(thread.replies[0].body, "Fixed");
  assert.ok(existsSync(path.join(dest, ".review", "annotated", `${remark.id}.png`)));
});

test("--readme writes a README whose table gives back the titles, and never overwrites one", async (t) => {
  const { dir } = await mockup(t);
  const dest = tmp(t, "mockup-export-dest-");
  const done = exportStills(dir, dest, { readme: true });
  assert.deepEqual(done.wrote, ["stills.json", "README.md"]);
  const readme = readFileSync(path.join(dest, "README.md"), "utf8");
  assert.match(readme, /^# Org locations\n/);
  assert.match(
    readme,
    /\| Invite \\\| a user \| !\[invite\]\(invite@mobile\.png\) !\[invite\]\(invite@desktop\.png\) \|/
  );
  rmSync(path.join(dest, "stills.json"));
  const source = readSource(dest);
  assert.deepEqual(
    source.stills.map((s) => s.title),
    ["Invite | a user", "The list"]
  );
  assert.equal(source.about.file, "README.md");

  const other = tmp(t, "mockup-export-dest-");
  writeFileSync(path.join(other, "README.md"), "# Mine\n");
  writeFileSync(path.join(other, "stills.json"), "[]\n");
  const again = exportStills(dir, other, { readme: true });
  assert.deepEqual(again.wrote, []);
  assert.deepEqual(again.skipped, ["stills.json", "README.md"]);
  assert.equal(readFileSync(path.join(other, "README.md"), "utf8"), "# Mine\n");
});

test("a folder that holds a review, or an image the export would write, is refused", async (t) => {
  const { dir } = await mockup(t);
  const reviewed = tmp(t, "mockup-export-dest-");
  mkdirSync(path.join(reviewed, ".review"));
  assert.throws(() => exportStills(dir, reviewed), /\.review\/ exists already/);
  const taken = tmp(t, "mockup-export-dest-");
  writeFileSync(path.join(taken, "list.png"), "mine");
  assert.throws(() => exportStills(dir, taken), /list\.png exists already/);
  assert.equal(readFileSync(path.join(taken, "list.png"), "utf8"), "mine");
});

test("the CLI exports a mockup, then works on the folder with --folder and refuses stills add there", async (t) => {
  const { dir, remark } = await mockup(t);
  const dest = tmp(t, "mockup-export-dest-");
  const done = await cli(["--dir", dir, "stills", "export", dest, "--readme"], {
    MOCKUP_EXPORT_HOST_DIR: "/host/kept",
  });
  assert.equal(done.code, 0, done.err);
  assert.match(done.out, /wrote \/host\/kept\/README\.md/);
  assert.match(done.out, /exported 2 stills \(3 images, 4 revisions\) and 2 events to \/host\/kept/);

  const ls = await cli(["--folder", dest, "review", "ls"]);
  assert.equal(ls.code, 0, ls.err);
  assert.match(ls.out, new RegExp(`${remark.id}  open  invite \\[mobile\\] r1 whole  1 reply  Ana \\(guest\\)`));
  const reply = await cli(["--folder", dest, "review", "reply", remark.id, "Done"], { REVIEW_AUTHOR: "claude" });
  assert.equal(reply.code, 0, reply.err);
  assert.equal(threads(folder(dest))[0].replies.at(-1).author.name, "claude");
  const show = await cli(["--folder", dest, "review", "show", remark.id], { MOCKUP_HOST_DIR: "/host/kept" });
  assert.match(show.out, /image {3}\/host\/kept\/\.review\/revs\/invite\/mobile\/1\.png/);
  assert.match(show.out, new RegExp(`marked  /host/kept/\\.review/annotated/${remark.id}\\.png`));

  const add = await cli(["--folder", dest, "stills", "add", "x.png", "--name", "x"]);
  assert.equal(add.code, 2);
  const nested = await cli(["--folder", dest, "stills", "export", tmp(t, "mockup-export-dest-")]);
  assert.equal(nested.code, 2);
});

test("an agent's write on a read-only folder says remarks are off", { skip: process.getuid?.() === 0 }, async (t) => {
  const { dir } = await mockup(t);
  const dest = tmp(t, "mockup-export-dest-");
  exportStills(dir, dest);
  chmodSync(path.join(dest, ".review"), 0o555);
  let idle;
  try {
    idle = await cli(["--folder", dest, "review", "idle"], { MOCKUP_HOST_DIR: "/host/kept" });
  } finally {
    chmodSync(path.join(dest, ".review"), 0o755);
  }
  assert.equal(idle.code, 1);
  assert.equal(idle.err, "/host/kept: read-only folder, remarks off");
});
