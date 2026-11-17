#!/usr/bin/env bash
# PostToolUse hook for Write|Edit: runs Stylelint (the design-token check) on an edited
# .astro/.css file and feeds violations back to Claude (exit 2). Skips quietly when the file
# isn't under src/, or the checkout has no node_modules (e.g. a fresh worktree).
set -u

f=$(jq -r '.tool_response.filePath // .tool_input.file_path // empty')
case "$f" in
  */src/*.astro|*/src/*.css) ;;
  *) exit 0 ;;
esac
[ -f "$f" ] || exit 0

root=$(git -C "$(dirname "$f")" rev-parse --show-toplevel 2>/dev/null) || exit 0
[ -x "$root/node_modules/.bin/stylelint" ] || exit 0

out=$(cd "$root" && node_modules/.bin/stylelint "$f" 2>&1)
status=$?
if [ $status -ne 0 ]; then
  { echo "Stylelint (design language) found problems in $f:"; echo "$out" | head -30; } >&2
  exit 2
fi
exit 0
