# Preview Hub

Preview Hub is a small, installable PWA that shows every active local dev preview
across all of your projects on one screen — grouped by project, each with a
tap-to-open link. It runs as a single Docker container and discovers previews by
reading Docker labels, so it depends on nothing from the projects it lists.

## Docker labels are the source of truth

The hub keeps no database and no registry. On an interval it asks the Docker
daemon for every container carrying a `preview.url` label, then groups and
deduplicates them for display. When a preview stack stops, its container is gone,
so its entry simply disappears on the next poll — there is no stale state and no
cleanup job to run.

A project participates by stamping these labels on at least one container in its
preview stack:

| Label              | Required | Meaning                                              |
| ------------------ | -------- | ---------------------------------------------------- |
| `preview.url`      | yes      | Reachable HTTPS URL; the hub filters on its presence |
| `preview.project`  | yes      | Project name — the hub's grouping key                |
| `preview.branch`   | yes      | Branch name                                          |
| `preview.worktree` | no       | Worktree name; defaults to `Root Worktree`           |
| `preview.desc`     | no       | Short description shown as muted subtext             |
| `preview.review`   | no       | Path of a review page, e.g. `/stills`; adds **Review** |

## Quickstart

Install the launcher (see [Install the launcher](#install-the-launcher)), then run
the hub with the CLI. The only runtime dependencies are **docker** (to run the hub
and read the socket) and, to publish it on your tailnet, **tailscale**:

```sh
preview hub up        # pulls ghcr.io/dantebarba/preview-hub and runs it
preview hub expose    # serve it on your tailnet on a dedicated HTTPS port
```

`preview hub up` runs the hub container with the Docker socket mounted so it can
discover previews and stop them from the UI, publishes `HUB_PORT` (default `8788`), and sets
`restart: unless-stopped`. Manage it with `preview hub {down,status,logs}`. The
published image is `ghcr.io/dantebarba/preview-hub:latest` (override with
`PREVIEW_HUB_IMAGE`).

Verify it locally:

```sh
curl http://127.0.0.1:8788/health      # -> ok
curl http://127.0.0.1:8788/api/previews
```

<details>
<summary>Alternative: run from a clone with docker compose</summary>

From the `hub/` directory:

```sh
docker compose up -d
```

Copy `.env.example` to `.env` to override the port or poll interval; both have
safe defaults, so `.env` is optional.
</details>

## Stopping a preview from the hub

Right-click a card (or focus it and press <kbd>Delete</kbd>) on desktop, or swipe it
left on a phone, to reveal its actions: **Stop**, plus the share actions when the hub
can [share](#sharing-from-the-hub), and **Review** when the preview carries `preview.review`,
a link to its review page (a mockup's `/stills`). Tap **Stop** to stop that preview. When the preview is
shared, the hub first retracts the share on the edge and removes its forwarder, so no
share outlives it. Then it stops every running container of the preview's compose
project — it only acts on stacks whose container carries `preview.url` — and the card
disappears on the next poll.

The hub runs in a container, so it cannot run the launcher's full teardown: the
containers are stopped, not removed, and the Tailscale mapping, any host processes an
`on_down` hook would stop, and the launcher's state stay behind until `preview stop`
or the auto-stop watchdog runs. `preview start` brings a hub-stopped preview back.

Anyone who can reach the hub can stop previews, and the Docker socket grants full
control of the engine whether or not it is mounted `:ro`; keep the hub on your tailnet.

## Sharing a preview on the internet

A running preview can be published to someone outside the tailnet, under its own name,
behind a key, for a limited time:

```sh
preview share [--hours N] [--yes]   # N from 1 to 72, default 4
preview unshare
preview shares                      # every share, from any directory
```

`share` and `unshare` act on the current checkout's preview, resolved like `preview stop`
(`PREVIEW_ID`, `.preview/`). `share` prints a link `https://<label>.<domain>/?k=<key>` and
the expiry in local time; the label is built from the project and the identity (lowercase,
each run of characters outside `[a-z0-9-]` becomes one `-`, no leading or trailing `-`, at
most 63 characters). Sharing again replaces the key and the expiry, so the link printed
before stops working. `shares` lists label,
link and time left, marking the shares whose preview is not running on this machine.

The launcher runs no tunnel, proxy or DNS itself. It asks an **edge host** that owns all
of that, over SSH, with a key the edge binds to its `share` command (verbs `add`, `remove`,
`list`); the edge proxies a guest to an address of this machine. While a preview is shared,
a forwarder container (`<compose project>-share`, `alpine/socat` on the host network)
serves the preview's `PREVIEW_SERVE_TARGET` on that one address at the preview's base
port, never on `0.0.0.0`. `share` fails when that address is not one of this machine's.

- `share` refuses a preview that is not running, and warns and asks for confirmation
  (skip it with `--yes`) when the preview's containers mount a `.env` / `.envrc`, read one
  through `env_file`, or compose reads the project directory's `.env`: the guest will be
  talking to a process that holds credentials.
- It warns when the preview did not start with the public host in `PREVIEW_ALLOWED_HOSTS`,
  so a server that checks `Host` would refuse it (see
  [Servers that check Host](#servers-that-check-host)).
- `preview stop`, `killall` and the auto-stop watchdog unshare first.
- The edge removes a share when it expires; `preview shares` and `preview status` then
  stop the forwarder it left behind.
- The hub shows a shared preview with a **Shared** badge, its public host and its expiry,
  and can share, unshare and copy the link itself when configured (see
  [Sharing from the hub](#sharing-from-the-hub)). A share made from either side is seen and
  retracted by the other.

Configure it with environment variables, or with `KEY=VALUE` lines in
`~/.config/preview/share.env` (the environment wins). Put them in the file when the
auto-stop watchdog must be able to unshare: it only sees the environment of `preview start`.

| Variable               | Default                        | Purpose |
| ---------------------- | ------------------------------ | ------- |
| `PREVIEW_SHARE_SSH`    | — (required)                   | SSH destination of the edge, `user@host` |
| `PREVIEW_SHARE_ADDR`   | — (required)                   | Address of this machine the edge proxies to; the forwarder binds only there |
| `PREVIEW_SHARE_KEY`    | `~/.ssh/share_key`             | SSH key bound to the edge's `share` command |
| `PREVIEW_SHARE_IMAGE`  | `alpine/socat:latest`          | Forwarder image |
| `PREVIEW_SHARE_KNOWN_HOSTS` | `~/.ssh/known_hosts`      | known_hosts `preview hub up` hands to the hub |
| `PREVIEW_SHARE_DOMAIN` | —                              | The edge's domain; `preview start` adds `.<domain>` to `PREVIEW_ALLOWED_HOSTS` |
| `PREVIEW_SHARE_CONFIG` | `~/.config/preview/share.env`  | Where the settings above are read from |

`share` needs `ssh` and `python3` besides docker.

### Servers that check Host

A server that refuses an unknown `Host` (Vite dev and preview, Django `ALLOWED_HOSTS`, …)
has to accept the tailnet name `tailscale serve` forwards and the public name the edge
forwards. `preview start` exports both as `PREVIEW_ALLOWED_HOSTS` before the hooks run: a
comma-separated list of this machine's tailnet host and, when `PREVIEW_SHARE_DOMAIN` is
set, `.<domain>`, where a leading `.` means the domain and its subdomains. Read it instead
of naming a domain in the project (`server` is `vite` dev, `preview` is `vite preview`):

```js
// vite.config.ts
const allowedHosts = (process.env.PREVIEW_ALLOWED_HOSTS ?? '').split(',').filter(Boolean)
export default defineConfig({ server: { allowedHosts }, preview: { allowedHosts } })
```

```python
# settings.py
ALLOWED_HOSTS = ["localhost", *filter(None, os.environ.get("PREVIEW_ALLOWED_HOSTS", "").split(","))]
```

A server in a container sees the variable only when the compose file passes it through,
e.g. `environment: [PREVIEW_ALLOWED_HOSTS]`. Set `PREVIEW_SHARE_DOMAIN` before
`preview start`: a preview started without it does not accept the share name until it is
restarted, and `preview share` says so.

### Sharing from the hub

When the settings above resolve, `preview hub up` hands them to the hub container: the
SSH destination, the bind address and the forwarder image as environment, the key and
`known_hosts` mounted read-only, and the edge's address as this host resolves it (the
container's DNS may not see a private zone). `preview hub status` says whether sharing
is on; after changing the settings, recreate the hub with `preview hub update`.

A card's actions (right-click, <kbd>Delete</kbd>, or a left swipe) then offer:

- **Share**, on a preview that is not shared: a dialog picks 1, 4 (default), 24 or 72
  hours. When one of the preview's containers bind-mounts a `.env` / `.envrc` file, the
  hub lists it and asks again before sharing. From inside its container the hub cannot
  look into mounted directories or `env_file`; `preview share` checks those.
- **Copy link**, on a shared preview: the link, key included, is fetched from the edge's
  `list` when pressed and put on the clipboard (or shown to copy by hand). The hub never
  stores it.
- **Unshare**: retracts the share on the edge and removes the forwarder.
- **Stop**: retracts the share first, then stops the preview.

A preview started by a launcher older than this feature lacks the `preview.edge.*`
labels the hub needs; restart it to share it from the hub. The hub image carries
`openssh-client` for this.

With sharing on, anyone who can reach the hub can publish previews on the internet and
read their links: keep the hub on your tailnet.

## Serve it over Tailscale (one time)

The easiest way is `preview hub expose`, which runs the command below on a dedicated
port for you. To do it by hand: publish the hub on your tailnet so the PWA has a
stable, installable URL you can reach from your phone. Serve it on **its own HTTPS
port** so it gets a clean root origin, independent of anything already mapped on `/`:

```sh
tailscale serve --bg --https=8443 http://127.0.0.1:8788
```

That gives `https://<your-tailnet-host>:8443/`. Use a tailnet HTTPS port that
differs from the container's published host port (`8788`) to avoid a bind
conflict. Open it and add it to the home screen to install the PWA — nothing else
on your tailnet is touched.

<details>
<summary>Alternative: mount under a subpath</summary>

You can instead expose it under a path on an existing hostname:

```sh
tailscale serve --bg --set-path=/previews http://127.0.0.1:8788
```

The PWA resolves its API and assets relative to the page, so it works under a
subpath — but you must open it **with the trailing slash**
(`https://<your-tailnet-host>/previews/`), and it shares an origin with whatever
serves `/`, which can cause service-worker scope overlap with that app. Prefer
the dedicated port above unless you specifically need a single hostname.
</details>

## Install the launcher

The `preview` CLI brings a project's stack up with the right labels and the
Tailscale URL the hub discovers. Install it into your `PATH` with one command:

```sh
curl -fsSL https://github.com/dantebarba/preview-hub/releases/latest/download/install.sh | sh
```

This downloads the standalone `preview` script to `~/.local/bin/preview`. Override
the location with `PREVIEW_BIN_DIR`, or pin a version with `PREVIEW_VERSION`:

```sh
curl -fsSL https://github.com/dantebarba/preview-hub/releases/latest/download/install.sh \
  | PREVIEW_BIN_DIR="$HOME/bin" PREVIEW_VERSION=v0.1.1 sh
```

Once installed, `preview hub {up,down,status,expose,logs}` runs the hub itself,
`preview {start,stop,status,killall}` drives a project's previews and
`preview {share,unshare,shares}` publishes one on the internet — see
`preview --help`, `preview hub --help`, and [`docs/participate.md`](docs/participate.md).

### Onboard a project

From inside a repo, `preview init` scaffolds everything a project needs to be
previewable — `.preview/config.sh`, `.preview/hooks.sh`, and the `preview` and
`mockup` Claude skills — and warns about any missing runtime tools (docker, docker compose,
tailscale, a SHA-256 tool):

```sh
preview init          # writes the files, skipping any that already exist
preview init --force  # overwrite existing files
```

It fetches the templates from the release tag matching your installed CLI (so the
scaffold always matches the engine), or copies them from the clone when you
installed from source. Then edit `.preview/config.sh` for your app and run
`preview start`.

Then confirm it is on your `PATH`:

```sh
preview --help
```

Prefer to inspect before running? Download the script, review it, and install by
hand — it is a single self-contained bash file with no dependencies:

```sh
curl -fsSL https://github.com/dantebarba/preview-hub/releases/latest/download/preview -o ~/.local/bin/preview
chmod +x ~/.local/bin/preview
```

Working from a clone instead? [`launcher/install.sh`](launcher/install.sh)
symlinks the repo copy into `~/.local/bin`.

### Updating

- **Update the hub** to the newest published image: `preview hub update` — pulls
  `ghcr.io/dantebarba/preview-hub:latest` from GitHub and recreates the container.
- **Update the CLI** itself: `preview self-update` — refetches the latest `preview`
  from the newest release and replaces it in place. (If you installed from a clone,
  it's a symlink, so `self-update` will point you to `git pull` instead.)

## How a project participates

Any project can join by stamping the labels above on its preview containers. The
recommended path is the bundled launcher, which stamps the labels for you and
wires up a per-branch Tailscale URL. See:

- [`docs/participate.md`](docs/participate.md) — the participation guide:
  installing the launcher and adding a `.preview/` config, with a synthetic
  worked example.
- [`docs/labeling-contract.md`](docs/labeling-contract.md) — the labeling
  contract in full.
- [`docs/review-contract.md`](docs/review-contract.md) — the stills review
  store: a mockup's stills, their revisions and the review event log.
- [`launcher/`](launcher/) — the preview engine that brings a stack up with the
  right labels and isolation.
- [`launcher/example/.claude/skills/`](launcher/example/.claude/skills/) — two
  Claude Code skills a project can copy in: `preview`, which decides when to run
  the launcher, and `mockup`, which turns a UI mockup into a preview of its own.

### Mockups as previews

A design question is cheaper to settle on a phone than in prose. The bundled
`/mockup` skill has the agent write **sample pages** that render a project's real
components into a self-ignoring `.mockup/` directory, and serves them from the
pinned `/mockup` runtime (`ghcr.io/dantebarba/preview-mockup`, built from
[`mockup/`](mockup/); `preview start` exports its name and tag as
`PREVIEW_MOCKUP_IMAGE`, so no project file names the image): Vite used as a library with its own React, Vue and Svelte
plugins, reading the project only as a read-only source tree (`node_modules`,
`tsconfig`/`jsconfig` paths, `postcss.config.*` with Tailwind v3 or v4, `.env*`).
There is no build step and no per-project recipe: start once, then every save hot
reloads on the phone, with component state kept by Fast Refresh. The launcher runs
it under its own identity (`mockup-<branch>`), so it gets a Tailscale URL, a card
on the hub and the 6h watchdog like any other preview; the card opens on a menu of
every page, variant and still. Angular, Svelte before 5 and route-level
SvelteKit/Nuxt/Next features are not compiled. It needs `docker`, `tailscale`, the
`preview` launcher and `git` on the machine. `/mockup stop` removes the container
and every file it created. See [`docs/participate.md`](docs/participate.md#mockups-as-previews).

A minimal, synthetic example — one service in a project's preview compose file.
The values are supplied at runtime (the launcher exports them; stamp them from
your own env or CI if you label by hand) rather than hardcoded, so nothing
branch- or machine-specific is ever committed:

```yaml
services:
  web:
    image: acme-widgets:preview
    labels:
      preview.url: "${PREVIEW_LABEL_URL}"
      preview.project: "${PREVIEW_LABEL_PROJECT}"
      preview.branch: "${PREVIEW_LABEL_BRANCH}"
      preview.worktree: "${PREVIEW_LABEL_WORKTREE}"
      preview.desc: "${PREVIEW_LABEL_DESC}"
```

### Reviewing stills

A mockup's stills are reviewed in place: the human marks an area of a still and
comments on it in the viewer, and the agent hears about it and answers from its
shell. Any folder of images can be reviewed the same way, with no mockup
([Any folder of images](#any-folder-of-images)). `preview stills` and `preview review` are the agent's side. Run them from
the frontend root (they find `.mockup/` and its `mockup-<branch>` identity the way
`mockup.sh` does) or from inside `.mockup/`. They run the review CLI of the
`/mockup` runtime image ([`mockup/review-cli.mjs`](mockup/review-cli.mjs)), in
the running container or in a throwaway one, so they work with the preview
stopped and need only `docker` on the host.

```sh
preview stills add .mockup/shots/05-invite-user.png --name 05-invite-user \
  --viewport mobile --tag dark --title "Invite a user" --source "/invite?v=b"   # rev 1, then 2, ...
preview stills shoot --only '^05-'   # shoot .mockup/shots.mjs as a batch; an unchanged image adds nothing
preview stills ls --as Dante          # each variant's latest rev, reviewed by Dante or not, open threads
preview review ls --open              # one line per thread; --json for the full fold
preview review show 3f9a0c1e          # body, anchor, variant, rev, replies, the still, the marked PNG, and the page and elements of a remark made on the live page
preview review working 3f9a0c1e --note "re-shooting mobile+dark"   # tells the reviewer the agent is on it
preview review reply 3f9a0c1e "Wrapped the label; see rev 2"      # also ends working
preview review idle                   # or idle <thread>; working also expires after 10 minutes
preview review resolve 3f9a0c1e       # or reopen
preview review watch --since 12       # one line per new human event, until stopped
preview stills export docs/mockups/invite --readme   # keep the stills and remarks in a folder
```

A still is one screen with one or more **variants**, each a viewport and free tags with
revisions of its own: `mobile+dark`, `mobile+light`, `desktop`. The viewport is a preset or a
custom `WxH[@dpr][+touch]` (pixel ratio 1 unless given; `+touch` is a touch device with a
mobile user agent):

| Preset            | CSS size | Pixel ratio | Device |
| ----------------- | -------- | ----------- | ------ |
| `mobile`          | 390×844  | 3 | touch, mobile user agent |
| `mobile-s`        | 375×812  | 3 | touch, mobile user agent (iPhone mini) |
| `tablet`          | 820×1180 | 2 | touch, tablet user agent |
| `desktop` (`web`) | 1440×900 | 1 | mouse |

Tags are free labels (`dark`, `light`, `rtl`, `empty`, `logged-out`); `dark` and `light` set
`prefers-color-scheme` when the still is shot, so they go in separate shots, never together.
The variant's key is the viewport and its tags, sorted: `--viewport mobile --tag dark` is
`mobile+dark`, and a custom viewport's key is `custom-WxH[@dpr][-touch]` (`custom-390x700`).
`--full-page` records that the whole page was captured. An image whose bytes equal the
variant's latest revision adds none (`stills add` prints `unchanged`), so re-shooting leaves
the reviewed marks of the stills that did not change alone. The viewer groups viewports by
device class: `mobile` and `mobile-s` are Mobile, `tablet` is Tablet, `desktop` is Desktop,
and a custom size goes by its width (under 600 Mobile, under 1100 Tablet, else Desktop). It
shows a switcher of the classes (Mobile · Tablet · Desktop) and a row of tag chips only when
the stills have more than one of either; the size of the variant on screen is a muted label
(`1440×1250`), or a size picker when the still has several sizes of that class. The choice of
class and tags sticks across stills, with the exact size where the next still has it, and the
URL names the variant on screen (`/stills#05-invite-user@mobile+dark`); a still without the
chosen class and tags shows its first variant of the class, else its first variant, with a
note such as "showing desktop". Revisions, remarks and reviewed marks are per variant, and the
reviewed count is the viewer's own, of the stills that have the chosen class and tags.

**Who reviews.** On the tailnet the viewer writes as the Tailscale user (`tailscale serve`
passes their name), with `via: "tailnet"` and no prompt. A guest on a share link views
freely; their first write (a remark, a reply, a reviewed mark) asks "What's your name?" once
per browser, and the server refuses a guest's write with no name (`400 name required`).
Guest events carry `via: "share"`: the viewer shows a `guest` chip (*Ana · guest*) and
`watch` prints `Ana (guest)`, so a guest calling themselves "dante" is still told apart.
Guests remark, reply and mark their own reviewed; **resolve and reopen are the owner's and the
agent's**: the viewer hides them from a guest and the server refuses them with `403`. Each
reviewer has their own reviewed marks, a tailnet user's under their Tailscale display name and
a guest's under `Ana (guest)`, so a guest's marks hide nothing from the owner; `--as` takes
that name, and without it `stills ls` says whose marks hold.

**Marking on the live page.** A remark can also be made on the mockup page itself, with no
still to find first. Every page on the menu has a **Live** link, `/live/<slug>`: the page in
a frame, with a bar outside it that shows the page's path (it follows the page as it
navigates), a device picker (Mobile · Tablet · Desktop, the presets above, scaled down when
the window is smaller), the **Mark** button and the **Remarks** button with the count of the
page's open remarks. Nothing a reviewer does there ever reloads the page or leaves it. It has
two modes, told apart by how the page is framed, not by a sentence:

| Mode | What a tap does | How it shows |
| ---- | --------------- | ------------ |
| **Use** (default) | navigates or acts, as on the page alone; nothing is ever selected | the plain bar |
| **Mark** | selects, and never reaches the page | a red frame around the page, a crosshair, the Mark button pressed |

Mark mode is entered only from the Mark button, or <kbd>M</kbd> on a desktop; it ends with
<kbd>Esc</kbd>, the same button or Cancel, and by itself once the remark is posted. On a
phone the Mark button sits in a dock under the page, in the thumb zone; there one finger
draws and two fingers scroll the page (the wheel does on a desktop). Two gestures mark, and
both end in a box:

- **Drag** draws a box, which can be moved or resized by its corners. It marks the visible
  elements whose box is inside it, leaving out a wrapper that covers the same area as what
  it wraps, at most 20 (`20+ elements` beyond).
- **Tap** marks the innermost element under it, and a breadcrumb row (`section#card ›
  p.lead › b`) widens the mark to a parent, up to the section it is in. With a mouse the
  element under the pointer is highlighted.

The strip under the page shows the count ("3 elements") with **Comment** and Cancel. Comment
opens a composer by the box (over the keyboard on a phone); **Post**, or
<kbd>Ctrl</kbd>/<kbd>⌘</kbd>+<kbd>Enter</kbd>, sends the remark with a snapshot of the page's
DOM as it is at that instant: the tab it is on, what was toggled and typed, an open dialog,
the scroll of every list. The runtime renders that snapshot in the background at the
reviewer's device and scroll and shoots it, so the shot is what the reviewer saw; it goes on
the still `live-<slug>`, one variant per device, and an image equal to the last adds no
revision. A guest is asked for a name on the first Post.

A toast says what became of it: **Posted**, with a spinner while the runtime shoots, then an
**Open** link to the thread in the stills viewer, in a new tab (`/stills#thread=<id>`); or
**Not posted: \<reason\>** with **Retry**, which sends the same remark again, snapshot
included, so a server that was down loses nothing.

The conversation stays on the page. **Remarks** opens a panel beside the page, a sheet at the
bottom on a phone, with the threads made on the page on screen, the open ones first: number,
author, body, time and replies, with **Reply**, **Resolve** / **Reopen** (not for a guest)
and **Open**. It follows the review log, so the agent's reply shows without a reload, and it
swaps with the page as the reviewer navigates. Each open thread has a numbered pin on its
first marked element, which follows the element as the page scrolls and changes and is gone
while the element is; a tap on a pin opens its thread, and a thread picked in the panel has
its elements outlined and scrolled into view. Pins and outlines are drawn over the page,
never put in it.

The agent gets the marked PNG as for any remark, plus what was marked: `preview review show`
prints the page, the viewport and scroll, the `state` of the shot (see the
[review contract](docs/review-contract.md#live-marks)) and each element's selector, text and
a cut of its HTML, and the `watch` line says `3 elements`.

**Working.** `preview review working <thread> --note "<what>"` (or `<still> [--variant K]`
for work on a still with no remark) tells the reviewer the agent is on it: the viewer shows
"working…" dots and the note on that conversation and its card, and pulses its mark (for a
still with no remark, the dots sit on the still's top bar). The agent's `reply` on the thread
ends it (a reviewer's does not), as does `preview review idle [thread]`; it expires 10 minutes
after the last `working`, so an agent that died does not look busy.

The `/mockup` skill shoots them with `mockup.sh shot <path> <name> [--viewport V]... [--tag
T]... [--full-page] [--title T]`: the runtime's [`mockup/capture.mjs`](mockup/capture.mjs)
runs Chromium in the mockup's own container and sets the device through the DevTools
protocol (size, pixel ratio, touch, a mobile user agent, the colour scheme), as Chrome's device
toolbar does, so `--viewport mobile` is a 1170×2532 PNG of a touch phone. Each `--viewport` is
one shot and one variant. It waits for the page to settle: `load`, the fonts, 500 ms without a
fetch or XHR in flight (never an open WebSocket or EventSource), and a still page, no DOM
mutation and no running finite animation or transition for 300 ms, which a mock API living in
the page needs since it makes no request. It shoots anyway after `MOCKUP_SHOT_WAIT_MS`
(default 5000). A full page is as tall as the document, or as the viewport plus what its
tallest inner scroller hides, so an app shell whose document is the viewport's height lays out
whole: the viewport is resized to that height (at most 6000 CSS px) before the shot. With a
dialog open (`[role=dialog]`, `[role=alertdialog]`, `[aria-modal=true]`, `dialog[open]`) the
viewport is shot as is and the still is recorded as not full page.

More than a couple of stills, or any that needs a click first, go in a **shots recipe**,
`.mockup/shots.mjs`, shot with `preview stills shoot [<shots.mjs>] [--only REGEX]
[--parallel N] [--strict] [--report FILE]`:

```js
export default {
  defaults: { viewports: ["desktop", "mobile"], tags: [], fullPage: true },
  ignore: [/Google Maps/],
  shots: [
    { name: "03-users", title: "Settings › Users", path: "/app?as=owner&p=/profileBuyer?tab=users" },
    { name: "05-invite-user", title: "Invite user", path: "/app?as=owner&p=/profileBuyer?tab=users",
      viewports: ["desktop"],
      steps: async (page) => {
        await page.click("Invite user");
        await page.type("[role=dialog] input[type=email]", "luis@example.com");
        await page.waitFor("[role=dialog] button", { text: "Send invitation" });
      } },
  ],
};
```

Each shot is taken once per viewport and tag set (`tags: [["dark"], ["light"]]` is two), in
one Chromium in the mockup's container, `--parallel` tabs at a time (default 4), each in a
browser context of its own so cookies and storage never leak between shots. `steps(page, {
viewport, tags })` run in Node and drive the page through the DevTools protocol with real
input, touch on a touch viewport, after scrolling the target into view; a step that navigates
does not end them. A target is a CSS selector, else the text (or label) of an element:

| Step | Does |
| ---- | ---- |
| `click(target, { within })`, `hover(…)` | a click (a tap on touch) or a hover on the target, inside the element `within` names |
| `type(selector, text)`, `press(key)` | focuses the field and inserts the text; one key (`Enter`, `Escape`, `a`) |
| `waitFor(target, { text, gone, timeout })` | until the target is there (holding `text`), or `gone` |
| `evaluate(fnOrString)` | runs in the page; a string sees `$$(selector)` and `byText(text)` |
| `sleep(ms)` | a last resort |

`click`, `hover`, `type` and `press` return once the page has settled again, each capped at
`MOCKUP_SHOT_WAIT_MS`; a target not found fails the shot, naming it. A page that is still for
300 ms counts as settled, so after an action whose answer comes later without touching the
page meanwhile (an in-page mock on a timer), `waitFor` what it brings. A failing shot fails
alone and the batch goes on. It prints one JSON line per shot and variant (ok or failed and
why, time taken, uncaught page exceptions and console errors minus `ignore`, the PNG under
`.mockup/shots/` and what was added, `rev 3` or `unchanged`), then a summary, and exits 1 when
a shot failed. A shot whose steps failed is never added; one with page exceptions is added and
flagged, or failed with `--strict`. `preview stills export` copies `shots.mjs` beside the
stills, so the recipe is kept with them.

`watch` is the backchannel: run it under a monitor and every remark, reply,
resolve, reopen and reviewed mark a human makes arrives as one line within a
fraction of a second. It is a stable stream, the seam other tools plug into:

```
#13 thread 3f9a0c1e 05-invite-user [mobile+dark] r1 box 0.12,0.40 0.50x0.08 Ana (guest): "The button overflows"
#14 reply 3f9a0c1e Ana (guest): "Still wraps at 320px"
#15 resolve 3f9a0c1e dante (tailnet)
#16 viewed 05-invite-user [mobile+dark] r2 dante (tailnet)
```

Each line starts with the event's `seq`; pass the last one to `--since` to resume
without missing or repeating anything (without it, `watch` starts at the end of the
log). The variant is in brackets after the still; the author's name is followed by how they
came, `(tailnet)`, `(guest)` on a share link or `(cli)`, when the event says. Anchors are
normalized to the still: `pin x,y`, `box x,y wxh`, or `whole`.
Bodies are JSON strings, so a newline never splits a line. `--json` prints each
event as its JSON line from the log instead. Agent events are left out, so the
agent never wakes on its own replies. `watch` exits non-zero when `.mockup/` is
removed, and it outlives `preview stop`. Replies, `working` and `idle` are written as
`{kind: "agent", name: $REVIEW_AUTHOR, via: "cli"}` (default name `agent`). The store and its events
are specified in [`docs/review-contract.md`](docs/review-contract.md).

#### Any folder of images

Any folder of images can be reviewed the same way, git or not, with no `.preview/` and no
mockup: **images are the only requirement**. A folder of PNGs, end to end:

1. Serve it: `preview stills serve docs/mockups/invite` prints the URL to review it at
   (`<url>stills`) and the command the agent listens with. The folder is a preview of its own,
   with its own Tailscale URL, a hub card "invite stills" with **Review**, and the auto-stop
   watchdog; the same folder always gets the same URL.
2. The agent listens: `preview review watch --dir docs/mockups/invite` under a monitor prints
   each remark the moment it is made, the same lines as for a mockup (above).
3. The reviewer opens the URL (or the card's **Review**), marks an area of a still and writes
   a remark.
4. The agent answers: `preview review reply <thread> "<what changed>" --dir docs/mockups/invite`.
   To fix the still it rewrites the image in place, under the same file name: the viewer shows
   it as the next revision, with before/after, without a reload.

```sh
preview stills serve docs/mockups/invite    # default: the working directory
preview stills status docs/mockups/invite   # or stop | share | unshare
preview stills ls --dir docs/mockups/invite      # stills ls and every review command take --dir
preview review watch --dir docs/mockups/invite   # served or not: --dir reads the folder itself
```

Everything else in the folder is optional and only adds to the viewer; a missing extra falls
back silently and a broken one shows as a note line, never an error:

| The folder may also have | It adds |
| ------------------------ | ------- |
| `stills.json`, `[{name, title, group?, file?}]` | Titles, order and groups. |
| `README.md` (or `index.md`) | The order of the images it references, groups from the heading above each, titles from their table row or alt text, and the document itself as the viewer's **About** page. |
| subfolders of images | A group per subfolder, when neither file above gives groups; `admin/01-list.png` is the still `admin.01-list`. |
| `name@<variant>.png` | A variant of the still `name`: `onboarding@mobile+dark.png`, `onboarding@desktop.png`. `<variant>` is a variant key (above), `web` or `WxH[@dpr]`; a plain `name.png` is the `desktop` variant. |
| `stills/manifest.json` | The full format of a mockup's stills, read as declared. |

Images are `png`, `jpg`, `jpeg`, `webp` or `gif`, ordered by name naturally (`2` before `10`)
and titled from it (`05-invite-user` is "05 invite user"); hidden entries are skipped.

**`.review/`** holds the folder's review: the event log of remarks and replies, the marked
stills, and every revision of every image (`revs.json` and `revs/`), so a remark on rev 1
still shows the pixels it was made on once the image is rewritten. Serving a writable folder
creates it at start; on a folder never served it appears on the first write, and reading never
creates it. Commit it to keep the remarks and revisions with the folder, or add it to
`.gitignore` to keep them on this machine.

**Read-only folders.** A folder the host user cannot write (or whose `.review/` they cannot) is
served read-only: the stills, the README and the existing remarks show, under "read-only
folder: remarks off", and every write is refused, the viewer's and `--dir`'s alike.

**Keeping a mockup's stills.** `preview stills export <dir> [--readme]` copies a mockup's stills
into a folder that reads back as the same stills, revisions and remarks: each variant as
`name@<variant>.png` (`name.png` for a still whose one variant is `desktop`), `stills.json`
with the titles and order, and with `--readme` a README table of titles and images. Run it
before `/mockup stop`, which deletes `.mockup/`, then commit the folder. A folder that holds a
review already is refused: export into a new one, or rewrite its images in place. The
[review contract](docs/review-contract.md#folder-sources) has the details.

## Configuration

All configuration comes from the environment. The **hub server** (the container,
whether started by `preview hub up` or docker compose) reads:

| Variable           | Default                       | Purpose                         |
| ------------------ | ----------------------------- | ------------------------------- |
| `HUB_PORT`         | `8788`                        | Host and container HTTP port    |
| `POLL_INTERVAL_MS` | `10000`                       | How often the PWA polls the API |
| `DOCKER_HOST`      | `unix:///var/run/docker.sock` | Docker endpoint to query        |

The **`preview hub` CLI** reads (all optional):

| Variable              | Default                                | Purpose                                     |
| --------------------- | -------------------------------------- | ------------------------------------------- |
| `PREVIEW_HUB_IMAGE`   | `ghcr.io/dantebarba/preview-hub:latest`| Image `preview hub up` runs                 |
| `PREVIEW_HUB_PORT`    | `8788`                                 | Published host port for the hub container   |
| `PREVIEW_HUB_TS_PORT` | `8443`                                 | Tailnet HTTPS port for `preview hub expose` |
| `PREVIEW_HUB_NAME`    | `preview-hub`                          | Hub container name                          |

The **per-project launcher** (`preview start` …) is configured by each project's
`.preview/config.sh`, plus `PREVIEW_ID`, `PREVIEW_DIR`, and `TIMEOUT_SECONDS`; see
[`docs/participate.md`](docs/participate.md). `preview share` reads the `PREVIEW_SHARE_*`
variables of [Sharing a preview on the internet](#sharing-a-preview-on-the-internet).

## Before publishing: scan for secrets and identity

This is a public repo. Nothing personal, secret, or machine-specific belongs in
a committed file — no tokens or credentials, no real names, emails, or home
paths, and no tailnet hostnames or machine-specific URLs. Run the bundled gate
before pushing anything public:

```sh
SCAN_NAME="Ada Lovelace" SCAN_EMAIL="ada@example.com" scripts/scan-secrets.sh
```

Pass your own name and email so the scan also catches identity creep. It fails on
tailnet domains, home paths, private keys, node ids, and common credential token
prefixes. It is a gate, not a guarantee — always review your diff as well.

## License

MIT — see [`LICENSE`](LICENSE).
