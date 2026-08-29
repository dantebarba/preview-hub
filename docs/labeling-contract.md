# The Labeling Contract

This is the authoritative specification of the `preview.*` Docker labels. It is the
single source of truth that connects a project's preview stack to the hub. The hub
discovers previews **only** by reading these labels off running containers — there is
no registry, no config file the hub reads, and no network handshake. If the labels are
present and well-formed, the preview shows up; if they are absent, it does not.

## The labels

A project stamps these labels on **at least one** container in its preview compose
project. All values are strings.

| Label              | Required | Default              | Meaning |
| ------------------ | -------- | -------------------- | ------- |
| `preview.url`      | **yes**  | —                    | Reachable Tailscale HTTPS URL for the preview. **The hub filters on the presence of this label** — a container without it is invisible to the hub. |
| `preview.project`  | **yes**  | —                    | Project name. This is the hub's grouping key: all previews sharing a `preview.project` are shown together. |
| `preview.branch`   | **yes**  | —                    | Branch name the preview was built from. |
| `preview.worktree` | no       | `Root Worktree`      | Worktree name. When the preview comes from the root checkout rather than a linked worktree, it defaults to `Root Worktree`. |
| `preview.desc`     | no       | `` (empty string)    | Short human-readable description shown alongside the preview. |

### `preview.url` presence is the filter

The hub enumerates containers and keeps only those carrying a non-empty `preview.url`
label. Everything else about a container is ignored. This is deliberate: it means a
stack can run any number of supporting containers (databases, workers, proxies) and only
the one that is actually user-reachable needs to be labeled. Put the full label set on
that single front-facing container.

## Values are runtime-only — never committed

Every value in the table above is **resolved at runtime** and must never be hard-coded
into a file checked into a repository. The URL, project, branch, and worktree are all
properties of *this particular run on this particular machine*: the branch you happen to
be on, the worktree you launched from, and the Tailscale HTTPS URL that the launcher
allocated for this preview. Committing any of them would leak machine-specific and
network-specific detail and would be wrong the moment someone else, or another branch,
runs a preview.

The mechanism that keeps values out of the repo is environment interpolation. The engine
exports the resolved values as environment variables, and the committed compose file
references them with `${...}` interpolation. Nothing concrete is written down; the values
are filled in when `docker compose` reads the file at launch time.

The engine exposes these variables for the labels:

- `PREVIEW_LABEL_URL`
- `PREVIEW_LABEL_PROJECT`
- `PREVIEW_LABEL_BRANCH`
- `PREVIEW_LABEL_WORKTREE`
- `PREVIEW_LABEL_DESC`

## Labels live on a container even when the app is a host process

A preview does not have to be served *by* the labeled container. It is common for the
actual application to run as a plain host process (a dev server, a compiled binary) that
Tailscale fronts, while the labeled container is just a lightweight placeholder whose only
job is to carry the `preview.*` labels so the hub can discover the preview.

This works because the contract is about **label presence on some container in the compose
project**, not about which process answers HTTP. `preview.url` points at the reachable
Tailscale endpoint regardless of whether that endpoint terminates at the labeled container
or at a host process behind Tailscale. The hub never connects to the labeled container; it
only reads the URL from the label and shows it. So the pattern is: run your app however you
like, expose it through Tailscale, and make sure one container in the stack carries the
labels pointing at that URL.

## Minimal compose snippet

The labels go under the front-facing service. Use `${...}` interpolation so the concrete
values come from the engine's environment at launch, never from the file:

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

In practice the engine generates an *override* compose file carrying exactly these labels
and layers it on top of the project's own compose file, so a project usually does not even
write the snippet above by hand — it only names which service should carry the labels (via
`PREVIEW_LABEL_SERVICE` in `.preview/config.sh`). The snippet is shown here so the shape of
the contract is unambiguous: five string labels, interpolated from the environment, on one
service.

## What the hub does with the labels

For completeness, this is how the labels map onto the hub's API. Each labeled container
becomes one preview entry:

- `preview.project` → the project grouping key.
- `preview.branch` → `branch`.
- `preview.worktree` → `worktree` (or `Root Worktree` when the label is absent).
- `preview.desc` → `desc` (or `""` when absent).
- `preview.url` → `url`.

The hub also reads the standard `com.docker.compose.project` label to deduplicate: a stack
may put the `preview.*` labels on more than one container, but each compose project appears
in the hub at most once.
