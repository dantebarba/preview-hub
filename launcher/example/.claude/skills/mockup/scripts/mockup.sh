#!/usr/bin/env bash
# /mockup runtime — run from the frontend project root. Everything lives in ./.mockup, a
# self-ignoring scratch dir that is also a `.preview/` project, so the generic `preview`
# engine builds it, serves it from an ephemeral nginx container, exposes it over
# Tailscale, stamps the Preview Hub labels and auto-stops it like any app preview.
#
#   mockup.sh init             create .mockup/ from the templates (idempotent)
#   (the menu at / and the gallery are generated from .mockup/manifest.json)
#   mockup.sh start [desc]     run .mockup/build.sh -> dist/, bring the preview up (idempotent)
#   mockup.sh capture          run .mockup/capture.spec.ts, make GIFs, refresh gallery + menu
#   mockup.sh status
#   mockup.sh stop             preview stop (container + image), then delete .mockup/
#                              (KEEP=1 keeps the dir)
set -euo pipefail

skill="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
root="$PWD"
scratch="$root/.mockup"
export PREVIEW_ID="mockup-$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo detached)"

for tool in docker tailscale preview git python3; do
  command -v "$tool" >/dev/null 2>&1 || { echo "$tool is required" >&2; exit 2; }
done
docker info >/dev/null 2>&1 || { echo "docker daemon is not running" >&2; exit 2; }

project_name() {
  local n=""
  [ -f package.json ] && n="$(python3 -c 'import json;print(json.load(open("package.json")).get("name",""))' 2>/dev/null || true)"
  printf '%s' "${n:-$(basename "$(git rev-parse --show-toplevel 2>/dev/null || echo "$root")")}"
}

state_dir() {
  local slug; slug="$(printf '%s' "$PREVIEW_ID" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9_-]+/-/g; s/^-+//; s/-+$//')"
  printf '%s/preview-hub/%s' "$(git rev-parse --path-format=absolute --git-common-dir)" "$slug"
}

case "${1:-status}" in
  init)
    mkdir -p "$scratch/public/gallery" "$scratch/.preview"
    printf '*\n' > "$scratch/.gitignore"
    for f in build.sh playwright.config.ts helpers.ts docker-compose.yml nginx.conf; do
      [ -f "$scratch/$f" ] || cp "$skill/assets/$f" "$scratch/$f"
    done
    cp "$skill/scripts/site.py" "$scratch/site.py"
    [ -f "$scratch/manifest.json" ] || printf '{ "title": "Mockup", "pages": [], "gallery": [] }\n' > "$scratch/manifest.json"
    [ -f "$scratch/.preview/hooks.sh" ] || cp "$skill/assets/preview/hooks.sh" "$scratch/.preview/hooks.sh"
    [ -f "$scratch/.preview/config.sh" ] || sed "s/__PROJECT__/$(project_name)/" "$skill/assets/preview/config.sh" > "$scratch/.preview/config.sh"
    echo "$scratch ready ($PREVIEW_ID)"
    ;;
  start)
    [ -d "$scratch/.preview" ] || "$0" init >/dev/null
    ( cd "$scratch" && PREVIEW_DESC="${2:-${PREVIEW_DESC:-UI mockup}}" preview start )
    ;;
  capture)
    [ -f "$scratch/capture.spec.ts" ] || { echo "write $scratch/capture.spec.ts first" >&2; exit 2; }
    [ -f "$(state_dir)/base" ] || { echo "not running; mockup.sh start first" >&2; exit 1; }
    port=$(( $(cat "$(state_dir)/base") + 1 ))
    rm -rf "$scratch/public/gallery/frames"
    ( cd "$scratch" && MOCKUP_PORT="$port" "$root/node_modules/.bin/playwright" test --config playwright.config.ts )
    for d in "$scratch"/public/gallery/frames/*/; do
      [ -d "$d" ] && python3 "$scratch/site.py" gif "$d" "$scratch/public/gallery/$(basename "$d")" "${MOCKUP_GIF_INTERVAL_MS:-100}"
    done
    python3 "$scratch/site.py" gallery "$scratch"
    python3 "$scratch/site.py" menu "$scratch"
    echo "images are on the menu at $(cat "$(state_dir)/url")"
    ;;
  status)
    [ -d "$scratch/.preview" ] && ( cd "$scratch" && preview status ) || echo "no .mockup here ($PREVIEW_ID)"
    ;;
  stop)
    [ -d "$scratch/.preview" ] && ( cd "$scratch" && preview stop ) || true
    if [ "${KEEP:-0}" = "1" ]; then echo "stopped; kept $scratch"; else rm -rf "$scratch"; echo "stopped and removed $scratch"; fi
    ;;
  *) echo "usage: mockup.sh init|start [desc]|capture [title]|status|stop" >&2; exit 2 ;;
esac
