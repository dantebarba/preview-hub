#!/usr/bin/env bash
#
# install.sh — put the preview engine on your PATH.
#
# Symlinks the sibling `preview` script into ~/.local/bin/preview (created if missing),
# marks it executable, and is safe to re-run: an existing link is replaced in place. No sudo,
# nothing written outside your home. Warns if ~/.local/bin is not on PATH so the fix is obvious.
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/preview"
BIN_DIR="$HOME/.local/bin"
DEST="$BIN_DIR/preview"

[ -f "$SRC" ] || { printf 'error: %s not found next to this installer\n' "$SRC" >&2; exit 1; }

chmod +x "$SRC"
mkdir -p "$BIN_DIR"
ln -sfn "$SRC" "$DEST"
printf 'linked %s -> %s\n' "$DEST" "$SRC"

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) printf 'warning: %s is not on your PATH; add it, e.g.: export PATH="%s:$PATH"\n' "$BIN_DIR" "$BIN_DIR" >&2 ;;
esac
