# Coding style

`aitm` does not invent a style. It reads the target repo's existing convention file and feeds it to every subagent.

## Source of truth

| File | Convention | Typical content |
| --- | --- | --- |
| `CLAUDE.md` | Claude Code projects | House rules, dos/don'ts, repo map, test commands. |
| `AGENTS.md` | Codex / generic-agents projects | Same shape, different audience. |
| `--style <path>` | Anything custom | Override both. |

`AgentConfigDetector` chooses the file. Its raw contents become the **style payload**.

## The style guide is two halves

`composeStyleGuide` (`src/agent-config/coding-style.ts`) builds what every prompt actually sees:

1. **The project style file, verbatim.** `CLAUDE.md` / `AGENTS.md` is injected in full, unsummarized, at the head of the guide. It is the repo's house rules, and a summarizer silently drops rules ("no default exports", "tests must pass under Node too") — which is how an agent ends up violating the file it was told to follow. It leads because it is authoritative and because the one cap that truncates this string (the editor leaf's) keeps the head.
2. **A distilled digest**, from one smart-tier LLM call over the repo's *other* signals — `CONTRIBUTING.md`, `biome.json`, every root `tsconfig*.json`, `package.json` scripts. The distiller is told the style file ships verbatim alongside it, so its job is the conventions the style file does not state: where tests live and how they are named, the commands that gate a commit, what the formatter and compiler enforce.

Only the digest is cached (`<stateDir>/coding-style.md`). The verbatim half is re-read from `AgentConfig` every run, so an edit to `CLAUDE.md` takes effect on the next run instead of being pinned by a stale cache. Any failure — no signals, a model error, a timeout — degrades to the verbatim half alone; the style file always reaches the prompts.

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
