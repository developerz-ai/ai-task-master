# Findings — subagents/ + orchestrator/

> Raw report from parallel audit agent. Scope: `packages/aitm/src/{subagents,orchestrator}/` (+ `packages/ai-claude-compat/src` references).

## Bugs / correctness

- [severity: med] [category: bug] `subagents/planner.ts:80-99` — `createPlannerAgent` silently drops `init.prepareStep` and `init.providerOptions` even though `SubagentInit` carries both (worker forwards both at `subagents/worker.ts:292-294`; reviewer forwards `prepareStep` at `subagents/reviewer.ts:134` but drops `providerOptions`), so Planner compaction or OpenRouter server tools wired by a caller are silently lost; forward them, or narrow each role's init type so unsupported fields are compile errors.
- [severity: med] [category: bug] `subagents/reviewer.ts:283-292` — `commitFix` stages `git add -A`, sweeping ANY dirty file into a thread's "fixed" commit, including stray edits left by an earlier replied/wontfix thread of the same pass (no per-thread or end-of-pass stray-edit cleanup like the worker's `discardStrayEdits`); stage only paths edited for this thread or reset stray edits between threads.
- [severity: med] [category: bug] `orchestrator/orchestrator.ts:793-806` — `refineCommitMessage` uses raw model text with no validation or fallback: an empty/fenced/over-72-char response goes straight into `git commit --amend -m` (orchestrator.ts:774), where an empty message fails the whole group at finalize; fall back to `delivery.draftCommitMessage` and strip fences, mirroring `composePr`'s total-function design.
- [severity: med] [category: bug] `subagents/worker.ts:653-676` — in `commitWithVerify`, a fix pass that returns `blocked`/`error` may still have written files; if the re-verify then passes, `stageAndCommit` (worker.ts:675) commits those edits but `extraChanges` only captures `fixed.kind === 'ok'` (worker.ts:662), so committed files are missing from `delivery.changes` and hence the PR body/commit narration; derive extra changes from a tree diff instead of the fanout outcome.
- [severity: med] [category: bug] `subagents/worker.ts:653-661` with `686-694` — the verify fix pass spreads `{...input, task}` so `planManifest` continues the stale `input.priorHandle` (a previous CI-fix run's conversation) instead of `planned.handle` from the first pass of this very run, losing the just-planned manifest context the #107 continuation mechanism exists to preserve; thread `planned.handle` into the fix pass.
- [severity: low] [category: bug] `subagents/worker.ts:797-801` and `1364-1368` — `dirtyPaths`/`hasStrayEdit` parse porcelain with `line.slice(3)`, which mis-parses rename records (`R  old -> new`) and git-quoted paths, so an inherited-dirty renamed file can defeat the inline-edit inference (`dirtyBefore.has(file.path)` at worker.ts:828 never matches); use `git status --porcelain -z` and parse records properly.
- [severity: low] [category: bug] `orchestrator/subagent-tools.ts:90-94` — `plannerInputSchema` lets the orchestrator's model choose any positive `maxPrs` unbounded, unlike the operator-configured cap on the direct path; clamp it against a dep-provided ceiling.
- [severity: low] [category: bug] `subagents/worker.ts:1170` (also 794, 1344, 1403, 1467; reviewer.ts:338) — `Date.now()`-based toolCallIds collide when parallel editors run `editorTouchedPath` in the same millisecond; use a counter or `crypto.randomUUID()`.
- [severity: low] [category: bug] `orchestrator/subagent-tools.ts:235` — `summarizeReviewerResult`'s error line drops the partial `resolutions` the error result deliberately carries (reviewer.ts:95), so the orchestrator model can't see threads 1..N-1 were already resolved; include the count.

## Prompt-injection surfaces

- [severity: med] [category: bug] `subagents/worker.ts:1430-1439` → `713-721` — `buildVerifyFixTask` embeds `verifyOutputTail` (raw stdout/stderr of repo-authored test code — a hostile repo can print directives) as trusted `task.text` interpolated unfenced into the manifest prompt (worker.ts:715); route verify output through a `data` envelope like `review-comment` (`prompts/slots.ts`).
- [severity: low] [category: bug] `subagents/prompts/slots.ts:66-69` — `defuseEnvelopeTags` defangs only the slot's own envelope, so a hostile review comment may still contain literal `specialist-guidance`/`env`/`system-reminder` tags forging trusted-looking regions inside the fence; defang all known envelope/reminder tags, not just the current one.
- [severity: low] [category: bug] `orchestrator/orchestrator.ts:816-819` and `927-929` — `buildCommitPrompt`/`buildPrPrompt` interpolate model-authored `draftCommitMessage` and per-file `summary` uncapped and unfenced (the worker caps every such field at `MANIFEST_FIELD_MAX`, worker.ts:378); apply the same slice-cap discipline.

## Missing resource cleanup / abort propagation

- [severity: med] [category: resource] `subagents/worker.ts:686-703` — the manifest-planning loop (`runSubagent`/`continueSubagent`) never receives `WorkerInput.signal`; only the editor fanout honors abort (worker.ts:1110), so SIGINT during the long planning phase keeps burning LLM calls to completion. Root cause: compat's `runSubagent`/`agent.generate` accepts no signal (`ai-claude-compat/src/subagent.ts:935`); plumb an abortSignal through.
- [severity: med] [category: resource] `subagents/planner.ts:46-61`, `subagents/reviewer.ts:68-83`, `subagents/planner-scouts.ts:130-136` — `PlannerInput`, `ReviewerInput`, and `ScoutAgentInit` carry no abort signal at all, so a run-level SIGINT cannot cancel planning, review-thread, or scout LLM loops (scouts additionally swallow every error via `.catch(() => null)` at planner-scouts.ts:185, including cancellation).
- [severity: low] [category: resource] `subagents/worker.ts:1019` — `runEditorFanout` never passes `controller.signal` to `runPool` even though the pool supports `options.signal` (`ai-claude-compat/src/pool.ts:16-56`), so abort is only observed inside `generateText`, not between calls.
- [severity: low] [category: resource] `orchestrator/subagent-tools.ts:64-78` — `WorkerToolDeps` has no `signal` field, so an orchestrator-tool Worker fanout is uncancellable by construction.
- [severity: low] [category: resource] `subagents/worker.ts:211, 454` — every `ok` WorkerResult retains a live `SubagentHandle` (full manifest conversation) in memory and inside the tool-result object on the orchestrator path; `toModelOutput` hides it from the model but transcript/step persistence still sees a large object.

## Token/step accounting

- [severity: med] [category: bug] `orchestrator/orchestrator.ts:713-747` — `Orchestrator.build` never forwards `init.timeout`/`init.onUsage` (nor `formatCommand`/`providerOptions`) into `makeWorkerTool` despite `WorkerToolDeps` accepting them (subagent-tools.ts:74-78), and `PlannerToolDeps`/`ReviewerToolDeps` cannot carry them at all — every subagent run on the orchestrator-agent path is unmetered (#114) and undeadlined (#129).
- [severity: low] [category: bug] `subagents/explore.ts:39-57` — `buildExploreTool` forwards no `timeout` and there is no usage sink in `makeAgentTool`, so explore children's tokens are invisible to the run-level cost ceiling (#190) and their steps have no per-step deadline.
- [severity: low] [category: bug] `subagents/worker.ts:1109` with `factory.ts:49` — an editor leaf runs to `EDITOR_MAX_STEPS` = 1000 with no submit tool, no compaction, and no survey-budget nudge; consider a lower leaf backstop or the manifest pass's read-only-streak reminder.

## Architecture

- [severity: high] [category: arch] `orchestrator/subagent-tools.ts` (whole file) and `orchestrator/orchestrator.ts:91-108, 692-747` — `Orchestrator.build`, `ORCHESTRATOR_ROLE_PREFIX`, `resolveMaxSteps`, and all three `make*Tool` wrappers have zero production callers (grep: only tests; the WorkLoop drives `runWorker`/`runPlanner`/`runReviewer` directly via `loop/run-loop-adapter.ts:954, 1303, 1441`) — ~400 lines of duplicated agent construction whose "no config drift" mirroring has already drifted (see accounting finding); delete the agent-as-tool path or actually wire it.
- [severity: med] [category: arch] `orchestrator/orchestrator.ts:99-103` vs `subagent-tools.ts:97-99` and `orchestrator.ts:141-150` — the role prompt instructs the model to loop "each ready group → worker … stop when every group is merged", but the tools bind exactly one group/pr/threads at build time behind empty input schemas, so a second `worker` call re-runs the same group; prompt and tool surface contradict each other.
- [severity: med] [category: arch] `subagents/worker.ts` (1484 lines) — manifest planning, fanout pooling/labeling, inline-edit inference, branch/stage/commit git phase, verify gate, and four prompt builders in one module; split at least the git commit phase and the verify gate into their own tested modules.
- [severity: med] [category: arch] `orchestrator/orchestrator.ts:161-649` — ~450 lines of PR-body text machinery (fenceMask, heading normalization, run-on splitting, JSON-envelope peeling, repair, fallback) live inside the Orchestrator; extract a `pr-body` module.
- [severity: low] [category: arch] `subagents/factory.ts:51-93` — `SubagentInit` is one grab-bag type where worker-only fields (`onEditorStepFinish`) and role-ignored fields coexist; per-role init types would turn silent field drops into compile errors.
- [severity: low] [category: arch] `orchestrator/subagent-tools.ts:88` — `SubagentToolDeps` aggregate exported but referenced nowhere else in src; dead export.
- [severity: low] [category: arch] `subagents/planner.ts:91-96`, `reviewer.ts:133-139`, `worker.ts:289-298`, `planner-scouts.ts:143-155` — the conditional-spread forwarding of init fields to `createSubagent` is copy-pasted four times (and is where the field-drop drift lives); extract one forwarding helper.

## Provider / portability / house rules

Clean: no Anthropic SDK usage anywhere in the audited files; no `Bun.*` APIs, no default exports, no `any` or `as unknown as` (worker.ts:754-768's double cast is assertion-heavy but legal under strict).

## Test coverage gaps

- [severity: med] [category: test] `subagents/worker.test.ts` — no test exercises `WorkerInput.signal` (outer-abort wiring + listener removal, worker.ts:990-996/1036); only the sibling-rejection abort is covered (worker.test.ts:441).
- [severity: low] [category: test] `subagents/planner-scouts.test.ts` — covers only pure helpers with stub runners; `createScoutRunner` (planner-scouts.ts:141-165), the real agent wiring and null-on-failure path, is untested.
- [severity: low] [category: test] `orchestrator/orchestrator.test.ts:344-539` — `finalizeCommit` happy/failure paths tested but not an empty or fence-wrapped refined message (the bug path at orchestrator.ts:806).

## Missing capabilities worth adding

- Run-wide cancellation: one AbortSignal threaded from the CLI through every subagent LLM loop (planner, reviewer, scouts, manifest pass, orchestrator generateText) — requires a `signal` parameter on compat's `runSubagent`/`agent.generate`; today only the worker editor fanout is cancellable.
- Uniform usage metering: explore children and any orchestrator-tool-path run are invisible to the run-level cost/token ceiling; an `onUsage` seam in `makeAgentTool` plus forwarding in `Orchestrator.build` would close the gap.
- A shared "untrusted text" envelope for repo-derived content (verify-command output, editor summaries, rolling context) so the fencing discipline that protects review comments and specialist files covers the remaining injection channels.
