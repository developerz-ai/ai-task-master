# 03 — Declarative editor toolset + transitive depth guard

> Part of [`overview.md`](overview.md). Depends on: none. **Lowest leverage — hardening, not a feature.** Behavior byte-identical today; it makes an invariant explicit rather than incidental.

## The mechanism

**OpenCode** (`~/workspace/opencode/packages/opencode/src/tool/task.ts`, `src/agent/subagent-permissions.ts`):
- When the `task` tool spawns a subagent it derives the child's tool permissions from the parent, then adds **explicit denies** (`task.ts:143`): the child cannot call `todowrite` or `task` itself (no recursion) unless the agent def grants them, and every `experimental.primary_tools` entry is denied to the child. So "what can a delegated child do" is a computed allow/deny set, not a hand-maintained list.
- Depth is bounded structurally: `task` walks the `parentID` chain and refuses past `cfg.subagent_depth ?? 1` (`task.ts:104`) — no unbounded nesting even as agent graphs grow.

**aitm today**:
- The editor leaf's toolset is produced by `editorToolSet` (`packages/aitm/src/subagents/worker.ts:574`) — a **destructure denylist**: it strips `explore`, `memory`, `bashOutput`, `killBash` by name and spreads the rest. Fragile: a runtime tool the adapter mounts *later* (e.g. a future MCP-sourced tool, or a new liveliness tool) is **not** stripped, so a leaf silently inherits a capability it should never have (nest surveys, manage background procs). It's exactly the implicit-denylist anti-pattern OpenCode avoids.
- aitm's generic-dispatch seam already does it right elsewhere: `makeAgentTool` (`packages/ai-claude-compat/src/agent-spawn.ts:76`) enforces an explicit `allowedTools` allowlist at **construction** and throws on an out-of-list tool or self-recursion (`:79`); `explore` pins `EXPLORE_ALLOWED_TOOLS` (`subagents/explore.ts:22`). Only the editor fanout skipped the pattern.
- Depth: `makeAgentTool` forbids *direct* self-recursion (`:79`) but nothing enforces a *transitive* bound (A→B→A). Harmless today (the Orchestrator→Worker→editor graph is fixed and acyclic), but the guard should be explicit before any generic delegate tool is added.

## Files to change
- `packages/aitm/src/subagents/worker.ts:574` — replace `editorToolSet`'s destructure with an allowlist filter over an exported `EDITOR_TOOL_ALLOWLIST`.
- New (or beside `worker.ts`): `EDITOR_TOOL_ALLOWLIST` — the leaf's legitimate keys: `readFile`, `writeFile`, `editFile`, `multiEdit`, `grep`, `glob`, `bash`, `multiBash`, `webFetch`, `webSearch`, `datetime` (the `WorkerTools` surface, `worker.ts:74`, minus the manifest/CI-fix-only extras).
- `packages/ai-claude-compat/src/agent-spawn.ts` — add an optional `maxDepth` to `AgentToolOptions` (default `maxDepth = 1`, matching OpenCode's `subagent_depth` default) and refuse to spawn past it. Depth rides the AI SDK's `experimental_context` (a Symbol key that can't collide with a caller's own context and survives object spread), so a spawned child sees how many agent frames are above it with no change to the tool input schema or caller wiring. `maxDepth = 1` is a single level of delegation: it matches aitm's **actual** behavior today (no survey toolset carries an agent tool, so nesting never exceeds one level) — it is not a literal no-op for a hypothetical pre-existing multi-level nesting, of which there are none. A non-finite or ≤ 0 value falls back to the default, so the guard can never be disabled.

> **Scope split:** the `editorToolSet` allowlist above is **deferred** — its region in `worker.ts` is under active concurrent change, and reworking it would rework unrelated in-flight edits. This slice ships only the additive depth guard (a clean, self-contained `agent-spawn.ts` change); the allowlist remains tracked on the issue for the owning stream.

## Steps
1. **Allowlist filter** (`worker.ts`): `export const EDITOR_TOOL_ALLOWLIST = [...] as const;` then rewrite `editorToolSet(tools)` to return `Object.fromEntries(Object.entries(tools).filter(([k]) => (EDITOR_TOOL_ALLOWLIST as readonly string[]).includes(k)))` typed back to `WorkerTools`. Result is byte-identical for today's tool set (same keys survive), but any *new* key is excluded by default — the safe direction. Keep the doc-comment explaining WHY each stripped tool (`explore`/`memory`/`bashOutput`/`killBash`) is leaf-inappropriate.
2. **Depth guard** (`agent-spawn.ts`): read the incoming depth from `execute`'s `experimental_context` (default 0). If `depth >= maxDepth`, **return** a refusal line — not throw — mirroring the existing caught-provider-error path, so a capped delegation degrades to a message instead of aborting the parent step, and the refused `generateText` is never paid for. Otherwise spawn the child with `experimental_context` carrying `depth + 1`, so any agent-tool the child invokes keeps counting down the chain. The boundary is inclusive: `depth === maxDepth` rejects the child itself. A **run-time** guard — not the construction-time throw first sketched — because it also catches an indirect A→B→A cycle, where the offending tool is a different handle the static self-recursion check (`:79`) can't see. Since aitm mounts `explore` with a read-only trio that contains no agent-tool, this is a no-op today — it just makes "surveys can't nest" a tested invariant instead of an accident of wiring.
3. Do **not** add a new model-facing delegate tool, and do **not** parallelize PR groups — see Rejected below.

## Tests (`worker.test.ts` / `agent-spawn.test.ts`)
- `editorToolSet`: given `WorkerTools` + an extra `mcpFoo` tool, the result excludes `mcpFoo` and `explore`/`memory`/`bashOutput`/`killBash`, and includes every `EDITOR_TOOL_ALLOWLIST` key present.
- Byte-identical regression: for exactly today's tool set, the returned keys equal the pre-change destructure output.
- `makeAgentTool` depth (through the real spawn chain — a child that invokes a nested agent-tool): at the default cap the nested delegate one level down is refused before it spawns (its model never runs) and the refusal line rides back to the child; a raised `maxDepth` lets it descend one level further; an invalid `maxDepth` falls back to the default (guard cannot be disabled); a spawned child preserves any caller `experimental_context` alongside the depth.
- Gates: `bun test`, `bun run test:node`, `bun run typecheck`, `bun run lint`.

## Done when
- The editor leaf toolset is derived from an explicit allowlist; a newly-mounted runtime tool is excluded by default (proven by test), and today's behavior is unchanged. *(Deferred — see the scope-split note above; tracked on the issue.)*
- Nested survey delegation at or past `maxDepth` is refused at run time (returns a refusal line; the parent step continues), and a non-finite/≤ 0 `maxDepth` cannot disable the guard.

## Rejected (why not, so the executor doesn't reopen)
- **Model-driven generic `task` dispatch** (OpenCode's central pattern): aitm's dispatch is a deliberate fixed role pipeline (Orchestrator→Planner/Worker/Reviewer as tools, `orchestrator/subagent-tools.ts:105`) + a bounded editor pool. A generic write-capable delegate duplicates the fanout and adds coordination/recursion burden for no clear win. `explore` already covers read-only delegation.
- **Parallel independent PR groups** (the Planner returns a DAG, `subagent-tools.ts:108`): blocked by CLAUDE.md — single shared checkout, no worktrees. Concurrent groups would collide on the working tree (`git checkout -B` switches the whole tree). Out of scope until/unless the no-worktree rule changes.
- **Background subagents** (OpenCode `task.ts:216`): aitm is unattended (no human to notify/continue); the value of "launch and keep working" is low, and `SubagentHandle` continuation (`subagent.ts:874`) already covers resume for the CI-fix path.
