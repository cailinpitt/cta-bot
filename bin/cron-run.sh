#!/bin/bash
# Usage: cron-run.sh <log-name> <script> [args...]
# Runs `node <script> <args...>` from the repo root, appending stamped output
# to cron/<log-name>-cron.log. Exists so crontab entries don't each repeat the
# cd/printf/redirect boilerplate.
set -e
cd "$(dirname "$0")/.."
NAME=$1
SCRIPT=$2
shift 2
LOG=cron/$NAME-cron.log
printf "\n\n=== $(date) $NAME ===\n" >> "$LOG"
exec /usr/bin/node "$SCRIPT" "$@" >> "$LOG" 2>&1
