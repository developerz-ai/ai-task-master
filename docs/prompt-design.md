# aitm agent-logic prompt design

Design for the English "judgment" prompts of aitm's subagents, and the split between what the
harness (code) owns and what the prompt (English) owns. Ready-to-paste prompt text plus the exact
constants to change.

Sources used:
- Bible: `docs/02-skills-agents-commands.md` (subagents = specialized parallel workers, isolation,
  model control), `11-compressed-config.md` (value-words, lead-with-rule, one-rule-per-line, agent
  ≤50 lines), `12-behavioral-rules.md` (four failure modes; success-criteria beat instructions),
  `10-planning-and-docs.md` (plan = files + `step → verify`, concise), `08-ecosystem.md` (few
  parameterized tools beat many).
- claudetm (Python, single-Claude serial): `core/prompts_planning.py`, `prompts_working.py`,
  `prompts_verification.py`, `prompts_base.py` — phrasing for planning, per-task execution, the
  push/create/commit modes, and the `VERIFICATION_RESULT: PASS/FAIL` gate.
- aitm current prompts: `packages/aitm/src/subagents/{worker,planner,reviewer}.ts`,
  `orchestrator/orchestrator.ts`, `subagents/role-prompt.ts`, `subagents/specialist-registry.ts`;
  harness injection in `packages/ai-claude-compat/src/{prompt-blocks,system-reminder,env-block}.ts`
  and `packages/aitm/src/loop/run-loop-adapter.ts` (`harnessContextBlock`, `stepCounter`).

---

## 1. Harness (code) vs agent (English) split

**The harness is the loop; the prompt is the judgment.** Code owns everything deterministic and
verifiable: the group/task walk, one branch per task in the current dir (no worktrees), the
manifest→editor fan-out mechanism, `git`/`gh`/CI/merge, state persistence, running the
format+verify commands, the schema-retry kernel, and *injecting* context (repo CLAUDE.md, specialist
roster, phase + N/M, plan/task text, style digest, date) into stable prompt slots. The English
prompt owns only the decisions a model must make: how to split a task and how many leaves to spawn,
right-sizing each slice, what to change and where, which review outcome to pick, and the pre-PR
adversarial read. Anything a `switch` can decide stays in code; anything needing taste stays in the
prompt. This keeps prompts short (every line is a judgment) and keeps the prefix stable for provider
prompt-caching.

Role map onto aitm today: the **Worker is the task-level coordinator** — it plans the manifest and
decides the split and how many per-file editors to spawn; the harness executes the fan-out. The
**editors are the single-level leaves** (their tool set already has `explore`/`memory` stripped, so
they cannot nest). The **Orchestrator** is harness-driven prose only (commit message + PR body). So
the "only the coordinator holds the spawn tool" rule already holds structurally — the prompts below
make it explicit and add the split/right-size judgment the current Worker prompt lacks.

---

## 2. Draft prompt text (ready to paste)

Style rules applied (bible ch.11/12): lead with the rule, one rule per line, value-words
(`MUST`/`NEVER`/`when`), no meta-framing, success-criteria over imperatives. Keep each prefix a
stable prefix — inject variable context via the harness, never by editing these strings per run.

### 2a. Coordinator (replaces `WORKER_SYSTEM_PREFIX`)

```
You are the Coordinator for one task. Turn the task into a set of file changes for a single PR,
and decide how to parallelize the work across per-file leaf agents.

Survey first, with the read tools (glob/grep/readFile, and `explore` when present) — never plan a
change to a file you have not read. Prefer `explore` for broad or multi-file questions; issue
independent explore/read calls in one turn so they run in parallel; keep the conclusions, not the
raw dumps.

Then decide the split, and how many leaves to spawn, by submitting a file manifest — one entry per
file, each with a self-contained purpose. The harness spawns one leaf editor per entry, in parallel,
in the current directory on the task's branch.

Split heuristic — choose the axis that keeps each leaf independent:
- by file: the default; one leaf per file it fully owns.
- by role: split tests from implementation only when they live in separate files.
- by chunk: a very large file → still ONE leaf (one path = one owner); never two leaves on one path,
  they clobber each other.
Right-size: one leaf per cohesive file. Do NOT over-fragment — you have a large context; a handful of
related one-line edits belong in one leaf's file, not five. Do NOT under-split — a 600-line
green-field file plus its test is two leaves, not one overloaded brief. When the task is small or the
files are tightly coupled, ONE leaf (or a single-entry manifest) is the right answer; splitting is not
free.
Parallel vs serial: leaves within this task run in parallel, so every entry MUST be independent — no
leaf may depend on another leaf's output. Dependencies across tasks are the harness's job (tasks run
one branch at a time); dependencies within a task mean you split on the wrong axis — merge those files
into one leaf.

Each purpose is the leaf's ENTIRE brief — it never sees the task, the plan, or its siblings. Write it
as a spec: what to change, where (file:line when known), and the contract it must satisfy. A vague
purpose produces a wrong file.

You — not the leaves — own verification and the submit. `draftCommitMessage` is a hint the harness may
rewrite: conventional subject, ≤72 chars. Only you spawn; leaves never spawn.

If earlier conversation was summarized (compaction), resume from the summary — do not re-plan from
scratch or hand off early.
```

Rationale: encodes split-axis + right-size + parallel-independence + "only you spawn" + "you own
verification", the five product principles, in the one place the model actually decides them. Keeps
the survey-first and compaction lines from today's prefix; drops the two-layer/SDK jargon (that is
harness concern, not model judgment).

### 2b. Leaf worker / specialist (replaces `EDITOR_SYSTEM_PREFIX`)

```
You are a leaf editor. You own ONE file. Your brief is one path + one purpose — you cannot see the
plan, the task, or the other files, and you MUST NOT spawn or delegate. Realize the purpose fully,
here, then stop.

- create → `writeFile` with the complete contents.
- modify → `readFile` first (editing unread content corrupts it), then `editFile` (one exact
  replacement) or `multiEdit` (several, atomic). Batch related edits into one `multiEdit`; a full
  rewrite is `writeFile`.
- delete → `bash rm -f <path>`.
- ordered shell (`mkdir … && generate && test`) → one `multiBash` with the commands in order; it
  stops at the first failure so you see which step broke. Batch; do not fire shell calls one at a time.
Independent calls go in the same turn (parallel). Match the file's existing style; add nothing the
purpose did not ask for — no drive-by refactors.

Stuck on an API/error/version? `webFetch` a doc URL (`fetchHtml` for scraper-hostile sites, when
available); `datetime` for the current time.

Your first line is returned as this file's summary: one line, present tense, specific —
`adds retry+backoff to fetchUser`, not `done`.
```

Rationale: "you're a leaf; do your slice; batch; don't spawn" made explicit (bible ch.12 surgical +
ch.08 batch/parameterized tools). Specialist guidance from `.claude/agents/*.md` is layered on by
`composeSpecialistGuidance` and needs no change — it already frames the specialist as refining *how*
the leaf works, not replacing the contract.

### 2c. Planner (replaces `PLANNER_SYSTEM_PREFIX`)

```
You are the Planner. Goal (+ optional acceptance criteria) → a DAG of PR groups. Ground every group
in real code first with the read tools (glob/grep/readFile, and `explore` when present) — do not
invent files.

Each group = one cohesive PR: ≤~300 LOC, independently reviewable — a reviewer needs no other group
open to judge it. If a group only makes sense beside another, merge them.

- Emit ≤ maxPrs groups; fold any tail into the last group.
- `dependsOn` = only the earlier groups whose code this one builds on; empty for roots. Wrong deps
  serialize work that could run in parallel — prefer parallel siblings over one linear chain.
- Each task carries a complexity tag (routes the coding model) and, under it, the files it touches
  (file:line when known) so the Coordinator can survey fast.
- Attach an acceptance check to each group — the command or observable that proves it done
  (`step → verify: check`). Success criteria let the run loop to completion without a human.

Confirm an external API/framework/version before planning around it: `webFetch` a doc URL
(`fetchHtml` when available); `datetime` for the current time.
```

Rationale: keeps today's group-sizing and dep-DAG lines; adds claudetm's file:line-under-task hints
and the ch.12 `step → verify` acceptance check, so downstream Coordinators and the self-review have a
verifiable target. Multi-provider note: no model-name routing table (claudetm hard-codes Opus/Haiku
tiers in its planner — aitm routes by capability tier in code, so the prompt stays provider-neutral).

### 2d. Reviewer (keep `REVIEWER_SYSTEM_PREFIX` shape; tightened)

```
You are the Reviewer. You get ONE unresolved PR review thread. Pick exactly one outcome and submit it.

- "fixed": the comment is right and needs code. Locate (grep/glob/readFile), change
  (editFile/multiEdit/writeFile), reply via `github` explaining the fix, resolve the thread. Submit
  { kind: "fixed", commitMessage } — the subject the harness commits. NEVER run git yourself.
- "replied": a question, no code change. Answer via github.replyToThread, leave the thread open.
  Submit { kind: "replied" }.
- "wontfix": stale, out of scope, or you disagree. Reply with the reason, resolve the thread. Submit
  { kind: "wontfix", reason }. Disagree when the comment is wrong — say why, don't silently comply.

Verify any claim in the comment (API, error, spec, changelog) before acting: `webFetch` a doc URL
(`fetchHtml` when available); `datetime` for the current time.

If earlier conversation was summarized, resume from the summary; do not re-decide a resolved thread.
```

Rationale: current prompt is already good; only add the explicit "disagree when wrong" from ch.12 so
a weak model doesn't rubber-stamp every comment. Reply-then-resolve flow matches claudetm's
`fix-coderabbit`/PR-review handling.

### 2e. Self-review (new prefix for the self-review session)

The self-review session currently reuses the Worker path with a verify command and no dedicated
prompt. Give it an adversarial prefix so the Coordinator's own diff gets a hostile read before the PR
opens:

```
You are the pre-PR self-reviewer. Read the diff about to become a PR as a hostile reviewer would,
then fix what you find — you own this gate.

Adversarial pass, in order:
1. Correctness: bugs, wrong edge cases, off-by-one, unhandled errors the change introduced.
2. Scope: every changed line must trace to the task — revert drive-by edits and reformatting.
3. Contract: does it meet the task's acceptance check? Run tests and lint (the verify command).
4. Style: matches the repo's conventions and the coding-style digest.

Fix real problems with the edit tools; leave a pre-existing issue you did not cause as a note, don't
bundle it. Do NOT claim green unless a tool result in this run shows it. When the diff is clean and
verify passes, submit — a partial-but-honest report beats an unearned "looks good".
```

Rationale: makes "the coordinator owns a pre-PR adversarial self-review" a real prompt (ch.12
four-failure-modes as a checklist; ch.11 value-words). The faithful-reporting clause reinforces the
always-on `communicationContract` block.

### 2f. Orchestrator (tighten `ORCHESTRATOR_ROLE_PREFIX`)

The Orchestrator is harness-driven and only composes prose today, so keep it minimal — but state the
spawn boundary so a future model-driven orchestrator inherits it:

```
## Role: Orchestrator

You coordinate Planner, Worker (Coordinator), and Reviewer, each exposed as a tool. You see the whole
plan and the rolling context, so you own the per-PR prose: the final commit message and the PR title
+ body.

Flow:
  1. planner → the PR-group DAG (once).
  2. each ready group → worker; the harness commits + opens the PR.
  3. each PR with unresolved threads → reviewer.
  4. stop when every group is merged or blocked.

Rules:
  - Only you route between subagents; subagents are leaves and never spawn each other.
  - Specific and terse. No marketing prose. Conventional commit subjects, ≤72 chars.
```

---

## 3. Harness-injection spec

Two injection surfaces, both already built — the design is to keep the **system prompt a stable
prefix** (cache-friendly) and put all per-run variability in the **first user message**.

### System prompt (stable prefix, per role) — `buildRolePrompt` in `role-prompt.ts`

Assembled by the `prompt-blocks.ts` pipeline in this canonical order (stable across runs, so the
provider caches the prefix):

| Slot | Content | Source |
|---|---|---|
| `harnessContract` | parallel tool calls, `file:line`, markdown out | `HARNESS_CONTRACT_TEXT` (const) |
| `communicationContract` | lead-with-outcome, faithful reporting, no unverified "done" | const |
| `selfId` | `You are running as the model <id>` (+ cutoff) | harness injects resolved `modelId` |
| `sessionGuidance` | **the role prefix from §2** + `stepBudgetLine(maxSteps)` | role const + code |
| `style` | coding-style digest (StyleDistiller) or raw CLAUDE.md/AGENTS.md | harness injects |
| `env` | `<env>` cwd, is-git-repo, platform, model id, **today's date** | `envBlock` (code) |
| `memoryIndex` | repo MEMORY.md index, advisory framing | harness injects when non-empty |
| `autonomy` | act-in-scope, verify-before-commit, no trailing promises | const |

Plus `SYSTEM_REMINDER_CONTRACT` appended for reminder-decorated agents. **Specialist roster**: the
Coordinator's `sessionGuidance` gets the matched `.claude/agents/*.md` body layered on via
`composeSpecialistGuidance` (selected in code by `selectSpecialist`); the roster itself is not dumped
into the prompt — only the one selected specialist, to keep the prefix small.

Keep the role constants (§2) verbatim and identical across runs — they are the cache key. Everything
run-specific goes below.

### First user message (per-run, variable) — `harnessContextBlock` + prompt builders

Prepended as one `<system-reminder>` envelope by `contextReminder`/`prependContextBlock`:

| Injected | Where | Notes |
|---|---|---|
| repo CLAUDE.md / AGENTS.md (`claudeMd`) | context reminder | advisory, framed "may not be relevant" |
| current date (`currentDate`) | context reminder | also in `<env>`; date is the one duplicated signal |
| **current phase + N/M step** | prompt body | from `stepCounter` — surface it in the user message, not only in `harnessProgress` logs (today it is logging-only) |
| plan / group / task text | prompt body | `buildManifestPrompt`, `buildUserPrompt`, `buildThreadPrompt` |
| branch, base branch, cwd | prompt body | current dir, no worktree |
| rolling context from prior PRs | prompt body | when non-empty |
| verify output tail (fix passes) | prompt body | `buildVerifyFixTask` |

Design change to make here: add the **phase + N/M** line to each subagent's first user message (a
`Step N of M — <phase>` line), so the model knows where it is in the run. It already exists as
`RunStep`/`stepCounter` for observability; route it into the prompt too. Untrusted, agent/CI-authored
context (memory entries, review-thread bodies) stays quoted/fenced as data — that guard already
exists in `memoryIndexBlock` and must be kept for anything injected.

---

## 4. aitm files/constants to change

| File | Constant | Change |
|---|---|---|
| `subagents/worker.ts` | `WORKER_SYSTEM_PREFIX` | replace with §2a Coordinator text (adds split/right-size/parallel-independence/own-verification/only-you-spawn). Biggest win. |
| `subagents/worker.ts` | `EDITOR_SYSTEM_PREFIX` | replace with §2b leaf text (explicit "you're a leaf, don't spawn, batch edits"). |
| `subagents/worker.ts` | `buildManifestPrompt` | add `Step N of M — working` line (thread `stepCounter` in via `WorkerInput`). |
| `subagents/planner.ts` | `PLANNER_SYSTEM_PREFIX` | replace with §2c (add file:line hints + `step → verify` acceptance check). |
| `subagents/reviewer.ts` | `REVIEWER_SYSTEM_PREFIX` | add the "disagree when wrong" line (§2d). |
| `loop/run-loop-adapter.ts` (self-review path) | new `SELF_REVIEW_SYSTEM_PREFIX` | add §2e; pass it as the self-review session's `roleGuidance` instead of reusing the plain Worker prefix. |
| `orchestrator/orchestrator.ts` | `ORCHESTRATOR_ROLE_PREFIX` | tighten to §2f (add the spawn-boundary rule). |
| `loop/run-loop-adapter.ts` | `harnessContextBlock` | add a `phaseStep` section (or add the line to each prompt builder). |

Before/after on the two biggest wins:

**Worker → Coordinator** (before): `"You are the Worker. One PR group → a file manifest… Phase 1
only… Phase 2 is out of your hands: the runtime fans the manifest to parallel editors."` — describes
the mechanism, gives no split/right-size judgment.
(after): §2a — same mechanism, but the model is now told *how to decide* the split axis, how many
leaves, when one leaf is right, that leaves must be independent, and that it owns verification. The
judgment moves into the prompt; the mechanism prose (which is code's job) is dropped.

**Editor → Leaf** (before): `"You are a per-file editor. You get ONE file path and a purpose…"` —
already leaf-shaped.
(after): §2b adds the explicit "MUST NOT spawn or delegate" and "batch related edits into one
multiEdit; do not fire shell one at a time" — the ch.08 few/parameterized-tools + batch discipline
that the current text only implies.

---

## 5. Copy from claudetm vs do differently

**Copy (phrasing that transfers):**
- Terse output contract: "Don't announce actions — take them. Fragments fine. Completion report 3-5
  lines: what changed, not how." (`prompts_working.py` intro) — already partly in aitm's
  `communicationContract`; keep the tone.
- `step → verify` per task and the hard `VERIFICATION_RESULT: PASS/FAIL` first-line gate
  (`prompts_verification.py`) — reuse the shape for §2e self-review (submit only when verify is green).
- Plan format: file:line + implementation hints *under* each task, not as prose (`prompts_planning.py`
  Step 2) — fold into §2c.
- "Read project conventions FIRST (CLAUDE.md, CONTRIBUTING, .cursorrules)" — aitm already does this
  *in code* via `AgentConfigDetector` + the injected `claudeMd`/`style` block, so it need not be
  re-stated in every prompt (harness owns it, not the model).
- "Focus on THIS task only — don't work ahead" — keep as the Coordinator's scope discipline.

**Do differently (aitm is multi-provider + subagent-parallel; claudetm is single-Claude serial):**
- **No model-name routing in prompts.** claudetm's planner hard-codes `[coding]→Opus 4.8`,
  `[quick]→Haiku`. aitm routes by capability tier in `Credentials`, possibly across vendors — keep
  complexity tags but never name a model in the prompt. `selfId`/`env` state the actual model at
  runtime instead.
- **No git/PR/CI verbs in the prompt.** claudetm's work prompt is a 9-step `git add`/`rebase`/`gh pr
  create` script embedded in English (`_build_full_workflow_execution`). aitm's harness owns branch,
  commit, rebase, push, PR-open, CI — so the leaf/Coordinator prompts must *not* contain git commands;
  they return changes and the harness commits. This is a hard boundary, not a style choice.
- **Parallel, not serial.** claudetm runs one Claude per task, sequentially. aitm's Coordinator fans
  out to parallel leaves within a task — so the Coordinator prompt carries the split/right-size/
  independence judgment claudetm never needs, and the leaf prompt carries the "don't spawn, you're one
  of several running now" constraint.
- **Stable prefix for caching.** claudetm rebuilds the whole prompt per call with `PromptBuilder`.
  aitm splits stable system prefix (cached) from per-run user message — keep the role constants
  byte-stable and inject variability only in the first user message.
- **Faithful-reporting is load-bearing across weak routed models.** claudetm assumes Claude; aitm may
  route a weak model, so the "never claim done unless a tool result shows it" clause
  (`communicationContract`, §2e) matters more and must stay in the always-on blocks, not just the
  role text.
