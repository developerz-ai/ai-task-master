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
  contents: string;       // raw markdown of the chosen file
};
```

`Orchestrator` prepends `contents` to every subagent system prompt, then layers the role-specific prefix (`planner-system.md`, `worker-system.md`, `reviewer-system.md`) on top.

## SRP

| Module | Owns | Does NOT |
| --- | --- | --- |
| `AgentConfigDetector` | Filesystem search + return typed `AgentConfig`. | Parse beyond reading file contents. Choose a model. Touch credentials. |
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
