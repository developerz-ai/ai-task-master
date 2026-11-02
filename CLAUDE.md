# CLAUDE.md

Instructions for Claude when editing `aitm` source. Not for end users.

## Non-negotiables (MUST / NEVER)
- **NEVER** add `bun test` to CI — Bun's `node:test` shim mis-handles this suite across files (oven-sh/bun#5090); the `node` + `integration` jobs are the authoritative runners.
- **NEVER** use an Anthropic SDK — inference is **OpenRouter** (OpenAI-compatible) only; `Credentials` reads `OPENROUTER_API_KEY` from env; no OAuth, no `~/.claude/.credentials.json`.
- **NEVER** expose `aitm` itself as an MCP server — it is **only an MCP client** (consumes external servers' tools via `mcpServers` in config).
- **NEVER** keep a superseded design alive behind a flag, optional field, fallback branch, or rename alias — delete it; a failure's safety net is "do less", never "run the thing we just rejected" (two data-only exceptions under House style).
- **NEVER** ship `Bun.file` / `Bun.$` / `Bun.spawn` in production code — portability bug (fine in dev scripts and tests gated behind `if (process.versions.bun)`).
- **NEVER** regenerate `bun.lock` inside a release PR, and never add a guard asserting lockfile workspace `version` fields match package.json — such a check is red after every release by construction (Releases below).
- **NEVER** use git worktrees — work directly in this checkout.
- **MUST** ship a paired `*.test.ts` with every module (two exemptions under Testing); no test, no merge.
- **MUST** pass `bin/check` and run the suite under both `bun test` and `node --test` locally before every commit.
- **MUST** keep provider wiring split exactly three ways — `credentials/` + `openrouter/` + `config/provider-presets.ts`; no fourth place constructs an `OpenRouterClient`.
- **MUST** pass `--admin` when running or merging on the `developerz-ai` repos — `main` requires one approving review (Branch protection below).
- **NEVER** add, stub, or leave TODOs for out-of-scope v1 features (mailbox, MCP server, webhooks, Docker) — stop and surface instead (Out of scope below).

## Stack
| Concern | Value |
| --- | --- |
| Dev runtime | Bun — `bun run`, `bun test`, `bun.lock` |
| Portability | Code runs unchanged on Bun, Node ≥ 20, Deno ≥ 1.40; Bun-only APIs are a portability bug |
| Runtime APIs | `node:fs/promises`, `node:child_process`/`execa`, web `fetch` |
| Modules | ESM only, `"type": "module"`; named exports only |
| TypeScript | `^7.0.2`, `strict: true` |
| AI SDK | `ai` `^6.0.182`, `ToolLoopAgent` (v6; the AI SDK 5 name `experimental_Agent` is gone) |
| Lint/format | Biome 2.5.6 — `bun run lint` = `biome check .` |
| Packages | `@developerz.ai/aitm` 0.0.56 + `@developerz.ai/ai-claude-compat` 0.0.56; aitm pins compat EXACTLY, versions move in lockstep |

## Commands
| `bin/` command | Runs |
| --- | --- |
| `bin/check` | The gate: `typecheck` → `typecheck:tests` → `lint` → `bunx madge@8.0.0 --circular packages/*/src` (import cycles) → `test:node` |
| `bin/setup` | `bun install` |
| `bin/dev` | `bun packages/aitm/scripts/debug-start.ts` — dogfood aitm on a throwaway repo |
| `bin/stop` | No-op (nothing detected to stop) |

| Workspace script (root delegates per-package) | Runs |
| --- | --- |
| `build` | per-package tsc — aitm `tsc -b tsconfig.build.json`, compat `tsc -p tsconfig.json` (root delegates via `bun run --filter '*'`) |
| `typecheck` / `typecheck:tests` | Separate tsc projects for src and test files — both must pass |
| `test` | `AITM_INSTANT_SLEEP=1 bun test` — local only, never in CI |
| `test:node` | `node --test --import tsx "src/**/*.test.ts"` — the authoritative unit runner |
| `test:integration` | `node --test --import tsx "test/**/*.test.ts"` — real temp git repo + real `gh` sandbox |
| `lint` / `lint:fix` / `format` | `biome check .` / `biome check --write .` / `biome format --write .` |

| ci.yml job | Steps | Why |
| --- | --- | --- |
| `bun` | install, lint, madge circular, typecheck, typecheck:tests | no `bun test` — oven-sh/bun#5090 |
| `node` | npm install, lint, `typecheck --workspaces`, `test:node --workspaces` | per-workspace npm — never shells out to bun |
| `integration` | npm install, `test:integration -w @developerz.ai/aitm` | 20-min budget; `e2e-smoke` self-skips without secrets |

`release.yml` publishes via npm OIDC trusted publishing (no NPM_TOKEN), npm pinned 11.5.2 (11.6.x regressed provenance), builds then publishes **ai-claude-compat first**, then aitm.

## Structure
- `bin/` — the commands above. `.github/workflows/` — `ci.yml` (3 jobs above) + `release.yml`.
- `packages/aitm/` — the CLI product (goal in → Planner/Worker/Reviewer loop → merged PRs): `src/` (module map below), `test/integration/` real-git e2e, `docs/` (incl. lint-excluded vendored AI SDK reference under `docs/vendor/`), `scripts/` (debug harness, smoke-e2e, benchmark).
- `packages/ai-claude-compat/` — Claude-Code-style agent primitives for the AI SDK; flat `src/`, one module per file with a paired test; depends only on `ai`/`zod`/`execa`; aitm depends on it, never the reverse.
- `.claude/skills/` — 4: `integration-suite`, `lockfile-resync`, `release-cut`, `verify-change` — open the matching `SKILL.md` from the checkout before doing that work. `.claude/agents/` — 4 agent definitions (`aitm-cli`, `provider-presets`, `run-state`, `task-loop`).

## Module map — `packages/aitm/src/`, 23 dirs
| Dir | Responsibility |
| --- | --- |
| `agent-config/` | Find `CLAUDE.md`/`AGENTS.md` in a target repo, return a coding-style payload (+ optional LLM style digest) |
| `benchmark/` | Scenario definitions and result comparison for the `aitm benchmark` dev tool |
| `cli/` | Arg parsing, dispatch, exit codes, presentation formatting (`format.ts`, `help.ts`, `model-banner.ts`) |
| `compaction/` | Shrink an over-budget subagent transcript (prune → summarize → hard-truncate) to fit the model's context |
| `composition/` | Leaf types shared across the cli↔loop boundary (`RunLoopInput`/`RunMergeFlowInput`), no runtime logic |
| `config/` | Load/write/merge `~/.aitm.json` + project + env + CLI layers; profiles; provider presets |
| `credentials/` | Read `OPENROUTER_API_KEY`, resolve model params, return a configured AI SDK model handle |
| `domain/` | Shared leaf domain types (`Task`, `PrGroup`, `Role`, `WorkerDelivery`, …) with no other module's logic |
| `fs/` | Atomic file writes (temp + fsync + rename) |
| `github/` | Thin wrapper over `gh` CLI for PR, CI status, review-thread pagination, check tolerance |
| `logger/` | Structured logs to stderr, plain status to stdout; secret scrubbing/redaction at every output channel |
| `loop/` | Drives Planner/Worker/Reviewer group-by-group through the plan; CI-fix, conflict resolution, merge flow |
| `mcp/` | MCP client: connect to configured servers, expose their tools, OAuth for remote servers |
| `observability/` | Heartbeat, step-progress rendering, usage tracking, error reporting (Sentry) |
| `openrouter/` | OpenRouter catalog client, model-limits lookup/reference-catalog fallback, server-side tools |
| `orchestrator/` | Commit/PR composition (`finalizeCommit`, `openPr`, PR body) — the `WorkLoopOrchestrator` port |
| `plan/` | Plan schema, markdown render/parse, plan-graph validation, acceptance criteria |
| `serialization/` | Cycle-safe `safeStringify` shared by logger and compactor |
| `state/` | Persist run state, plan, PR groups, transcripts, run lock, PR-context cache; schema migrations |
| `subagents/` | Planner/Worker/Reviewer/scout implementations, bash/editor/explore/memory tool factories |
| `testing/` | Test-only support (`makeTempRepo`, …) consumed exclusively by `*.test.ts` files |
| `tools/` | Model-facing tools: `datetime`, `web-fetch`, `fetch-html`, `web-search`, `github` thread tool |
| `workspace/` | Git plumbing: checkout, dirty-tree guard, branch naming/cleanup, task-commit markers |

`fs/atomic-write.ts` duplicates `ai-claude-compat/src/atomic-write.ts` (same shape, two packages) — known, tracked, low-priority; don't fix it by importing across the package boundary without an explicit task; eventual direction is re-exporting one from the other, not yet done.

## House style
- SOLID — one responsibility per module; a file with a second reason to change gets split.
- Every module ships with tests; SRP + tested is the bar.
- No premature abstraction — inline first, extract on the second real caller.
- **No legacy:** a replaced design is DELETED — not kept behind a flag, an optional field, a fallback branch, or a rename alias. A superseded path that still runs is untested in anger, drags its assumptions into new code, and fires exactly when something else already went wrong.
- A failure's safety net is "do less" (skip the phase, let the caller proceed as it would have), never "run the thing we just rejected".
- The only two exceptions, both about DATA rather than code: an on-disk state/config file written by an older version must still parse (`state/` migrations); a documented CLI/config key is renamed in one release with the old name removed, not aliased forever.
- No comments unless the WHY is non-obvious; names carry intent.
- Conventional commits; no co-author trailers.

## TypeScript
- `strict: true`; no `any`, no `as unknown as` — use `unknown` and narrow.
- `type` for data shapes; `interface` only when declaration merging is actually needed.
- Named exports only; no default exports.
- File names kebab-case, type names PascalCase, function names camelCase.

## Provider & AI SDK
- `CLAUDE.md` in a target repo is a *coding-style signal*, not a provider signal — feed it to subagent system prompts.
- Subagents-as-tools pattern (https://ai-sdk.dev/docs/agents/subagents): `Orchestrator` is the top-level agent; `Planner`, `Worker`, `Reviewer` are exposed to it as tools.
- The fixed three-way split: `credentials/` builds the injected model handle from `OPENROUTER_API_KEY` + resolved `baseURL`; `openrouter/` owns the catalog client, model-limits lookup, and server-tools; `config/provider-presets.ts` owns the named presets (`openrouter`/`zai`/`moonshot`/…) resolved into that baseURL/key pair — don't add a fourth place that constructs an `OpenRouterClient`.

## Testing
- Every module has a paired `*.test.ts`. Two narrow exemptions, applied consistently: pure re-export barrels with no logic of their own (`export { ... } from './x.ts'` / `export type { ... }`) — e.g. `observability/step-progress.ts`; and test-only support/fixture modules consumed exclusively by `*.test.ts` files — e.g. `loop/work-loop-test-support.ts`. Everything else — including small constant/helper files with real logic — ships a paired test.
- Integration tests run against a real temp git repo and real `gh` against a sandbox account — the source of truth for behavior. Unit tests cover pure modules (`AgentConfigDetector`, `Credentials` resolution, plan parsing, PR-group sizing).
- No mocking of `gh` or the AI SDK in integration tests; mock only at module boundaries in unit tests.
- Tests must pass under both `bun test` and `node --test` (or `vitest run` with a Node target) locally before every commit. CI's `bun` job deliberately omits `bun test` (oven-sh/bun#5090), so the `node` + `integration` jobs are authoritative for portability enforcement.

## Branch protection & `--admin`
- `main` on the `developerz-ai` repos requires **one approving review**, so `gh pr merge` on a solo-authored PR is refused with "the base branch policy prohibits the merge" even with every check green.
- Running aitm here: pass `--admin` (`aitm start … --admin`, `aitm merge-pr --pr N --admin`) or the run blocks on a finished, green PR it cannot land. Merging by hand: `gh pr merge <n> --squash --admin`.
- `--admin` overrides the policy — it does not satisfy it. It never skips CI or ignores failing checks (those still route to the CI-fix loop); it only advances a CI *timeout* to the review stage rather than blocking.

## Releases and `bun.lock`
- **A release bump never regenerates `bun.lock`.** Bump the three version lines (both package `version` fields + aitm's exact `@developerz.ai/ai-claude-compat` pin), run `bun install`, open the PR. The lockfile is not part of a release.
- `bun.lock`'s workspace `version` entries lag the published versions **on purpose**. Never "fix" that with a matching guard: `bun install` rewrites the lockfile only when *resolution* changes, and a `version` field moving is not one — an equality check is red after every release by construction, and the only way to green it is to regenerate, which is the thing the rule exists to prevent.
- **Regenerating is a dependency upgrade, not a metadata fix.** Deleting `bun.lock` and reinstalling resolves every unpinned range to current (measured on #327: 71 packages moved — `ai` 6.0.182 → 6.0.240, `@ai-sdk/provider` 3.0.10 → 3.0.14, `@biomejs/biome` 2.4.15 → 2.5.6, `@types/node`, `tsx`, the whole `@sentry/*`/`@esbuild/*` sets — while the workspace `version` lines were 3 of 160 changed lines). Landing that inside a release PR would ship an unreviewed SDK upgrade under a title about something else.
- So: resync the lockfile in **its own PR**, whose subject is the upgrade. Enumerate the moved packages in the body and verify `typecheck`, `typecheck:tests`, `lint`, and `node --test` against the upgraded tree — `bun install --frozen-lockfile` passing proves nothing here, since it does not gate on the workspace `version` field. Bump `biome.json`'s `$schema` in the same PR when biome moves (`bunx @biomejs/biome migrate --write`).

## Tolerated check failures
- `github/check-tolerance.ts` holds a whitelist of `{ check, description, reason, match }` rules; a failure matching one is treated as *skipped*, so `waitForChecks` neither reports it as failed nor loops on it. Built in: **CodeRabbit quota failures** — `match: 'contains'` on `rate limit` and `limit reached`. A real verdict (`1 issue found`, `Review failed`) contains neither and still fails CI, as does the same message from any other check.
- Add an exception by appending a rule (`match: 'contains'` when a service words one condition several ways), or without a release via `AITM_TOLERATED_CHECK_FAILURES="check=description;other=description"` — env rules are always exact. Mirrors `claude-task-master`'s `github/check_tolerance.py`.

## Out of scope for v1
Do not add, do not stub, do not leave TODOs for:

- Mailbox / inbox features.
- Exposing `aitm` itself as an MCP server — never (Non-negotiables above).
- Webhooks or any inbound HTTP — **exception:** loopback-only OAuth redirects per RFC 8252 (`http://127.0.0.1:PORT` / `http://[::1]:PORT`) for native-app OAuth flows during MCP server authentication; remote inbound servers remain banned.
- Docker, devcontainers, or any containerization.

If a change pulls in any of these, stop and surface it instead of implementing.

## Note
Do not use git worktrees — work directly in this checkout. If a task is big enough to need subagents, run them as a team in this same checkout: split the work into disjoint pieces so no two agents touch the same files.
