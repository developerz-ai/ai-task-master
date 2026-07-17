# aitm Audit Remediation — hardening for autonomous parallel-team execution

## Goal
Fix the real bugs a 5-agent parallel deep-dive found across `aitm`. Priority order is driven by the product stance: **non-interactive, autonomous, multi-agent team sharing one in-place checkout (no worktrees), driving GitHub PRs / comments / CI fixes** with no human in the loop to catch a wrong turn. That stance turns three finding-classes from "edge case" into "must-fix": (A) an arbitrary target repo is **hostile input**, (B) parallel agents share one working tree + one `.ai-task-master/` state dir with **no filesystem isolation**, (C) the PR/CI/review loop must **never lose a fix or spin forever** unattended.

## Context
- Stack: `packages/aitm` — TS strict, ESM, `ai` package `experimental_Agent` + subagents-as-tools; OpenRouter-only via `Credentials`; `gh`/`git` via execa (array form). Runs unchanged on Bun + Node≥20 + Deno≥1.40.
- **Clean, do not touch**: no command-injection (every `gh`/`git` call is execa argv, GraphQL via `-f`/`-F`), no `Bun.*` shipped APIs, no `any`/`as unknown as` in shipped code (two narrow cast escapes noted in `06`). Branch sanitization (`workspace/branch-name.ts`), `SAFE_GROUP_ID` gate, cycle detection in `PlanGraph.validate`, usage-tracker cost math, `run-step` counter, `expand-imports` containment (realpath/symlink/`..` refusal) all verified sound.
- **Architecture principle (owner):** two kinds of logic — **code/harness** (deterministic: orchestration, git, gh, state) and **agent/logic-eng** (LLM reasoning in prompts). Keep them separate, reusable, each testable alone. Slice `08` makes the prompt-template boundary that seam; SRP fixes (`06` CLI, `05` wiring) keep harness logic out of the wrong layer.
- Trust model gap is the spine of slice `01`: `.ai-task-master/config.json` + `./.mcp.json` are repo-shippable yet already partly treated as untrusted (`hooks` stripped at `config-loader.ts:165`) — the same gate is missing on `baseURL`/`apiKey`/`mcpServers`.
- Reference patterns: `config-loader.ts:165` (existing trust strip for `hooks` — extend it), `state/state-store.ts:52` (correct serialized read-modify-write — copy it), `fs/atomic-write.ts` (temp+rename — the durability primitive to harden), `subagents/role-prompt.ts` `buildRolePrompt` (single place contract blocks are injected — all paths must route through it), `loop/ci-fix.ts` `rebaseAndForcePush` (the push-before-recheck primitive `autoMergeFlow` skips).
- **Review model (owner-clarified)**: aitm's own review runs **before the PR opens** (self-review is the primary quality gate). Post-PR review comments come from whatever the target repo runs (CodeRabbit etc.) — that path is optional/repo-dependent, not the core loop, so don't over-invest in it. **But** it's exactly why the prompt-injection fence in slice `01` (`reviewer.ts:201`) still ships: a third-party bot's comment body feeds a subagent holding `bash`/`writeFile`/`editFile`. Fence it; don't build it out.

## Plan files (execute in order)
1. [`01-untrusted-repo-trust-boundary.md`](01-untrusted-repo-trust-boundary.md) — treat target-repo config/MCP/comments/imports as hostile: config-key redirect, arbitrary MCP spawn, prototype pollution, SSRF-redirect, expand-import DoS, prompt-injection.
2. [`02-parallel-team-shared-checkout.md`](02-parallel-team-shared-checkout.md) — safe concurrency on one shared checkout + one state dir: branch-before-edit, clean-tree gate, single-writer serialization, atomic/serialized state writes.
3. [`03-pr-ci-review-loop-correctness.md`](03-pr-ci-review-loop-correctness.md) — no lost fixes, no premature merge, no infinite/duplicate loops: autoMergeFlow push gap, CI empty-rows grace, durable attempt cap, pagination bounds, reviewer commit-abort, dangling deps, terminal-blocked, dead stop-condition.
4. [`04-persistence-durability.md`](04-persistence-durability.md) — crash-durable writes: dir fsync, temp-file leak, validated transcript reload, empty-summary passthrough.
5. [`05-subagent-wiring.md`](05-subagent-wiring.md) — every subagent path carries its contract + verify gate; changes reflect real disk edits.
6. [`06-cli-tools-observability.md`](06-cli-tools-observability.md) — stream correctness, secret scrubbing, ANSI sanitization, arg guards, config-key parity, misc tool hygiene.
7. [`08-prompt-templating.md`](08-prompt-templating.md) — structural: prompts as named templates with typed (auto-fenced) slots; the harness/code ↔ agent/logic seam. Underpins `01` + `05`. (Numbered `08`; execute before or alongside 01/05.)
8. [`07-tests.md`](07-tests.md) — paired `*.test.ts` + integration coverage for every fix; `bun test` + `node --test` both green.

## Done when
- A hostile target repo cannot redirect inference, exfiltrate the API key, spawn an unapproved process, poison a prototype, drive an SSRF, blow up memory, or inject instructions into a tool-holding subagent.
- Two ready groups running concurrently on the shared checkout never clobber each other's branch, working tree, or state files; every fix is committed to the correct branch.
- Every CI/review fix reaches the remote before recheck/merge; no run merges a still-red head, re-burns budget on an unfixable PR forever, or loops on pagination.
- State/transcript writes survive a mid-write crash; corrupt state degrades loudly, not silently.
- `bun test`, `bun run test:node`, `bun run typecheck`, `bun run lint` all green.

## Risks / open questions
- **Concurrency policy is a real design fork** (slice `02`): either (a) serialize ready groups to one-at-a-time on the shared checkout, or (b) restore per-group isolation. Worktrees were deliberately removed (commit 7572a96), so (a) is the presumed direction — but it caps the "parallel team" to parallel *planning/review*, serial *editing*. **Confirm with owner before implementing `02`.** The rest of `02` (atomic state writes) is needed either way.
- **Env-vs-file credential precedence** (finding auth#6): the header comment says `env` outranks file; the code puts `env` lowest. Slice `01` assumes user-owned config wins and env is a fallback — but the doc/code contradiction must be resolved deliberately, not silently.
- Slices `01`, `03`, `04`, `06` are independent and parallelizable across executors; `02` gates on the concurrency-policy decision; `07` follows all.
- Nothing here pulls in out-of-scope surfaces (mailbox, aitm-as-MCP-server, webhooks, Docker). If a fix seems to, stop and surface it.
