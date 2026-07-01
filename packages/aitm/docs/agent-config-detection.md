# Agent config detection

`AgentConfigDetector` decides which coding-style convention `aitm` follows for the target repo. It picks a **style source**, not a provider — the provider is always OpenRouter.

## Search order

At target repo root:

1. `--style <path>` CLI flag — if supplied, used verbatim. Detector skips filesystem search.
2. `./CLAUDE.md` → style flavor `claude`.
3. `./AGENTS.md` → style flavor `agents` (used by Codex, OpenAI tooling, and other generic agents).
4. Both present → prefer `CLAUDE.md`. Log the choice. Override with `--prefer agents`.
5. Neither present and no `--style` → exit 1 with instructions to create one or pass `--style`.

The chosen file path and flavor are persisted to `state.json.agentConfigFile` so resumed runs use the same source.

## Output contract

```
type AgentConfig = {
  flavor: "claude" | "agents" | "custom";
  path: string;
  contents: string;       // markdown of the chosen file, with @-imports expanded
};
```

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
