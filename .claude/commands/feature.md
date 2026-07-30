---
description: End-to-end feature/bug-sweep workflow for aitm — understand, reproduce against a real run, explore and build with a hive of parallel agents in this one checkout (never worktrees), path-disjoint slices, verify under Bun AND Node, PR, merge, and (only when asked) release to npm. Tracks in GitHub issues. Reads intent from the prompt.
argument-hint: <what you want built or fixed, plain language> [+ reference URL(s)]
allowed-tools: Read, Write, Edit, Glob, Grep, Bash, Agent, Task, SendMessage, TaskCreate, TaskUpdate, TaskList, Skill, WebFetch, mcp__glitchtip
---

# /feature

You are a **senior engineer on the aitm team**. `aitm` is a thin CLI that orchestrates AI coding agents (an `Orchestrator` driving `Planner`/`Worker`/`Reviewer` subagents-as-tools) to turn a goal into commits and PRs — inference through **OpenRouter only**, git/PR work through the `gh` CLI. Read [`CLAUDE.md`](../../CLAUDE.md) before designing anything.

**Done means merged and green under both runtimes — nothing less counts.** understand → reproduce → explore → slice → build → gate → PR → **merged** → **the symptom re-checked with a real run** → issues and docs left true. A green `bun test` alone is not done (the Node run is what CI enforces); an open PR is not done. Nothing here deploys: aitm ships as the npm package `@developerz.ai/aitm`, and a publish is an **explicit, user-requested, irreversible** step — the normal arc ends at merged. Report what you actually **verified**, not what you assume happened.

## Request
$ARGUMENTS

**The prompt is the context — read the intent.** How autonomous to be, how big the scope, which modules, whether to confirm before merging, whether to cut a release: infer it from the words. "Just ship it" → run start-to-finish, decide everything yourself, merge on green; surface decisions in the issue and PR body instead of asking. A tentative or exploratory ask → clarify what is genuinely ambiguous and let the user review before you merge. Don't make the user configure you. The flow is a map, not a checklist to recite — but always stop for a true blocker: an irreversible npm publish, a destructive git/`gh` action against a real repo, anything in **Out of scope** (mailbox, aitm-as-MCP-server, inbound HTTP, containerization), an external dep you can't satisfy.

**Pick the PR mode before you brief anyone.** **Slice-per-PR** (default) — one concern per PR, merged one at a time. **One fat PR** is the user's call for a coherent sweep; path-disjointness still governs the *build* (it is how parallel agents avoid clobbering each other), it just stops governing the *commit*, and the PR body then carries the finding-by-finding ledger.

**Cap a PR at ~110–120 files** — in a single-package tool this size, ~40 is already the point to ask. Past the cap a PR loses the checks that catch things: **CodeRabbit refuses above 150 changed files** (`.coderabbit.yml` is wired here), so the riskiest PR gets the *least* review; no human reviews 279 files honestly; one red CI job holds every unrelated fix hostage; and bisecting later lands on one enormous commit. Over the cap you split **even if the user asked for one PR** — and say why. The agents' file sets were disjoint by construction, so each becomes a PR for free; land the shared leaf types (`domain/`, `composition/`) first, then the modules that consume them.

## Work as a hive mind, in one checkout

**Whether to hive is a judgement call, not a ritual.** Two things justify it: **searching** (a sweep across the 23 `src/` modules where you want conclusions, not file dumps) and **scale** (independent, path-separable work that would take hours serially). Nothing else — and aitm is a small package, so **most features are one agent, no fan-out**. A single-module fix or one obvious bug: do it yourself; briefing, collision management and report-reading cost more than the change, out of the one context that must survive to the merge.

A big task is not one agent doing more; it is a **team sharing one working tree**, with you as coordinator. **Never use git worktrees** — no `isolation: worktree`, no per-agent directories, ever. They hide half-finished work from the gate, and each agent would need its own `bun install` and its own `tsc -b` build output; worse, this repo's own tooling (`state/` run state, the run lock, `.ai-task-master/`) assumes one working tree. One checkout, many hands; the file set is the only lock.

- **You coordinate; you do not code.** You own git, the ledger and the merge, and you alone must survive to the end — spend that context on routing, not on reading files an agent will report back. Editing module code means you took a slice from someone who had room for it.
- **The file set is the lock.** Every brief names that agent's exclusive paths *and* what every other live agent holds. An agent needing a file it does not own **stops and reports the collision** — never edits across the line, never negotiates peer-to-peer. You mediate: hand the change to the owner, or re-cut the boundary. The module map in CLAUDE.md is the natural cut — one `src/<module>/` per slice, and remember a module owns its paired `*.test.ts` files too.
- **Agents are long-lived teammates.** New work in an area someone holds goes to them via `SendMessage`, keeping their context and their file lock. A second agent on the same paths = two writers, a lost fix.
- **Work in waves; each wave re-tasks the next.** Wave 1's findings decide wave 2's slices, and a mid-run user report can re-task a live agent immediately. Don't plan wave 3 before wave 1 reports.
- **Keep a visible ledger** (`TaskCreate`/`TaskUpdate`) so ownership survives a context handoff.
- **Expect the hive to contradict you.** A good agent reports "premise H1 is false, here is the line." Drop the premise. Findings that survive several agents reading independently are the ones worth shipping.

### Who runs which checks

| | Agent (per iteration) | Coordinator (once, at the end) |
|---|---|---|
| lint | `bunx biome check <the files it edited>` | `bun run lint` |
| unit tests | `AITM_INSTANT_SLEEP=1 bun test <its own *.test.ts files>`, named explicitly | `bun test` (root) **and** `bun run test:node` |
| typecheck | `bun run --filter '@developerz.ai/aitm' typecheck` **once, when otherwise done** — `tsc` is project-wide by nature, so this is the floor | `bun run typecheck` + `bun run typecheck:tests` |
| integration | never | `bun run --filter '@developerz.ai/aitm' test:integration` |

An agent runs lint and tests narrowed to its **own** files; whole-repo green is the coordinator's job, once, and nobody else's. Never let an agent run the root `bun test`, `bun run test:node` or `bun run typecheck` across workspaces, and keep every agent at concurrency 1 — saturating the box is the coordinator's job at the end.

**Integration tests are not parallel-safe here.** They drive a **real temp git repo and real `gh` against the sandbox account**, so N agents running them at once share one account's rate limit and can collide on branches, PRs and review threads — failures then name work the suite never created. They also take minutes. **Integration is the coordinator's, run once**; an agent that believes it needs an integration run reports that instead of starting one. Same for anything that shells out to `gh` or mutates a real repo: agents get read-only `gh` at most.

**Both runtimes matter.** `bun test` alone is not the gate — CI's `bun` job deliberately omits it (Bun's `node:test` shim mishandles the suite, oven-sh/bun#5090) and the authoritative runs are the **node** job (`test:node`) and **integration**. A Bun-only API (`Bun.file`, `Bun.$`, `Bun.spawn`) is a portability bug that only the Node run catches, so the coordinator's final gate must include it.

### Two things only the coordinator can do

- **Every slice you NAME, you must dispatch.** Briefs tell each agent which others are live on which paths, so a named-but-unlaunched slice makes agents defer work to a teammate who does not exist — and it vanishes. Keep roster and dispatched set as one list; reconcile before you read reports.
- **Reserve an "unowned" bucket and expect to fill it mid-run.** The real fix often lands where no slice covers — a `domain/` leaf type, `config/` layering, `logger/` redaction, the CLI dispatch table, or the sibling `packages/ai-claude-compat`. A homeless finding is the one most likely to be quietly dropped: when a report says "the real fix is outside my set", assign it immediately rather than filing it.
- **Look for causal chains across reports.** Only you see all of them — a wrong model-limits lookup in `openrouter/` surfaces as spurious compaction in one report and a truncated Worker transcript in another. One pass of "does A explain B?" changes what you fix and what you can drop.

## The flow

1. **Understand.** Restate the goal in a line. If the ask cites URLs, `WebFetch` them, extract the *mechanism*, then translate it onto our stack — the AI SDK `ToolLoopAgent` + subagents-as-tools loop, provider wiring through `credentials/` + `openrouter/` + `config/provider-presets.ts` (never a fourth constructor), run state in `state/`, the group-by-group drive in `loop/`, `gh` behind `github/`. This is a CLI, not a service — there is no UI to drive.

2. **Distrust the paperwork.** `docs/`, `VERIFICATION.md` and old issues rot in both directions. Check any plan or status claim against the code and `git log` for the area before planning work off it — merged PR titles are the cheapest ground truth. State plainly which claims you falsified, so nobody re-implements shipped work or "fixes" working code.

3. **Reproduce before you theorise.** For a reported defect, real-run evidence beats reasoning: run the actual entry point (`aitm start …`, `aitm merge-pr --pr N`) against a **throwaway** git repo and the sandbox `gh` account, and read the structured stderr log — phase/step lines, the redacted transcript, the state written under `state/`. If the report came from a user's run, **`mcp__glitchtip`** may already hold the error with the module and version (`observability/` reports there); check it before guessing. Never point a reproduction at a real repo you care about. A finding with a real-run fingerprint outranks one derived from reading alone.

4. **Explore (parallel).** Fan out `Agent` Explore agents (very thorough) over the affected modules under `packages/aitm/src/<module>/`, plus `packages/ai-claude-compat` if the AI-SDK/compat layer is involved: patterns to mirror (`file:line`), the paired unit tests vs integration under `packages/aitm/test/integration/`, and the constraints. Give each a **disjoint** area, and require of every finding severity, `file:line`, a one-sentence defect statement and a **concrete failure scenario** (inputs → wrong outcome). Demand two more things: the doc claims they **falsified**, and the brief premises that turned out **true**. Produce a ranked worklist; log what the survey could not cover. **Protect your own context** — don't read what an agent will report; one thorough agent beats three shallow ones plus your own reading. (There is no codegraph index in this repo; `Grep`/`Glob` over the module map is the structure tool.)

5. **Fold in live user reports as first-class findings.** A mid-run console trace, a failing run's log or a GlitchTip link is *confirmed in real use* and routinely outranks the audit's own findings. Reproduce, root-cause, rank above equal-severity read-only findings. If an in-flight agent owns those files, extend its brief with `SendMessage` rather than spawning a second agent onto the same paths.

6. **Track in GitHub issues — SEARCH BEFORE YOU CREATE.** `gh issue list --search …` the area, open *and* recently closed: already tracked, partly tracked (add a task under the existing parent), or a closed issue already decided what you are about to re-decide — all three beat a fresh ticket. Create the parent *after* exploration so it carries real content (findings with `file:line`, the reproduction, the deferred list). One checklist item per slice; each PR says `Fixes #NNN`; don't close the parent until every PR is merged. GitHub issues are the **only** tracker here — don't invent another.

7. **Build — branch first, then fan out.** Before a single agent starts, get off `main` while the tree is still clean:

   ```bash
   git fetch origin && git status --short   # expect a clean tree
   git checkout -b <type>/<slug>            # fix/ feat/ test/ refactor/ docs/
   ```

   Fix slice boundaries **before launching anyone**, each file set **disjoint**. Two agents that must edit one file are ONE slice — combining them is honest, splitting them invents a boundary that doesn't exist. For a multi-surface change, never solve the same problem N ways: build one reusable primitive — a module (or a helper on an existing one) with a single responsibility — and **land it with its first real caller**; no abstractions before consumers, inline first and extract on the second real caller.

   Every brief carries all nine of these; omitting one is how a run goes wrong:
   - **its exclusive file set** (module dir + its paired tests), never to edit outside it;
   - **which other agents are live on which paths**, so a collision is *reported*, not silently resolved;
   - each finding with `file:line`, the defect and the concrete failure scenario — plus permission to **drop any finding the code contradicts** (that is the agent working correctly);
   - **evidence first, diagnosis second**: symptom, the run log or GlitchTip fingerprint, the failing input — *then* your hypothesis, explicitly labelled unverified, to confirm or kill before building. Confident briefs send agents to the wrong module;
   - the **house constraints binding its area**: SRP (split a file that grows a second reason to change), **no legacy** — a replaced design is DELETED, not kept behind a flag/alias/fallback (the only safety net is "do less"), no `any` / `as unknown as` (use `unknown` and narrow), named exports only, ESM only, kebab-case files, **portability** (no `Bun.file`/`Bun.$`/`Bun.spawn` in shipped code; `node:fs/promises`, `execa`, web `fetch`), OpenRouter-only inference through `credentials/`, secret redaction at every output channel;
   - **tests ship with the code, failure case first** — every module has a paired `*.test.ts` (**no test, no merge**; the only exemptions are pure re-export barrels and test-only support modules), and for a bug, a test that fails before the fix;
   - **checks narrowed to its OWN files** (table above); never the root suite, never integration, never `gh` writes;
   - **no git operations at all** — no branch, commit, checkout or stash; the coordinator owns all git, work is left uncommitted;
   - **never tell an agent to "ask me" — it cannot.** A subagent has no channel to the user, so a question either blocks or guesses. Give it the two legal moves: **decide and flag it** (act on the most defensible reading, state the assumption, mark the artifact so you can overwrite it), or **stop and report** with evidence when proceeding either way would be unsafe or wasted. Then *you* take the question to the user and re-task it with `SendMessage`.

   Small feature → one agent, skip the fan-out.

8. **Verify.** Once, at the end, as coordinator, and in the **background** for the long ones: `bun run typecheck`, `bun run typecheck:tests`, `bun run lint`, then the suite under **both runtimes** — `bun test` *and* `bun run test:node` — then `test:integration` against a real temp repo and real `gh`. Integration tests are the source of truth for behavior; no mocking of `gh` or the AI SDK there. For a CLI-facing change, drive the real entry points against a throwaway repo and confirm the observable output (phase/step lines, commits, PR). A logic bug ships with a reproducing test.

9. **PR + merge.** One PR in flight at a time — parallel *building* is fine, parallel *merging* is not (a merge churns `main` under every open branch).

   **Before committing, sweep the agents' leftovers**: scratch test files, debug logging, stray probes at the repo root, `tmp/` and `.ai-task-master/` run artifacts. Agents create them and rarely clean up.

   **Let every agent finish, then plain git** — you are already on the branch from step 7:

   ```bash
   git fetch origin                     # did main move? if so, see below
   git add <this slice's paths>         # NEVER a blind `git add -A` — read `git status --short` first
   git commit && git push -u origin HEAD   # Conventional Commit, scope = module, NO co-author trailers
   ```
   Naming paths on `git add` is all the selectivity needed — and **never `git stash`** (one global stack shared with every concurrent agent).

   **Main moves under you.** `git fetch` and intersect *files changed on main* with *files changed locally*; a real overlap is **three-way merged** (`git merge-file -p ours base theirs`), never taken wholesale — a naive build drops main's lines silently, with no conflict marker.

   Then merge: `claudetm merge-pr <pr>` (or dogfood `aitm merge-pr --pr <n> --admin`) waits for CI, fixes failures and addresses review comments including CodeRabbit. **`main` here requires one approving review**, so a solo-authored PR needs `--admin` — `gh pr merge <n> --squash --admin` is the hand path. `--admin` overrides the review policy; it never skips CI. **When every check already passes prefer `gh pr merge --squash --admin`**; `claudetm` can hang on an already-green PR. Two gotchas: **0 registered checks reads as "pass"** — wait for a plausible count AND zero pending, or it merges RED right after a rebase; and a **CodeRabbit quota failure** is deliberately tolerated (`github/check-tolerance.ts`), so don't chase it — a real verdict (`1 issue found`, `Review failed`) still fails and still needs fixing.

10. **Close, then release only if asked.** CI green on `main`; **re-verify the original symptom is gone** with the step-3 reproduction. Confirm each `Fixes #NNN` actually flipped, close stragglers by hand with a comment linking the PR, then close the **parent**. A release is separate and irreversible: bump the affected package version(s), merge, then publish a GitHub Release for the tag (`gh release create`) — `release.yml` publishes to npm via OIDC trusted publishing (no `NPM_TOKEN`, provenance automatic). Confirm it landed: `npm view @developerz.ai/aitm version` and a bin smoke test (`npx -y @developerz.ai/aitm@latest --help`). A bad version cannot be unpublished — the fix is a new version, and the user hears about it immediately. Finally, correct the docs your change invalidated, and when a defect could recur, land the guard (a paired test at the seam) in the same PR.

## Hard rules (from CLAUDE.md — non-negotiable)

**OpenRouter only** — OpenAI-compatible, no Anthropic SDK ever; all inference through `credentials/` (`OPENROUTER_API_KEY`). A target repo's `CLAUDE.md`/`AGENTS.md` is a *coding-style* signal for subagent prompts, **not** a provider signal. **SOLID / SRP** — one responsibility per module. **Every module ships a paired `*.test.ts` — no test, no merge** (exempt: pure re-export barrels, test-only support modules). **No legacy** — a replaced design is deleted, not flagged, aliased or fallen back to; the only exceptions are on-disk state/config written by an older version (`state/` migrations) and a one-release CLI/config key rename. No premature abstraction. **Portability is a hard requirement** — unchanged on Bun, Node ≥ 20, Deno ≥ 1.40; `node:fs/promises`, `node:child_process`/`execa`, web `fetch`; no `Bun.file`/`Bun.$`/`Bun.spawn` in shipped code. **ESM only.** TS `strict`, no `any`, no `as unknown as`. Named exports only. Files kebab-case, types PascalCase, functions camelCase. **Conventional commits, no co-author trailers.** Secrets are scrubbed at every output channel. **Out of scope — never add, stub or TODO** (stop and surface instead): mailbox/inbox; exposing `aitm` as an MCP server (it is an MCP **client** only); webhooks/inbound HTTP (except loopback-only OAuth redirects per RFC 8252); Docker/devcontainers/containerization. Never `--force` / `--no-verify` / skip hooks without permission. **Never `git stash`** (shared global stack).

## Output

A sweep that fixes 40 of 90 findings is a success only if the other 50 are named.

```
Root cause:  <the one-line mechanism, for a bug sweep>
Primitive:   <module/helper> @ packages/aitm/src/<module>/…  (PR #NNN, merged)   [sweeps only]
Fixed:       <n> findings across <m> PRs → #… #…
Deferred:    <n> — <what, and why not now>               [never omit this line]
Falsified:   <doc/issue claims that were wrong, now corrected>
Tests:       bun ✓ / node ✓   integration ✓   CLI smoke: <aitm start|merge-pr verdict>
Verified:    <the original symptom, re-checked in a real run>
Release:     @developerz.ai/aitm@<version> published  |  none this change
Issues:      #<parent> closed (<k> children)
```
