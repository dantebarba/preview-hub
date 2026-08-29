#!/usr/bin/env sh
#
# Remote installer for the `preview` launcher (part of preview-hub).
#
# Downloads the standalone `preview` CLI from a GitHub release into your PATH:
#
#   curl -fsSL https://github.com/dantebarba/preview-hub/releases/latest/download/install.sh | sh
#
# Environment:
#   PREVIEW_BIN_DIR   directory to install into (default: $HOME/.local/bin)
#   PREVIEW_VERSION   release tag to install (default: latest)
set -eu

REPO="dantebarba/preview-hub"
BIN_DIR="${PREVIEW_BIN_DIR:-$HOME/.local/bin}"
VERSION="${PREVIEW_VERSION:-latest}"

if [ "$VERSION" = "latest" ]; then
  ASSET_URL="https://github.com/$REPO/releases/latest/download/preview"
else
  ASSET_URL="https://github.com/$REPO/releases/download/$VERSION/preview"
fi

command -v curl >/dev/null 2>&1 || { echo "install: curl is required" >&2; exit 1; }

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT INT TERM

echo "install: downloading preview ($VERSION)..."
curl -fSL --proto '=https' --tlsv1.2 "$ASSET_URL" -o "$tmp"

head -n1 "$tmp" | grep -q '^#!.*bash' || {
  echo "install: downloaded file is not the preview launcher (aborting)" >&2
  exit 1
}

mkdir -p "$BIN_DIR"
chmod +x "$tmp"
mv "$tmp" "$BIN_DIR/preview"
trap - EXIT INT TERM

echo "install: installed -> $BIN_DIR/preview"
case ":$PATH:" in
  *":$BIN_DIR:"*) echo "install: run 'preview --help' to get started." ;;
  *) echo "install: NOTE — add $BIN_DIR to your PATH, then run 'preview --help'." >&2 ;;
esac
