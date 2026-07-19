# 05 — Editor team fanout ("football team")

> Part of [`overview.md`](overview.md). Depends on: 01 (labels).
> Team invariants already hold — keep them: only the main agent manages subagents (orchestrator role prefix `orchestrator.ts:87-104`; Kimi enforces the same root-only rule), no worktrees, editors share the working tree. This slice makes the fanout bounded, cooperative, and visible.

## Files to change
- `packages/aitm/src/subagents/worker.ts:481-505` — `runEditorFanout`: concurrency pool + file grouping.
- `packages/aitm/src/subagents/worker.ts:507-549` — `runEditor`: shared team brief + progress label.
- `packages/aitm/src/subagents/specialist-registry.ts:115-131` — announce selection.
- `packages/aitm/src/config/schema.ts` — `editorConcurrency` (default 4, min 1); reuse existing `concurrency` naming conventions.
- New: `packages/ai-claude-compat/src/pool.ts` + test — tiny promise pool (inline-first rule: only extract if compat lacks one; check before adding).

## Steps
1. **Bounded pool**: replace unbounded `Promise.all` with a pool of `min(editorConcurrency, files)`; keep the shared `AbortController` semantics (any reject aborts siblings, `worker.ts:481-505`).
2. **File grouping**: group manifest entries by top-level dir (or explicit `group` field if the manifest schema gains one) so one editor owns cohesive files instead of strictly one-per-file; cap ~3 files/editor. Single-file manifests: behavior unchanged.
3. **Team brief**: build once per fanout — task text + manifest table (path → purpose) + rolling context (existing `ROLLING_CONTEXT_MAX=4000`, `worker.ts:215`) — and inject into every editor's system prompt so each teammate sees the whole play, not just its file. Keep per-editor style cap `EDITOR_STYLE_MAX=1500`.
4. **Identity in logs**: label each editor `editor:<basename-or-group>` via the 01 label hook; fanout start prints roster: `worker: fanning out 3 editors — auth/ (2 files), api/ (1 file)…`; each completion prints one outcome line (changed/blocked). Uses `agentStepProgress` per editor.
5. **Specialist announcement**: when `selectSpecialist` picks a `.claude/agents/*.md`, print `using specialist: <name> (score N)` once per group.
6. **Phantom-edit policy unchanged**: keep `editorTouchedPath` git check (`worker.ts:556-574`); with grouping, check all files of the group.

## Tests
- `worker.test.ts`: pool cap honored (mock model, observe max concurrent generates); grouping by dir; abort propagation preserved; single-file path byte-identical prompts vs today (regression guard).
- `pool.test.ts` (if extracted): cap, rejection, abort.
- `specialist-registry.test.ts`: announcement callback.
- Gates: `bun test`, `bun run test:node`, `bun run typecheck`, `bun run lint`.

## Done when
- A 10-file manifest runs ≤4 editors concurrently in ~4 dir-cohesive groups, every editor visible in the console with its own label, roster + outcomes printed; no behavior change for 1-file manifests.
