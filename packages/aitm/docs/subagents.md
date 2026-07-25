# Subagents

`aitm` follows the Vercel AI SDK subagents pattern: an agent calls another agent as a tool. See https://ai-sdk.dev/docs/agents/subagents. The payoff — isolated context windows, focused system prompts, and natural parallelism.

## Composition

`Orchestrator` is the top-level agent. Its tool surface:

- The three subagents below.
- Low-level tools: `fs.read`, `fs.write`, `bash`, `GitHubClient` methods.

Subagents never call each other. Only `Orchestrator` composes them — the dependency graph stays a tree.

## Roster

| Subagent | Single responsibility | Tools it gets | Output contract |
| --- | --- | --- | --- |
| `Planner` | Turn goal plus repo survey into an ordered list of **PR groups**, each containing tasks. | Read-only subset: `readFile` (offset/limit), `grep`, `glob`. | `PrGroup[]` (Zod schema). Capped by `options.maxPrs`. |
| `Worker` | Implement one PR group on a dedicated branch (commits + branch); the Orchestrator opens the PR. | `readFile`, `writeFile`, `editFile`, `multiEdit`, `grep`, `glob`, `bash`. | Branch + draft commit message, or `blocked` reason. |
| `Reviewer` | Address PR review comments, push fixes, resolve threads. | The Worker's full set plus a `github` thread tool (`GitHubClient` GraphQL). | Resolution report per comment. |

The FS/edit/search/shell tools are the Claude-Code-style surface from `@developerz.ai/ai-claude-compat`, scoped to the active worktree. When an MCP server supplies some of them, the rest are partial-filled from the local set so a bare `aitm start` (no `mcpServers`) still works.

## Specialists

A repo that ships `.claude/agents/*.md` gets its own agents layered onto the generic Worker: work is routed to the best match, and that agent's guidance is appended to the role prompt. When a repo ships none, `bootstrapSpecialists` generates a team for the accepted plan (one smart-tier call) into `<stateDir>/agents/`, in the same frontmatter format — routing and resume behave identically either way. Repo-shipped agents always win.

**The name is the routing key.** `specialist-registry.ts` scores an agent against the task text by token overlap, weighting name words ×3 over description words, after dropping stopwords and tokens under 3 characters. That has a sharp consequence: a name like `code-specialist` is *entirely* stopwords, so it matches nothing, ever. Generated names are therefore normalized and validated at parse time (`sanitizeName`):

- lowercase kebab-case, 1–3 domain words, ≤24 chars — `sqlite-migrations`, `stripe-webhooks`, `cli-flags`
- meaningless suffixes stripped: `stripe-webhooks-agent` → `stripe-webhooks`
- a name with nothing routable left is dropped, as is one whose words a previously accepted specialist already claims (two agents sharing every word are a permanent tie)

Descriptions are router entries, not bios: *what it owns → `Use for <literal task keywords>` → `Do NOT use for <adjacent domain> — <the capability limit>`*. Bodies are rule lists (one imperative per line, no headings) — the generic agent already knows how to write code; the body carries only what is specific to this domain in this repo.

## The `explore` fan-out (issue #126)

The Planner and the Worker's manifest pass also get a read-only **`explore`** tool. Calling it spawns a fresh, bounded, fast-tier child that surveys the repo with the read-only trio (`readFile`/`grep`/`glob`) and returns a single self-contained conclusion. The child ingests the raw file text; the parent's context holds only the answer — so a survey phase no longer re-sends file dumps on every step of its own conversation (the pressure `#102`'s compaction repairs after the fact). Independent `explore` calls issued in one assistant turn run in parallel (AI SDK parallel tool execution).

Contract (built on compat's `makeAgentTool`):

- **Fresh context, self-contained prompt.** The child shares no parent conversation; the tool description states the prompt must carry every detail the child needs.
- **Read-only by allowlist.** `makeAgentTool` refuses (typed construction error) any child toolset key outside the explicit allowlist — the `explore` callers pass `['readFile', 'grep', 'glob']`. No recursion: the child toolset can never contain `explore` itself.
- **Bounded + failure-tolerant.** Default 15-step child cap and a 4000-char output cap (truncated with a marker). A step-cap exhaustion returns the last text (or a no-conclusion line); a child provider error is caught and returned as an error line — never thrown into the parent step. The parent's per-step deadline (`#129`) propagates into the child via the execute `abortSignal`.
- **Adapter-local glue, never MCP.** The child model is `credentials.modelForCapability('fast')` and its read tools are `resolveInside`-confined to the invoking agent's worktree — constructed in the run-loop adapter (same precedent as the Reviewer's `github` slot), never sourced from a server. Mounted as a runtime-only extra so the core `WorkerTools`/`PlannerTools` types are unchanged; records built without it (take-over flow, editors, test stubs) behave exactly as before. Editors strip it before their per-file fanout — editors never nest surveys.

## SRP

Each subagent owns exactly one phase of the lifecycle. Planning, building, and reviewing are separate concerns with separate prompts and separate tool grants.

## Context isolation

Subagent system prompts are assembled from `CLAUDE.md` or `AGENTS.md` plus a role-specific prefix plus an `<env>` block (`envBlock` from `@developerz.ai/ai-claude-compat`: worktree cwd, platform, OS version, runtime, date). The `<env>` block is composed at the wiring site via `composeSystemPrompt` because cwd is per-worktree. `AgentConfigDetector` decides which config file to read — it drives **coding-style** only. Provider is always OpenRouter; the per-role model id comes from `ConfigLoader` (`models.planner`, `models.worker`, `models.reviewer`), so each subagent can run on a different OpenRouter-routed model.

## Context carry-over

A group's tasks run sequentially against the same checkout, and each one used to cold-start its own Coordinator. Timing a real run showed the cost: roughly half the wall-clock went to re-orientation — every task re-read the same dozen files (`repository.ts`, `errors.ts`, `app.ts`, `package.json`, each 4–6 times across one group) and then wrote ~40 lines. Survey cost does not shrink with task size, so paying it per task is the largest single tax on throughput.

The Coordinator's conversation is now carried task→task for the life of a group (`run-loop-adapter.ts`). Only the **messages** travel: task N+1 builds a fresh agent — its own routed specialist, its own acceptance block, its own step budget — and inherits the history, the same shape the crash-resume path uses. An in-memory carry-over beats a durable transcript (it is strictly fresher), a `blocked` pass leaves the previous carry-over in place rather than dropping the group to a cold start, and nothing crosses a group boundary.

Compaction still applies: the Coordinator's `prepareStep` compacts a long carried history exactly as it does a long single-task one.

## Self-review reviews against intent, not just the diff

The pre-PR self-review is adversarial by design, and it deliberately does **not** inherit the coding pass's conversation — a reviewer that inherits the author's rationalizations stops being adversarial. It does receive one thing beyond the diff: the group's **planned work**, as facts.

That closes a real hole. A phantom edit (the coding model narrating a file instead of writing it) once shipped a PR containing its services and none of its routes; self-review passed it, because it only ever looked at the diff, and the diff was internally consistent. Work that was planned and is missing is now a defect the review pass is told to find and write — a PR that ships half a feature and looks green is the failure mode this catches.

### The review pass does not fan out over its own edits

A reviewer fixes what it finds as it finds it: it reads the diff, spots the bug, and edits. Its manifest therefore describes work that is **already on disk**, and fanning editor leaves out over it makes them re-derive finished changes. Observed on a real run: two editors, ~70 seconds, a net **zero-line** diff — one leaf spent its turn `sed`-reverting and restoring a file to re-prove a regression test it had not written, while the other argued with a stale `git status` before concluding the fix was already there and running `git add`.

The `applied` flag on the manifest already existed for this; the review pass simply never set it. Rather than depend on a model remembering a flag, the self-review Worker runs with `inlineEditsExpected`, and its manifest is treated as applied when **every** planned file was edited during planning. Two conditions, both required:

- **dirty now** — the change is really on disk, not merely described;
- **not dirty before** — it is this pass's work, not dirt the task inherited (the tree is snapshotted before planning).

It is all-or-nothing: a partially-edited manifest still fans out, so a leaf with real work left is never skipped because a sibling's file happened to be finished. And it is scoped to the review pass — the normal coding path keeps planning and editing as distinct phases, and skips the extra `git status` entirely.

## Leaf hand-off

An editor leaf used to receive nothing but its manifest entry's `purpose`, so every leaf independently re-read the files the Coordinator had *just* finished reading — four leaves, four surveys of the same set. The Coordinator now fills a `sharedContext` digest in the `submit` it was already making (no extra round-trip), and each leaf's prompt opens with it plus two harness facts: the verify command the edit must clear, and that the formatter runs after the leaf, so it must not hand-fix formatting or import order.

It is a **task, not a dump**: what to change, where, the contract, and only the conventions that bear on this edit, capped so a fanout doesn't pay for preamble ×N. A leaf can still read whatever it likes — this is a head start, not a restriction. Nothing to distil → the leaf prompt is byte-identical to before.

## No step budget — agents run until they submit

Every subagent terminates when it calls `submit` (`createSubagent` pairs `stepCountIs` with `hasToolCall(submit)` in its `stopWhen`). The per-role step counts (planner 20, worker 30, editor 12, reviewer 20) were never the finish line — only a runaway guard — and at those low values they fired *before* an agent finished exploring, cutting real work off mid-task. Autocompaction now bounds **context**, so the step count no longer needs to. All roles share one high `AGENT_STEP_BACKSTOP` (1000): far above any real task, so it never binds in practice, while still stopping a pathological non-terminating loop. The per-step wall-clock deadline (`llmStepTimeoutMs`) is the orthogonal per-step guard. No prompt tells an agent to ration steps — that only rushed it against quality.

Editor leaves are the one exception to "terminate on submit": a leaf has no `submit` tool, so it ends on a plain text response or the backstop. A leaf that keeps calling tools without finishing is exactly the runaway the backstop catches.

## Cancellation

One `AbortSignal` — the CLI's SIGINT/SIGTERM handle, carried as `RunLoopInput.signal` — reaches every subagent through its init (`SubagentInit.signal`, `ScoutAgentInit.signal`) and is forwarded to `createSubagent`, which applies it to **every** generate that agent makes.

Agent-scoped rather than per-call, because the calls that matter are not all driven by the caller: `runWithSchemaRetry` owns its own re-invocations (Planner, Reviewer, scouts), so a signal handed in at the call site could never reach them. It **composes** instead of replacing:

- with the configured per-step deadline (`llmStepTimeoutMs`) — whichever fires first aborts the step, and a cancel is never relabelled as a deadline breach;
- with a per-call `abortSignal` — both are honored, so a call that brings its own signal is still cancellable by one Ctrl-C.

It also ends the retry kernel: an aborted run never sits out a backoff window nobody is waiting for.

The editor fanout is the one set of generations an agent init cannot reach — the leaves are raw `generateText` calls sharing the fanout's own `AbortController`, not agent steps. That controller links to `WorkerInput.signal`, so the same run signal has to arrive twice: once on the agent (Coordinator) and once on the Worker input (leaves). Production passes it on both from one expression per call site — `WorkLoop` → `WorkerInvocation.signal` for the task path, and the run signal directly in the CI-fix, self-review and take-over sessions. Without the second, a Ctrl-C stops the Coordinator while every leaf keeps generating against a run that is already over.

The optional half of a `SubagentInit` is forwarded through one helper (`forwardInit`), so every role passes the same dial set — before it, each factory hand-rolled the spread and quietly dropped fields the others forwarded.

The same signal also runs the loops *between* subagent calls, where a run spends most of its wall clock: `StageDeps.signal` carries it into the stage machine, which hands it to `waitForChecks` and to the post-CI review grace; the take-over loop threads it through its CI poll, grace and cooldown; the shared rebase path stops before another AI conflict-resolution pass. Sleeps **resolve** on abort rather than rejecting (`defaultSleep`), so each loop re-checks `signal.aborted` at the top of its next iteration and decides what a cancelled run returns — a cancelled `waitForChecks` comes back `pending`, which is a *non-verdict*: every caller re-checks the signal before treating it as CI state, so no cancelled run routes into a fix pass or walks on to `gh pr merge`.

## Throughput guards

Three mechanical limits, each traced to an observed waste:

- **Survey budget.** A manifest pass that makes 20 tool calls without a single write gets one corrective reminder pointing at `submit`. `bash` counts as survey — the observed spiral was `cat`/`ls`/`find` plus a `bun install` probe, 40 calls deep, inside *planning*. It nudges; it never fails the pass and never forbids reading.
- **Fanout floor.** A manifest that is small, cheap, and creates no new file runs inline in one editor pass instead of spawning N. The observed pathology was four subagent spawns — four surveys, four verify runs — to sort imports and expand a one-line `exports` field.
- **Phantom-edit retry.** A leaf that narrates a change instead of writing it is retried once with a corrective prompt naming the failure, scoped to the unwritten paths. Only a second narration blocks. Previously the first one blocked the whole task, which is how a PR shipped its services and none of its routes.

## Scout survey before planning

The Planner is a single agent that surveys the repo one grep/read at a time before it can plan — measured at ~8 minutes on a real run, most of it discovery. A **survey team** runs first and hands it a map, so its own steps go to structure instead of discovery. The team works like a construction crew sizing up an existing building: look at the site, report to the chief, then the chief splits the work.

1. **The map** (`workspace/repo-skeleton.ts`) — no LLM at all. `git ls-files` folded into a ranked directory tree (top-level → depth 3, with file counts) plus the root manifests. Every agent downstream starts from it, so nobody spends their opening steps re-learning where the repo keeps its code.
2. **The lead** (`scout-lead.ts`) — takes a sneak peek with the read-only tools, then decides **how many scouts and where**, capped at `SCOUT_MAX_ASSIGNMENTS`. One scout is a legitimate answer and the prompt says so outright: a scout is not rationed, it reads as much as it judges necessary, so splitting only pays when the ground genuinely divides. The lead sizes each assignment before sending it — too big if it crosses unrelated areas, too small if it lands in a neighbour's files — and briefs each scout with sub-questions, start paths, files to read in full, and the identifiers this codebase actually uses.
3. **The scouts** (`planner-scouts.ts`) — read-only, concurrent, bounded by `SCOUT_CONCURRENCY`. The briefing is a floor, never a ceiling: the lead picked its leads off a map, not off the code, so a scout covers them, corrects them where they are wrong, and follows the question wherever it actually goes. Each returns a schema-validated `ScoutFinding` — summary, facts anchored to `file:line`, relevant paths, and what it could not settle.
4. **The gap round** (`scout-survey.ts`) — the same lead reads the findings and either declares the map good enough (an empty wave, the expected outcome) or aims one small follow-up at named holes. Bounded at `SCOUT_MAX_ROUNDS`; an assignment key already dispatched is never re-sent.

The findings synthesize into one brief, led by the map, that the Planner reads up front — framed as leads to verify, not as gospel.

What the scouts return is capped and structured on purpose. An unbounded prose report per scout would put the raw reads back into the Planner's context, which is the cost the survey exists to avoid; the caps bound the *report*, never the scout's own reading.

Planning is the *only* phase that gets a survey team: coding-style distillation and specialist generation are each already a single LLM call over pre-gathered inputs, so parallelizing them would split one call into many for no gain. Best-effort throughout — a git failure yields no map, a dead lead falls back to a fixed assignment set, a dead scout drops just itself (like a failed editor leaf), and a survey that returns nothing leaves the Planner prompt byte-identical to the un-surveyed path. It accelerates planning; it can never fail it.

## Schemas

Inputs and outputs of every subagent are Zod-validated. Handoffs between `Orchestrator` and subagents are predictable, typed, and refuse malformed payloads at the boundary.

## Failure surface

Each subagent returns a discriminated-union result — `ok`, `blocked`, `needs-input`, `error`. `Orchestrator` interprets the variant and decides retry, escalate, or mark blocked in `StateStore`.

## SRP + tested

Each subagent is a pure factory: `(model, tools, systemPrompt) -> Agent`. The factory is unit-tested; the integration behavior is covered by end-to-end tests in `test/integration/`. No subagent ships without both.

## See also

- `./commands/start.md`
- `./commands/merge-pr.md`
- `./task-groups.md`
- `./coding-style.md`
- `./config.md`
- `./architecture.md`
- `./agent-config-detection.md`
