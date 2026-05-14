# Config

Persistent settings live in JSON config files. CLI flags always win. Projects keep **one** `aitm` artifact: the `.ai-task-master/` directory. Config-as-override lives inside it.

## Files

| Path | Scope | Purpose |
| --- | --- | --- |
| `~/.aitm.json` | Global | User-wide defaults: API key, default models, default `maxPrs`, default merge method. |
| `./.ai-task-master/config.json` | Project (target repo root) | Per-project overrides. Same schema as global, every field optional. Lives inside the existing state dir so a project has exactly one `aitm`-owned path. |

Both files are optional. A run with neither still works using built-in defaults plus env vars.

The project file is read by `ConfigLoader` *before* `StateStore` initializes the rest of `.ai-task-master/`. Treat it as the only file in `.ai-task-master/` that survives across runs — everything else (`plan.md`, `state.json`, `scratch/`, `downloads/`) is run-scoped. Add `.ai-task-master/` to `.gitignore` if you want config to stay personal; **un**-ignore `config.json` if the team wants shared defaults.

## Resolution order

`ConfigLoader` merges sources in this order; later sources win:

1. Built-in defaults.
2. `~/.aitm.json`.
3. `./.ai-task-master/config.json` (project override).
4. Environment variables (e.g., `OPENROUTER_API_KEY`).
5. CLI flags.

The merged result is what every other module sees. A frozen snapshot is written to `.ai-task-master/config.snapshot.json` at run start so a resumed run reproduces the same behavior even if the source files have changed.

## Schema

```jsonc
{
  "openrouterApiKey": "sk-or-...",    // optional; falls back to env OPENROUTER_API_KEY
  "models": {
    "default":  "anthropic/claude-opus-4",
    "planner":  "anthropic/claude-opus-4",
    "worker":   "openai/gpt-5",
    "reviewer": "anthropic/claude-sonnet-4"
  },
  "maxPrs": 5,
  "maxSessions": null,
  "autoMerge": true,
  "mergeMethod": "squash",
  "stylePath": null,
  "logLevel": "info"
}
```

All fields optional. Missing fields fall through to the next source.

## Per-role models

Each subagent can run on a different OpenRouter model. Use a cheap fast model for `Planner`, a strong model for `Worker`, a critical model for `Reviewer` — or pin one model everywhere via `models.default`.

`Credentials` returns role-specific model handles. `Orchestrator` injects the right handle into each subagent when constructing it.

## SRP

| Module | Owns | Does NOT |
| --- | --- | --- |
| `ConfigLoader` | Find, parse, merge, and validate config files. Return a typed `ResolvedConfig`. | Read state, talk to providers, mutate env. |
| `Credentials` | Take `ResolvedConfig`, produce AI SDK model handles per role. | Read config files itself. |

`ConfigLoader` is the only module allowed to read `~/.aitm.json` or `.ai-task-master/config.json`. SRP.

## Validation

- Zod schema. Unknown keys → warning, not error (forward-compat).
- Type errors → exit 1 with file + path, e.g., `.ai-task-master/config.json: models.worker must be string`.
- `OPENROUTER_API_KEY` missing AND not in config → exit 1 with auth instructions.

## Cross-links

- `./auth.md`
- `./state.md`
- `./commands/start.md`
- `./architecture.md`
