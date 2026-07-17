# 08 — Prompt templating (single source, injected slots)

> Part of [`overview.md`](overview.md). Depends on: informs `01` (untrusted-data envelope) and `05` (single prompt builder) — land this as the structural home they plug into, or land them first and refactor into this. Owner-requested.

**Root cause behind 01 & 05:** prompt text is assembled ad-hoc at each call site by string concatenation, so mandatory pieces (contract blocks, `<env>`, step-budget, untrusted-data fencing) get dropped on whichever path forgot them. Fix the *structure*: every subagent/orchestrator prompt is a **named template with typed slots**; values are injected in one place (harness or top agent), never hand-concatenated at the call site.

**Guiding principle (owner):** aitm has two kinds of logic — **code / harness** (deterministic: orchestration, git, gh, state, value computation) and **agent / logic-eng** (the LLM reasoning encoded in prompts). Keep them separate and each reusable. The template boundary *is* that seam: harness code computes and injects slot values; the template holds the agent-facing reasoning. Neither reaches into the other — no business logic in prompt strings, no prompt text hand-built in harness control flow. Good, reusable modules on both sides of the seam.

## Current scattered sites (consolidate these)
| `file:line` | What it builds today |
| --- | --- |
| `subagents/role-prompt.ts` (`buildRolePrompt`) | The intended single builder (contract + `<env>` + step-budget). Make it the template engine's front door. |
| `orchestrator/subagent-tools.ts:98,120,143` | Ad-hoc `styleContents + *_SYSTEM_PREFIX` concat, bypasses the above (finding 05). |
| `subagents/reviewer.ts:201` (`buildThreadPrompt`) | Inline concat of untrusted comment bodies (finding 01). |
| `subagents/specialist-registry.ts:149` (`composeSpecialistGuidance`) | Verbatim append of repo `.claude/agents/*.md` (finding 01). |
| `subagents/{planner,worker,explore}.ts` `*_SYSTEM_PREFIX` consts | Role prefixes scattered as string consts. |
| `orchestrator/orchestrator.ts` system prompt | Top-level prompt assembly. |

## Design
- One `prompts/` module (SRP): named templates + a typed `render(templateName, slots)` that returns the final string. Named exports, kebab-case files, PascalCase slot types.
- **Slot kinds** carry trust: a `data`/untrusted slot is auto-wrapped in the fenced envelope from `01` (`<review-comment>…</review-comment>`, `<specialist-guidance>…</specialist-guidance>`) with the "data not instructions" directive; an `instruction` slot is verbatim. The template author can't forget to fence — the slot type does it.
- **Injection boundary:** the top agent / harness supplies slot values (goal, style digest, `<env>`, step budget, group, rolling context, comment bodies); templates never read globals or reach into config. This makes prompts testable in isolation and keeps the contract blocks non-optional (they're baked into the template, not a caller's responsibility).
- No premature abstraction: start by extracting the prompts that already exist at the 6 sites above into templates — do not invent templates for prompts that don't exist yet. Inline first, template on the real second caller (which `buildRolePrompt` already is).

## Steps
1. Create the `prompts/` module: a template registry + `render()` with typed `instruction` vs `data` (auto-fenced) slots.
2. Move the role prefixes, contract blocks, `<env>`, and step-budget reminder into role templates behind `buildRolePrompt`; `buildRolePrompt` calls `render()`.
3. Convert the 6 sites to `render(...)`; delete the ad-hoc concatenation. Orchestrator-tool path (05) and reviewer/specialist path (01) now go through templates by construction.
4. Snapshot-test each rendered template with representative slots so prompt drift is caught in review.

## Tests
- Unit: `render()` fences every `data` slot and never fences an `instruction` slot. Each role template rendered with fixture slots contains the contract/`<env>`/step-budget blocks (property, not string-match, where possible). Rendering with a malicious `data` slot (embedded "ignore previous instructions") keeps it inside the envelope. Snapshot tests for planner/worker/reviewer/orchestrator/explore system prompts.
- Commands: `bun test`, `bun run test:node`, `bun run typecheck`, `bun run lint`.

## Done when
- No subagent/orchestrator prompt is built by string concatenation at a call site — all go through `render()`.
- Untrusted slots are fenced by construction (can't be forgotten); contract blocks are baked into templates, not caller-supplied.
- Slot values are injected at one boundary (top agent/harness); templates read no globals.
