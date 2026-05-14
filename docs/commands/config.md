# `aitm config`

Read and write the JSON config files.

Two surfaces, same shape (see `../config.md`):

| Scope | File | Selector |
| --- | --- | --- |
| Global | `~/.aitm.json` | default |
| Project | `./.ai-task-master/config.json` | `--project` |

## Signature

```
aitm config set <key> <value> [--project]
aitm config unset <key>      [--project]
aitm config get <key>        [--project]
aitm config list             [--project]
```

`<key>` is dotted: `models.smart`, `mergeMethod`, `autoMerge`, `concurrency`. `<value>` is JSON-parsed (`"sk-or-..."`, `true`, `5`, `null`).

## Capability tiers

Models are configured by capability, not by subagent role. Tiers and their canonical defaults (OpenRouter routes — see `../auth.md`):

| Tier | Default | Used by |
| --- | --- | --- |
| `fast` | `anthropic/claude-haiku-4.5` | Orchestrator routing, `toModelOutput` compaction |
| `generic` | `anthropic/claude-sonnet-4.6` | Fallback for any unspecified tier |
| `smart` | `anthropic/claude-opus-4.7` | Planner, Reviewer |
| `coding` | `anthropic/claude-opus-4.7` | Worker |

Role→tier mapping is fixed (`src/credentials/credentials.ts §ROLE_CAPABILITY`); tier→model is user-configurable.

## API key

`aitm config set openrouterApiKey "sk-or-..."` writes the key. `aitm start` still falls back to `OPENROUTER_API_KEY` in env (see `../auth.md` §"LLM provider" — resolution order).

## SRP

`ConfigWriter` is the only module allowed to mutate config files. Writes are atomic (temp file + rename) and validated against `ConfigFileSchema` before persisting.

## See also

- `../config.md`
- `../auth.md`
- `./start.md`
