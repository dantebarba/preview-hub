#!/usr/bin/env bash
# on_build runs ./build.sh, whose only job is to leave a static site in ./dist.
# on_down takes the container AND its image down; `--rmi all` removes nginx:alpine only
# when no other container still uses it (docker refuses otherwise), so it is safe.

on_build() {
  plog "building sample pages..."
  bash "$PREVIEW_ROOT/build.sh"
  [ -f "$PREVIEW_ROOT/dist/index.html" ] || { pwarn "build.sh left no dist/index.html"; return 1; }
  mkdir -p "$PREVIEW_ROOT/public/gallery"
  python3 "$PREVIEW_ROOT/site.py" menu "$PREVIEW_ROOT"
}

on_healthcheck() {
  local i
  for i in $(seq 1 30); do
    curl -fsS -o /dev/null "http://127.0.0.1:$PREVIEW_PORT_1/" && return 0
    sleep 0.5
  done
  pwarn "mockup server did not answer on :$PREVIEW_PORT_1"; return 1
}

on_down() {
  dc down --rmi all --volumes --remove-orphans >/dev/null 2>&1 || true
}
