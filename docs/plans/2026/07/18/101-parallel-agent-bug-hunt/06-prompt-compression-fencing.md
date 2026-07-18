# 06 — Prompt compression + injected-value fencing

> Part of [`overview.md`](overview.md). Depends on: none. Reconcile with `../../../17/101-aitm-audit-remediation/08-prompt-templating.md` (same seam; don't duplicate).

Design intent (owner): every runtime value reaches a prompt **via the builder with typed slots** — `buildRolePrompt`/`render`/`slots.ts` is the gold standard. Audit verdict: system prompts already comply; the gaps are the first-user-message context block and token duplication.

Standards refs: `gold-standards-in-ai/docs/writing-for-agents/compressed-config.md`, `claude-code-bible/docs/11-compressed-config.md` (fragments, one rule per line, agent prompt <50 lines, per-spawn cost), `claude-task-master/src/claude_task_master/core/prompts_base.py` (PromptBuilder `include_if`).

## Files to change
- `packages/aitm/src/loop/run-loop-adapter.ts:334-341,650,748,983,1019` (+ `695/699,903/904,1092/1095`) — claudeMd fence/cap; style duplication.
- `packages/aitm/src/observability/system-reminder.ts:32-34,115-122` — verbatim `wrapReminder` sections.
- `packages/aitm/src/subagents/worker.ts:392-416,448-453,505-514` — editor frame, manifest interpolation caps.
- `packages/aitm/src/subagents/prompt-blocks.ts:62-88`, `role-guidance.ts:32-95` — contract/role prose.
- `packages/aitm/src/orchestrator/orchestrator.ts:333-346,389-403` — commit/PR prompt duplication.

## Steps
1. **Fence + cap claudeMd** (high). Target repo's `CLAUDE.md` is injected verbatim into the `<system-reminder>` block — a literal `</system-reminder>` inside it (docs, pasted logs, hostile repo) breaks out of the envelope. Route external `ContextSection` bodies through the same defuse as `slots.ts:62-65` `defuseEnvelopeTags` (or JSON-escape like `prompt-blocks.ts:119-133` `memoryIndexBlock`). Cap `styleContents` before injection — the ~600-word bound only exists inside the distiller (`coding-style.ts:37-41`); the raw fallback (`run-loop-adapter.ts:650,748`) is unbounded.
2. **Style digest once per call** (high). Same `style` string sent as system-prompt block AND as `harnessContextBlock` claudeMd section — every planner/worker/reviewer/self-review/CI-fix call pays it twice. Keep the system block (cacheable); drop the context-section copy at all listed call sites.
3. **Slim the editor leaf**. `runEditor` ships full contract stack + style digest per file, ×N parallel per manifest. Leaf is "one file, can't see plan" — follow `explore.ts:53` lean-leaf pattern. Trim conservatively (editors write code — keep style essentials); measure tokens before/after.
4. **Cap manifest interpolations**. `group.title`/`task.text`/`subtasks`/`rollingContext`/`file.purpose` interpolated raw, uncapped; `rollingContext` grows across groups. Apply slice-caps matching `VERIFY_TAIL_MAX` discipline (`worker.ts:201,640-645`).
5. **Orchestrator commit/PR prompts**. Both prepend full `buildSystemPrompt()` into the *user* prompt per group. Move to `system` field or trim to delivery facts.
6. **Compress contract prose** (soft). Rewrite `HARNESS_/COMMUNICATION_/AUTONOMY_CONTRACT_TEXT` + Worker/Editor role prose as fragments per the standards refs. Behavior-sensitive — A/B on a real run before adopting.

## Tests
- Unit: `system-reminder.test.ts` — body containing `</system-reminder>` cannot close the envelope. `run-loop-adapter.test.ts` — style appears exactly once per built prompt; raw-fallback capped. `worker.test.ts` — oversized rollingContext truncated at cap.
- Token check: log prompt char counts before/after on `e2e-smoke.ts`; record the delta in the PR.
- `bun test`, `bun run test:node`.

## Done when
- No unfenced/uncapped external content in any prompt path; style digest single-sourced.
- Measured per-call prompt-size reduction reported.
