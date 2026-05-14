# Architecture

`aitm` — TypeScript rewrite of `claude-task-master`. Bun for local dev; ships portable ESM that runs on Bun, Node ≥ 20, and Deno ≥ 1.40. Autonomous loop: plan a goal into **PR-sized task groups**, work each group on its own branch, open a PR, **auto-merge** (default on), repeat until done. No final verification phase. No release phase.

Two commands only: `aitm start "<goal>"` and `aitm merge-pr`. With automerge on, `start` runs everything end-to-end; `merge-pr` is the manual gate for `--no-automerge` runs.

Single LLM provider: **OpenRouter** (OpenAI-compatible API). No Anthropic SDK. The presence of `CLAUDE.md` in a target repo is a coding-style signal only.

## Flow

```
CLI
 └─ WorkLoop
     └─ Orchestrator (experimental_Agent)
         ├─ Planner   (subagent-as-tool)
         ├─ Worker    (subagent-as-tool)
         └─ Reviewer  (subagent-as-tool)
              └─ tools: FS, Bash, GitHubClient
```

Subagents follow the Vercel AI SDK pattern: each is an `experimental_Agent` exposed to the Orchestrator as a tool. See https://ai-sdk.dev/docs/agents/subagents.

## Modules (SRP)

| Module | Single responsibility | Does NOT |
| --- | --- | --- |
| `CLI` | Parse argv, dispatch to `start` or `merge-pr`. | Run loops, touch state, call AI. |
| `WorkLoop` | Drive PR groups one at a time until plan exhausted. | Make planning/coding decisions. |
| `Orchestrator` | Top-level agent; route between subagents. | Read FS, write state, call git. |
| `Planner` | Turn goal + repo context into ordered **PR groups** (each = tasks for one PR). | Execute tasks, open PRs. |
| `Worker` | Execute one PR group: edit files, run commands, commit, open PR. | Plan groups, review, merge. |
| `Reviewer` | Address PR review comments, push fixes, resolve threads. | Edit unrelated code, plan. |
| `StateStore` | Read/write `.ai-task-master/` atomically. | Interpret state, mutate domain logic. |
| `AgentConfigDetector` | Detect `CLAUDE.md` vs `AGENTS.md`; emit coding-style payload. | Choose provider or model. |
| `GitHubClient` | Wrap `gh` for PRs, comments, checks, merges. | Embed business rules. |
| `ConfigLoader` | Find, parse, merge `~/.aitm.json` + `./.aitm.json` + env + CLI flags. | Read run state, talk to providers. |
| `Credentials` | Take resolved config, return AI SDK model handles per subagent role. | Read config files itself. Touch Anthropic. |
| `Logger` | Structured logs to `.ai-task-master/logs/`. | Decide log policy per module. |

Every module ships with a paired `*.test.ts`. SRP + tested is the bar.

## Dependency direction

Low-level (`Credentials`, `StateStore`, `GitHubClient`, `Logger`)
  -> Mid (`AgentConfigDetector`, `Planner`, `Worker`, `Reviewer`)
    -> High (`Orchestrator`, `WorkLoop`, `CLI`)

No cycles. High depends on mid depends on low. Subagents receive injected tools, never import high-level modules.

## Where subagents fit

`Orchestrator` is the only top-level agent. `Planner`, `Worker`, `Reviewer` are subagents — registered as tools on the Orchestrator per the Vercel AI SDK subagents pattern. The Orchestrator decides which to invoke each turn; subagents return structured results, not control flow.

## Exit codes

| Code | Meaning | State action |
| --- | --- | --- |
| 0 | Success — all PR groups merged, or PR opened with `--no-automerge`. | Clean `.ai-task-master/` except `logs/`. |
| 1 | Blocked — needs human input. | Preserve full `.ai-task-master/` for resume. |
| 2 | User-interrupted (SIGINT). | Preserve full `.ai-task-master/` for resume. |

## Cross-links

- `./commands/start.md`
- `./commands/merge-pr.md`
- `./subagents.md`
- `./state.md`
- `./task-groups.md`
- `./coding-style.md`
- `./agent-config-detection.md`
