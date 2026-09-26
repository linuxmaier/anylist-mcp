#!/usr/bin/env bash
# Merge bobby060's upstream changes into dated sync branches for review.
#   mise run upstream-sync                # write review report, merge into upstream-sync/<date>, run checks
#   mise run upstream-sync -- --continue  # after resolving + committing a conflict it stopped on
#   mise run upstream-sync -- --push      # after review: push the branches, open PRs in linuxmaier/* forks
# Never pushes to or opens PRs against upstream. See AGENTS.md "Syncing from upstream".
set -euo pipefail

MODE=${1:-prepare}
ROOT=$(git rev-parse --show-toplevel)
JS="$ROOT/anylist-js"

die() { echo "error: $*" >&2; exit 1; }
has_branch() { git -C "$1" rev-parse --verify -q "refs/heads/$BRANCH" >/dev/null; }

if [[ "$MODE" == prepare ]]; then
  BRANCH="upstream-sync/$(date +%F)"
else
  # Resume the most recent sync prepared by an earlier run
  BRANCH=$(git -C "$ROOT" for-each-ref --sort=-refname --count=1 --format='%(refname:short)' refs/heads/upstream-sync/)
  [[ -n "$BRANCH" ]] || BRANCH=$(git -C "$JS" for-each-ref --sort=-refname --count=1 --format='%(refname:short)' refs/heads/upstream-sync/)
  [[ -n "$BRANCH" ]] || die "no upstream-sync/* branch; run without arguments first"
fi
REPORT="$ROOT/.git/upstream-sync-${BRANCH#upstream-sync/}.md"

# Stop on conflicts we don't know how to resolve, leaving the merge in progress.
check_conflicts() {
  local dir=$1 remaining
  remaining=$(git -C "$dir" diff --name-only --diff-filter=U)
  [[ -z "$remaining" ]] && return 0
  echo >&2
  echo "Unresolved conflicts in $dir (merge left in progress on $BRANCH):" >&2
  echo "$remaining" | sed 's/^/  /' >&2
  echo "Review report so far: $REPORT" >&2
  die "resolve them (see AGENTS.md), commit, then: mise run upstream-sync -- --continue"
}

merge_js() {
  git -C "$JS" checkout -q -b "$BRANCH" origin/master
  if ! git -C "$JS" merge -q --no-ff --no-edit upstream/master; then
    if git -C "$JS" diff --name-only --diff-filter=U | grep -qx package-lock.json; then
      git -C "$JS" checkout --ours package-lock.json
      (cd "$JS" && npm install --package-lock-only --no-audit --no-fund >/dev/null)
      git -C "$JS" add package-lock.json
    fi
    check_conflicts "$JS"
    git -C "$JS" commit -q --no-edit
  fi
}

merge_mcp() {
  git -C "$ROOT" checkout -q -b "$BRANCH" origin/main
  (( $(git -C "$ROOT" rev-list --count origin/main..upstream/main) > 0 )) || return 0
  if ! git -C "$ROOT" merge -q --no-ff --no-edit upstream/main; then
    local conflicted
    conflicted=$(git -C "$ROOT" diff --name-only --diff-filter=U)
    # Files this fork deleted on purpose stay deleted
    for f in .github/workflows/release.yml .releaserc.json; do
      if grep -qx "$f" <<<"$conflicted"; then git -C "$ROOT" rm -q "$f"; fi
    done
    # Our lockfile wins; finalize() regenerates it
    if grep -qx package-lock.json <<<"$conflicted"; then
      git -C "$ROOT" checkout --ours package-lock.json
      git -C "$ROOT" add package-lock.json
    fi
    # The pointer is reset to our merged anylist-js in finalize()
    if grep -qx anylist-js <<<"$conflicted"; then git -C "$ROOT" add anylist-js; fi
    check_conflicts "$ROOT"
    git -C "$ROOT" commit -q --no-edit
  fi
}

# Point the submodule at our anylist-js (upstream's pointer names a bobby060 commit), regenerate the lockfile
finalize() {
  local target
  if has_branch "$JS"; then target=$(git -C "$JS" rev-parse "$BRANCH"); else target=$(git -C "$JS" rev-parse origin/master); fi
  git -C "$JS" checkout -q "$target"
  git -C "$ROOT" add anylist-js
  (cd "$ROOT" && npm install --package-lock-only --no-audit --no-fund >/dev/null)
  git -C "$ROOT" add package-lock.json
  if ! git -C "$ROOT" diff --cached --quiet; then
    git -C "$ROOT" commit -q -m "chore: point anylist-js at merged fork commit, regenerate lockfile"
  fi
}

run_checks() {
  local checks=()
  check() {
    local name=$1; shift
    if (cd "$ROOT" && "$@" >/dev/null 2>&1); then checks+=("- ✅ $name"); else checks+=("- ❌ $name"); fi
  }
  check "npm ci" npm ci --no-audit --no-fund
  check "submodule deps in sync" npm run -s check:submodule-deps
  check "unit tests" npm test
  check "stdio smoke test" node scripts/smoke-stdio.mjs
  check "security scanners" mise run security
  { echo; echo "## Checks on the merged branch"; echo; printf '%s\n' "${checks[@]}"; } >> "$REPORT"
  echo
  printf '%s\n' "${checks[@]}"
  echo "Review report: $REPORT"
  echo "After review: mise run upstream-sync -- --push"
}

case "$MODE" in
  prepare)
    for dir in "$ROOT" "$JS"; do
      [[ -z "$(git -C "$dir" status --porcelain --untracked-files=no)" ]] || die "uncommitted changes in $dir"
      has_branch "$dir" && die "branch $BRANCH already exists in $dir"
      git -C "$dir" fetch -q origin
      git -C "$dir" fetch -q upstream
    done
    js_new=$(git -C "$JS" rev-list --count origin/master..upstream/master)
    mcp_new=$(git -C "$ROOT" rev-list --count origin/main..upstream/main)
    echo "anylist-js: $js_new new upstream commit(s); anylist-mcp: $mcp_new"
    (( js_new + mcp_new > 0 )) || { echo "Nothing to sync."; exit 0; }

    # The report only depends on refs, so write it before any merge can stop on a conflict
    echo "# $BRANCH" > "$REPORT"
    if (( js_new > 0 )); then
      { echo; echo "## anylist-js (bobby060/anylist-js)"; echo; } >> "$REPORT"
      node "$ROOT/scripts/upstream-review.mjs" "$JS" origin/master upstream/master >> "$REPORT"
    fi
    if (( mcp_new > 0 )); then
      { echo; echo "## anylist-mcp (bobby060/anylist-mcp)"; echo; } >> "$REPORT"
      node "$ROOT/scripts/upstream-review.mjs" "$ROOT" origin/main upstream/main >> "$REPORT"
    fi
    echo "Review report: $REPORT"

    if (( js_new > 0 )); then merge_js; fi
    merge_mcp
    finalize
    run_checks
    ;;
  --continue)
    for dir in "$JS" "$ROOT"; do
      git -C "$dir" rev-parse -q --verify MERGE_HEAD >/dev/null && die "merge still in progress in $dir; resolve and commit first"
    done
    has_branch "$ROOT" || merge_mcp
    finalize
    run_checks
    ;;
  --push)
    [[ -f "$REPORT" ]] || die "missing report $REPORT"
    if has_branch "$JS"; then
      git -C "$JS" push -q -u origin "$BRANCH"
      (cd "$JS" && gh pr create --repo linuxmaier/anylist-js --base master --head "$BRANCH" \
        --title "Sync $BRANCH" --body-file "$REPORT")
    fi
    git -C "$ROOT" push -q -u origin "$BRANCH"
    (cd "$ROOT" && gh pr create --repo linuxmaier/anylist-mcp --base main --head "$BRANCH" \
      --title "Sync $BRANCH" --body-file "$REPORT")
    ;;
  *)
    die "unknown argument: $MODE (expected --continue or --push)"
    ;;
esac
