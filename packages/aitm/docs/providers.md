# Providers

`aitm` talks to **one OpenAI-compatible endpoint** through `@openrouter/ai-sdk-provider`. The
default is OpenRouter; override the base URL to run against any other OpenAI-compatible provider
(z.ai GLM, a self-hosted gateway, OpenAI, …). One credential, no Anthropic SDK. See
[`auth.md`](./auth.md) for resolution order and validation, [`config.md`](./config.md) for the
full config schema.

## Requirement: function/tool calling

Subagents deliver their structured output (Planner plan, Worker file manifest, Reviewer
resolution, PR composition) by calling a `submit` **tool** — not via `response_format`
json_schema, which some providers silently ignore and return prose for. So **the provider must
support OpenAI-style function/tool calling.** OpenRouter, z.ai GLM, and OpenAI all do.

## The three knobs

| Knob | Config key | Env | Notes |
| --- | --- | --- | --- |
| Credential | `openrouterApiKey` | `OPENROUTER_API_KEY` | The provider's API key (despite the name, it's whatever the `baseURL` provider expects). |
| Endpoint | `baseURL` | `OPENROUTER_BASE_URL` | Unset → `https://openrouter.ai/api/v1`. Validated as a URL. |
| Models | `models.{generic,smart,coding,fast}` | — (config only; `--model` pins `generic`) | Model ids the endpoint serves. |

Each config key works in project config (`./.ai-task-master/config.json`), global
(`~/.aitm.json`), or env. Precedence: project > global > **active profile** > env.

## Profiles: switch providers in one command

Setting the three knobs by hand every time you change provider is tedious. **Profiles** bundle
the provider triple (key + base URL + per-tier models) under a name, so you switch the whole
provider in one command — version-manager style (think `nvm use`). See
[`commands/profile.md`](./commands/profile.md) for the full command reference.

```sh
# Create a profile from a built-in preset (--preset openrouter|zai), add your key:
aitm profile add z.ai       --preset zai        --api-key "<your z.ai key>"
aitm profile add openrouter --preset openrouter --api-key "sk-or-..."

# Switch the active provider (this is the whole point):
aitm profile use z.ai
aitm start "add a /healthz endpoint" --max-prs 1   # now runs on z.ai GLM

aitm profile use openrouter                         # back to OpenRouter
aitm profile list                                   # see all profiles, '*' marks active
```

A preset pre-fills `baseURL` and sensible `models.*`; `--api-key` (or `aitm profile set <name>
openrouterApiKey <key>`) supplies the credential — presets never ship keys. The **active**
profile fills in provider settings at run time, sitting just below explicit top-level/project
config and above env (so `aitm profile use` takes effect even if a stale `OPENROUTER_API_KEY`
lingers in your shell). The sections below show the equivalent **manual** config if you'd rather
edit JSON directly.

## OpenRouter (default)

```jsonc
// ~/.aitm.json  (or ./.ai-task-master/config.json)
{ "openrouterApiKey": "sk-or-..." }
```

or just `export OPENROUTER_API_KEY=sk-or-...`. Models default to `anthropic/claude-*` OpenRouter
routes (see `src/credentials/defaults.ts`); override any tier under `models` if you want a
different route.

## z.ai (GLM coding plan)

Use z.ai's **OpenAI-compatible** coding endpoint (not its Anthropic endpoint):

```jsonc
// ./.ai-task-master/config.json  (or ~/.aitm.json)
{
  "openrouterApiKey": "<your z.ai api key>",
  "baseURL": "https://api.z.ai/api/coding/paas/v4",
  "models": {
    "generic": "glm-5.2",
    "smart": "glm-5.2",
    "coding": "glm-5.2",
    "fast": "glm-5-turbo"
  }
}
```

Or set the key + base URL via env and the models in config:

```sh
export OPENROUTER_API_KEY="<your z.ai api key>"
export OPENROUTER_BASE_URL="https://api.z.ai/api/coding/paas/v4"
```

The flat-rate coding-plan quota (Lite/Pro/Max) is billed through this endpoint.

> **Model ids move.** The `zai` preset pins the current GLM coding-plan models (`glm-5.2`,
> `glm-5-turbo`). z.ai has no stable "latest" alias, so when newer ids ship just point a tier
> at the new id — `aitm profile set z.ai models.coding <new-id>` (or edit `models.*`). Nothing
> auto-upgrades the model, by design: a silent model swap would change behaviour and cost mid-run.

## Any other OpenAI-compatible provider

Same three knobs: point `baseURL` at the provider's OpenAI-compatible URL, set `openrouterApiKey`
to its key, and set `models.*` to ids it serves. The only hard requirement is function/tool
calling support (see above). Example shape:

```jsonc
{
  "openrouterApiKey": "<provider key>",
  "baseURL": "https://<provider>/v1",
  "models": { "generic": "<model-id>", "smart": "<model-id>", "coding": "<model-id>", "fast": "<model-id>" }
}
```

## Cross-links

- [`commands/profile.md`](./commands/profile.md) — profile command reference (one-command provider switching)
- [`auth.md`](./auth.md) — credential + base-URL resolution order, error cases
- [`config.md`](./config.md) — full config schema
