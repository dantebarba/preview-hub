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
#   mockup.sh shot <path> <name> [--viewport V]... [--tag T]... [--full-page] [--title T]
#                                         still of the live page as a device, shot by the
#                                         runtime's capture.mjs in the mockup's own container and
#                                         added with `preview stills add` as the next revision of
#                                         that variant of <name>. V is mobile (default), mobile-s,
#                                         tablet, desktop/web or WxH[@dpr][+touch]; each
#                                         --viewport is one shot. T is a free tag added to every
#                                         shot's variant; dark and light set the colour scheme
#                                         and go in separate calls. --full-page shoots the
#                                         whole page, an app shell's inner scroller included,
#                                         or the viewport while a dialog is open. An image
#                                         equal to the variant's latest adds no revision
#                                         ("unchanged"). Many stills, or any that need a click
#                                         first: `preview stills shoot`. The old positional form
#                                         `shot <path> <name> [WxH] [title]` still works.
set -euo pipefail

skill="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
root="$PWD"
scratch="$root/.mockup"
shot_usage="shot <path> <name> [--viewport V]... [--tag T]... [--full-page] [--title T]"
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

## The id of the running mockup container: the one publishing 127.0.0.1:$1 on its port 80.
mockup_container() {
  docker ps --format '{{.ID}} {{.Ports}}' | awk -v p="127.0.0.1:$1->80/tcp" 'index($0, p) { print $1; exit }'
}

## Escape a string for the replacement side of a sed s|||.
sed_escape() { printf '%s' "$1" | sed 's/[&|\\]/\\&/g'; }

case "${1:-status}" in
  init)
    mkdir -p "$scratch/pages" "$scratch/shots" "$scratch/stills" "$scratch/review" "$scratch/.preview"
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
    usage="usage: mockup.sh $shot_usage"
    [ "$#" -ge 3 ] || { echo "$usage" >&2; exit 2; }
    page="$2" name="$3" title="" full=() tags=() viewports=() positional=()
    shift 3
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --viewport) [ "$#" -ge 2 ] || { echo "$usage" >&2; exit 2; }; viewports+=("$2"); shift 2 ;;
        --viewport=*) viewports+=("${1#*=}"); shift ;;
        --tag) [ "$#" -ge 2 ] || { echo "$usage" >&2; exit 2; }; tags+=(--tag "$2"); shift 2 ;;
        --tag=*) tags+=(--tag "${1#*=}"); shift ;;
        --full-page) full=(--full-page); shift ;;
        --title) [ "$#" -ge 2 ] || { echo "$usage" >&2; exit 2; }; title="$2"; shift 2 ;;
        --title=*) title="${1#*=}"; shift ;;
        --) shift; positional+=("$@"); break ;;
        -*) echo "$usage" >&2; exit 2 ;;
        *) positional+=("$1"); shift ;;
      esac
    done
    if [ "${#positional[@]}" -gt 0 ] && [[ "${positional[0]}" =~ ^[1-9][0-9]{0,4}x[1-9][0-9]{0,4}$ ]]; then
      viewports+=("${positional[0]}")
      positional=("${positional[@]:1}")
    fi
    [ "${#positional[@]}" -le 1 ] || { echo "$usage" >&2; exit 2; }
    [ "${#positional[@]}" -eq 0 ] || [ -n "$title" ] || title="${positional[0]}"
    [ "${#viewports[@]}" -gt 0 ] || viewports=(mobile)
    [[ "$page" == /* ]] || { echo "path must start with / (e.g. /checkout?v=b)" >&2; exit 2; }
    [[ "$name" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$ ]] \
      || { echo "name: a letter or digit, then letters, digits, '.', '_' or '-' (100 at most)" >&2; exit 2; }
    [ -z "$title" ] || [[ "$title" =~ [^[:space:]] ]] || { echo "title must not be blank" >&2; exit 2; }
    [ -f "$(state_dir)/base" ] || { echo "not running; mockup.sh start first" >&2; exit 1; }
    port=$(( $(cat "$(state_dir)/base") + 1 ))
    cid="$(mockup_container "$port")"
    [ -n "$cid" ] || { echo "no mockup container on port $port; mockup.sh start first" >&2; exit 1; }
    docker exec "$cid" test -f /srv/capture.mjs || {
      echo "this mockup runtime cannot shoot devices; run 'preview self-update', then mockup.sh stop and start" >&2
      exit 1
    }
    mkdir -p "$scratch/shots"
    i=0
    for v in "${viewports[@]}"; do
      i=$((i + 1))
      file="$name.$i.png"
      rm -f "$scratch/shots/$file"
      shot="$(docker exec --user "$(id -u):$(id -g)" -e HOME=/tmp -e "MOCKUP_SHOT_WAIT_MS=${MOCKUP_SHOT_WAIT_MS:-5000}" \
        "$cid" node /srv/capture.mjs "http://127.0.0.1:80$page" "/app/.mockup/shots/$file" \
        --viewport "$v" ${tags[@]+"${tags[@]}"} ${full[@]+"${full[@]}"})" \
        || { echo "capture of $page at $v failed" >&2; exit 1; }
      [ -s "$scratch/shots/$file" ] || { echo "no image written for $page at $v" >&2; exit 1; }
      whole=(${full[@]+"${full[@]}"})
      case "$shot" in *" viewport") whole=(); echo "$name at $v: a dialog is open, shot the viewport" >&2 ;; esac
      add=(stills add "$scratch/shots/$file" --name "$name" --source "$page" --viewport "$v")
      add+=(${tags[@]+"${tags[@]}"} ${whole[@]+"${whole[@]}"})
      [ -z "$title" ] || add+=("--title=$title")
      ( cd "$scratch" && preview "${add[@]}" )
    done
    ;;
  *) echo "usage: mockup.sh init|start [desc]|status|stop|$shot_usage" >&2; exit 2 ;;
esac
