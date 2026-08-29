# .preview/hooks.sh — example preview lifecycle hooks (SYNTHETIC REFERENCE)
#
# Copy this file to <your-project>/.preview/hooks.sh and adapt each function to your
# app. Every function is OPTIONAL — delete the ones you do not need and the engine
# falls back to its defaults (no build, `dc up -d`, no healthcheck, no extra teardown).
#
# The engine sources this file into its own bash shell, so these functions can read
# every variable the engine exports, including:
#   PREVIEW_URL, PREVIEW_BRANCH, PREVIEW_WORKTREE, PREVIEW_SLUG, PREVIEW_ID
#   PREVIEW_ROOT, PREVIEW_STATE_DIR, PREVIEW_COMPOSE_PROJECT
#   PREVIEW_BASE / TS_PORT and the port block PREVIEW_PORT_0..PREVIEW_PORT_3
#
# It also exposes three helpers to these hooks:
#   dc ...    docker compose scoped to this preview's project + compose + labels override.
#             on_up MUST use dc so isolation and the preview.* labels are applied.
#   plog ...  log an informational line.
#   pwarn ... log a warning line.

# on_build: build the app before any services come up. Optional.
on_build() {
  plog "Building the ${PREVIEW_LABEL_SERVICE} image for ${PREVIEW_PROJECT}"
  dc build "$PREVIEW_LABEL_SERVICE"
}

# on_up: bring services up. Export any host-port env the compose file consumes,
# then start the stack with dc so isolation and labels apply. A host-side helper
# process is started here and its pid recorded so on_down can stop it. Optional;
# if omitted the engine runs `dc up -d`.
on_up() {
  export WEB_HOST_PORT="$PREVIEW_PORT_1"
  export API_HOST_PORT="$PREVIEW_PORT_2"

  dc up -d

  plog "Starting host-side asset watcher"
  ( while true; do sleep 3600; done ) >"${PREVIEW_STATE_DIR}/asset-watcher.log" 2>&1 &
  echo "$!" >"${PREVIEW_STATE_DIR}/asset-watcher.pid"
}

# on_healthcheck: block until the app is ready to serve. Optional; if omitted the
# engine treats the stack as ready immediately after on_up returns.
on_healthcheck() {
  local url="http://127.0.0.1:${PREVIEW_PORT_2}/health"
  plog "Waiting for ${PREVIEW_PROJECT} to become healthy at ${url}"

  local attempt=1
  while [ "$attempt" -le 30 ]; do
    if curl -fsS "$url" >/dev/null 2>&1; then
      plog "Healthy after ${attempt} attempt(s)"
      return 0
    fi
    attempt=$((attempt + 1))
    sleep 2
  done

  pwarn "${PREVIEW_PROJECT} did not become healthy in time"
  return 1
}

# on_down: extra teardown for anything on_up started outside compose. The engine
# already stops the compose stack; here we stop the host-side process whose pid we
# recorded under PREVIEW_STATE_DIR. Optional; if omitted the engine does no extra work.
on_down() {
  local pidfile="${PREVIEW_STATE_DIR}/asset-watcher.pid"
  if [ -f "$pidfile" ]; then
    local pid
    pid="$(cat "$pidfile")"
    if [ -n "$pid" ] && kill "$pid" 2>/dev/null; then
      plog "Stopped host-side asset watcher (pid ${pid})"
    fi
    rm -f "$pidfile"
  fi
}
