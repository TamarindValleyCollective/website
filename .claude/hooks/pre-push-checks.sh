#!/usr/bin/env bash
# PreToolUse hook for Bash: runs on `git push`, `gh pr create` and `gh pr merge`.
#  1. git push: blocks (exit 2) if the lines this branch adds contain what looks like real
#     finance data (UPI IDs, long account-style numbers). The repo is public; use invented data.
#  2. all three: if the branch adds a supabase/migrations file, reminds that migrations are
#     not auto-applied to TVC ERP (merging does not apply them).
# Reads the hook JSON on stdin. Needs jq and git.
set -u

cmd=$(jq -r '.tool_input.command // empty')
[ -z "$cmd" ] && exit 0

repo=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
cd "$repo" || exit 0

base=origin/main
git rev-parse --verify -q "$base" >/dev/null || exit 0
range="$base...HEAD"

case "$cmd" in
  *"git push"*|*"gh pr create"*|*"gh pr merge"*) ;;
  *) exit 0 ;;
esac

if [[ "$cmd" == *"git push"* ]]; then
  # Added lines only, skipping this hook's own patterns and lockfiles.
  added=$(git diff "$range" -U0 -- . ':!package-lock.json' ':!.claude/hooks' \
    | grep -E '^\+[^+]' || true)

  vpa='[A-Za-z0-9._-]{3,}@(ok(hdfcbank|sbi|axis|icici)|ybl|ibl|axl|paytm|apl|upi|sbi|icici|hdfcbank|axisbank|kotak|barodampay|pnb|idfcbank|aubank|fbl|federal|rbl|yesbank|airtel|jio|slc|oksbi)\b'
  acct='(^|[^0-9A-Za-z])[0-9]{11,18}([^0-9A-Za-z]|$)'

  hits=$(printf '%s\n' "$added" | grep -E -i "$vpa|$acct" | head -5 || true)
  if [ -n "$hits" ]; then
    {
      echo "Blocked git push: the diff adds lines that look like real finance data (UPI ID or long account-style number)."
      echo "This repo is public. Replace with invented values, rewrite the unpushed commit, then push again."
      echo "Matching added lines (first 5):"
      printf '%s\n' "$hits" | cut -c1-160
    } >&2
    exit 2
  fi
fi

if git diff "$range" --name-only --diff-filter=A 2>/dev/null | grep -q '^supabase/migrations/'; then
  new=$(git diff "$range" --name-only --diff-filter=A | grep '^supabase/migrations/' | sed 's#.*/##' | tr '\n' ' ')
  msg="This branch adds migration(s): ${new}. Migrations are NOT auto-applied to TVC ERP; merging does not apply them (passkeys broke on unapplied 0030). Apply and verify before merging, and say so to the user."
  jq -n --arg m "$msg" '{hookSpecificOutput:{hookEventName:"PreToolUse",additionalContext:$m}}'
fi
exit 0
