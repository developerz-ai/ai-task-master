# 07 — CLI flag correctness

> Part of [`overview.md`](overview.md). Depends on: none.

## Files to change
- `packages/aitm/src/cli/args.ts:233-236` — `--no-resume` parse (kept or dropped).
- `packages/aitm/src/cli/commands.ts:469,528` — honor `resume: false` in `runMergePr`.
- `packages/aitm/src/cli/cli.ts:46-48` + `args.ts` HELP returns — usage-error exit code.

## Steps
1. **Make `--no-resume` real** (logic #1). Parsed and forwarded (`commands.ts:528`) but never read — `runMergePr` always uses persisted `currentPr` (`commands.ts:469`), so stale state drives the wrong PR to merge. When `resume: false`: skip persisted `currentPr`, force the synthesize-takeover path from the current branch. (Alternative — drop the flag — rejected: the stale-state escape hatch is the point.)
2. **Parse errors exit nonzero** (logic #5). Malformed input (`--max-prs abc`, unknown flag, missing goal) returns HELP → exit 0, masking CI-wrapper typos. Split `help` (explicitly requested, exit 0) from `usage-error` (print help to stderr, exit 2). Respects the `Logger` stdout/stderr split (status → stdout, diagnostics → stderr).

## Tests
- Unit: `args.test.ts` — `--no-resume` sets `resume:false`; malformed inputs yield `usage-error`. `commands.test.ts` — `resume:false` ignores persisted `currentPr` (stub state with stale PR). `cli.test.ts` — exit codes: help 0, usage-error 2.
- `bun test`, `bun run test:node`.

## Done when
- `aitm merge-pr --no-resume` with stale `state.json` targets the current branch's PR, not the persisted one.
- `aitm start --max-prs abc "goal"` exits 2.
