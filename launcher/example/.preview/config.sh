# .preview/config.sh — example preview configuration (SYNTHETIC REFERENCE)
#
# Copy this file to <your-project>/.preview/config.sh and edit the values for your
# app. The preview engine sources it before it brings anything up, so every line
# here runs in the engine's bash shell. Keep it to plain variable assignments.
#
# The engine reads these:
#   PREVIEW_PROJECT                 (required) human project name; the hub's grouping key.
#   PREVIEW_DESC                    (optional) short description shown in the hub. Use the
#                                   ${PREVIEW_DESC:-...} form so a caller can override it per
#                                   run — e.g. `PREVIEW_DESC="what to test" preview start` —
#                                   to say what a specific preview is for.
#   PREVIEW_COMPOSE_FILE            (optional) compose file to use; default docker-compose.yml.
#   PREVIEW_COMPOSE_PROJECT_PREFIX  (optional) docker compose project prefix; default a slug
#                                   of PREVIEW_PROJECT. The engine appends the branch/worktree.
#   PREVIEW_LABEL_SERVICE           (required) which compose service carries the preview.*
#                                   labels; MUST be a service that on_up actually brings up.
#   PREVIEW_SERVE_TARGET            (required) local host:port that Tailscale proxies to. May
#                                   reference the engine-provided port block (PREVIEW_PORT_0..3).

PREVIEW_PROJECT="Acme Widgets"

PREVIEW_DESC="${PREVIEW_DESC:-Acme Widgets storefront — preview build}"

PREVIEW_COMPOSE_FILE="docker-compose.yml"

PREVIEW_COMPOSE_PROJECT_PREFIX="acme"

PREVIEW_LABEL_SERVICE="web"

PREVIEW_SERVE_TARGET="127.0.0.1:$PREVIEW_PORT_1"
