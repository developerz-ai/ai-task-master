# 07 — Test coverage

> Part of [`overview.md`](overview.md). Depends on: 01–06 (add tests alongside each fix; this slice is the completeness sweep).

House rule: no test, no merge. Every fixed module keeps its paired `*.test.ts`; behavior that spans modules gets integration coverage against a **real temp git repo + stubbed/sandbox `gh`**. All tests pass under **both** `bun test` and `node --test`.

## Coverage map (per slice)
| Slice | Unit (`*.test.ts` beside module) | Integration (`packages/aitm/test/integration/`) |
| --- | --- | --- |
| `01` | project-vs-global config trust strip; prototype-pollution reject; snapshot secret-redaction; `assertSafeUrl` redirect-chain; expand-import diamond/hostile budget; reviewer prompt fencing | hostile-repo fixture: run cannot redirect inference / spawn unapproved MCP |
| `02` | concurrent `recordAddressedThreads`/`begin`/`appendProgress` no-lost-update | two concurrent ready groups on shared checkout: no branch/tree/state cross-contamination; reviewer fix on correct branch; dirty tree cleaned |
| `03` | `capGroups` dep remap; transitive-block `isComplete`; paginator stuck-cursor terminates; `resolveMaxSteps` decoupling; reviewer empty-diff isolation | autoMerge pushes before merge; no red-head merge; fresh-PR grace; unfixable PR stops durably across resume |
| `04` | `atomicWrite` no-orphan-temp + dir-fsync; transcript corrupt-line skip; compactor empty-summary passthrough | crash-mid-write → resume reads last good state |
| `05` | orchestrator-path subagent carries contract/`<env>`/step-budget; `makeWorkerTool` config parity (format/providerOptions/timeout/usage); `runEditor` phantom-edit rejection | both spawn paths configure the Worker identically (no drift); per-commit verify stays off |
| `06` | ANSI strip; secret scrub in msg/error/log; stream routing; shared config-key table (`config set selfReview`); arg flag-guards; web-search cap; `truncated`; `forModel` single fetch; empty-reply error; datetime ISO | — |
| `08` | `render()` fences `data` slots, not `instruction` slots; each role template carries contract/`<env>`/step-budget; malicious `data` slot stays enveloped; per-role snapshot tests | subagent spawned via any path renders an equivalent prompt (no path-dependent drift) |

## Steps
1. Add/extend the paired unit test with each fix as it lands (don't batch to the end).
2. Add the integration fixtures above; reuse `testing/temp-repo.ts` for real git repos; stub `gh` at the module boundary (no mocking `gh`/AI SDK inside integration paths per CLAUDE.md — use the sandbox account seam).
3. Run the full gate; fix portability drift so both runtimes stay green.

## Tests / commands
- `bun test`
- `bun run test:node`  (Node `--test` target — portability gate)
- `bun run typecheck`
- `bun run lint`

## Done when
- Every module touched in 01–06 has a passing paired test asserting the fixed behavior.
- Integration fixtures cover the hostile-repo, concurrent-checkout, and PR/CI-loop data-loss scenarios.
- All four commands green under both runtimes.
