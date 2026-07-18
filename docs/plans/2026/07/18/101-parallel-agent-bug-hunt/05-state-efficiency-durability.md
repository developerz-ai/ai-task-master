# 05 — State efficiency + durability polish

> Part of [`overview.md`](overview.md). Depends on: none.

## Files to change
- `packages/aitm/src/state/state-store.ts:55,58-66` — in-memory cache, drop double validate.
- `packages/aitm/src/loop/run-loop-adapter.ts:545-546` + `packages/aitm/src/plan/plan-graph.ts:10-13,71-108` — validate-once graph.
- `packages/aitm/src/state/pr-context-store.ts:58,82,88` — atomic writes.
- `packages/aitm/src/fs/atomic-write.ts:34,43-53` — post-rename dir-fsync severity.
- `packages/aitm/src/state/transcript-store.ts:153-164` — persistent-failure signal.

## Steps
1. **StateStore cached RMW** (N+1 #3). `update()` re-reads `state.json` from disk + runs `RunStateSchema.parse` twice per call, driven per stage transition / task / batch. Store is the sole writer and serialized via `updateChain`: cache last-written `RunState`, mutate from it under the chain, keep the single post-mutation `parseState`, drop the disk re-read (first `update` after construction still reads).
2. **PlanGraph validate-once** (N+1 #4). `ready`/`isComplete` closures rebuild `new PlanGraph([...liveGroups])` per while-tick, re-running full DFS cycle/dangling validation on immutable topology. Validate once at plan acceptance; per-tick calls read live statuses from one graph (or a rebuild that skips `validate()`).
3. **pr-context atomic writes** (durability #9). `saveCiFailures`/`saveComments` use bare `writeFile`, unlike the rest of `.ai-task-master/`. Route through `fs/atomic-write.ts`.
4. **Post-rename fsync downgrade** (durability #10). `fsyncParentDir` failure after a successful `rename` throws, reporting a durable write as failed. Warn instead of throw for the post-rename dir-fsync only; pre-rename behavior unchanged.
5. **Transcript-failure signal** (durability #8). `FileRecorder.append` swallows all errors by design; after N (e.g. 3) consecutive failures set a persistent flag the resume path can read, so `findResumable` can distinguish "truncated by crash" from "recording died mid-run". Keep the never-throw contract.
6. Optional, owner-gated (see overview risks): memoryIndex per-group caching with write-invalidation (`run-loop-adapter.ts:186-191,938,1061,1126`). Skip if freshness wins.

## Tests
- Unit: `state-store.test.ts` — read-count spy: N updates = 1 initial read; external-corruption test updated to match cached contract. `plan-graph.test.ts` — validate called once (spy) across ticks. `pr-context-store.test.ts` — tmp+rename observable (no partial file on injected crash). `atomic-write.test.ts` — post-rename fsync failure warns, resolves. `transcript-store.test.ts` — 3 consecutive append failures → flag set.
- Integration: `crash-durability.test.ts` still green (contract unchanged where it matters).
- `bun test`, `bun run test:node`.

## Done when
- One disk read + one schema validation per state update after warm-up; crash tests unchanged-green.
- No bare `writeFile` under `.ai-task-master/`.
