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

## Quickstart

Install the launcher (see [Install the launcher](#install-the-launcher)), then run
the hub with the CLI. The only runtime dependencies are **docker** (to run the hub
and read the socket) and, to publish it on your tailnet, **tailscale**:

```sh
preview hub up        # pulls ghcr.io/dantebarba/preview-hub and runs it
preview hub expose    # serve it on your tailnet on a dedicated HTTPS port
```

`preview hub up` runs the hub container with the Docker socket mounted **read-only**
so it can discover previews, publishes `HUB_PORT` (default `8788`), and sets
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

Once installed, `preview hub {up,down,status,expose,logs}` runs the hub itself and
`preview {start,stop,status,killall}` drives a project's previews — see
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
- [`launcher/`](launcher/) — the preview engine that brings a stack up with the
  right labels and isolation.
- [`launcher/example/.claude/skills/`](launcher/example/.claude/skills/) — two
  Claude Code skills a project can copy in: `preview`, which decides when to run
  the launcher, and `mockup`, which turns a UI mockup into a preview of its own.

### Mockups as previews

A design question is cheaper to settle on a phone than in prose. The bundled
`/mockup` skill builds a sample page from a project's **real components** into a
static site, serves it from an ephemeral `nginx:alpine` container and hands it
to the launcher under its own identity (`mockup-<branch>`), so it gets a
Tailscale URL, a card on the hub and the 6h watchdog like any other preview. The
card opens on a generated menu that links every variant, state and, when
captured, a gallery of stills and slow-motion GIFs of transitions. `/mockup stop`
removes the container, its image and every file it created. Everything lives in
a self-ignoring `.mockup/` scratch directory; no tracked file is touched, and
nothing about the project's framework is shipped with the skill — the build
recipe is inferred per project. See [`docs/participate.md`](docs/participate.md#mockups-as-previews).

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
[`docs/participate.md`](docs/participate.md).

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
