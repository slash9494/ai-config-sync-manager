#!/bin/bash
# Weekly nudge: if the upstream-compat workflow left an open drift PR, notify the user to review it
# interactively with /compat-review. It deliberately does NOT run an unattended agent — a headless
# `claude -p --dangerously-skip-permissions` over external changelog text is a prompt-injection path
# to the host (CodeRabbit PR #29 critical). Rule edits happen only in an interactive, permission-gated session.
set -u

REPO_DIR="/Users/maxx/dev/projects/ai-config-sync-manager"
REPO_SLUG="slash9494/ai-config-sync-manager"
LOG_DIR="$REPO_DIR/_workspace/compat-review/logs"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/compat_$(date +%Y-%m-%d).log"

# PATH/gh auth live in the login shell (launchd env is minimal).
[ -f "$HOME/.claude/.env" ] && { set -a; . "$HOME/.claude/.env"; set +a; }
cd "$REPO_DIR" || exit 1

PR=$(/bin/zsh -ilc "gh pr list --repo '$REPO_SLUG' --label compatibility --state open --json number --jq 'max_by(.number) | .number // empty'" 2>>"$LOG_FILE")

if [ -z "$PR" ]; then
  echo "$(date -u +%FT%TZ) no open drift PR — no-op" >>"$LOG_FILE"
  exit 0
fi

MSG="Upstream drift PR #$PR open — run /compat-review $PR to review and apply rule updates."
echo "$(date -u +%FT%TZ) $MSG" >>"$LOG_FILE"
osascript -e "display notification \"$MSG\" with title \"ai-config-sync drift\"" 2>>"$LOG_FILE" || true

# Log rotation: keep newest 50 daily logs.
stale=$(ls -1t "$LOG_DIR"/compat_*.log 2>/dev/null | tail -n +51)
[ -n "$stale" ] && echo "$stale" | xargs rm -f --
exit 0
