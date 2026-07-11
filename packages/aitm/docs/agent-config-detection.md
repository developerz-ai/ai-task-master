# Agent config detection

`AgentConfigDetector` decides which coding-style convention `aitm` follows for the target repo. It picks a **style source**, not a provider — the provider is always OpenRouter.

## Search order

Discovery is **layered**, general → specific (issue #117). Every layer that exists is concatenated, so a more-specific convention comes later in the text and wins on conflict (deepest-wins):

1. **User-global** `~/.claude/CLAUDE.md` — operator-wide house conventions. **Additive only**: it never satisfies detection on its own.
2. **Project-level pick** (the gate) at the target repo root:
   - `--style <path>` CLI flag — if supplied, used verbatim (skips the root search).
   - `./CLAUDE.md` → flavor `claude`; `./AGENTS.md` → flavor `agents`; both present → prefer `CLAUDE.md`, override with `--prefer agents`.
   - Neither present and no `--style` → **exit 1** with instructions (unchanged — the user-global layer does not rescue this).
3. **Nested** per-directory `CLAUDE.md`/`AGENTS.md` (same per-directory preference), discovered across the subtree. Skips `.git`, `node_modules`, hidden directories, and `.ai-task-master/`. Sorted **depth then path**, deterministically.

A total **byte budget** (64 KiB across nested files) guards monorepo blowup: once exceeded, remaining nested files are skipped and a warning is logged to stderr, so the style distiller never receives unbounded input.

Each `@`-import is expanded per file with a **per-file containment root**: repo files stay confined to the repo root (as before); the user-global file expands within `~/.claude` only — its imports can never read the target repo, and vice versa.

The **project-level** file path and flavor are persisted to `state.json.agentConfigFile` so resumed runs use the same source; the layered detail is exposed via `AgentConfig.sources`.

## Output contract

```
type AgentConfig = {
  flavor: "claude" | "agents" | "custom";  // describes the PROJECT-level pick
  path: string;                            // the PROJECT-level pick's path
  contents: string;                        // all layers, @-imports expanded per file
  sources: Array<{ path: string; scope: "user" | "project" | "nested" }>;
};
```

**Labeling** — with more than one source, each block is prefixed `Contents of <path>:` (repo-relative for repo files, absolute for the user-global file). With **exactly one** source, `contents` is byte-identical to the un-layered single file (no label), so existing callers and the cached `.ai-task-master/coding-style.md` digest are unaffected.

`Orchestrator` prepends `contents` to every subagent system prompt, then layers the role-specific prefix (`planner-system.md`, `worker-system.md`, `reviewer-system.md`) on top.

## `@`-import expansion

The chosen file's contents are passed through `expandImports` before being returned, so Claude Code's `@path` import syntax is honored. A line like `@core/AGENTS.md` is replaced with the referenced file's contents inline — otherwise governance that lives in an `@`-imported file would reach the model as an inert `@core/AGENTS.md` string and its rules would never be seen.

- **Resolution** — `@path` is expanded when `@` starts a line or follows whitespace. Paths resolve relative to the **importing file's** directory.
- **Recursion** — imported files may themselves import, up to a depth cap (default 5). Cycles are detected and stop (the repeated reference is left as literal text).
- **Not expanded** — `@` inside fenced code blocks or inline code spans, email-like `me@host`, escaped `@@`, and any import that does not resolve to a readable file (left as literal text).
- **Containment (hardening)** — imports are confined to the target repo root. Absolute paths, `..` escapes, and `~`-home imports are refused (left literal). `aitm` runs against untrusted target repos, so an `@`-import must never pull a file from outside the repo into the prompt.

## SRP

| Module | Owns | Does NOT |
| --- | --- | --- |
| `AgentConfigDetector` | Filesystem search + return typed `AgentConfig`. | Interpret contents beyond `@`-import expansion. Choose a model. Touch credentials. |
| `expandImports` | Expand `@path` imports within the repo root. | Filesystem search. Know about flavors or `--style`. |
| `Orchestrator` | Compose the final system prompt per subagent. | Re-read the file. |

## Why `CLAUDE.md` does not imply Anthropic

`aitm` decouples "whose conventions does the project follow" from "which LLM API answers our requests". The project might be a Claude-conventioned codebase but `aitm` will still route the call through OpenRouter — possibly to an Anthropic model, possibly to a different one, depending on `models.*` in config. Detection is style-only.

## Custom style

`--style <path>` accepts any markdown file. Useful for monorepos where conventions live in `docs/style.md`, or for testing alternate prompts. Recorded as `flavor: "custom"`.

## Cross-links

- `./coding-style.md`
- `./config.md`
- `./subagents.md`
- `./architecture.md`
