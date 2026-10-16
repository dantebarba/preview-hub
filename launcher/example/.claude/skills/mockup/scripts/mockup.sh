#!/usr/bin/env bash
# /mockup driver: run from the frontend project root. Everything lives in ./.mockup, a
# self-ignoring scratch dir that is also a `.preview/` project, so the generic `preview`
# engine runs it as a preview of its own: the /mockup runtime container (a pinned Vite dev
# server with hot reload), a Tailscale URL, the Preview Hub card and the 6h watchdog.
#
#   mockup.sh init                        create .mockup/ from the templates (idempotent)
#   mockup.sh start [desc]                bring the preview up; needed once, then just save
#   mockup.sh status
#   mockup.sh stop                        preview stop, then delete .mockup/ (KEEP=1 keeps it)
#   mockup.sh shot <path> <name> [WxH]    still of the live page into .mockup/shots/<name>.png
#                                         (default 390x844), listed on the menu
set -euo pipefail

skill="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
root="$PWD"
scratch="$root/.mockup"
chrome_image="${MOCKUP_CHROME_IMAGE:-zenika/alpine-chrome:124}"
PREVIEW_ID="mockup-$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo detached)"
export PREVIEW_ID

for tool in docker tailscale preview git; do
  command -v "$tool" >/dev/null 2>&1 || { echo "$tool is required" >&2; exit 2; }
done
docker info >/dev/null 2>&1 || { echo "docker daemon is not running" >&2; exit 2; }

## The frontend's name: package.json "name", else the repo directory's name.
project_name() {
  local n=""
  [ -f package.json ] && n="$(sed -n 's/^[[:space:]]*"name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' package.json | head -n 1)"
  printf '%s' "${n:-$(basename "$(git rev-parse --show-toplevel 2>/dev/null || echo "$root")")}"
}

## The engine's state dir for this mockup's identity, where it records the port block.
state_dir() {
  local slug
  slug="$(printf '%s' "$PREVIEW_ID" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9_-]+/-/g; s/^-+//; s/-+$//')"
  printf '%s/preview-hub/%s' "$(git rev-parse --path-format=absolute --git-common-dir)" "$slug"
}

## Escape a string for the replacement side of a sed s|||.
sed_escape() { printf '%s' "$1" | sed 's/[&|\\]/\\&/g'; }

case "${1:-status}" in
  init)
    mkdir -p "$scratch/pages" "$scratch/shots" "$scratch/.preview"
    printf '*\n' > "$scratch/.gitignore"
    [ -f "$scratch/docker-compose.yml" ] || cp "$skill/assets/docker-compose.yml" "$scratch/docker-compose.yml"
    [ -f "$scratch/manifest.json" ] || printf '{ "title": "Mockup", "pages": [] }\n' > "$scratch/manifest.json"
    [ -f "$scratch/.preview/hooks.sh" ] || cp "$skill/assets/preview/hooks.sh" "$scratch/.preview/hooks.sh"
    [ -f "$scratch/.preview/config.sh" ] \
      || sed "s|__PROJECT__|$(sed_escape "$(project_name)")|" "$skill/assets/preview/config.sh" > "$scratch/.preview/config.sh"
    echo "$scratch ready ($PREVIEW_ID)"
    ;;
  start)
    [ -d "$scratch/.preview" ] || "$0" init >/dev/null
    ( cd "$scratch" && PREVIEW_DESC="${2:-${PREVIEW_DESC:-UI mockup}}" preview start )
    ;;
  status)
    if [ -d "$scratch/.preview" ]; then ( cd "$scratch" && preview status ); else echo "no .mockup here ($PREVIEW_ID)"; fi
    ;;
  stop)
    if [ -d "$scratch/.preview" ]; then ( cd "$scratch" && preview stop ); fi
    if [ "${KEEP:-0}" = "1" ]; then echo "stopped; kept $scratch"; else rm -rf "$scratch"; echo "stopped and removed $scratch"; fi
    ;;
  shot)
    [ "$#" -ge 3 ] || { echo "usage: mockup.sh shot <path> <name> [WxH]" >&2; exit 2; }
    page="$2" name="$3" size="${4:-390x844}"
    [[ "$page" == /* ]] || { echo "path must start with / (e.g. /checkout?v=b)" >&2; exit 2; }
    [[ "$name" =~ ^[A-Za-z0-9._-]+$ ]] || { echo "name may only use letters, digits, '.', '_' and '-'" >&2; exit 2; }
    [[ "$size" =~ ^[0-9]+x[0-9]+$ ]] || { echo "size must look like 390x844" >&2; exit 2; }
    [ -f "$(state_dir)/base" ] || { echo "not running; mockup.sh start first" >&2; exit 1; }
    port=$(( $(cat "$(state_dir)/base") + 1 ))
    mkdir -p "$scratch/shots"
    docker run --rm --network host --user "$(id -u):$(id -g)" -e HOME=/tmp \
      -v "$scratch/shots:/shots" "$chrome_image" \
      --no-sandbox --headless=new --hide-scrollbars --force-device-scale-factor=1 \
      --window-size="${size/x/,}" --virtual-time-budget="${MOCKUP_SHOT_WAIT_MS:-5000}" \
      --screenshot="/shots/$name.png" "http://127.0.0.1:$port$page" >/dev/null 2>&1 \
      || { echo "chrome failed to capture http://127.0.0.1:$port$page" >&2; exit 1; }
    [ -s "$scratch/shots/$name.png" ] || { echo "no image written for $page" >&2; exit 1; }
    echo "$scratch/shots/$name.png ($size); listed on the menu"
    ;;
  *) echo "usage: mockup.sh init|start [desc]|status|stop|shot <path> <name> [WxH]" >&2; exit 2 ;;
esac
