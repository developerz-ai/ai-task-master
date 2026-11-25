# Standard: key-hold attribution (K1, `key_held_older_24h`)

This record settles where an aging key or provider hold can come from, and where it cannot. It exists
so the next investigation does not look for a repair in a repository that never held a key.

## Scope of this claim

This standard covers the `developerz-ai/ai-task-master` checkout (the `aitm` CLI plus the
`ai-claude-compat` workspace it pins). "Key hold" means a provider credential or account being held,
cooled down, or unavailable for work. The K1 question asks why tasks remain held beyond 24 hours and
whether this repository's code causes it.

## False premises, resolved first

The request this task came from assumed a census command, a metric, and a repairable >24h hold all
live in this repository. Each assumption is false. They are listed first because they would
otherwise send a reader to the wrong repo.

1. **No K1 / `key_held_older_24h` / census code exists in this repository.** A case-insensitive
   search across the tree found only hash coincidences in `bun.lock`. The root `package.json:8-17`
   declares exactly `build`, `typecheck`, `typecheck:tests`, `test`, `test:node`, `lint`, `lint:fix`
   and `format`. There is no `infra` script and no `census` script, so `bun run infra census --only
   K1` is not runnable here.

2. **The CLI renders no census anchors, so there is no anchor/layout mismatch to repair.**
   `packages/aitm/src/cli/help.ts:26-92` is the whole command table (`start`, `resume`, `merge-pr`,
   `config`, `profile`, `mcp-login`, `clean`, `update`, `help`, `version`). No entry mentions a
   census, K1, a key hold, or a metric. `packages/aitm/src/cli/format.ts:1-40` is pure presentation
   helpers for usage lines, PR links, config/profile listings and secret masking. The census anchors
   belong to an in-cluster tool, not to this CLI, which is why they do not appear in the rendered
   layout. The mismatch is a scope error in the question, not a rendering defect.

3. **No repository-local code can hold a key beyond 24 hours.** The only path here that waits on a
   provider is the retry kernel in `packages/ai-claude-compat/src/subagent.ts`. It is bounded to
   minutes by construction, with no day-scale timer anywhere in the tree.

4. **`docs/standards` did not exist in this checkout.** This file is the first standard in that
   directory. There is no earlier attribution record to amend.

5. **Hold and cooldown state is owned externally.** The connected gateway exposes a
   `multi_ai_router` database with `account_breakers` (columns `status`, `cooldown_until`,
   `cooldown_source`), `account_recoveries`, `quota_windows` and `audit_events`. This repository has
   no database connection, no key or lease model, and no code that reads those tables. Sampled
   cooldowns there were seconds-to-minutes, not 24 hours.

## Finding: the only provider-wait code here is minute-bounded

`packages/ai-claude-compat/src/subagent.ts` is the complete provider-wait path. Its bounds are:

- `DEFAULT_LLM_MAX_RETRIES = 10` at `:575-585`, with `defaultRetryDelayMs` returning 1s for the
  first retry and 5s, 10s, 15s and so on thereafter. The whole escalating schedule is minutes.
- `callWithRetry` at `:613-638` throws immediately on a non-retryable error or an aborted signal,
  sleeps only via `resolveRetryDelay`, and increments the attempt each pass. It has no unbounded
  loop and no long-duration wait.
- `MAX_RETRY_AFTER_MS = 300_000` at `:677-686`, with `resolveRetryDelay` returning
  `Math.min(after, MAX_RETRY_AFTER_MS)`. A single honoring of a provider `Retry-After` is capped at
  five minutes so a malformed or hostile header cannot stall a PR group.
- `parseRetryAfterMs` at `:709-715` reads `Retry-After` / `retry-after-ms` headers and a "try again
  in Ns" hint. It returns the true provider value, so legitimate provider waits are preserved; only
  the caller's application of the cap bounds a pathological value.

There is no `key_held`, `provider_clock`, `account_breakers` reference, `DATABASE_URL`, or 24-hour
constant in the source. The repository therefore contains no code path that could produce a
`key_held_older_24h` reading. Attribution to this repo is disproved; attributing the regression to a
local repair here would be an invented code fix.

## Exact owning boundary

| Concern | Owning boundary | Evidence / command |
| --- | --- | --- |
| The K1 metric (`key_held_older_24h`) and its baseline | The in-cluster census tool, not this CLI | Run `bun run infra census --only K1` in its owning in-cluster environment (the second leg of this goal records the timestamp and reading). It is not a root package script here, as `package.json:8-17` shows. |
| Live hold and cooldown state | External `multi_ai_router` database on gateway `d1`, server `worker-db` | `account_breakers`, `account_recoveries`, `quota_windows`, `audit_events`. No code in this repo reads them. |
| Provider wait during a subagent call | `packages/ai-claude-compat/src/subagent.ts`, owned here but already minute-bounded | `callWithRetry :613-638`, `MAX_RETRY_AFTER_MS :677-686`, `parseRetryAfterMs :709-715`. Leave unchanged. |
| CLI rendering of the command surface | `packages/aitm/src/cli/help.ts:26-92` and `format.ts`, owned here | No census/hold output exists; adding it would be fabricating a feature, not repairing a regression. |

Baseline 129 and the current K1 reading are supplied task figures and leg-2 evidence. They were not
measured or verified in this repository and are recorded here as supplied values only. This standard
does not claim to have observed the regression or to have corrected it.

## Prevention rule (fleet-readable)

**Attribute before repairing.** A symptom named by a metric belongs to the system that emits the
metric. Before editing code for an aging hold, name the emitting command, read the state store that
backs the metric, and confirm the suspect code can actually hold for the measured duration. If the
suspect repo has no such code, record the evidence and the owning boundary instead of inventing a
repair. Concretely for K1: the census command and hold tables own the reading; this repo's provider
wait stays minute-bounded and its `Retry-After` handling stays intact.

This rule has two standing corollaries:

- Preserve legitimate provider waits. Do not "fix" a hold by shortening or removing
  `parseRetryAfterMs` or the bounded retry kernel; a real provider cooldown must be honored.
- Do not touch credentials to mask a symptom. No key is rotated, disabled, re-enabled, or changed in
  capacity, agents, or models as part of an attribution record. Investigation is read-only with
  respect to keys.

## What this record does not change

This is a documentation-only attribution. It does not alter root `CLAUDE.md`, `.dz/schedules`, any
metric table, or any census query. It does not add a repository-local code fix, change provider
routing, or modify existing keys.
