# `aitm profile`

Named **provider profiles** — bundle the provider triple (API key + base URL + per-tier
models) under a name and switch the whole provider in one command, version-manager style
(think `nvm use`). Profiles live in the global config file `~/.aitm.json` under `profiles`,
with `activeProfile` naming the one in effect.

See [`../providers.md`](../providers.md) for the provider-switching walkthrough and
[`../config.md`](../config.md) §"Profiles" for how a profile resolves at run time.

## Signature

```text
aitm profile list
aitm profile use <name>
aitm profile add <name> [--preset openrouter|zai] [--base-url <url>]
                        [--api-key <key> | --api-key-stdin]
aitm profile set <name> <key> <value>
aitm profile get <name> <key>
aitm profile remove <name>
aitm profile rename <from> <to>
aitm profile show [<name>]
```

Profiles are **global-only** (always written to `~/.aitm.json`); there is no `--project`
selector. `<key>` for `set`/`get` is `openrouterApiKey`, `baseURL`, or `models.<tier>`.

`<name>` must be non-empty and cannot be `__proto__`, `prototype`, or `constructor`: those name
`Object.prototype` members, so every subcommand rejects them up front and profile lookups are
own-property only — an inherited key is never mistaken for a profile.

## Subcommands

| Command | Effect |
| --- | --- |
| `list` | List every profile. `*` marks the active one; shows base URL + a **masked** key hint. |
| `use <name>` | Make `<name>` the active profile. Errors if the profile doesn't exist (no dangling pointer). |
| `add <name>` | Create a profile. `--preset` seeds base URL + models; `--base-url` / `--api-key` override. The **first** profile created auto-activates. Prefer `--api-key-stdin` (pipe the key) for scripts/CI — a key passed as `--api-key` is visible in process listings and shell history, so aitm warns when you use it. |
| `set <name> <key> <value>` | Set one field. Value is JSON-parsed (bare strings stay literal), like `config set`. |
| `get <name> <key>` | Print one field's value. |
| `remove <name>` | Delete the profile. If it was active, `activeProfile` is cleared. |
| `rename <from> <to>` | Rename a profile in place, keeping every field. Errors if `<from>` doesn't exist or `<to>` already does. If `<from>` was active, `activeProfile` is repointed at `<to>`. |
| `show [<name>]` | Print a profile as JSON with the key **masked**. Defaults to the active profile. |

## Presets

`--preset` pre-fills a profile from a built-in template. Presets **never** ship an API key —
supply it with `--api-key` or `aitm profile set <name> openrouterApiKey <key>`.

| Preset | Base URL | Models |
| --- | --- | --- |
| `openrouter` | `https://openrouter.ai/api/v1` | (built-in capability defaults) |
| `zai` | `https://api.z.ai/api/coding/paas/v4` | `glm-5.2` (generic/smart/coding), `glm-5-turbo` (fast) |

## Quickstart

```sh
# OpenRouter and z.ai side by side
aitm profile add openrouter --preset openrouter --api-key "sk-or-..."
aitm profile add z.ai       --preset zai        --api-key "<your z.ai key>"

aitm profile use z.ai
aitm start "add a /healthz endpoint with a test" --max-prs 1   # runs on z.ai GLM
aitm profile use openrouter                                     # switch back
```

## Resolution

The active profile supplies provider defaults that sit **between** explicit top-level/project
config and env — precedence per provider field is:

```text
project config  >  global top-level key  >  active profile  >  env
models:  defaults < active profile < global < project < --model
```

So an explicit `openrouterApiKey` / `baseURL` in a config file still overrides the profile, but
the profile beats a stale `OPENROUTER_API_KEY` in the environment. No active profile → resolution
is identical to before profiles existed (full back-compat). A dangling `activeProfile` (set but no
matching profile) warns and falls back to top-level/env rather than failing the run.

## Security

API keys are **masked** in `profile list` and `profile show` (and in `config list`). The raw key
is only ever written to `~/.aitm.json` on disk. The run snapshot
(`.ai-task-master/config.snapshot.json`) records the key's **source** (`<from profile>`), never
its value.

## SRP

`ProfileManager` is the only module that mutates `profiles` / `activeProfile` in `~/.aitm.json`.
Writes are atomic (temp file + rename) and validated against `ConfigFileSchema` before persisting.
Run-time precedence lives in `ConfigLoader`; this command never resolves a run.

## See also

- [`../providers.md`](../providers.md)
- [`../config.md`](../config.md)
- [`../auth.md`](../auth.md)
- [`./config.md`](./config.md)
