# Coding style

`aitm` does not invent a style. It reads the target repo's existing convention file and feeds it to every subagent.

## Source of truth

| File | Convention | Typical content |
| --- | --- | --- |
| `CLAUDE.md` | Claude Code projects | House rules, dos/don'ts, repo map, test commands. |
| `AGENTS.md` | Codex / generic-agents projects | Same shape, different audience. |
| `--style <path>` | Anything custom | Override both. |

`AgentConfigDetector` chooses the file. Its raw contents become the **style payload**.

## How subagents consume it

`Orchestrator` builds each subagent's system prompt as:

```
<style payload from CLAUDE.md or AGENTS.md>

<role-specific prefix: Planner | Worker | Reviewer>

<dynamic context: current task, recent diff, etc.>
```

All three subagents see the same style payload. That means `Planner` plans within the project's rules, `Worker` writes code that matches them, and `Reviewer` enforces them when addressing review comments.

## What lives in the style payload vs in `aitm` itself

| Belongs in `CLAUDE.md` / `AGENTS.md` (the target repo) | Belongs in `aitm` itself |
| --- | --- |
| House style (naming, comments, exports). | Subagent role definitions. |
| Test commands, lint commands. | Loop control, PR-group sizing rules. |
| Architectural rules ("no cycles between X and Y"). | Tool surface (`fs.read`, `bash`, `GitHubClient`). |
| Domain-specific don'ts. | Failure-handling protocol. |

`aitm` is style-agnostic. If the target repo says "use four-space indents" or "always async/await, never `.then`", subagents inherit that — no flags needed.

## Override path

`--style <path>` wins over filesystem detection. Useful when:

- Conventions live somewhere non-standard (`docs/conventions.md`).
- A run needs a stricter or looser flavor for one task (e.g., refactor-only run with a "no behavior change" style).

The override path is recorded in `state.json.options.stylePath` so resume reproduces it.

## SRP

`AgentConfigDetector` owns *finding* the style source. `Orchestrator` owns *assembling* the prompt. No subagent reads the style file directly — it arrives as a prompt fragment.

## Cross-links

- `./agent-config-detection.md`
- `./subagents.md`
- `./commands/start.md`
