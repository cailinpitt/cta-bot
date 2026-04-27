#!/bin/bash
# Install/update the cta-bot logrotate config under /etc/logrotate.d/.
# Run on the server: sudo scripts/install-logrotate.sh
set -euo pipefail

SRC="$(cd "$(dirname "$0")/.." && pwd)/cron/logrotate.conf"
DEST="/etc/logrotate.d/cta-bot"

if [ ! -f "$SRC" ]; then
  echo "Source config missing: $SRC" >&2
  exit 1
fi

if [ "$(id -u)" -ne 0 ]; then
  echo "Must run as root (use sudo)." >&2
  exit 1
fi

install -m 0644 "$SRC" "$DEST"
echo "Installed $DEST"

# Validate by running logrotate in debug mode — will print what *would* happen
# without rotating anything. Surfaces parse errors immediately.
logrotate -d "$DEST"
echo "OK — logrotate parsed the config cleanly."
echo "System cron will pick it up on the next daily run (usually overnight)."
