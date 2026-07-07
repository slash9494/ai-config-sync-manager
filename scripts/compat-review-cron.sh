#!/bin/bash
# Layer-4 semantic review of the CI-opened upstream drift PR, run locally on a subscription
# (no CI API key). launchd fires this ~30min after the upstream-compat workflow opens the PR.
set -u

REPO_DIR="/Users/maxx/dev/projects/ai-config-sync-manager"
REPO_SLUG="slash9494/ai-config-sync-manager"
MARKER="<!--compat-review-bot-->"
LOG_DIR="$REPO_DIR/_workspace/compat-review/logs"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/compat_$(date +%Y-%m-%d).log"

# Keys/PATH that only exist in the login shell (launchd env is minimal).
[ -f "$HOME/.claude/.env" ] && { set -a; . "$HOME/.claude/.env"; set +a; }
cd "$REPO_DIR" || exit 1

# Idempotent gate: pick the newest open compatibility PR that has no bot marker yet.
PR=$(caffeinate -dimsu /bin/zsh -ilc "gh pr list --repo '$REPO_SLUG' --label compatibility --state open --json number,comments --jq '[.[] | select([.comments[].body] | any(contains(\"$MARKER\")) | not)] | max_by(.number) | .number // empty'" 2>>"$LOG_FILE")

if [ -z "$PR" ]; then
  echo "$(date -u +%FT%TZ) no unreviewed drift PR — no-op" >>"$LOG_FILE"
  exit 0
fi

echo "$(date -u +%FT%TZ) reviewing drift PR #$PR" >>"$LOG_FILE"
caffeinate -dimsu /bin/zsh -ilc "claude -p '/compat-review $PR' --dangerously-skip-permissions --allowedTools 'Bash,Read,Edit,Write'" >>"$LOG_FILE" 2>&1

# Log rotation: keep newest 50 daily logs.
stale=$(ls -1t "$LOG_DIR"/compat_*.log 2>/dev/null | tail -n +51)
[ -n "$stale" ] && echo "$stale" | xargs rm -f --
exit 0
