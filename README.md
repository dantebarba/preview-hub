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

From the `hub/` directory:

```sh
docker compose up -d
```

The hub listens on `HUB_PORT` (default `8788`) and reads the Docker socket
read-only to discover previews. Copy `.env.example` to `.env` if you want to
override the port or the poll interval; both have safe defaults, so `.env` is
optional.

Verify it locally:

```sh
curl http://127.0.0.1:8788/health      # -> ok
curl http://127.0.0.1:8788/api/previews
```

## Serve it over Tailscale (one time)

Publish the hub on your tailnet so the PWA has a stable, installable URL you can
reach from your phone. Serve it on **its own HTTPS port** so it gets a clean root
origin, independent of anything already mapped on `/`:

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
  | PREVIEW_BIN_DIR="$HOME/bin" PREVIEW_VERSION=v0.1.0 sh
```

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

All configuration comes from the environment (see `.env.example`):

| Variable           | Default                       | Purpose                         |
| ------------------ | ----------------------------- | ------------------------------- |
| `HUB_PORT`         | `8788`                        | Host and container HTTP port    |
| `POLL_INTERVAL_MS` | `10000`                       | How often the PWA polls the API |
| `DOCKER_HOST`      | `unix:///var/run/docker.sock` | Docker endpoint to query        |

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
