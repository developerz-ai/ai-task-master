# 03 — PR composition robustness

> Part of [`overview.md`](overview.md). Depends on: none.
> Fixes the observed run-101 failure: group `blocked (orchestrator PR composition failed schema validation: title >72 chars)` after 10.1M tokens. Review-before-PR ordering is already correct (`maybeSelfReview` runs inside `openPr` bridge before `orchestrator.openPr`, `work-loop.ts:658-666`) — do not reorder it.

## Files to change
- `packages/aitm/src/orchestrator/orchestrator.ts:322-398` — `composePr`: in-conversation schema retry + deterministic fallback.
- `packages/aitm/src/orchestrator/orchestrator.test.ts` — paired tests.
- `packages/aitm/src/loop/work-loop.ts:428-458` — composition failure path must not reach the group-`blocked` catch.

## Steps
1. **Schema retry**: mirror compat `runWithSchemaRetry` (used by planner `planner.ts:95` and worker manifest, `MANIFEST_SCHEMA_RETRIES=2`): on `PrCompositionSchema` (`orchestrator.ts:191-195`) or `assertPrBodySections` (`:168-187`) failure, feed the violation back as a user message ("title was N chars, max 72 — resubmit") and retry up to 2 times within the same conversation. Keep `toolChoice: 'auto'` (thinking-model constraint, `:358-365`).
2. **Deterministic fallback**: if retries exhaust (or the model never calls `submit`), synthesize instead of throwing:
   - title: `feat: <group.title>` hard-sliced to 72 chars (word boundary when possible);
   - body: `## Summary` from group title+tasks, `## Changes` from `git log --oneline base..head` (available via `GitHubClient`/deps), `## Testing` from the verify/self-review outcome string. Must pass `assertPrBodySections` by construction.
3. **Never block on composition**: `composePr` becomes total (always returns a composition). Log a warning line (`PR composition fell back to generated title/body`) via the progress sink so the run surfaces the degradation. Delete/adjust the throw sites at `:386-395`.
4. **Log the composition**: one progress line with the final title on PR open (users currently can't see what title was attempted).

## Tests
- Unit (`orchestrator.test.ts`, MockLanguageModel): over-long title → retry message sent → second attempt accepted; retries exhausted → fallback used, sections valid, title ≤72; model never calls submit → fallback; happy path unchanged.
- Unit (`work-loop.test.ts`): openPr no longer produces `blocked` for composition-shaped errors (only for genuine push/gh failures).
- Gates: `bun test`, `bun run test:node`, `bun run typecheck`, `bun run lint`.

## Done when
- Run-101's failure input (72+ char title) yields an opened PR (retried or fallback), never a blocked group; degradation is visible in the console.
