#!/usr/bin/env bash
#
# scan-secrets.sh — pre-publish secret and identity gate for the Preview Hub repo.
#
# Walks the working tree (excluding .git, node_modules, and this script itself)
# and reports any value that must never land in a public repo: tailnet domains,
# home paths, PEM private keys, Tailscale-style node ids, and common credential
# token prefixes. A caller may also export SCAN_NAME and/or SCAN_EMAIL to catch
# their own identity leaking into committed files.
#
# Each match is printed as "path:line:content" on stderr. Exit status is 1 when
# anything matches and 0 when the tree is clean. This is a gate, not a guarantee:
# a clean run does not prove the tree is free of every possible secret, so review
# your diff as well.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
self_name="$(basename "${BASH_SOURCE[0]}")"

patterns=(
  '\.ts\.net'
  '/Users/'
  '/home/'
  'BEGIN [A-Z ]*PRIVATE KEY'
  'tail[0-9a-f]{4,}'
  'sk-[A-Za-z0-9_-]{16,}'
  'ghp_[A-Za-z0-9]{20,}'
  'xox[aboprs]-[A-Za-z0-9-]{8,}'
)

if [[ -n "${SCAN_NAME:-}" ]]; then
  patterns+=("$SCAN_NAME")
fi
if [[ -n "${SCAN_EMAIL:-}" ]]; then
  patterns+=("$SCAN_EMAIL")
fi

cd "$repo_root"

hits=0
for pattern in "${patterns[@]}"; do
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    if (( hits == 0 )); then
      printf 'scan-secrets: potential secret or identity leaks found:\n' >&2
    fi
    hits=$((hits + 1))
    printf '  %s\n' "$line" >&2
  done < <(grep -rnIE \
    --exclude-dir=.git \
    --exclude-dir=node_modules \
    --exclude="$self_name" \
    -- "$pattern" . 2>/dev/null || true)
done

if (( hits > 0 )); then
  printf 'scan-secrets: FAIL (%d match(es)) — resolve the above before publishing.\n' "$hits" >&2
  exit 1
fi

printf 'scan-secrets: OK — no matches for the scanned patterns.\n'
exit 0
