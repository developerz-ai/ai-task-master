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
- `packages/ai-claude-compat/src/agent-spawn.ts` — add an optional `depth` + `maxDepth` to `AgentToolOptions` and refuse to spawn past it (default `maxDepth = 1`, matching OpenCode's `subagent_depth` default). Additive; unset → today's behavior.

## Steps
1. **Allowlist filter** (`worker.ts`): `export const EDITOR_TOOL_ALLOWLIST = [...] as const;` then rewrite `editorToolSet(tools)` to return `Object.fromEntries(Object.entries(tools).filter(([k]) => (EDITOR_TOOL_ALLOWLIST as readonly string[]).includes(k)))` typed back to `WorkerTools`. Result is byte-identical for today's tool set (same keys survive), but any *new* key is excluded by default — the safe direction. Keep the doc-comment explaining WHY each stripped tool (`explore`/`memory`/`bashOutput`/`killBash`) is leaf-inappropriate.
2. **Depth guard** (`agent-spawn.ts`): thread a numeric `depth` (default 0) through `makeAgentTool`; when a child's toolset itself contains agent-tools, they are constructed with `depth+1`; refuse (throw `AgentToolConstructionError`) when `depth >= maxDepth`. Since aitm mounts `explore` with a read-only trio that contains no agent-tool, this is a no-op today — it just makes "surveys can't nest" a tested invariant instead of an accident of wiring.
3. Do **not** add a new model-facing delegate tool, and do **not** parallelize PR groups — see Rejected below.

## Tests (`worker.test.ts` / `agent-spawn.test.ts`)
- `editorToolSet`: given `WorkerTools` + an extra `mcpFoo` tool, the result excludes `mcpFoo` and `explore`/`memory`/`bashOutput`/`killBash`, and includes every `EDITOR_TOOL_ALLOWLIST` key present.
- Byte-identical regression: for exactly today's tool set, the returned keys equal the pre-change destructure output.
- `makeAgentTool` depth: constructing an agent-tool whose toolset contains another agent-tool at `depth = maxDepth` throws; below it constructs.
- Gates: `bun test`, `bun run test:node`, `bun run typecheck`, `bun run lint`.

## Done when
- The editor leaf toolset is derived from an explicit allowlist; a newly-mounted runtime tool is excluded by default (proven by test), and today's behavior is unchanged.
- Nested survey delegation past `maxDepth` fails loudly at construction.

## Rejected (why not, so the executor doesn't reopen)
- **Model-driven generic `task` dispatch** (OpenCode's central pattern): aitm's dispatch is a deliberate fixed role pipeline (Orchestrator→Planner/Worker/Reviewer as tools, `orchestrator/subagent-tools.ts:105`) + a bounded editor pool. A generic write-capable delegate duplicates the fanout and adds coordination/recursion burden for no clear win. `explore` already covers read-only delegation.
- **Parallel independent PR groups** (the Planner returns a DAG, `subagent-tools.ts:108`): blocked by CLAUDE.md — single shared checkout, no worktrees. Concurrent groups would collide on the working tree (`git checkout -B` switches the whole tree). Out of scope until/unless the no-worktree rule changes.
- **Background subagents** (OpenCode `task.ts:216`): aitm is unattended (no human to notify/continue); the value of "launch and keep working" is low, and `SubagentHandle` continuation (`subagent.ts:874`) already covers resume for the CI-fix path.
