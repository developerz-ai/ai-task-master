# 07 — Subagents & Orchestrator

> Part of [`overview.md`](overview.md). Depends on: none. **Carries owner decision: delete or wire the agent-as-tool path.**
> Findings: [`findings/02-subagents-orchestrator.md`](findings/02-subagents-orchestrator.md) (all items not taken by slice 03).

## Files to change
- `packages/aitm/src/subagents/planner.ts:80-99`, `reviewer.ts:133-139`, `worker.ts:289-298`, `planner-scouts.ts:143-155` — copy-pasted init forwarding; planner drops `prepareStep`+`providerOptions`, reviewer drops `providerOptions`.
- `packages/aitm/src/subagents/reviewer.ts:283-292` — `git add -A` sweeps stray edits into thread-fix commits.
- `packages/aitm/src/subagents/worker.ts:653-676,686-694` — verify-fix pass: committed files missing from `delivery.changes`; stale `priorHandle` instead of `planned.handle`.
- `packages/aitm/src/subagents/worker.ts:797-801,1364-1368` — porcelain parsing breaks on renames/quoted paths; use `--porcelain -z`.
- `packages/aitm/src/subagents/worker.ts:1170` etc. — `Date.now()` toolCallId collisions; counter or `randomUUID()`.
- `packages/aitm/src/orchestrator/orchestrator.ts:793-806` — `refineCommitMessage` no fallback → empty `git commit --amend -m` fails the group; fall back to `draftCommitMessage`, strip fences.
- Injection surfaces: `worker.ts:1430-1439→713-721` (verify output as trusted task text), `prompts/slots.ts:66-69` (defuse only own envelope), `orchestrator.ts:816-819,927-929` (uncapped interpolation).
- Decision: `orchestrator/subagent-tools.ts` + `Orchestrator.build` (~400 LOC, zero production callers, already drifted — unmetered/undeadlined). Default recommendation: **delete** the agent-as-tool path; WorkLoop drives roles directly. If kept instead: forward `timeout`/`onUsage`/`formatCommand`/`providerOptions`, clamp `maxPrs`, fix the prompt/tool-surface contradiction.

## Steps
1. Extract one `forwardInit` helper used by all four create sites; or better, per-role init types so unsupported fields are compile errors (`factory.ts:51-93` grab-bag).
2. Reviewer: stage only thread-edited paths (or `discardStrayEdits` between threads).
3. Worker verify-fix: derive `extraChanges` from tree diff; thread `planned.handle` into the fix pass.
4. Porcelain `-z` parsing helper (one place, two callers).
5. `refineCommitMessage` total-function fallback mirroring `composePr`.
6. Injection: route `verifyOutputTail` through a `data` envelope (like `review-comment`); `defuseEnvelopeTags` defangs ALL known envelope/reminder tags; cap orchestrator prompt interpolations at `MANIFEST_FIELD_MAX`.
7. Resolve the orchestrator dead-path decision; if delete — also remove `ORCHESTRATOR_ROLE_PREFIX`, `resolveMaxSteps`, dead `SubagentToolDeps` export, and their tests.
8. Small: `summarizeReviewerResult` includes partial resolution count; explore tool gets `timeout` + usage sink (`makeAgentTool` seam in compat); consider lower `EDITOR_MAX_STEPS` backstop.

## Tests
- Planner/reviewer forwarding (field-drop regression); reviewer stray-edit isolation; verify-fix tree-diff delivery; rename-porcelain parsing; empty/fenced refined commit message; envelope defusing for foreign tags.

## Done when
- No `SubagentInit` field is silently dropped; thread commits contain only thread edits; a bad model response can't fail finalize; repo-derived text can't forge trusted prompt regions; the orchestrator module contains no unwired duplicate path.
