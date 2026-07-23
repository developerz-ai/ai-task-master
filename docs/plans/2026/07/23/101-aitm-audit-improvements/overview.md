# aitm audit — fixes & improvements

## Goal
Fix the bugs, resource-lifecycle leaks, and architecture drift found by an 8-agent parallel audit of `packages/aitm` (2026-07-23), and add the small missing capabilities the audit surfaced. Raw per-agent reports live in [`findings/`](findings/) — each slice cites the items it executes.

## Context
- Bun dev runtime; code must run unchanged on Bun, Node ≥20, Deno ≥1.40. ESM only. TS `strict`, no `any`, no `as unknown as`. Named exports only. Every module has a paired `*.test.ts`.
- Provider: OpenAI-compatible via `Credentials` (`OPENROUTER_API_KEY` / baseURL profiles). No Anthropic SDK.
- Audit verdict: mechanical house rules are held nearly perfectly (zero `any`/default exports/`Bun.*`). Debt clusters in: cancellation (one signal reaches one LLM call site), a double composition root (`cli/commands.ts` + `loop/run-loop-adapter.ts`), `mcp/oauth.ts` (largest problem cluster), and duplicated-but-diverged pipelines (`aitm start` vs `aitm merge-pr`).
- Reference patterns to copy: `subagents/worker.ts:984-1038` (correct abort wiring), `fs/atomic-write.ts` (correct cleanup), `mcp/stdio-process-registry.ts` (correct process reaping), `tools/web-fetch.ts` (correct fetch timeouts).

## Findings index
| File | Area |
| --- | --- |
| [`findings/01-loop.md`](findings/01-loop.md) | loop/ |
| [`findings/02-subagents-orchestrator.md`](findings/02-subagents-orchestrator.md) | subagents/, orchestrator/ |
| [`findings/03-cli-config.md`](findings/03-cli-config.md) | cli/, config/ |
| [`findings/04-github-state-workspace-fs.md`](findings/04-github-state-workspace-fs.md) | github/, state/, workspace/, fs/ |
| [`findings/05-mcp-openrouter-credentials-agent-config.md`](findings/05-mcp-openrouter-credentials-agent-config.md) | mcp/, openrouter/, credentials/, agent-config/ |
| [`findings/06-observability-logger-compaction-plan-tools.md`](findings/06-observability-logger-compaction-plan-tools.md) | observability/, logger/, compaction/, plan/, tools/ |
| [`findings/07-resource-lifecycle-sweep.md`](findings/07-resource-lifecycle-sweep.md) | cross-cutting RAII |
| [`findings/08-architecture-sweep.md`](findings/08-architecture-sweep.md) | cross-cutting architecture |

## Plan files (execute in order)
1. [`01-data-safety-state.md`](01-data-safety-state.md) — stop destroying user work/state: dirty-tree guard, run lock, init/no-resume clobber, schemaVersion.
2. [`02-config-trust-secrets.md`](02-config-trust-secrets.md) — trust boundaries + secret redaction: project bashRules, prototype pollution, scrubber gaps, git-exec bypass.
3. [`03-cancellation-resources.md`](03-cancellation-resources.md) — one cancellation + disposal convention: abortable sleep, signal threading, execa timeouts, Disposer, exit/flush.
4. [`04-mcp-oauth.md`](04-mcp-oauth.md) — MCP connect/close deadlines, oauth PKCE + lifecycle fixes; carries the inbound-HTTP scope decision.
5. [`05-loop-flows.md`](05-loop-flows.md) — loop correctness: no-changes burn loop, prContext.clear, self-review error masking, start/merge-pr pipeline unification.
6. [`06-github-client.md`](06-github-client.md) — gh wrapper robustness: ENOENT, poll retry, pagination, cursor drop, NODE_ENV sleep, domain errors.
7. [`07-subagents-orchestrator.md`](07-subagents-orchestrator.md) — subagent wiring: init forwarding, reviewer `git add -A`, commit-message fallback, injection envelopes, orchestrator dead-path decision.
8. [`08-compaction-observability.md`](08-compaction-observability.md) — compaction overflow guarantee + Logger actually wired + misc tool/plan fixes.
9. [`09-cli-config-ux.md`](09-cli-config-ux.md) — CLI/config paper cuts and missing UX: `--` sentinel, help drift, precedence, `config list --effective`.
10. [`10-architecture-refactors.md`](10-architecture-refactors.md) — structural moves: one composition root, `domain/` leaf types, module splits, dedup helpers, CLAUDE.md refresh.
11. [`11-tests-ci-docs.md`](11-tests-ci-docs.md) — remaining test pairs/coverage gaps, oauth test rewrite, CI-vs-CLAUDE.md testing claim.

Slices 1–9 are independent of each other (disjoint files except noted `Depends on`). Slice 10 moves code that 1–9 touch — do it after. Slice 11 closes whatever gaps 1–10 didn't already cover with their own tests.

## Done when
- All high-severity findings fixed with regression tests; med-severity fixed or explicitly deferred in `status.yml` notes.
- `bun test`, `bun run test:node`, `bun run typecheck`, `bun run lint` green.
- A single Ctrl-C cancels a run (LLM streams, sleeps, gh/git children) within seconds, verified by test.
- No resource acquired in `src/` lacks a guaranteed release on error/abort paths (Disposer or try/finally).
- CLAUDE.md module map, provider invariant, and testing claims match the code.

## Risks / open questions
- **Decision (owner): oauth inbound HTTP.** `mcp/oauth.ts` ships a localhost HTTP listener; CLAUDE.md bans inbound HTTP. Options: amend CLAUDE.md with an RFC 8252 loopback exception, or drop remote-OAuth MCP servers for v1. Slice 04 blocks on this.
- **Decision (owner): orchestrator agent-as-tool path.** `Orchestrator.build` + `subagent-tools.ts` (~400 LOC) have zero production callers and have drifted. Delete or wire — slice 07.
- **Decision (owner): `src/templates/*.html`.** Never shipped in dist; delete + keep inline fallback, or add a build copy step — slice 04.
- Fixing `datetime` tool and `--no-resume` semantics changes behavior tests currently bless — update tests deliberately, not mechanically.
- Compat package (`ai-claude-compat`) needs a `signal` param on `runSubagent`/`agent.generate` for slice 03; that is a cross-package change, version-locked at 0.0.44.
