# 02 — Parallel team on a shared checkout + shared state dir

> Part of [`overview.md`](overview.md). Depends on: none for the state-write fixes; the **checkout-serialization decision** gates the git-isolation fixes (see overview Risks).

Worktrees were removed (commit 7572a96) — all subagents share one working tree and one `.ai-task-master/`. `PlanGraph.ready()` can return several groups; editors already fan out via `Promise.all`. Nothing today prevents two Workers from `git checkout -B` + editing the same tree simultaneously, and several state writes are non-atomic read-modify-writes. This slice makes concurrency safe.

## Decision gate (resolve first)
Pick one, confirm with owner:
- **(a) Serialize editing** — one group holds the checkout at a time; planning/review may still parallelize. Simplest given no worktrees. Assumed default.
- **(b) Restore isolation** — per-group scratch checkout. Contradicts the worktree-removal decision; larger change.
Everything below assumes **(a)** for git; the **state-write fixes apply under either**.

## Files to change
| `file:line` | Problem | Fix |
| --- | --- | --- |
| `subagents/worker.ts:340` + `plan/plan-graph.ts:16` (`ready()`) | Concurrent Workers `git checkout -B` + edit the same tree → clobber each other's branch/diff. | Enforce a single-checkout lock: only one group in the edit/commit critical section at a time (mutex/promise-chain around checkout→edit→commit). |
| `subagents/worker.ts` `runWorker` (editor fanout runs `planAndEdit` **before** `checkout -B`) | Edits land on whatever branch is currently checked out. | Create/switch the group branch **before** the editor fanout writes any file. |
| `subagents/reviewer.ts:210-224` (`commitFix`) | `git add -A && commit` on whatever branch is checked out; input has `pr` but no branch → review fixes may commit to wrong branch. | Check out the PR head branch (or assert current branch == PR head) before committing. |
| `workspace/in-place-checkout.ts:63-66, 84-85` (`acquire`/`resetToBase`) | Never clean the tree; a crashed/blocked Worker's uncommitted edits get carried onto the next group's branch (contamination) or block the checkout. | Assert clean tree before switching; `git reset --hard` / stash-and-drop stale changes at group boundary. |
| `state/pr-context-store.ts:107-116` (`recordAddressedThreads`) | Plain `writeFile` + unserialized read-modify-write → lost updates + non-durable review-loop termination guard. | Route through `atomicWrite`; serialize appends on a per-store promise chain (copy `StateStore.update`, `state-store.ts:52`). |
| `state/state-store.ts:82-85` (`appendProgress`) | Bare `appendFile` from concurrent groups; large multi-line entries can interleave. | Serialize progress appends on the per-store chain. |
| `state/transcript-store.ts:156-171` (`nextOrdinal`) | `readdir`→`max+1` check-then-create race → two `begin`s pick the same ordinal, interleave one JSONL. | `open(...,'wx')` + retry-increment on `EEXIST`, or serialize `begin` per subdir. |

## Steps
1. Land the **state-write fixes** first (`pr-context-store`, `state-store`, `transcript-store`) — independent of the git decision, and the highest-value concurrency wins for a shared state dir.
2. Resolve the decision gate. If (a): add a checkout mutex owned by the driver (`loop/work-loop.ts` / `run-loop-adapter.ts`) wrapping the edit/commit section; have `ready()` consumers acquire it. Ensure branch create/switch precedes editor writes in `runWorker`.
3. Reviewer: check out PR head before `commitFix`.
4. `in-place-checkout`: clean-tree assertion + reset/stash at `acquire`/`resetToBase`.

## Tests
- Integration (temp git repo): two ready groups driven concurrently → each commits only its own files to its own branch; working tree never carries group A's edits into group B. Reviewer fix lands on the PR head branch. A dirty tree left before `acquire` is cleaned, not carried forward.
- Unit: concurrent `recordAddressedThreads` calls → union preserved, no lost ids, file readable after simulated mid-write. Concurrent `begin` → distinct ordinals, no shared JSONL. Concurrent `appendProgress` → no interleaved lines.
- Commands: `bun test`, `bun run test:node`, `bun run typecheck`, `bun run lint`.

## Done when
- No interleaving of branches, working-tree edits, or state files under concurrent groups.
- Review/CI fixes always commit to the intended PR branch on a clean tree.
- `addressed_threads`, progress, and transcript ordinals survive concurrent writers without lost updates.
