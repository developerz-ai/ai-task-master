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

gh repo clone "$SANDBOX_REPO" "$TMPDIR/repo"
cd "$TMPDIR/repo"

# Requires a CLAUDE.md or AGENTS.md in the sandbox repo.
# Fail fast rather than mutating the default branch — avoids branch-protection
# failures and prevents permanent state changes on a shared sandbox.
if [[ ! -f CLAUDE.md && ! -f AGENTS.md ]]; then
  echo "Missing CLAUDE.md or AGENTS.md on default branch of ${SANDBOX_REPO}. Add one, then rerun smoke.sh." >&2
  exit 1
fi

OPENROUTER_API_KEY="$OPENROUTER_API_KEY" \
  node "$OLDPWD/dist/cli/cli.js" start \
    "Add a single-line comment to README.md saying 'smoke test'" \
    --max-prs 1 \
    --no-automerge \
    --concurrency 1

echo ""
echo "smoke.sh: all checks passed"
