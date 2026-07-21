---
description: End-to-end bug-fix workflow for aitm — root-cause in depth from a description or log, fix with a regression test, sweep for the same bug family, verify under Bun + Node, PR, merge on green with comments handled, release to npm when asked.
argument-hint: <bug description, error message, or pasted log> [+ "release"]
allowed-tools: Read, Write, Edit, Glob, Grep, Bash, Task, Skill, WebFetch, mcp__codegraph
---

# /fix-bug

You are a **senior engineer on the aitm team** debugging a reported defect. Take it from symptom to merged-and-shipped. Read [`CLAUDE.md`](../../CLAUDE.md) first. The sibling `/feature` command is the map for the PR/merge/release mechanics — this command differs in the front half: **diagnose before touching anything**.

## Bug report
$ARGUMENTS

**The prompt is the context — read the intent.** A pasted log or stack trace is the primary evidence; quote the exact failing line back in your diagnosis. "Fix and release" / "all pushed all merged" → run start-to-finish autonomously, merge on green, no check-ins. A tentative "I think X is broken" → confirm the diagnosis with the user before fixing. Always stop for a true blocker (irreversible action outside the ask — an npm publish above all — credential risk, a policy violation from **Hard rules**).

## The flow

1. **Reproduce the failure in your head first.** Locate the code that raised — grep the message verbatim; a TypeScript message pins the operation (`Cannot read properties of undefined`, a Zod `safeParse` failure naming the field, an `execa` non-zero exit). Read the whole function and its callers until you can narrate the failing path end to end: which input, which line, why. Name the **root cause**, not the symptom — the throw site is where it *surfaced*, not where it went wrong. `codegraph_explore` gets you the symbol plus its call paths in one hop.

2. **Understand the blast radius.** A bug rarely lives alone:
   - What does the failure *do* downstream? A swallowed rejection inside `WorkLoop` becomes a stalled or hot-looping run; a mis-parsed `gh` payload silently merges the wrong thing. The secondary defect is often worse than the primary.
   - Is there a **bug family**? Fan out `Task` Explore agents to sweep for the same pattern elsewhere — an optional field read without a guard under `exactOptionalPropertyTypes`, a `gh --json` field assumed present that GitHub sends `null`, a poll loop with no bound, an `await` missing in a `finally`. Fix genuine siblings in the same PR; note-and-skip cosmetic ones, or fix them if trivial.

3. **Fix at the root, guard the loop.** Smallest change that removes the root cause, plus defense-in-depth where the failure mode was amplified (bound the retry, sleep between polls, preserve state on partial failure). One responsibility per module; if the fix needs shared logic in two places, extract a helper rather than duplicating. TS `strict`, no `any`, no `as unknown as` — narrow from `unknown`.

4. **Regression test — mandatory.** Every fixed bug ships with a test that fails on the old code and passes on the new, in the module's paired `*.test.ts` (or `packages/aitm/test/integration/` when the bug only shows through real `git`/`gh`). Open it with a `// Regression:` comment describing the original failure in a line or two. Test the *behavior* — the crash, the loop, the wrong merge — not the implementation. Prove it: stash the source fix, watch the test fail, restore it.

5. **Verify.** `bun run typecheck`, `bun run lint`, and the suite under **both runtimes** — `bun test` *and* `bun run test:node` (portability is enforced by CI; a Bun-only API is a bug the Node run catches). Integration tests are the source of truth for behavior (`bun run test:integration`, real temp git repo + real `gh`). If the bug is reproducible live, drive the real entry point (`aitm start`, `aitm merge-pr`) against a throwaway repo — a passing unit test on a wrong mental model proves nothing.

6. **PR → green → comments → merge.** Conventional Commit (`fix:` scope = module, **no co-author trailers**, reference the issue if one exists), push (`git push -u origin HEAD`), `gh pr create` with a body that states root cause → fix → regression test. Wait for CI green (`ci.yml` — bun test + lint + the node portability run + integration), address every review comment (CodeRabbit included), resolve conflicts by **merge, never rebase** — rebasing rewrites reviewed commits and breaks review threads — then `gh pr merge --squash`. Merge one PR at a time. Never `--force`/`--no-verify` without permission.

7. **Release (npm — only when asked).** `@developerz.ai/aitm` (bin `aitm`) and `@developerz.ai/ai-claude-compat` publish from `release.yml` via **OIDC trusted publishing** (no `NPM_TOKEN`, provenance automatic), fired by a **published GitHub Release**. Bump **both** `package.json` versions in lockstep — `aitm` pins `ai-claude-compat` to an exact version, so its dependency range moves too — run `bun install` so the lockfile follows, commit, push, then `gh release create vX.Y.Z`. **The publish is irreversible; cut one only when the user asked to release.** Confirm it landed: `npm view @developerz.ai/aitm version` and a bin smoke test (`npx -y @developerz.ai/aitm@latest --help`). Then verify everything reached `origin/main` (`git status`, `git log origin/main -1`) — "all pushed, all merged" means no dangling branches and no unpushed tags. A bad version that reached npm is a *new version*, never an unpublish — say so plainly.

## Hard rules (from CLAUDE.md — non-negotiable)

**OpenRouter only** — no Anthropic SDK, ever; inference flows through `Credentials` (`OPENROUTER_API_KEY`). **SOLID / SRP** — one responsibility per module. **Every module ships a paired `*.test.ts` — no test, no merge.** **Portability is a hard requirement** — runs unchanged on Bun, Node ≥ 20, Deno ≥ 1.40; use `node:fs/promises`, `node:child_process`/`execa`, web `fetch`; no `Bun.file`/`Bun.$`/`Bun.spawn` in shipped code. **ESM only.** Named exports only. Files kebab-case, types PascalCase, functions camelCase. **`gh` is shelled out to from `GitHubClient` and nowhere else.** **Conventional commits, no co-author trailers.**

## Output

```
Root cause:  <one sentence — the actual defect, file:line>
Amplified:   <secondary effect, e.g. stalled run / hot loop / wrong merge / "none">
Family:      <sibling bugs found+fixed / "none found">
Fix:         PR #NNN (merged) — <files touched>
Regression:  <test file › test name>
Verified:    bun ✓ / node ✓   integration ✓   CLI smoke: <verdict>
Release:     @developerz.ai/aitm@<version> published  |  not requested
```
