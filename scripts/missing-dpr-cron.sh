#!/bin/bash
# Nightly missing-DPR sweep - SOURCE COPY (not loaded by launchd directly).
#
# launchd cannot exec scripts inside ~/Documents/ due to macOS TCC. Copy this
# file to ~/bin/missing-dpr-cron.sh and load the plist from there. The Node
# script (check-missing-dprs.mjs) stays in this repo - bash sets cwd and
# invokes /path/to/node to run it, so the mjs path is fine inside Documents.
#
# Setup:
#   1. cp scripts/missing-dpr-cron.sh ~/bin/
#   2. chmod +x ~/bin/missing-dpr-cron.sh
#   3. Create ~/.missing-dpr-secrets (chmod 600) with:
#        export NEXT_PUBLIC_SUPABASE_URL="https://sksfyygufnnbzrmneccx.supabase.co"
#        export SUPABASE_SERVICE_ROLE_KEY="..."
#        export TELEGRAM_BOT_TOKEN="..."
#        export TELEGRAM_CHAT_ID="8612267135"
#        # optional: export MISSING_DPR_SILENT_IF_CLEAR=1
#   4. cp scripts/com.ahc.missing-dpr.plist ~/Library/LaunchAgents/
#   5. launchctl load ~/Library/LaunchAgents/com.ahc.missing-dpr.plist
#
# Manual run: bash ~/bin/missing-dpr-cron.sh

set -uo pipefail

PM_DIR="/Users/amh_holdings/Documents/AMH Claude/pm-platform"
SCRIPT="$PM_DIR/scripts/check-missing-dprs.mjs"
SECRETS_FILE="$HOME/.missing-dpr-secrets"
LOG_DIR="$HOME/Library/Logs"
LOG_FILE="$LOG_DIR/ahc-missing-dpr.log"
mkdir -p "$LOG_DIR"

export PATH="/Users/amh_holdings/.nvm/versions/node/v24.15.0/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin"
export HOME="${HOME:-/Users/amh_holdings}"

ts() { date "+%Y-%m-%d %H:%M:%S"; }
log() { echo "[$(ts)] $*" >> "$LOG_FILE"; }

if [[ ! -f "$SECRETS_FILE" ]]; then
  log "Missing secrets file: $SECRETS_FILE"
  exit 1
fi
# shellcheck disable=SC1090
source "$SECRETS_FILE"

if [[ ! -f "$SCRIPT" ]]; then
  log "Missing script: $SCRIPT"
  exit 1
fi

cd "$PM_DIR" || { log "Cannot cd to $PM_DIR"; exit 1; }

log "Starting missing-DPR sweep"
if node "$SCRIPT" >> "$LOG_FILE" 2>&1; then
  log "Sweep done OK"
else
  rc=$?
  log "Sweep failed with exit $rc"
  exit $rc
fi
