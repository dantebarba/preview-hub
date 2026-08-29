# How a project participates

A project joins the hub in four steps: install the launcher, drop a small `.preview/`
config into the repo, define a couple of hooks, and run `preview start`. Once the stack is
up with the `preview.*` labels (see [labeling-contract.md](./labeling-contract.md)), the
project appears in the hub automatically — there is nothing to register.

## 1. Install the launcher

Run the launcher installer once per machine:

```sh
./preview-hub/launcher/install.sh
```

This puts the `preview` command on your `PATH`. The launcher (the "engine") is what
allocates a deterministic port block, resolves the Tailscale URL, generates the labels
override compose file, and drives your project's hooks.

## 2. Add a `.preview/` directory to your project

Create two files at the root of the project you want to preview. A complete, working copy
of both lives under [`launcher/example/.preview/`](../launcher/example/.preview/) — copy it
and edit the values.

### `.preview/config.sh`

Declares what the launcher needs to know about your stack:

```sh
PREVIEW_PROJECT="Acme Widgets"
PREVIEW_DESC="Widget catalog and checkout"

PREVIEW_COMPOSE_FILE="docker-compose.yml"
PREVIEW_COMPOSE_PROJECT_PREFIX="acme-widgets"

PREVIEW_LABEL_SERVICE="web"

PREVIEW_SERVE_TARGET="127.0.0.1:${PREVIEW_PORT_1}"
```

| Variable                         | Required | Default                     | Meaning |
| -------------------------------- | -------- | --------------------------- | ------- |
| `PREVIEW_PROJECT`                | **yes**  | —                           | Project name; becomes the hub grouping key and `preview.project`. |
| `PREVIEW_DESC`                   | no       | empty                       | Short description; becomes `preview.desc`. |
| `PREVIEW_COMPOSE_FILE`           | no       | `docker-compose.yml`        | The compose file the launcher layers the labels override on top of. |
| `PREVIEW_COMPOSE_PROJECT_PREFIX` | no       | a slug of the project name  | Prefix for the isolated compose project name. |
| `PREVIEW_LABEL_SERVICE`          | **yes**  | —                           | Which compose service carries the `preview.*` labels. It **must** be a service that `on_up` actually brings up. |
| `PREVIEW_SERVE_TARGET`           | **yes**  | —                           | The local `host:port` that Tailscale proxies to. May reference the port-block variables, e.g. `${PREVIEW_PORT_1}`. |

### `.preview/hooks.sh`

Optional shell functions the engine sources into its own shell. Define only the ones you
need; every hook is optional and has a sensible default.

```sh
on_build() {
  docker build -t acme-widgets:preview .
}

on_up() {
  dc up -d
}

on_healthcheck() {
  until curl -fsS "http://${PREVIEW_SERVE_TARGET}/health" >/dev/null 2>&1; do
    sleep 1
  done
}

on_down() {
  :
}
```

| Hook             | Runs                                    | Default if undefined |
| ---------------- | --------------------------------------- | -------------------- |
| `on_build`       | Build the app, before services come up. | no-op |
| `on_up`          | Bring services up. **Must** use the `dc()` helper so isolation and labels apply. | `dc up -d` |
| `on_healthcheck` | Block until the preview is ready.       | no-op |
| `on_down`        | Extra teardown (e.g. stop host processes started in `on_up`). | no-op |

The engine exposes these helpers to your hooks:

- `dc ...` — runs `docker compose` scoped to this preview's isolated project and layered
  with the generated labels override. Always bring services up through `dc` so the
  isolation and the `preview.*` labels are applied.
- `plog ...` / `pwarn ...` — structured log and warning output.

## 3. Run it

From the project root:

```sh
preview start
```

The launcher builds (`on_build`), brings the stack up (`on_up`) through `dc`, waits for
readiness (`on_healthcheck`), exposes `PREVIEW_SERVE_TARGET` over Tailscale, and stamps the
front-facing service with the `preview.*` labels. Within one hub poll interval, **Acme
Widgets** shows up in the hub grouped by project, listing this branch's preview with its
Tailscale URL.

To take a single preview down (running the `on_down` hook and removing its stack):

```sh
preview stop
```

## The port block

Each preview is allocated a **contiguous block of four ports** starting at a deterministic
base. The engine exports them as:

- `PREVIEW_BASE` — the base port for this preview.
- `TS_PORT` — the port Tailscale serves from; equal to `PREVIEW_BASE`.
- `PREVIEW_PORT_0` … `PREVIEW_PORT_3` — the four ports in the block.

The invariant is `PREVIEW_PORT_0 == TS_PORT == PREVIEW_BASE`. Port `0` is the
Tailscale-facing port; `1`–`3` are yours to hand to additional services (an API, a
database admin UI, a websocket endpoint) via `PREVIEW_SERVE_TARGET` and your compose file.
Because the block is contiguous and computed, you never guess or hard-code a port — you
reference `${PREVIEW_PORT_1}` and friends.

## One preview per branch (determinism)

The port block and the compose project name are **derived deterministically from the
branch (and worktree)**. The same branch always maps to the same port block and the same
isolated compose project. Two consequences follow:

- **Idempotent restarts.** Running `preview start` again on a branch that already has a
  preview *replaces* it in place rather than spinning up a second copy. There is at most
  one live preview per branch, so URLs and ports are stable across restarts.
- **No collisions between branches.** Different branches derive different port blocks and
  different compose projects, so previews for several branches (and worktrees) run side by
  side without stepping on each other.

## Tearing everything down (`killall`)

`preview stop` removes the current branch's preview. To stop **every** preview this machine
is running at once — across all projects, branches, and worktrees — use:

```sh
preview killall
```

This tears down all preview compose projects and stops any host processes the previews
started via their `on_down` hooks. Reach for it to reclaim ports and resources, or to get
back to a clean slate when several previews have accumulated.

## Reference adopter

For a real-world example beyond the synthetic one above, look at the `.preview/` directory
of a project that has adopted the launcher — its `config.sh` and `hooks.sh` show the config
and lifecycle hooks wired up against a non-trivial stack (a built frontend, a seeded
database, and a health-gated API).
