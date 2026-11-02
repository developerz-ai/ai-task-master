# Reviewer instructions — developerz-ai/ai-task-master

> Read by the developerz.ai reviewer at EVERY review of this repository, at the reviewed
> commit, as this repo's own layer of the reviewer's prompt — established by dz-runner setup mode.
> It refines the platform rules (a finding is cited or withheld; the bot always discloses)
> and never overrides them. Edit freely; keep it under 12,000 characters — past that it is cut.

## Stack

Bun + TypeScript monorepo. The gate is `bin/check` (`bun run typecheck && bun run typecheck:tests && bun run lint && bunx madge@8.0.0 --circular packages/*/src && bun run test:node`): a change that does not pass it is not proven, whatever its description says.

## Review conventions

- Hold every module to SRP with a paired `*.test.ts` — no test, no merge; pure re-export barrels and `src/testing/` are the only exemptions.
- Reject `any`, `as unknown as`, default exports, non-null assertions, and Bun-only APIs in shipped code (must run on Bun, Node ≥ 20, Deno ≥ 1.40).
- Reject any Anthropic SDK dependency or OAuth credential reuse — inference goes through OpenAI-compatible providers via `credentials/` + `config/provider-presets.ts` + `openrouter/`, a fixed three-way split: never approve a fourth place that constructs an `OpenRouterClient`.
- Reject legacy paths kept behind a flag, optional field, fallback branch, or rename alias — replaced designs are deleted.
- Enforce conventional commits, no co-author trailers, no emoji in source.
- Out of scope v1 (stop the change, don't review it): exposing aitm as an MCP server, webhooks/inbound HTTP beyond loopback OAuth redirects for MCP auth, Docker or any containerization, mailbox/inbox features.
- Outside contributors' changes to `.github/` or `PUBLISHING.md` are members-only — the maintainer bot does not merge those.

## Gates that matter

- `bin/check` is the local gate: `bun run typecheck && bun run typecheck:tests && bun run lint && bunx madge@8.0.0 --circular packages/*/src && bun run test:node` — proven green on a clean checkout.
- CI (`ci.yml`) decides merges: the `bun` job (lint, madge import cycles, typecheck, typecheck:tests), the `node` job (`test:node` per workspace — the authoritative unit runner), and the `integration` job (real git + gh, 20-min budget).
- `bun test` is deliberately NOT a gate (oven-sh/bun#5090 node:test shim breaks across files); never demand it in CI or block a PR on its absence.
- "Proven" for a dependency-upgrade PR: typecheck, typecheck:tests, lint, and `test:node` against the upgraded tree — `bun install --frozen-lockfile` passing proves nothing.
- Typecheck covers test files via `typecheck:tests`; a test drifting from package source must fail the gate.

## Never flag

- `bun.lock` workspace `version` lines lagging published versions — that lag is deliberate; a release bump never regenerates the lockfile.
- `fs/atomic-write.ts` duplicating `ai-claude-compat/src/atomic-write.ts` — known, tracked, low-priority; do not demand a cross-package import without an explicit task.
- `docs/vendor/` (vendored AI SDK reference) is excluded from biome and lint on purpose.
- `AITM_INSTANT_SLEEP=1` in the test scripts, `noForEach`/`noConsole` disabled in `biome.json`, `--concurrency` pinned to 1 (accepted and persisted, runs sequential by design) — all chosen, not oversights.
- CodeRabbit quota failures (`rate limit` / `limit reached`) in CI checks — whitelisted as *skipped* by `github/check-tolerance.ts`; a real verdict wording still fails.
- The generated onboarding files under `.dz/` and `.claude/commands/` — platform- and maintainer-owned layouts.
