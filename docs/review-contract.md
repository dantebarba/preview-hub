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
  stills/manifest.json        the stills and their revisions
  stills/<name>/<n>.png       one file per revision, immutable
  stills/.lock                held while the manifest is being changed
  review/events.jsonl         append-only event log: the backchannel
  review/.lock                held while an event is being appended
  review/annotated/<id>.png   thread <id>'s still with its mark drawn
```

All paths in the files below are relative to `.mockup/`.

## Stills

A **still** is a named screenshot of a mockup page, such as `05-invite-user`. A name is 1 to
100 characters of letters, digits, `.`, `_` and `-`, starting with a letter or digit, so it
is safe as a directory name and in a URL. Two names that differ only in case are refused,
since a case-insensitive filesystem would give them one directory.

Shooting a still again under the same name makes a new **revision**: rev 1, 2, 3, ... Every
revision keeps its own file, `stills/<name>/<n>.png`, which is never rewritten, so a remark
made on rev 1 still points at the pixels it was made on after rev 2 lands.

`stills/manifest.json` is a JSON list, one entry per still, in the order they were first
added:

```json
[
  {
    "name": "05-invite-user",
    "title": "Invite a user",
    "source": { "path": "/invite", "size": "390x844" },
    "revs": [
      { "n": 1, "file": "stills/05-invite-user/1.png", "at": "2026-11-17T10:02:11.120Z" },
      { "n": 2, "file": "stills/05-invite-user/2.png", "at": "2026-11-17T10:31:40.007Z" }
    ]
  }
]
```

| Field         | Meaning |
| ------------- | ------- |
| `name`        | The still's name, its key. |
| `title`       | Human-readable title; the name until one is given. |
| `source.path` | The mockup page the still was shot from (`/invite`), or null. |
| `source.size` | The viewport it was shot at, `WxH`, or null. |
| `revs`        | Every revision, oldest first: `n` from 1, `file` the PNG, `at` when it was added (ISO 8601, UTC). The last one is the current revision. |

The manifest is rewritten whole on every change: written to a temporary file next to it,
then renamed over it, so a reader always sees either the old or the new list, never a
partial one.

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
| `author`      | `{kind, name}`: `kind` is `"human"` (someone in the viewer) or `"agent"` (the agent answering, or any other program); `name` a string of at most 100 characters, not empty or only whitespace. |

An event carries exactly the fields of its type; any other field makes the line malformed.

### Types

| Type       | Extra fields                     | Meaning |
| ---------- | -------------------------------- | ------- |
| `thread`   | `still`, `rev`, `anchor?`, `body` | Opens a thread: a remark on revision `rev` of `still`, on the area `anchor` (the whole still when absent). |
| `reply`    | `thread`, `body`                 | Answers thread `thread`. |
| `resolve`  | `thread`                         | Marks thread `thread` resolved. |
| `reopen`   | `thread`                         | Marks thread `thread` open again. |
| `viewed`   | `still`, `rev`                   | Marks revision `rev` of `still` reviewed. |
| `unviewed` | `still`, `rev`                   | Clears the reviewed mark of `still`; `rev` is the revision on screen. |

- `still` is a still name from the manifest and `rev` one of its revision numbers, at the
  time the event was appended.
- `still: null` on a `thread` is a **general thread**, about no still: it has no `rev` and no
  `anchor`. Reserved for chat in a later version; a reader may ignore it.
- `thread` is the `id` of a `thread` event earlier in the log.
- `body` is a non-empty string (not only whitespace) of at most 10000 characters, plain
  text, shown as written.

### Anchors

An anchor is the marked area, in coordinates normalized to the still: `0..1` from the left
(`x`) and from the top (`y`) of the image, so it holds at any display size. A pixel is
`x * width` from the left of the revision's PNG.

- A **pin** is `{x, y}`: one point.
- A **region** (box) is `{x, y, w, h}`: its top-left corner, width and height, `w` and `h`
  above 0 and the box inside the image (`x + w <= 1`, `y + h <= 1`).

An anchor belongs to the revision named in its thread; it is not moved onto later revisions.

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
these `threads(dir)` and `reviewed(dir)`.

**Threads.** One per `thread` event, in log order: its still, rev, anchor, body, author and
time; `status` `"open"` when opened, then set by each `resolve` (`"resolved"`) and `reopen`
(`"open"`) in turn, repeats being harmless; `replies` the `reply` events in log order. A reply
does not change the status. An open thread is one whose last resolve was followed by a
reopen, or that was never resolved.

**Reviewed marks.** Per still in the manifest: the last `viewed` event for it sets the
reviewed revision, an `unviewed` after it clears it. With `rev` the still's current revision
and `viewed` the reviewed revision:

| State                       | When |
| --------------------------- | ---- |
| reviewed                    | `viewed == rev` |
| changed since reviewed      | `viewed < rev`: a newer revision landed after the mark, which no longer holds |
| not reviewed                | no mark |

So after a round of fixes, the stills to step through are the ones not reviewed or changed
since reviewed.

## Who writes what

| File                        | Written by | Read by |
| --------------------------- | ---------- | ------- |
| `stills/manifest.json`, `stills/<name>/<n>.png` | whoever shoots stills, through `addStill`: `preview stills add`, the `/mockup` skill | the viewer, `preview stills ls`, the agent |
| `review/events.jsonl`       | the viewer for the human (`thread`, `reply`, `resolve`, `reopen`, `viewed`, `unviewed`), `preview review reply\|resolve\|reopen` for the agent | the viewer (live, over SSE), `preview review ls\|show\|watch`, any later reader |
| `review/annotated/<id>.png` | the viewer, when thread `<id>` is opened: the revision's PNG with the anchor drawn on it | the agent, to see the remark without redrawing it |

Readers need no lock. Writers go through the reference implementation or follow its
protocol exactly, because the runtime (in a container) and the CLI (on the host) write the
same files at once:

1. **Take the lock.** Create `review/.lock` (or `stills/.lock` for the manifest) with
   create-exclusive (`O_CREAT|O_EXCL`); if it exists, retry in a few milliseconds. A lock
   older than 10 seconds belongs to a writer that died: rename it aside to a name of your
   own, delete it if what moved is still older than 10 seconds (else hard-link it back), and
   retry.
2. **Validate** the event against the schema, and that its thread exists in the log and its
   still and rev in the manifest.
3. **Assign** `seq` (one above the log's last good `seq`, 1 for an empty log), a fresh `id`
   and `at`.
4. **Append** the line, `\n`-terminated, with a single `write` on a descriptor opened with
   `O_APPEND`, preceded by a `\n` when the file does not end with one.
5. **Release** the lock by removing it, only if it is still the file you created (same inode).

Adding a still under `stills/.lock`: copy the PNG to `stills/<name>/<n>.png` with `n` one past
the still's last revision, then rewrite the manifest through a temporary file and a rename.
The file lands before the manifest names it, so a reader never sees a revision without its
image.
