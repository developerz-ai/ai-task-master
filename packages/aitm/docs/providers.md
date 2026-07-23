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

## Routing controls

On OpenRouter (where one model id can be served by several upstream providers) two config keys
steer *which* provider serves a request and *what happens when one is down*. Both are
provider-shaped, so they also live in a [profile](#profiles-switch-providers-in-one-command) and
resolve project > global > profile. Neither sends anything unless set — with both unset, requests
are byte-identical to today.

### `providerRouting`

Maps onto OpenRouter's `provider.*` routing object. One value applies to every role.

| Field | Type | Effect |
| --- | --- | --- |
| `order` | string[] | Try these providers first, in order (e.g. `["anthropic", "openai"]`). |
| `allowFallbacks` | boolean | Allow providers outside `order`/`only` when the preferred ones fail. |
| `requireParameters` | boolean | Only route to providers that support every request parameter (see below). |
| `sort` | `price \| throughput \| latency` | Sort the eligible provider pool by this axis. |
| `only` | string[] | Restrict routing to exactly these providers. |
| `ignore` | string[] | Never route to these providers. |

```jsonc
// ~/.aitm.json (or ./.ai-task-master/config.json, or a profile)
{
  "providerRouting": {
    "sort": "throughput",
    "requireParameters": true,
    "ignore": ["deepinfra"]
  }
}
```

> **Recommendation: set `requireParameters: true`.** aitm sends structured-output and
> reasoning parameters (`tools`, `reasoning`) that not every upstream provider honors. Without
> `requireParameters`, OpenRouter may route to a provider that silently drops one, producing an
> empty manifest or a missing plan. With it, only providers that support the sent parameters are
> eligible.
>
> **Caveat:** `requireParameters`, `only`, and a strict `order` **narrow the provider pool**. If
> the narrowed pool is empty (or all its members are rate-limited/down) the request fails rather
> than falling back — keep `allowFallbacks` on, or the pool wide enough, on free/low-quota tiers.

**Permanent `amazon-bedrock` exclusion.** aitm **always** unions `amazon-bedrock` into
`provider.ignore`, whatever you configure. Bedrock rejects the AI SDK's structured-output
`output_config.format`, which randomly broke Planner/Worker/Reviewer on free models routed there.
This is baked in (`credentials.ts`) and cannot be re-enabled; your own `ignore` entries are added
on top and de-duplicated.

### `fallbackModels`

Per-capability alternate model ids OpenRouter fails over to on a provider/model outage. They are
sent as OpenRouter's top-level `models` fallback array (the alternates only); the primary stays the
resolved `models.<tier>` id. OpenRouter tries the primary first, then each id in this array in
order. Keyed by the same capability tiers as `models`.

```jsonc
{
  "models":         { "coding": "anthropic/claude-sonnet-4" },
  "fallbackModels": { "coding": ["openai/gpt-5", "google/gemini-2.5-pro"] }
}
```

Use it against single-model outages and free-tier saturation: if the `coding` primary is
unavailable, the request retries the listed ids in order before failing the step.

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

## Model catalog: context window + pricing

`GET {baseURL}/models` is the only place `aitm` learns a model's **context window**, and that window is what decides when the Compactor auto-compacts (see below). The same response supplies per-token pricing for the run's cost line, and `max_completion_tokens` (top-level or under `top_provider`) sizes the reply reserve.

OpenRouter publishes `context_length` on every entry. Other OpenAI-compatible catalogs spell it differently or omit it, so the parser accepts, in order: `context_length`, `top_provider.context_length`, `max_model_len`, `context_window`. Entries that fail to parse are dropped individually rather than failing the whole catalog — one odd model must not cost the run its autocompaction and its cost accounting.

A model whose catalog publishes **no** window is not compacted: `aitm` skips rather than guessing a size and truncating a conversation on a wrong number. If a long run on a custom endpoint never seems to compact, check that its `/models` response carries one of the four keys above.

## Per-model sampling defaults

A model family's usable sampling range is part of its contract, like its context window. aitm used to send **no** sampling parameters at all, so every model ran at whatever its endpoint defaulted to — and several families behave materially worse there. The symptom is not an error, it is degraded instruction-following: on a real run against `glm-5.2` at the endpoint default we saw tool arguments double-encoded as a JSON string, an editor narrating an edit instead of writing it, and an eight-minute reasoning block before the first tool call.

`src/credentials/model-params.ts` holds known-good values for the families that need them, matched on the resolved model id (substring, case-insensitive, so `glm-5.2`, `z-ai/glm-5.2`, and `zai-org/GLM-5.2` all hit):

| Family | temperature | topP | topK |
| --- | --- | --- | --- |
| GLM (4.6 / 4.7 / 5.x) | 1.0 | — | — |
| Qwen | 0.55 | 1 | — |
| MiniMax M2 | 1.0 | 0.95 | 20 |
| Gemini | 1.0 | 0.95 | 64 |
| Kimi K2 thinking / 2.5 | 1.0 | 0.95 | — |
| Kimi K2 | 0.6 | — | — |

A family with no entry contributes nothing and its request stays byte-identical to before the table existed — Anthropic and OpenAI models are deliberately unlisted (Anthropic reasons worse with an explicit temperature). Values mirror opencode's `provider/transform.ts`, which carries them for the same reason across the same families. They compose in `chatSettings` (`credentials.ts`), the single provider-wiring point, so every subagent, the style distiller, and the PR composer get them without a per-call-site opt-in.

## Auto-compaction

Long runs outgrow any window, so every subagent loop compacts itself: when the live context reaches the **usable budget**, a `fast`-tier step rewrites the older conversation into a compact note and the loop resumes with that note plus the most recent N steps verbatim (`src/compaction/`).

Usable is not a fixed fraction of the window. Input and output share the context, so the budget is:

```
usable = contextLength − reserve
reserve = min(20_000, max_completion_tokens)      # the whole 20k when the catalog publishes no output limit
```

A flat fraction gets both ends wrong: 70% of a 200k window strands 60k that the reply will never need, while 70% of a 32k window can still overflow a model that may emit 8k. Reserving what the model can actually emit fixes both — a model capped at 4k output gets 96k of a 100k window for conversation, and a 200k model compacts at 180k. (Same shape as opencode's `session/overflow.ts`, which is where the approach comes from.)

Two windows are left alone: one the catalog never published (no number to be right about), and one smaller than the reserve itself, where summarizing could never bring the conversation under budget and would just burn a summarizer call per step.

## Cross-links

- [`commands/profile.md`](./commands/profile.md) — profile command reference (one-command provider switching)
- [`auth.md`](./auth.md) — credential + base-URL resolution order, error cases
- [`config.md`](./config.md) — full config schema
