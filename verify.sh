#!/usr/bin/env bash
# Quiet verify for conveyor-engine-arena: full logs go to .verify/, stdout gets one line per step.
set -u
cd "$(git rev-parse --show-toplevel)" || exit 2
out=.verify
mkdir -p "$out"
fail=0
step() {
  local name=$1
  shift
  local log="$out/$name.log"
  local t0=$SECONDS
  if "$@" >"$log" 2>&1; then
    echo "PASS $name ($((SECONDS - t0))s)"
  else
    echo "FAIL $name ($((SECONDS - t0))s) -> $log"
    tail -n 25 "$log" | sed 's/^/  | /'
    fail=1
  fi
}
step bake npm run bake:scene
step restore-assets git checkout -- web/assets
step build npm run build
step typecheck npm run typecheck
step test npm test
grep -Eo '(# )?(tests|pass|fail)[ :]+[0-9]+' "$out/test.log" | tail -n 3 | sed 's/^/  /'
step diff-check git diff --check
if git status --porcelain -- 'web/assets/**/*.png' | grep -q .; then
  echo "FAIL png-in-diff"
  fail=1
else
  echo "PASS png-in-diff"
fi
exit $fail
