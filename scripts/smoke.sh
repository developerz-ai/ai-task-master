#!/usr/bin/env bash
# smoke.sh — manual sandbox validation for aitm
#
# Prerequisites:
#   1. OPENROUTER_API_KEY set in env
#   2. gh authenticated against a sandbox GitHub account (gh auth status)
#   3. A sandbox repo accessible to that account
#   4. bun run build has been run (dist/cli/cli.js exists)
#
# Usage:
#   SANDBOX_REPO=owner/repo bash scripts/smoke.sh

set -euo pipefail

: "${OPENROUTER_API_KEY:?OPENROUTER_API_KEY must be set}"
: "${SANDBOX_REPO:?SANDBOX_REPO=owner/repo must be set}"

BIN="node dist/cli/cli.js"

echo "==> 1. CLI binary responds to --help"
$BIN --help

echo ""
echo "==> 2. bun test — all unit + integration tests pass"
bun test

echo ""
echo "==> 3. npm run test:node — Node runner parity"
npm run test:node

echo ""
echo "==> 4. aitm start smoke (dry-run: no-automerge, max-prs 1)"
#
# Clone sandbox repo to a temp dir, run aitm start, confirm it either:
#   a) exits 0 and opens a PR, or
#   b) exits 1 with a clear human-readable message (not a stack trace)
#
TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

git clone "git@github.com:${SANDBOX_REPO}.git" "$TMPDIR/repo"
cd "$TMPDIR/repo"

# Requires a CLAUDE.md or AGENTS.md in the sandbox repo.
# If neither exists, create a minimal one for the smoke run:
if [[ ! -f CLAUDE.md && ! -f AGENTS.md ]]; then
  echo "# Smoke test repo" > CLAUDE.md
  git add CLAUDE.md
  git commit -m "chore: add CLAUDE.md for smoke test"
  git push
fi

OPENROUTER_API_KEY="$OPENROUTER_API_KEY" \
  node "$OLDPWD/dist/cli/cli.js" start \
    "Add a single-line comment to README.md saying 'smoke test'" \
    --max-prs 1 \
    --no-automerge \
    --concurrency 1

echo ""
echo "smoke.sh: all checks passed"
