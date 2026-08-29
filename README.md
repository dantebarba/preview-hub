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
reach from your phone:

```sh
tailscale serve --bg --set-path=/previews http://127.0.0.1:8788
```

This maps `https://<your-tailnet-host>/previews/` to the hub. The `--set-path`
form adds only the `/previews` route, so it will not disturb an existing mapping
on `/`. The PWA resolves its API and assets relative to the page, so it runs
unchanged under a subpath — just **open the URL with the trailing slash**
(`https://<your-tailnet-host>/previews/`) the first time so relative links
resolve correctly. Add it to the home screen to install; the installed app then
launches at the correct scope on its own.

Prefer a root mount instead? Serve it on its own HTTPS port, which also leaves an
existing `/` mapping untouched:

```sh
tailscale serve --bg --https=8788 http://127.0.0.1:8788
```

That gives `https://<your-tailnet-host>:8788/` at the root.

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
