# Parallel-Agent Bug Hunt — remediation

## Goal
Fix confirmed findings from a 5-agent parallel sweep (2026-07-18, HEAD `7f9e8e5`) across five lenses: logic/correctness, resource cleanup (RAII), N+1/repeated work, error-handling/durability, prompt compression + injected-value hygiene.

## Context
- Stack: `packages/aitm` — TS strict, ESM, `ai` `experimental_Agent` + subagents-as-tools; OpenRouter-only via `Credentials`; `gh`/`git` via execa argv. Runs unchanged Bun + Node≥20 + Deno≥1.40.
- Follows [`../../17/101-aitm-audit-remediation/`](../../../17/101-aitm-audit-remediation/overview.md) — partially remediated in PR #215 (its `status.yml` is stale). This hunt audited post-#215 HEAD; no finding here is already fixed. Its slice `08-prompt-templating` overlaps slice `06` here — reconcile, don't duplicate.
- Production forces `concurrency = 1` (`run-loop-adapter.ts:563`). Non-mutexed `openPr`/`autoMergeFlow`/`addressReviews` are latent, not live — revisit before ever enabling concurrency > 1. Not in scope here.
- **Verified clean (do not "fix")**: `atomicWrite` temp+fsync+rename core; `StateStore.update` serialization chain; `waitForChecks` backoff; `ModelLimits`/CLAUDE.md/specialist-roster caching; GraphQL pagination bounds; CI-fix attempt caps; `mcp-client` connect/close error paths; `web-fetch`/`web-search` body draining; system-prompt fencing via `slots.ts` `defuseEnvelopeTags` (except the one seam in `06`).
- Reference patterns cited per slice: `state/state-store.ts` serialized RMW, `fs/atomic-write.ts`, `slots.ts` fencing, `worker.ts` `VERIFY_TAIL_MAX` cap discipline, `github-client.ts` `safeJson`.
- Prompt standards source: `~/workspace/developerz-ai/gold-standards-in-ai/docs/writing-for-agents/compressed-config.md`, `~/workspace/sebyx07/claude-code-bible/docs/11-compressed-config.md` (agent prompt <50 lines, fragments, per-spawn cost), `~/workspace/developerz-ai/claude-task-master` `prompts_base.py` PromptBuilder (`include_if` sections).

## Plan files (execute in order)
1. [`01-pr-lifecycle-idempotency.md`](01-pr-lifecycle-idempotency.md) — crash-safe `gh pr create`; prPerTask+no-automerge duplicate PR; false `success` on awaiting-pr; partial group marked `merged` with a dropped task.
2. [`02-signal-cancellation-cleanup.md`](02-signal-cancellation-cleanup.md) — SIGINT/SIGTERM + AbortController wiring (currently dead code); editor-fanout sibling abort; temp-repo leak.
3. [`03-review-loop-idempotency.md`](03-review-loop-idempotency.md) — reviewer partial-resolution loss; addressed-thread record ordering; duplicate task commit on resume; sessionCount pre-batch inflation.
4. [`04-gh-client-parsing-caching.md`](04-gh-client-parsing-caching.md) — unguarded `JSON.parse` of `gh` stdout ×5; memoize `repoMeta`/`defaultBranch`; `{ cause }` at rethrow boundaries.
5. [`05-state-efficiency-durability.md`](05-state-efficiency-durability.md) — StateStore in-memory cache + drop double-validate; PlanGraph validate-once; pr-context atomic writes; post-rename fsync downgrade; transcript-failure signal.
6. [`06-prompt-compression-fencing.md`](06-prompt-compression-fencing.md) — claudeMd fence/cap in system-reminder; style digest sent twice; editor-leaf frame slimming; contract-prose compression.
7. [`07-cli-flag-correctness.md`](07-cli-flag-correctness.md) — inert `--no-resume`; parse errors exit 0.
8. [`08-tests.md`](08-tests.md) — paired `*.test.ts` + integration coverage per fix; both runtimes green.

## Done when
- Kill -9 at any point in pr-open / review-address / task-commit resumes without a duplicate PR, duplicate reply, duplicate commit, or a permanently-blocked recoverable group.
- Ctrl-C closes MCP children and aborts in-flight subagent/gh work; `{ kind: 'cancelled' }` is reachable from the real binary.
- No `gh repo view` inside a poll tick; no unguarded `JSON.parse` of subprocess stdout.
- A run never exits 0 while planned work was dropped or a PR dangles unmerged under autoMerge.
- Style digest sent once per subagent call; repo `CLAUDE.md` fenced + capped before injection.
- `bun test`, `bun run test:node`, `bun run typecheck`, `bun run lint` all green.

## Risks / open questions
- **Partial-PR policy (01)**: shipping a partial group is partly intentional. Decide: blocked group vs distinct `partial` status vs carry-forward task. Owner call before implementing.
- **prPerTask + no-automerge (01)**: reject flag combo vs one-PR-after-last-task. Owner call.
- **Editor-leaf slimming (06)**: which contract blocks a write-capable leaf keeps is a behavioral trade-off — trim conservatively, measure.
- `05` memoryIndex per-task re-read is intentional freshness — only cache per group with write-invalidation, or skip.
- Slices 01–07 are independent and parallelizable across executors; 08 follows all.
