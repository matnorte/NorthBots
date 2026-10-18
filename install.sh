#!/usr/bin/env bash
# Portable entry point; implementation and shared helpers live in deploy/.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SCRIPT_DIR/deploy/installer.sh"
