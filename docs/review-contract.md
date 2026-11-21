# The Review Contract

This is the authoritative specification of the stills review store: the files a mockup's
stills and its review remarks live in. It is the single source of truth that connects the
`/mockup` runtime's viewer, the `preview` CLI, the agent that answers remarks and any later
reader (orchetta, a bot). Nothing else is shared between them: there is no hub state, no
database and no network handshake. A reader that follows this document needs no other code.

The reference implementation is [`mockup/review.mjs`](../mockup/review.mjs).

## Layout

Everything lives in the preview's mockup scratch directory, `<frontend>/.mockup/`, which
the `/mockup` runtime serves and which gitignores itself:

```
.mockup/
  stills/manifest.json        the stills, their variants and their revisions
  stills/<name>/<key>/<n>.png one file per revision of a variant, immutable
  stills/<name>/<n>.png       a revision written before variants, kept where it was
  stills/.lock                held while the manifest is being changed
  review/events.jsonl         append-only event log: the backchannel
  review/.lock                held while an event is being appended
  review/annotated/<id>.png   thread <id>'s still with its mark drawn
```

All paths in the files below are relative to `.mockup/`.

## Stills

A **still** is one named screen of a mockup, such as `05-invite-user`. A name is 1 to 100
characters of letters, digits, `.`, `_` and `-`, starting with a letter or digit, so it is
safe as a directory name and in a URL. Two names that differ only in case are refused, since
a case-insensitive filesystem would give them one directory.

A still has one or more **variants**: the same screen shot at a viewport, with free tags,
such as `mobile+dark` and `desktop`. Shooting a variant again makes its next **revision**:
rev 1, 2, 3, ..., counted per variant. Every revision keeps its own file,
`stills/<name>/<key>/<n>.png`, which is never rewritten, so a remark made on rev 1 still
points at the pixels it was made on after rev 2 lands.

### Viewports

| Preset     | CSS size  | Pixel ratio | Device |
| ---------- | --------- | ----------- | ------ |
| `mobile`   | 390×844   | 3 | touch, mobile user agent |
| `mobile-s` | 375×812   | 3 | touch, mobile user agent (iPhone mini) |
| `tablet`   | 820×1180  | 2 | touch, tablet user agent |
| `desktop`  | 1440×900  | 1 | mouse; `web` is an alias |

A **custom** viewport is given as `WxH[@dpr][+touch]`: `360x740`, `360x740@2.5+touch`. Its
pixel ratio is 1 unless given; `+touch` makes it a touch device with a mobile user agent. One
that is exactly a preset (`1440x900`, `390x844@3+touch`) is that preset.

A variant's **viewport** is stored as `{preset, width, height, dpr, mobile, fullPage}`:
`preset` is the preset's name or `"custom"`, `mobile` is true for a touch device and
`fullPage` true when the whole document was captured, beyond the viewport.

### Tags

Tags are free labels, 1 to 32 lowercase letters, digits, `.`, `_` and `-`: `dark`, `light`,
`rtl`, `es`, `logged-out`. `dark` and `light` set `prefers-color-scheme` when the still is
shot; the others only label it.

### Variant keys

A variant's **key** is `<viewport>[+<tag>...]`, the tags sorted, so the same viewport and
tags always give the same key. The viewport part is the preset's name, or
`custom-<W>x<H>[@<dpr>][-touch]` (the pixel ratio left out when it is 1):

| Viewport and tags            | Key |
| ---------------------------- | --- |
| `mobile`, `dark`             | `mobile+dark` |
| `web`                        | `desktop` |
| `mobile`, `rtl` and `dark`   | `mobile+dark+rtl` |
| `360x740@2+touch`, `es`      | `custom-360x740@2-touch+es` |

### The manifest

`stills/manifest.json` is a JSON list, one entry per still, in the order they were first
added; each still's variants are in the order they were first shot:

```json
[
  {
    "name": "05-invite-user",
    "title": "Invite a user",
    "source": { "path": "/invite" },
    "variants": [
      {
        "key": "mobile+dark",
        "viewport": { "preset": "mobile", "width": 390, "height": 844, "dpr": 3, "mobile": true, "fullPage": false },
        "tags": ["dark"],
        "revs": [
          { "n": 1, "file": "stills/05-invite-user/mobile+dark/1.png", "at": "2026-11-17T10:02:11.120Z" },
          { "n": 2, "file": "stills/05-invite-user/mobile+dark/2.png", "at": "2026-11-17T10:31:40.007Z" }
        ]
      }
    ]
  }
]
```

| Field         | Meaning |
| ------------- | ------- |
| `name`        | The still's name, its key. |
| `title`       | Human-readable title; the name until one is given. |
| `source.path` | The mockup page the still was shot from (`/invite`), or null. |
| `variants`    | Every variant: `key`, `viewport` and `tags` as above, and `revs`, every revision, oldest first: `n` from 1, `file` the PNG, `at` when it was added (ISO 8601, UTC). The last one is the variant's current revision. |

A still's **first variant** is the first in its list with a revision. An event about a still
that names no variant means that one.

The manifest is rewritten whole on every change: written to a temporary file next to it,
then renamed over it, so a reader always sees either the old or the new list, never a
partial one.

### Upgrading a v1 manifest

Before variants, an entry had its revisions at the top level and its size in its source:

```json
{ "name": "01-organization", "title": "Organization", "source": { "path": "/org", "size": "1440x1250" },
  "revs": [{ "n": 1, "file": "stills/01-organization/1.png", "at": "2026-11-18T14:35:37.223Z" }] }
```

Readers accept both shapes. A v1 entry (one with `revs` and no `variants`) is read as one
variant, with no tags, whose viewport comes from `source.size`: `desktop` when it is 1440
wide at the preset's height (`1440x900`), else the custom viewport `<W>x<H>` at pixel ratio
1, key `custom-<W>x<H>`; an entry without a size is read as `desktop`. Its revisions and
their files stay where they are, `stills/<name>/<n>.png`.

Reading never rewrites the manifest. The first write to a v1 still (a new revision of any of
its variants) rewrites that entry in v2 shape, `source.size` dropped and its old revisions
moved, as they are, into its variant; the other entries are left as they were. A new revision
of the upgraded variant takes the next number and lands in `stills/<name>/<key>/<n>.png`.

## Folder sources

Any local directory of images is a stills source too, git or not: a folder such as
`docs/mockups/<topic>/` on a mockup branch. The reference reader is
[`mockup/source.mjs`](../mockup/source.mjs): `openSource(dir)` returns
`{stills, groups, about?, notes, writable}`, `stills` in the manifest's shape above, so a
`.mockup/` is just one more source.

**Images are the only requirement.** Every `png`, `jpg`, `jpeg`, `webp` and `gif` under the
folder is a still, in natural order of its name (`2` before `10`, `20` before `20b`), titled
from it (`05-invite-user` is "05 invite user"). An image in a subfolder is named by its path,
`admin/01-list.png` being `admin.01-list`. `.review/`, hidden entries and `node_modules` are
skipped.

Everything else is optional and only adds to that, highest priority first; each fills only
what it knows and leaves the rest to the next:

| The folder also has | It adds |
| ------------------- | ------- |
| `stills/manifest.json` | The stills, variants and revisions as declared: the folder is a scratch dir in the [layout](#layout) above, its log in `review/`. |
| `stills.json`, `[{name, title, group?, file?}]` | Titles, order and groups. An entry finds its still by `file` (a path from the folder), else by `name`; with both, `name` renames the still of `file`. |
| `README.md` (or `index.md`) | Order of appearance of the images it references (`![alt](x.png)`, `<img src>`, a link to an image), groups from the nearest `#`, `##` or `###` heading above each, titles from the text cells of its table row (less one the file name starts with, such as its number) or else its alt text, and the document itself as `about: {file, markdown}`, the viewer's About page. |
| subfolders with images | Each subfolder is a group, only when nothing above gives groups. |
| `name@<key>.png` | The variant `<key>` of the still `name`, such as `onboarding@mobile+dark.png`; `<key>` is a [variant key](#variant-keys), `web` or `WxH[@dpr]` for its viewport. A plain `name.png` is its `desktop` variant and its first. |

`groups` is `[{title, stills: [name]}]` in the order of `stills`, a still in no group in the
group titled `null`; it is empty when nothing gives groups. Stills a README or `stills.json`
leaves out follow the ones it orders, in name order.

**Nothing breaks the read.** A missing extra falls back silently. A broken or partial one is
used for what it gives and its problem is a line of `notes`, such as `stills.json: line 3:
Expected double-quoted property name`; so are a reference to an image that is not there
(dropped), a `@` that is not a variant key (the image is its own still) and two images of one
still and variant (the first kept).

**Revisions by content hash.** Without a manifest, a still's revision is its content. The
review of the folder lives in `<dir>/.review/`, created by the first write (a remark, a
reviewed mark, keeping the revisions) and never by reading; commit it or ignore it:

```
.review/
  events.jsonl                       the event log, as below
  .lock                              held while an event is being appended
  annotated/<id>.png                 thread <id>'s still with its mark drawn
  revs.json                          {name: {key: [{n, hash, ext, size, mtimeMs, at}]}}, hash a SHA-256
  revs.lock                          held while revisions are being kept
  revs/<name>/<key>/<n>.<ext>        the bytes of every revision kept
```

The first write keeps every image as rev 1. From then on, a read that finds an image whose
content differs from its last kept revision makes it rev N+1 and keeps its bytes, so a remark
on rev N still points at the pixels it was made on and before/after works. A revision's
`file` is the image in the folder for the current one and `.review/revs/...` for the older
ones: the folder itself only ever holds the current images. Until `.review/` exists every
image is rev 1, and a change replaces it.

A folder that cannot be written reads fine with `writable: false`; writing its review fails.

**In the viewer.** Served from a folder, the runtime adds what the source gives to the answer
of `GET /_review/stills` (see [Reviewers](#reviewers)): `groups` and `notes` as above,
`writable`, and `about`, `{file}` when there is a README and null when not. A mockup's own
`.mockup/` adds none of them. The viewer heads the strip with the groups, shows the notes as
one dismissible line and, with `writable: false`, disables Remark, Reply, Resolve and Reviewed
under "read-only folder: remarks off". Two more routes serve the About page:

| Route | Answers |
| ----- | ------- |
| `GET /_review/about` | `{file, html}`: the README rendered by the runtime, with markdown-it 14.1.0 vendored in the image, as sanitized HTML. Raw HTML shows as text, but `<img>` and `<br>`, read as their markdown; no script, and no `javascript:` or `data:` link. An `http(s)` or `mailto` link opens in a new tab; a relative image is served from the folder, and one that is a still links to it, `#<name>[@<key>]`; an image from elsewhere is a link, never loaded; any other relative link keeps its text and loses its target. 404 without a README. |
| `GET /_review/file/<path>` | An image of the folder (`png`, `jpg`, `jpeg`, `webp`, `gif`), `<path>` from the folder. Nothing else: not a hidden entry, another kind of file, or a path that leaves the folder, by itself or through a link. |

**Live.** While a viewer is connected the runtime looks at the folder four times a second, and
once two looks agree on a change (an image rewritten, added or removed, the README or
`stills.json` edited) it reads the folder, keeping a changed image as its next revision when
`.review/` exists, and sends `stills` on the event stream; the viewer reads everything again.
The current image of a folder is rewritten in place, so the viewer asks for it with `?t=<the
revision's time>` and never shows a stale one.

**Serving a folder.** `preview stills serve [<dir>]` runs the runtime in folder mode
([`mockup/folder.mjs`](../mockup/folder.mjs)) on the folder mounted at `/stills`, read-only
when the host user cannot write it. Serving a writable folder keeps its revisions at start
(the first write), so the first rewrite of an image is already rev 2 with before/after.
Its routes are the viewer's above; a `POST /_review/events` to a read-only folder is a 403,
`read-only folder: remarks off`. Besides them only the files of the stills' revisions are
served, never the folder's other files.
`--dir <dir>` on `preview stills ls` and the `preview review` commands reads and writes the same
store, served or not.

**Exporting a mockup.** `preview stills export <dir> [--readme]` copies a mockup's stills into a
folder that reads back as the same stills with the same remarks: each variant's current
revision as `<name>@<key>.png` (`<name>.png` for a still whose one variant is `desktop`), every
revision in `.review/revs/` and `.review/revs.json` so the revision numbers carry over, and the
log and annotated stills in `.review/`. An event on a still without `variant` gets the still's
first variant written in, since the folder may order the variants differently. `stills.json`
keeps the titles and order; `--readme` writes a `README.md` table of titles and images when the
folder has no README. Neither is ever overwritten, and a folder that holds a review already or
an image the export would write is refused.

## Events

`review/events.jsonl` is an append-only log, one JSON object per line, each terminated by
`\n`. Lines are never edited or removed. Every remark, reply and reviewed mark is an event;
the state of the review (open threads, reviewed stills) is a fold over the log.

```json
{"seq":1,"id":"3f9a0c1e","type":"thread","at":"2026-11-17T10:05:02.410Z","author":{"kind":"human","name":"dante"},"still":"05-invite-user","rev":1,"anchor":{"x":0.12,"y":0.4,"w":0.5,"h":0.08},"body":"The button overflows on a phone"}
{"seq":2,"id":"b71d22aa","type":"reply","at":"2026-11-17T10:31:52.881Z","author":{"kind":"agent","name":"claude"},"thread":"3f9a0c1e","body":"Wrapped the label; see rev 2"}
{"seq":3,"id":"0c4e9f13","type":"viewed","at":"2026-11-17T10:33:15.002Z","author":{"kind":"human","name":"dante"},"still":"05-invite-user","rev":2}
{"seq":4,"id":"e2d81b70","type":"resolve","at":"2026-11-17T10:33:20.551Z","author":{"kind":"human","name":"dante"},"thread":"3f9a0c1e"}
```

### Fields every event has

| Field         | Meaning |
| ------------- | ------- |
| `seq`         | Position in the log: an integer from 1, above the `seq` of every good event before it. The reference writer makes it one more than the last; a reader accepts any increase. The cursor readers resume from (see [Cursor](#cursor)). |
| `id`          | The event's id, unique in the log: 8 lowercase hex characters from the reference writer; a reader accepts any 1 to 64 letters, digits, `_` and `-`. A `thread` event's id is the thread's id. |
| `type`        | One of the types below. |
| `at`          | When it was appended: ISO 8601 date and time with a zone, `YYYY-MM-DDTHH:MM[:SS[.sss]]` then `Z` or `±HH:MM`. The reference writer always writes UTC (`Z`) with milliseconds. |
| `author`      | `{kind, name, via?}`: `kind` is `"human"` (someone in the viewer) or `"agent"` (the agent answering, or any other program); `name` a string of at most 100 characters, not empty or only whitespace; `via`, when present, how the author came: `"tailnet"` (a user on the tailnet), `"share"` (a guest on a share link) or `"cli"` (the `preview` CLI). |

An event carries exactly the fields of its type; any other field makes the line malformed.

### Types

| Type       | Extra fields                     | Meaning |
| ---------- | -------------------------------- | ------- |
| `thread`   | `still`, `variant?`, `rev`, `anchor?`, `body`, `target?` | Opens a thread: a remark on revision `rev` of a variant of `still`, on the area `anchor` (the whole still when absent); `target` when it was made on the live page (see [Targets](#targets)). |
| `reply`    | `thread`, `body`                 | Answers thread `thread`. |
| `resolve`  | `thread`                         | Marks thread `thread` resolved. |
| `reopen`   | `thread`                         | Marks thread `thread` open again. |
| `viewed`   | `still`, `variant?`, `rev`       | Marks revision `rev` of a variant of `still` reviewed, by the event's author. |
| `unviewed` | `still`, `variant?`, `rev`       | Clears the author's reviewed mark of a variant of `still`; `rev` is the revision on screen. |
| `working`  | `thread?`, `still?`, `variant?`, `note?` | The agent is working on thread `thread`, or on `still` (a variant of it with `variant`), or on something it does not name; `note` says on what. See [Working](#working). |
| `idle`     | `thread?`                        | The agent stopped working on thread `thread`, or, with no `thread`, on everything. |

- `still` is a still name from the manifest, `variant` the key of one of its variants and
  `rev` one of that variant's revision numbers, at the time the event was appended.
- `variant` absent means the still's first variant, so logs written before variants keep
  their meaning; on a `working` it means the whole still. `variant` goes only with a `still`.
- `still: null` on a `thread` is a **general thread**, about no still: it has no `rev`, no
  `anchor` and no `target`. Reserved for chat in a later version; a reader may ignore it.
- `thread` is the `id` of a `thread` event earlier in the log.
- `body` and `note` are non-empty strings (not only whitespace) of at most 10000 characters,
  plain text, shown as written.

### Anchors

An anchor is the marked area, in coordinates normalized to the still: `0..1` from the left
(`x`) and from the top (`y`) of the image, so it holds at any display size. A pixel is
`x * width` from the left of the revision's PNG.

- A **pin** is `{x, y}`: one point.
- A **region** (box) is `{x, y, w, h}`: its top-left corner, width and height, `w` and `h`
  above 0 and the box inside the image (`x + w <= 1`, `y + h <= 1`).

An anchor belongs to the revision named in its thread; it is not moved onto later revisions.

### Targets

A remark made on the live mockup page, not on a still, carries a `target`: what was marked on
the page. The still and the anchor of its thread are the shot the runtime took of that page
for it (see [Live marks](#live-marks)); the target is what the reviewer pointed at.

```json
{"page":"/checkout?step=2","elements":[{"selector":"#pay > button","text":"Pay now","html":"<button class=\"primary\">Pay now</button>"}],"viewport":"390x844@3+touch","scroll":{"x":0,"y":120},"state":"reproduced"}
```

| Field       | Meaning |
| ----------- | ------- |
| `page`      | The page's path on the mockup, with its query: starts with one `/`, no space, at most 2000 characters. |
| `elements`  | Up to 20 marked elements, `{selector, text, html}`: a CSS selector of the element (1 to 500 characters), its visible text (at most 200) and a cut of its HTML (at most 1000). May be empty. |
| `truncated` | Optional: `true` when more elements were marked than `elements` keeps. |
| `viewport`  | The viewport the page was seen at, a [preset or custom viewport](#viewports). |
| `scroll`    | `{x, y}`: how far the page was scrolled, in CSS pixels, 0 or more. |
| `state`     | `reproduced` when the shot shows every marked element, so the anchor is the region around them on it; `not-reproduced` when it does not (the reviewer reached them by acting on the page, such as opening a dialog, which a page loaded from scratch does not show), so the anchor is the box the reviewer drew and the elements' HTML is what is left of them. |

Every other field makes the line malformed. The threads fold carries it as `target`, null on a
thread without one; `preview review show` prints it under the thread's image and mark, and the
`preview review watch` line of the thread says how many elements it marks (`3 elements`,
`20+ elements` when truncated).

### Annotated stills

`review/annotated/<id>.png` is the still of thread `<id>` as the reviewer saw it: the
revision's image with the anchor drawn on it, a red frame for a region and a red ring for a
pin, so an agent reads one image instead of drawing the mark itself. The viewer draws it when
the remark is posted and the runtime writes it right after the `thread` event, whole (written
beside its name, then renamed). It is a convenience, not part of the log:

- It may be missing: the thread has no anchor, the browser could not draw it, or the event was
  read in the instant before the file landed. The event's `still`, `rev` and `anchor` always
  say the same thing.
- It may be smaller than the revision's PNG: a still too large to upload (over 8 MiB as a PNG)
  is scaled down. The anchor's normalized coordinates hold at any size.

## Cursor

`seq` grows with every appended event, starting at 1, and is never reused. A reader keeps
the highest `seq` it has handled and, on its next read, handles only the events above it.
Starting from 0 reads everything. Because the log is only ever appended to, a reader can also
re-read the whole file and skip what it has seen; the reference reader does just that.

A reader must tolerate the log as it finds it:

- **The last line without `\n`** is a write in progress. Leave it for the next read; do not
  report it.
- **A malformed line** (not JSON, or breaking the schema above) is skipped and reported,
  never fatal. Its `seq` counts for nothing.
- **A `seq` not above the last good one** (a duplicate, or a line out of order) is malformed.
- **An `id` an earlier good line already has** is malformed.
- **An event naming a thread the log does not open** is ignored by the folds below.
- **Blank lines** are skipped silently.

Whether a line is good depends on the good lines before it (its `seq` and `id`), so a reader
that reads only the new part of the file must carry the last good `seq` and the ids it has
seen from one read to the next. Re-reading the whole file needs no such state.

A writer that died mid-line leaves a torn line; the next append starts with a `\n`, so the
torn line becomes one malformed line and the next event is whole.

## Folds

Readers derive the review's state from the whole log; the reference implementation calls
these `threads(dir)`, `reviewMarks(dir)` with `reviewed(dir, by)`, and `working(dir, now)`.

**Threads.** One per `thread` event, in log order: its still, rev, anchor, body, author and
time; `status` `"open"` when opened, then set by each `resolve` (`"resolved"`) and `reopen`
(`"open"`) in turn, repeats being harmless; `replies` the `reply` events in log order. A reply
does not change the status. An open thread is one whose last resolve was followed by a
reopen, or that was never resolved.

**Threads** carry their `variant`: the one their event names, else the still's first
variant (null for a general thread).

**Reviewed marks are per reviewer.** A reviewer is an author's name, a guest's (`via:
"share"`) with ` (guest)` after it, `Ana (guest)`, so a guest who types the owner's name is
still another reviewer. For each reviewer, per still in the manifest and per variant: their
last `viewed` event for it sets the reviewed revision, and their `unviewed` after it clears
it. Another reviewer's events never touch it, so a guest marking stills reviewed hides
nothing from the owner. "Reviewed" always means reviewed by someone in
particular: the viewer's own identity, or the reviewer `preview stills ls --as` names. The
fold also gives the **reviewers**, every author with a mark that holds. With `rev` the
variant's current revision and `viewed` the revision that reviewer marked:

| State                       | When |
| --------------------------- | ---- |
| reviewed                    | `viewed == rev` |
| changed since reviewed      | `viewed < rev`: a newer revision landed after the mark, which no longer holds |
| not reviewed                | no mark |

So after a round of fixes, the stills to step through are the ones not reviewed or changed
since reviewed.

### Working

The agent's **working state** tells the reviewer it has seen a remark and is on it. It is a
fold too, `working(dir, now)` in the reference implementation:

- A `working` event starts a working state, one per thread, or per still and variant, or one
  with neither; another `working` for the same one keeps it on.
- It ends with the agent's next `reply` on that thread, its next `idle` on that thread, or an
  `idle` with no thread, which ends every one.
- It expires 10 minutes after its last `working`, so an agent that died does not look busy
  for good.

Each working state reads as `{thread, still, variant, note, author, since, at, until}`:
`since` when it started, `at` its last `working`, `until` when it expires, and null for what
the agent did not name. Only events of `kind: "agent"` end one.

## Reviewers

The viewer never says who is writing; the runtime does, per request, and writes it as the
event's `author` (`kind: "human"`), whatever `author` the posted body claims:

| Who       | How the runtime tells | `author` |
| --------- | --------------------- | -------- |
| A tailnet user | The request carries `Tailscale-User-Login`, which `tailscale serve` adds (and strips from what a client sends) | `name` from `Tailscale-User-Name`, else the login; `via: "tailnet"` |
| A guest   | Anything else: a share link, or a request to a host that is not the tailnet name of `PREVIEW_ALLOWED_HOSTS` (one under the share domain, its leading-dot entry, or an address), which did not come through `tailscale serve` whatever headers it carries | `name` from the body's `author.name`, trimmed, 1 to 40 characters; `via: "share"` |

- **Reading never asks.** A guest sees everything a tailnet user sees.
- **A guest's write needs a name.** A `POST /_review/events` from a guest without one is
  refused, `400` with `{"error": "name required"}`. The viewer asks for it once, on the first
  write, and keeps it in the browser.
- **A guest cannot `resolve` or `reopen`**: `403`. Those are the owner's (any tailnet user)
  and the agent's. A guest can open threads, reply and set their own reviewed mark.
- **`working` and `idle` are the agent's**: `403` from the viewer for anyone.
- A name is not an identity: a guest may type any name, so a reader tells *Dante* the owner
  from a guest calling themself Dante by `via`. The viewer shows a `guest` chip, and
  `preview review watch` prints `Ana (guest)`.

`GET /_review/stills` answers `{stills, marks, working, me, cursor}`: `marks` every
reviewer's marked revisions as `{reviewer: {still: {variant key: rev}}}`, `working` the
[working](#working) fold, and `me` who is asking, `{name, via}`, `name` null for a guest.

## Live marks

A reviewer can mark the live mockup page instead of a still. The page shows what was marked,
a still keeps it: the runtime shoots the page again for the remark, and the remark goes on
that shot with the marked elements as its [target](#targets).

`POST /_review/freeze` asks for that shot, a JSON body:

| Field       | Meaning |
| ----------- | ------- |
| `path`      | The page's path, as `target.page`. |
| `viewport`  | The viewport it was seen at, a preset or `WxH[@dpr][+touch]`. |
| `tags`      | Optional [tags](#tags) of the variant to shoot, `dark` or `light` setting the colour scheme. |
| `scroll`    | `{x, y}`, as `target.scroll`. |
| `box`       | `{x, y, w, h}`: the box drawn, in CSS pixels from the top left of the viewport, `w` and `h` above 0. |
| `elements`  | The marked `{selector, text, html}`; text and HTML are cut and the list kept to its first 20, `truncated` then true. |
| `truncated` | Optional: `true` when the browser kept fewer elements than were marked. |
| `author`    | A guest's `{name}`, as on an event. |

It is posted as an event is: JSON only (`415`), from the page's own origin only (`403`), at
most 64 KiB (`413`), and a guest's needs a name (`400`, `name required`; see
[Reviewers](#reviewers)). A bad field is a `400`, a shot that failed a `500`, and a folder
source, which has no pages, answers `404`. The runtime then shoots `path` from scratch at that
viewport and tags in its headless browser, measuring each element's selector on the shot, and
keeps the shot as a revision of a still, under `stills/.lock` as any still is added:

1. **The still of that screen**, when there is one: the first still whose `source.path` is
   `path`, that has the variant of that viewport and tags, and that `shots.mjs` does not shoot
   after steps (none when `shots.mjs` cannot be read). It is shot as that variant was, whole
   or not; one shot only at its viewport is taken only when the box, moved by the scroll, is
   inside it. An image equal to the variant's latest revision adds none, so a new revision
   appears only when the still was stale.
2. **Otherwise `live-<slug>`**, made with that variant and shot whole: the slug is the path
   with its query, lowercased, each run of characters other than letters, digits, `.` and `_`
   one `-` (`/checkout?step=2` is `live-checkout-step-2`, `/` is `live-index`). A name a still
   of another page already has ends with `-` and six hex characters of the SHA-256 of `path`.
   Its title is `<path> (live)`.

It answers `200` with `{still, variant, rev, anchor, state, target}`: the revision the remark
goes on, its anchor and state, and the `target` its `thread` event carries. When every
selector is found on the shot, the anchor is the region around their elements on it and the
state `reproduced`; otherwise, or with no elements, the anchor is the box sent, moved by the
scroll and cut to the shot, and the state `not-reproduced` (no anchor when that box is not on
the shot). The reviewer then posts the remark as a `thread` on that still, variant and rev,
with the anchor and the target, through `POST /_review/events`.

## Who writes what

| File                        | Written by | Read by |
| --------------------------- | ---------- | ------- |
| `stills/manifest.json`, `stills/<name>/<key>/<n>.png` | whoever shoots stills, through `addStill`: `preview stills add`, `preview stills shoot`, the `/mockup` skill's `mockup.sh shot`, the runtime for a [live mark](#live-marks) | the viewer, `preview stills ls`, the agent |
| `review/events.jsonl`       | the viewer for the human (`thread`, `reply`, `viewed`, `unviewed`, and for a tailnet user `resolve`, `reopen`; see [Reviewers](#reviewers)), `preview review reply\|resolve\|reopen\|working\|idle` for the agent | the viewer (live, over SSE), `preview review ls\|show\|watch`, any later reader |
| `review/annotated/<id>.png` | the viewer, when it posts thread `<id>`: the revision's PNG with the anchor drawn on it | the agent, to see the remark without redrawing it |

Readers need no lock. Writers go through the reference implementation or follow its
protocol exactly, because the runtime (in a container) and the CLI (on the host) write the
same files at once:

1. **Take the lock.** Create `review/.lock` (or `stills/.lock` for the manifest) with
   create-exclusive (`O_CREAT|O_EXCL`); if it exists, retry in a few milliseconds. A lock
   older than 10 seconds belongs to a writer that died: rename it aside to a name of your
   own, delete it if what moved is still older than 10 seconds (else hard-link it back), and
   retry.
2. **Validate** the event against the schema, and that its thread exists in the log and its
   still, variant (the first when it names none) and rev in the manifest.
3. **Assign** `seq` (one above the log's last good `seq`, 1 for an empty log), a fresh `id`
   and `at`.
4. **Append** the line, `\n`-terminated, with a single `write` on a descriptor opened with
   `O_APPEND`, preceded by a `\n` when the file does not end with one.
5. **Release** the lock by removing it, only if it is still the file you created (same inode).

Adding a still under `stills/.lock`: copy the PNG to `stills/<name>/<key>/<n>.png` with `n`
one past the variant's last revision, then rewrite the manifest through a temporary file and
a rename, the still's entry in v2 shape.
The file lands before the manifest names it, so a reader never sees a revision without its
image.
