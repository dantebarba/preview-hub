#!/usr/bin/env bash
# on_build only checks the mockup: the runtime image validates manifest.json and that every
# page file exists. It runs from the compose file alone, without the engine's labels
# override, so the one-off container never shows up on the hub. There is nothing to build:
# the runtime compiles pages on demand and hot-reloads them on save.
# on_down leaves the pinned runtime image in place for the next mockup.

on_build() {
  plog "checking manifest.json and pages..."
  docker compose -p "$PREVIEW_COMPOSE_PROJECT" -f "$PREVIEW_COMPOSE_FILE" \
    run --rm --no-deps -T web node /srv/server.mjs --check
}

on_healthcheck() {
  for _ in $(seq 1 60); do
    curl -fs -o /dev/null "http://127.0.0.1:$PREVIEW_PORT_1/" && return 0
    sleep 0.5
  done
  pwarn "mockup server did not answer on :$PREVIEW_PORT_1; see: docker logs $PREVIEW_COMPOSE_PROJECT-web-1"
  return 1
}

on_down() {
  dc down --volumes --remove-orphans >/dev/null 2>&1 || true
}
