# Auth

`aitm` has two independent auth surfaces — the LLM provider and GitHub. Neither touches Anthropic.

## LLM provider

OpenRouter only. OpenAI-compatible API. One credential.

| Source | Order | Owner |
| --- | --- | --- |
| `openrouterApiKey` in `./.ai-task-master/config.json` (project) | 1 | `ConfigLoader` |
| `openrouterApiKey` in `~/.aitm.json` (global) | 2 | `ConfigLoader` |
| `openrouterApiKey` in the **active profile** (`~/.aitm.json`) | 3 | `ConfigLoader` |
| Env `OPENROUTER_API_KEY` | 4 | `ConfigLoader` |

The active profile (set via `aitm profile use`) supplies provider defaults below explicit
top-level config but above env — see [`commands/profile.md`](./commands/profile.md) and
[`config.md`](./config.md) §Profiles. `Credentials` receives the resolved key from `ConfigLoader` and constructs role-specific AI SDK model handles via `@openrouter/ai-sdk-provider`.

### Base URL

The provider defaults to `https://openrouter.ai/api/v1`. Override it to point at any
**OpenAI-compatible** endpoint — a self-hosted gateway, a proxy, or another provider's
OpenAI-compatible API (e.g. the z.ai GLM coding plan at
`https://api.z.ai/api/coding/paas/v4`). This stays within the OpenAI-compatible contract —
it is **not** an Anthropic SDK path (see [Anthropic](#anthropic) below).

| Source | Order | Owner |
| --- | --- | --- |
| `baseURL` in `./.ai-task-master/config.json` (project) | 1 | `ConfigLoader` |
| `baseURL` in `~/.aitm.json` (global) | 2 | `ConfigLoader` |
| `baseURL` in the **active profile** (`~/.aitm.json`) | 3 | `ConfigLoader` |
| Env `OPENROUTER_BASE_URL` | 4 | `ConfigLoader` |

Unset in every source → the provider default. The value is validated as a URL. When a
custom base URL is set, point `models.*` at model ids the endpoint serves (e.g. `glm-5.2`).
See [`providers.md`](./providers.md) for ready-to-copy OpenRouter / z.ai / generic configs.

Error cases:

| Case | Behavior |
| --- | --- |
| No key in any source | Exit 1: print instructions to set `OPENROUTER_API_KEY` or add it to `~/.aitm.json`. |
| Key rejected by OpenRouter (401) | Exit 1: surface the upstream message. No retries on auth failure. |
| Rate limit (429) | Exponential backoff with jitter inside the `Credentials`-built fetch wrapper. |

## GitHub

`gh` CLI auth, separate from the LLM. `GitHubClient` shells out to `gh` and assumes the user is already logged in.

| Check | Owner |
| --- | --- |
| `gh auth status` returns ok | `CLI` (precondition) |
| Token has `repo` + `workflow` scopes | `GitHubClient` (lazy, on first call) |

If `gh` is missing or unauthenticated, `CLI` exits 1 with instructions before any LLM call is made.

## Anthropic

Not used. Ever. `aitm` does not call Anthropic, does not read `~/.claude/.credentials.json`, does not bundle `@ai-sdk/anthropic`. The only Claude-related concept is recognising `CLAUDE.md` in a target repo as a coding-style source (see `./coding-style.md`).

## Security

- Keys never logged. `Logger` redacts any field whose name matches `/key|token|secret|authorization/i`.
- `config.snapshot.json` in `.ai-task-master/` stores the key **with the value redacted** — only the resolution source is recorded for debugging.
- SRP: only `ConfigLoader` reads the JSON config files; only `Credentials` constructs model handles; only `GitHubClient` shells `gh`. No module crosses these boundaries.

## Cross-links

- `./config.md`
- `./providers.md`
- `./commands/profile.md`
- `./agent-config-detection.md`
- `./github-integration.md`
- `./architecture.md`
