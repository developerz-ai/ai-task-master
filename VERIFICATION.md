# Verification Report

**Date:** 2026-05-28
**Project:** `ai-task-master` (monorepo: `packages/aitm` CLI + `@developerz-ai/ai-claude-compat`)
**Tested at:** branch `fix/reviewer-output-and-config-key` (`4abb75c`) = `main` (`53a31c6`) + the E2E-blocker fixes in PR #43
**Runtime:** Bun 1.3.14 / Node 22, dev build (`bun packages/aitm/src/cli/cli.ts`)
**Models:** `x-ai/grok-build-0.1` for the LLM paths (planner/worker/reviewer); take-over + failure-mode are model-agnostic
**Provider:** OpenRouter (`OPENROUTER_API_KEY`)

> Mirrors the structure of the sibling `developerz-ai/claude-task-master` `VERIFICATION.md`, extended with the live E2E scenarios from issue #29.

## 1. Quality gates

| Check | Command | Result |
| --- | --- | --- |
| Unit/integration (Bun) | `bun test` | **493 passed, 1 skipped, 0 failed** ✅ |
| Unit/integration (Node) | `node --test` (both packages) | **lib 58 + aitm 429 passed, 0 failed** ✅ |
| Lint | `biome check .` | **clean** ✅ |
| Types | `tsc --noEmit` (both packages) | **0 errors** ✅ |

## 2. Live E2E scenarios (issue #29)

Real `gh` + real OpenRouter inference against throwaway sandbox repos on a personal account (`OGtwelve`), per the #29 constraint (not the `developerz-ai` org).

**Public evidence repo:** [`OGtwelve/aitm-e2e-rr-1779979041`](https://github.com/OGtwelve/aitm-e2e-rr-1779979041) — made public for inspection. The full review-loop (scenario 3) is in [PR #1](https://github.com/OGtwelve/aitm-e2e-rr-1779979041/pull/1): the change-request comment, the Reviewer subagent's follow-up commit, the resolved thread, and the merge are all visible there.

| # | Scenario | Result | Evidence / exit codes |
| --- | --- | --- | --- |
| 1 | **Happy path** — `aitm start` → planner → worker opens a PR | ✅ pass | `start` exit 0; planner emitted 1 PR group; worker opened a real PR with a `node:test`. |
| 2 | **Take-over** — PR opened outside aitm, then `aitm merge-pr` (no prior `start`) | ✅ pass | `merge-pr` exit 0 → PR **MERGED**. |
| 3 | **Review-loop** — a `gh` review comment is left; `aitm merge-pr` runs the Reviewer subagent to address it | ✅ pass | Posted an inline change-request ("add an empty-name test"). The Reviewer subagent read it, **added exactly that test case**, committed + pushed (commits 1→2), **resolved the thread** (unresolved 1→0), CI green → **MERGED**. PR: [`OGtwelve/aitm-e2e-rr-1779979041#1`](https://github.com/OGtwelve/aitm-e2e-rr-1779979041/pull/1). |
| 4 | **Failure mode** — interrupt `aitm` mid-run, then `aitm merge-pr --no-resume` | ✅ pass | Interrupted run left state behind; `merge-pr --no-resume` exited **1 cleanly** (precondition block, no crash/stack trace). |

**Driven flow (scenario 3, end-to-end):** `aitm start` → PR → Claude posts good + change-request comments via `gh` (emulating CodeRabbit) → `aitm merge-pr` → Reviewer subagent addresses the comment + pushes a fix + resolves → merge. This is the realistic loop and it works.

## 3. Divergences found (per #29: "any divergence → file as a blocker")

| Finding | Severity | Status |
| --- | --- | --- |
| Reviewer structured output used a Zod `discriminatedUnion` → JSON-Schema `oneOf`, rejected by some providers (`output_config.format.schema: 'oneOf' is not supported`, hit on Anthropic — the default tier) | 🔴 blocker | **Fixed in PR #43** (flat output schema) |
| Reviewer `github` tool input was also a `discriminatedUnion` → `oneOf` in tool params, rejected by `x-ai/grok-build-0.1` (`Invalid arguments passed to the model`) | 🔴 blocker | **Fixed in PR #43** (flat tool-input schema) |
| `aitm config list` printed `openrouterApiKey` in cleartext | 🔴 security | **Fixed in PR #43** (masked to `sk-or-…<last4>`) |
| `deepseek/deepseek-v4-flash` (cheapest model) returns an empty Worker file-manifest — too weak for the structured manifest output | 🟡 model-compat | Use a more capable model; tracked for v1 (see Notes) |
| `qwen/…:free` is persistently rate-limited upstream (Venice) → planner/reviewer can't complete | 🟡 infra | Free model unsuitable for LLM-heavy E2E; use a cheap paid model or an own-key tier |

## 4. Spend

- Free-model attempts: **$0** (rate-limited / failed before billable tokens).
- `x-ai/grok-build-0.1` paid runs (start + review-loop + merges, a small task): **well under the $5/pass cap** (cents-scale; exact figure on the OpenRouter dashboard).

## 5. Deviations from the #29 spec (to close before v1.0.0)

- **Tested the dev build, not the published artifact.** #29 requires testing `npm i -g ai-task-master@next` / a `npm pack` tarball after #20 (publish) + #28 (minify) land. Publishing (#37) is currently deferred, so this run used `bun … cli.ts`.
- **No `v1.0.0` tag cut.** Gated on the publish workflow (#37) and on PR #43 merging.
- Per #29 this report is therefore a **pre-publish verification**; a publish-candidate pass + the v1 tag remain.

## Conclusion

The full loop — `start → PR → review-loop → merge`, take-over, and clean interrupt/abort — **works end-to-end on a real model** once PR #43's three fixes are applied. Quality gates are green. Remaining for v1.0.0: land #43, complete #37 (publish + OIDC), then re-run this verification against the published artifact and cut the tag.
