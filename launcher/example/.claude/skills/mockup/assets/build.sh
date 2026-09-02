#!/usr/bin/env bash
# The runtime's only contract: leave a static site (with an index.html) in ./dist.
# How is the project's business — write this file for its toolchain (see SKILL.md §2).
set -euo pipefail
cd "$(dirname "$0")"
echo "no build recipe yet: write .mockup/build.sh for this project's toolchain" >&2
exit 1
