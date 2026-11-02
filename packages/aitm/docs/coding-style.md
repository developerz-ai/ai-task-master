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
2. **A distilled digest**, from one bounded multi-step smart-tier LLM call over the repo's *other* signals — `CONTRIBUTING.md`, `biome.json`, every root `tsconfig*.json`, `package.json` scripts, plus source/test samples. The call runs at most 10 model steps. The distiller is told the style file ships verbatim alongside it, so its job is the conventions the style file does not state: where tests live and how they are named, the commands that gate a commit, what the formatter and compiler enforce. When that bundle is not enough — a repo whose only convention doc is `docs/STYLE.md`, say — the distiller may read a few files from the repo itself through the `readRepoFile` tool; that exploration phase is described below.

Only the digest is cached (`<stateDir>/coding-style.md`). The verbatim half is re-read from `AgentConfig` every run, so an edit to `CLAUDE.md` takes effect on the next run instead of being pinned by a stale cache. Any failure — no signals, a model error, a timeout — degrades to the verbatim half alone; the style file always reaches the prompts.

## The digest may read the repo

The signal bundle is deterministic, but it is not the whole truth. A repo whose only convention doc is `docs/STYLE.md` still gets a digest — the bundle is `CLAUDE.md`/`AGENTS.md` + `CONTRIBUTING.md` + root config files + `package.json` scripts + source/test samples — but that digest cannot mention `docs/STYLE.md`: no file in the bundle says what is in it.

So the digest call may now **explore the target repo**, bounded and read-only (`src/agent-config/style-exploration.ts`):

- **One tool, `readRepoFile`.** It reads a UTF-8 file from the target repo. Nothing else — no write, no edit, no bash, no glob, no grep, no directory listing. The model gets a single way in, and that way only reads.
- **At most 10 model steps** for the whole distillation. The cap belongs to this pre-flight exploration alone; the subagents' own step budgets are untouched.
- **Confined to the repo root.** Every path goes through the shared `resolveInside` guard from `@developerz.ai/ai-claude-compat`, which refuses `..` traversal and symlinks resolving outside the root. On top of that the explorer refuses any path with a dot-prefixed segment (`.git`, `.env`, `.claude`) and refuses directories; an oversize file is truncated with a marker rather than failing the read.
- **The tool never throws.** A refused path comes back to the model as a refusal string, so a bad path costs one step, not the digest.

What this does *not* change:

- The **deterministic signal bundle** and the signal section of the rendered prompt are byte-identical to before. The exploration instruction sits in a constant tail after the prompt (or in the tool description), never inside the signal block, so the provider-cached prompt prefix stays the signal bundle.
- **Content the model reads never enters that prompt.** It arrives only as a tool-result message, after the prompt was already sent.
- **`COMPLETION_MARKER` (`CODING_STYLE_COMPLETE`) and `cleanDigest`** are untouched: the marker is stripped and the digest is sliced from `# Coding Style` exactly as before.
- **The cache is untouched.** The digest is still cached in `<stateDir>/coding-style.md` and reused whenever it is non-empty. No new cache file, and no cache identity derived from what the model explored.
- **Degradation is unchanged.** A timeout, an aborted signal, a model error or an unreadable file all yield `''` — the guide then carries the raw style file alone, and the run continues.
- **The model handle stays injected.** `StyleDistillerInit.model` remains the only source of the model; `agent-config` builds no provider and adds no provider wiring.

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
