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
  // omit `baseURL` when unset; if present it must be a valid URL
  "baseURL": "https://api.z.ai/api/coding/paas/v4", // optional; falls back to env OPENROUTER_BASE_URL when omitted
  "activeProfile": "z.ai",            // optional; name of the profile (below) in effect — global only
  "profiles": {                       // optional; named provider bundles — see §Profiles
    "z.ai": { "baseURL": "https://api.z.ai/api/coding/paas/v4", "models": { "coding": "glm-5.2" } }
  },
  "models": {                          // per capability tier (NOT per role) — see §Per-role models
    "generic": "anthropic/claude-opus-4",
    "smart":   "anthropic/claude-opus-4",  // Planner, Reviewer
    "coding":  "openai/gpt-5",             // Worker
    "fast":    "anthropic/claude-sonnet-4" // Orchestrator
  },
  "maxPrs": 5,
  "maxSessions": null,
  "autoMerge": true,
  "mergeMethod": "squash",
  "stylePath": null,
  "formatCommand": null,              // optional; run in the worktree before the Worker commits
  "verifyCommand": null,              // optional; test/lint gate run before the Worker commits
  "logLevel": "info",
  "allowForcePush": true,             // optional; false forbids all force-push (incl. --force-with-lease)
  "prBodySections": ["## Summary", "## Changes", "## Testing"]  // optional; per-repo PR body headings
}
```

All fields optional. Missing fields fall through to the next source. The block above is a
representative subset — the **complete** key list is the reference table below.

## Key reference

Every key `ConfigLoader` accepts, grouped by area. **Scope** is where a key is honored:

- *global* — `~/.aitm.json` only.
- *project + global* — either file; the project file (`./.ai-task-master/config.json`) wins.
- *+ profile* — also settable inside a named profile (resolved below explicit config, above env).
- *CLI `--flag`* — also a `aitm start` flag, which wins over every file.

Keys marked *global* carry a trust boundary: the same key in a repo-shippable project file is
parsed but **ignored and warned**, so a cloned repo can't set it (credential, endpoint, or
code-execution surfaces). Keys absent from a file fall through per the
[Resolution order](#resolution-order).

### Provider and models

| Key | Type | Default | Scope | Purpose |
| --- | --- | --- | --- | --- |
| `openrouterApiKey` | string | — (required, or env) | global, + profile | Provider API key. Project value ignored + warned. Env `OPENROUTER_API_KEY`. |
| `baseURL` | URL string | `https://openrouter.ai/api/v1` | global, + profile | OpenAI-compatible endpoint override. Project value ignored + warned. Env `OPENROUTER_BASE_URL`. See [baseURL](#baseurl). |
| `activeProfile` | string | unset | global | Name of the `profiles` entry seeding this run. See [Profiles](#profiles). |
| `profiles` | map | `{}` | global | Named provider bundles (write via `aitm profile …`). See [Profiles](#profiles). |
| `models` | `{generic,smart,coding,fast}` | provider defaults | project + global, + profile, CLI `--model` (pins `generic`) | Per-capability model ids. See [Per-role models](#per-role-models). |
| `providerRouting` | object | unset | project + global, + profile | OpenRouter `provider.*` routing controls. See [providers.md](./providers.md#routing-controls). |
| `fallbackModels` | `{tier: string[]}` | unset | project + global, + profile | Per-tier failover model ids. See [providers.md](./providers.md#routing-controls). |
| `reasoningEffort` | `{tier: effort}` | `{}` | project + global, + profile | Per-tier OpenRouter reasoning effort. See [reasoningEffort](#reasoningeffort). |

### Run control

| Key | Type | Default | Scope | Purpose |
| --- | --- | --- | --- | --- |
| `maxPrs` | int > 0 | `5` | project + global, CLI `--max-prs` | Cap on PR groups opened in one run. |
| `maxSessions` | int > 0 or `null` | `null` (unlimited) | project + global, CLI `--max-sessions` | Cap on work sessions before the run stops. |
| `maxCiFixAttempts` | int > 0 | `3` | project + global, CLI `--max-fix-attempts` | CI-fix passes per PR group before it blocks. See [maxCiFixAttempts](#maxcifixattempts). |
| `maxCostUsd` | number > 0 | unset (no ceiling) | project + global | Run-level cost ceiling; stops opening new PR groups when crossed. See [maxCostUsd and maxTotalTokens](#maxcostusd-and-maxtotaltokens). |
| `maxTotalTokens` | int > 0 | unset (no ceiling) | project + global | Run-level token ceiling; stops opening new PR groups when crossed. See [maxCostUsd and maxTotalTokens](#maxcostusd-and-maxtotaltokens). |
| `llmStepTimeoutMs` | int ≥ 1000 | `900000` (15 min) | project + global | Per-step LLM request deadline. See [llmStepTimeoutMs](#llmsteptimeoutms). |
| `concurrency` | int > 0 | `1` | project + global, CLI `--concurrency` | PR groups worked in parallel. See [concurrency and editorConcurrency](#concurrency-and-editorconcurrency). |
| `editorConcurrency` | int ≥ 1 | `4` | project + global | Editor files fanned out per Worker. See [concurrency and editorConcurrency](#concurrency-and-editorconcurrency). |
| `logLevel` | `debug \| info \| warn \| error` | `info` | project + global | Log verbosity. |
| `streaming` | boolean | `false` | project + global | Stream subagent output live. See [streaming](#streaming). |

### Worker commit and PR gates

| Key | Type | Default | Scope | Purpose |
| --- | --- | --- | --- | --- |
| `formatCommand` | string | unset | project + global | Formatter run before `git add`. See [formatCommand](#formatcommand). |
| `verifyCommand` | string | unset | project + global | Test/lint gate run before commit. See [verifyCommand](#verifycommand). |
| `selfReview` | boolean | `true` | project + global | Pre-PR adversarial self-review + verify + fix pass. See [selfReview](#selfreview). |
| `webSearch` | boolean \| object | unset (CI-fix only) | project + global | OpenRouter `web_search` on Worker calls (tri-state) + optional domain filters. See [webSearch](#websearch). |
| `generateSpecialists` | boolean | `true` | project + global | Generate a specialist team when the repo ships no `.claude/agents`. See [generateSpecialists](#generatespecialists). |
| `prBodySections` | string[] | Summary / Changes / Testing | project + global | PR body headings. See [prBodySections](#prbodysections). |

### Git and merge

| Key | Type | Default | Scope | Purpose |
| --- | --- | --- | --- | --- |
| `autoMerge` | boolean | `true` | project + global, CLI `--no-automerge` | Auto-merge a green PR. See [start.md](./commands/start.md#auto-merge). |
| `mergeMethod` | `squash \| merge \| rebase` | `squash` | project + global | Merge strategy for `gh pr merge`. |
| `allowForcePush` | boolean | `true` | project + global | Permit `--force-with-lease`. See [allowForcePush](#allowforcepush). |
| `resolveConflicts` | boolean | `true` | project + global | Hand a rebase/merge conflict to an AI subagent before blocking. See [resolveConflicts](#resolveconflicts). |
| `stylePath` | string or `null` | detected | project + global, CLI `--style` | Coding-style file override. See [coding-style.md](./coding-style.md). |

### Governance and tools

| Key | Type | Default | Scope | Purpose |
| --- | --- | --- | --- | --- |
| `bashRules` | `{pattern, action}[]` | built-in denies | project + global | Deny/allow rules for the bash tool (#113); appended before the built-in destructive-command defaults, first-match-wins. |
| `hooks` | `{preToolUse, postToolUse}` | unset | global | PreToolUse/PostToolUse shell hooks. See [hooks](#hooks). |
| `mcpServers` | map | `{}` | project + global (+ Claude interop) | External MCP servers to mount. See [mcp.md](./mcp.md). |
| `mcpRoleAllowlist` | map | unset (every server to every role) | project + global | Per-role MCP server/tool allowlist. See [MCP tool controls](#mcp-tool-controls). |
| `mcpDeferToolsOver` | int ≥ 0 | `20` | project + global | Defer a role's MCP tools to stubs + `tool_search` above this count. See [MCP tool controls](#mcp-tool-controls). |

## baseURL

Overrides the OpenAI-compatible inference endpoint (provider default `https://openrouter.ai/api/v1`). Set it to target a self-hosted gateway, a proxy, or another provider's OpenAI-compatible API — e.g. the z.ai GLM coding plan at `https://api.z.ai/api/coding/paas/v4`. Resolution order: project config > global config > env `OPENROUTER_BASE_URL`; unset everywhere → the provider default. Validated as a URL. When set, point `models.*` at ids the endpoint serves (e.g. `glm-5.2`). This is an OpenAI-compatible path only — see [auth.md](./auth.md) §Anthropic. Not a CLI flag. See also [auth.md](./auth.md) §"Base URL" and [providers.md](./providers.md) for per-provider configs (OpenRouter / z.ai / generic).

## Profiles

`profiles` + `activeProfile` bundle the provider triple (`openrouterApiKey` + `baseURL` +
`models`) under a name so `aitm profile use <name>` switches the whole provider in one command —
version-manager style. **Global-only** (the write surface is `aitm profile …`, which always
targets `~/.aitm.json`).

The active profile supplies provider defaults that sit between explicit top-level config and env:

```text
apiKey / baseURL:  project > global top-level > active profile > env
models:            defaults < active profile < global < project < --model
```

So an explicit key/baseURL in a config file still wins, but the active profile beats a stale
`OPENROUTER_API_KEY` in the environment. No `activeProfile` set → resolution is identical to
before profiles existed (full back-compat). A dangling `activeProfile` (named but absent from
`profiles`) warns and falls back rather than failing the run. Full command reference and presets:
[`commands/profile.md`](./commands/profile.md).

## allowForcePush

`true` by default. aitm's git guard already refuses a raw `git push --force` / `-f` (even alongside `--force-with-lease`, which git lets override the lease); the only sanctioned force-push is a bare `--force-with-lease`, used by the CI-fix flow after rebasing onto the latest base. Set `allowForcePush: false` on a repo whose policy forbids **all** force-pushes: the guard then also rejects `--force-with-lease`, and the CI-fix rebase-and-push path blocks cleanly (a human lands the rebased fix) instead of pushing. Project/global config only — not a CLI flag.

## prBodySections

Every aitm-opened PR follows a fixed body shape so reviewers get a consistent layout. By default that is `## Summary`, `## Changes`, `## Testing`. Set `prBodySections` to a list of `## ` headings (in order) to match a repo whose convention differs — e.g. `["## What", "## Why", "## Changes", "## Verification"]`. The list drives both the model guidance (what the composer is told to produce) and the post-composition contract check (`assertPrBodySections`) from one source, so they never drift. Every entry must be a real `## ` heading; an empty list or any malformed entry falls back to the default. Project/global config only — not a CLI flag.

## formatCommand

LLM output is rarely byte-identical to a project's formatter, so on a repo with a format-gated CI (biome/prettier/gofmt/black) an otherwise-correct PR would fail on formatting alone. Set `formatCommand` to a shell command (e.g. `"bun run lint:fix"`); the Worker runs it in the worktree **before `git add -A`**, so the committed diff already matches the formatter. A non-zero exit (e.g. unfixable lint errors) surfaces as a Worker error rather than a later CI failure. Project/global config only — not a CLI flag. Unset → no format step (current behavior).

## verifyCommand

The first time any test or lint runs against a Worker's diff is otherwise on GitHub CI, after the PR is already open — every avoidable red-CI cycle costs a full remote round-trip plus a coding-tier fix session. Set `verifyCommand` to a shell command (e.g. `"bun test"` or `"bun run lint && bun test"`); the Worker runs it in the worktree **after the editor fanout and after `formatCommand`, before `git add`**. On a non-zero exit the Worker runs **one** bounded local fix pass (a task-scoped manifest+editor re-run fed the tail of the verify output), then re-verifies. Exit 0 → commit as usual; still non-zero → the group **blocks without committing** and no PR is opened, so a red diff never reaches the remote. The verify call is given a 600s timeout (the bash tool's ceiling) so real test suites aren't cut off. The same gate is inherited by the CI-fix session and the `merge-pr` take-over fix pass. Project/global config only — not a CLI flag. Unset → no verify step (current behavior).

## selfReview

`true` by default. Before opening **each** PR, a coordinator-driven pass adversarially self-reviews, re-verifies, and fixes the just-committed diff — aitm never opens a PR it hasn't reviewed itself, treating external CI and CodeRabbit as backstops rather than the only gate. Set `selfReview: false` to open the PR straight after the Worker commits (the pre-self-review behavior), trading pre-PR safety for speed/cost. Project/global config only — not a CLI flag.

## generateSpecialists

`true` by default. When the target repo ships no `.claude/agents/*.md`, aitm generates a specialist team on the fly from the goal plus the accepted plan and persists it under `.ai-task-master/agents/`. Repo-shipped agents always win — this only fills the gap when there are none. Set `generateSpecialists: false` to run with the generic Worker alone (no synthesized specialists). Project/global config only — not a CLI flag.

## resolveConflicts

`true` by default. When a rebase or merge hits a conflict, aitm hands it to an AI subagent to resolve and retries the force-push + merge instead of blocking the group for manual resolution. Attempts are bounded; an unresolvable conflict still aborts the rebase and blocks. Set `resolveConflicts: false` to block on the first conflict for a human to land. Project/global config only — not a CLI flag.

## maxCiFixAttempts

Default `3`. Bounds the `waiting-ci ⇄ ci-failed` recovery loop: after a PR group's CI goes red, aitm runs a fix session and re-pushes, up to this many times, before it **blocks for a human** rather than burning sessions on an unfixable red PR. Each attempt is a full coding-tier fix pass plus a remote CI round-trip, so this is a direct cost/patience knob on flaky or genuinely-broken PRs. Set higher for tolerant repos, lower to fail fast. Also settable per run with `aitm start --max-fix-attempts N`.

## maxCostUsd and maxTotalTokens

Unattended-run guardrails. Neither is set by default, so a run is unbounded and byte-identical to before unless you opt in.

- `maxTotalTokens` — the run's cumulative input + output tokens across every subagent.
- `maxCostUsd` — the run's cumulative priced cost in US dollars.

The work loop consults the live usage ledger **at each PR-group boundary, before dispatching the next group** — so a crossed ceiling stops the run *between* groups (never mid-commit, never abandoning work in flight). The run then blocks with a budget reason (exit 1) and opens no further PRs.

```jsonc
{
  "maxTotalTokens": 2000000,   // stop before the next group once the run has spent 2M tokens
  "maxCostUsd": 5.0            // …or once priced cost reaches $5
}
```

Set either, or both (whichever trips first stops the run). This is a **guardrail, not a hard cap**: cost is priced at ledger-flush and the check runs at group boundaries, so a single group already in flight can carry the totals past the ceiling before the next check sees it. Cost enforcement is also skipped for any run whose model has **no known price** (the ledger reports tokens but `null` cost) — use `maxTotalTokens` when running on an unpriced/self-hosted model. Project/global config only — not a CLI flag.

## llmStepTimeoutMs

Default `900000` (15 minutes); minimum `1000`. A per-**step** deadline armed on every LLM generate call so a stalled provider cannot hang an unattended run. It bounds **one** step — a single provider HTTP call plus that step's tool executions — not the whole run, so it must clear the bash tool's own 600s ceiling plus a slow high-effort completion; hence the high default. **Honest limitation:** a step that times out is **not** auto-retried — the deadline aborts the stalled call and the run surfaces the failure; it is a hang guard, not a resiliency/retry layer. Project/global config only — not a CLI flag.

## concurrency and editorConcurrency

Two independent parallelism knobs:

- `concurrency` (default `1`) — how many **PR groups** may have a Worker running at the same time. `1` is sequential (groups land one after another); raise it to work independent groups in parallel. Also settable per run with `aitm start --concurrency N`.
- `editorConcurrency` (default `4`, min `1`) — how many **editor files** a single Worker fans out in parallel while applying one group's file manifest. Project/global config only — no CLI flag.

They compose: up to `concurrency × editorConcurrency` editor calls can be in flight at once, so raise them together only with provider rate limits and machine resources in mind.

## webSearch

Attaches OpenRouter's server-side `web_search` tool to Worker generate calls. **Tri-state**, so it is deliberately *not* collapsed to a boolean default:

- **unset** (default) — enabled for **CI-fix sessions only**. That is the highest-value lookup point (an unfamiliar failing dependency or error) at a bounded cost.
- `true` — enabled on **all** Worker calls.
- `false` — **never** enabled.

### Domain filters

To restrict which sites `web_search` may draw from, use the **object form** instead of a bare boolean. `enabled` occupies the same tri-state axis (omit it for the CI-fix-only default, `true` for all Worker calls, `false` for never); `allowedDomains` / `excludedDomains` map onto OpenRouter's `allowed_domains` / `excluded_domains` and ride the server-tool payload whenever web_search is enabled:

```jsonc
{
  "webSearch": {
    "enabled": true,                       // same tri-state as the bare boolean; omit for CI-fix-only
    "allowedDomains": ["docs.rs", "developer.mozilla.org"],
    "excludedDomains": ["pinterest.com"]
  }
}
```

A bare boolean (`"webSearch": true`) carries no domain filters — identical to before. Project/global config only — not a CLI flag.

## streaming

`false` by default. Routes subagent generate calls through the AI SDK's `streamText` funnel instead of `generateText`, so text and tool-call lines render **live** as the model streams rather than after each step finishes. Higher-risk (a two-regime stall watchdog covers it), so it stays off until burn-in. Config-only, no CLI flag. See [observability.md](./observability.md).

## MCP tool controls

Two keys tune how a role's Model Context Protocol tools are exposed; both are **aitm-config only** (project > global) — the Claude Code interop sources contribute `mcpServers` alone, never these. See [mcp.md](./mcp.md) for the server surface itself.

- `mcpRoleAllowlist` — restrict which servers/tools each role (Planner, Worker, Reviewer) sees. Entries are whole servers by name, or per-server `*`-glob tool patterns. Unset → every role gets every connected server.
- `mcpDeferToolsOver` — default `20`; `0` = always defer. Once a role's MCP tool count exceeds this threshold, those tools are deferred to name-only stubs plus a `tool_search` tool, keeping their full JSON schemas out of every request until the model asks for them. Bounds request size on servers that expose many tools.

## hooks

PreToolUse/PostToolUse shell hooks on the tool registry (issue #121) — the programmable governance escape hatch above the declarative `bashRules` deny/allow engine. Each hook is a shell command gated by an optional `matcher` (a `*`-glob on the tool name; omitted = all tools) with an optional per-hook `timeoutMs` (default 30s).

```jsonc
{
  "hooks": {
    "preToolUse":  [{ "matcher": "bash", "command": "./scripts/guard.sh", "timeoutMs": 30000 }],
    "postToolUse": [{ "matcher": "writeFile", "command": "./scripts/lint-notice.sh" }]
  }
}
```

- **PreToolUse** runs before the tool executes, receiving `{"event":"PreToolUse","toolName","input","cwd"}` on stdin. Exit 2 **blocks** the call (the model sees a typed denial — the `bashRules` exit-126 shape for `bash`/`multiBash`, a `{ok:false,blockedByHook:true,reason}` object otherwise); exit 0 with a stdout `{"input":…}` **rewrites** the tool input (a rewrite failing the tool's schema is discarded with a warning); any other non-zero exit, timeout, or spawn failure **fails open** with a logged warning — a hook can never crash or hang the run.
- **PostToolUse** runs after the tool, receiving the result too; non-empty stdout is surfaced to the model as a delimited feedback block. It cannot block or rewrite.
- Applied after the MCP/local partial-fill, so both MCP-supplied and local tools are covered.

**Trust boundary:** hook commands run shell commands with the operator's privileges, so hooks are honored **only from the user-owned global config `~/.aitm.json`**. The same `hooks` key in the per-repo `./.ai-task-master/config.json` — which an untrusted repo could ship — is parsed but **ignored and warned**, and the worked-on repo's `.claude/settings.json` (or any repo-shipped file) is never consulted. This keeps a cloned repo from executing code as the operator.

**Bypass limitation:** hooks intercept the tool boundary only. Child processes of a single `bash` call are visible to PreToolUse only as the text of that one command, and harness-side subprocesses (e.g. `gh pr merge` in `GitHubClient.mergePr`) never cross the tool boundary at all. Hooks are a governance seam, not a sandbox.

## Per-role models

Models are configured by **capability tier**, not by a per-role key. Each subagent maps to a tier: `smart` (Planner, Reviewer), `coding` (Worker), `fast` (Orchestrator), and `generic` — the fallback used for any tier left unset. So set a strong reasoning model on `smart`, a capable code model on `coding`, and a cheap model on `fast` — or pin one model everywhere via `models.generic`, which every other tier falls back to. (There is no `models.default` / `models.planner` / `models.worker` key; those are silently ignored.)

`Credentials` resolves each role to its tier's handle (`models[tier] || models.generic || built-in default`) and `Orchestrator` injects it into the subagent.

> **Model capability matters for `coding`.** The Worker plans each PR group into a structured `FileManifest` (JSON). Weak/cheap models often return an **empty manifest** here, which blocks the group with an actionable message (issue #45). If you see "the configured coding model produced no files", set `models.coding` to a more capable model. The `smart` tier (Planner/Reviewer) likewise wants a strong reasoning model.

## reasoningEffort

Set OpenRouter [reasoning effort](https://openrouter.ai/docs/use-cases/reasoning-tokens) per capability tier. Each tier is optional; a tier with no entry is sent with **no** `reasoning` parameter, so its requests are byte-identical to today. Strictly opt-in — nothing is defaulted, because a `reasoning` param can be rejected by a custom-`baseURL` gateway or a non-reasoning model.

```jsonc
{
  "reasoningEffort": {
    "smart":  "high",     // Planner, Reviewer
    "coding": "medium",   // Worker (manifest + editor fanout)
    "fast":   "none"      // Orchestrator
  }
}
```

Values: `xhigh`, `high`, `medium`, `low`, `minimal`, `none`. Keys are capability tiers (`generic`, `smart`, `coding`, `fast`), same as `models` — the tier is selected by capability, not by the resolved model id, so a tier served through the model fallback chain still carries its own effort. Unlike `models.generic`, `reasoningEffort.generic` is **not** a fallback for the other tiers; it applies only to explicit `generic` resolution.

Recommended tiers (mirrors the comment next to `DEFAULT_MODELS`):

| Tier | Roles | Recommended | Why |
| --- | --- | --- | --- |
| `smart` | Planner, Reviewer | `high` | a wrong plan or missed review costs a whole run leg |
| `coding` | Worker | `medium` | quality/volume balance on the highest-traffic tier |
| `fast` | Orchestrator | `none` | routing/summarization needs no deliberation |
| `generic` | (fallback model tier) | unset | effort has no generic-fallback semantics |

Provider-shaped, so it can live in a named profile (`aitm profile set <name> reasoningEffort.smart high`) and resolves project > global > profile, merged per capability. See §Profiles.

## SRP

| Module | Owns | Does NOT |
| --- | --- | --- |
| `ConfigLoader` | Find, parse, merge, and validate config files. Return a typed `ResolvedConfig`. | Read state, talk to providers, mutate env. |
| `Credentials` | Take `ResolvedConfig`, produce AI SDK model handles per role. | Read config files itself. |

`ConfigLoader` is the only module allowed to read `~/.aitm.json` or `.ai-task-master/config.json`. SRP.

## Validation

- Zod schema. Unknown keys → warning, not error (forward-compat).
- Type errors → exit 1 with file + path, e.g., `.ai-task-master/config.json: models.coding must be string`.
- `OPENROUTER_API_KEY` missing AND not in config → exit 1 with auth instructions.

## Cross-links

- `./auth.md`
- `./providers.md`
- `./commands/profile.md`
- `./state.md`
- `./commands/start.md`
- `./architecture.md`
