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
  "formatCommand": null,              // optional; run in the worktree before the Worker commits
  "verifyCommand": null,              // optional; test/lint gate run before the Worker commits
  "logLevel": "info",
  "allowForcePush": true,             // optional; false forbids all force-push (incl. --force-with-lease)
  "prBodySections": ["## Summary", "## Changes", "## Testing"]  // optional; per-repo PR body headings
}
```

All fields optional. Missing fields fall through to the next source.

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

## Per-role models

Each subagent can run on a different OpenRouter model. Use a cheap fast model for `Planner`, a strong model for `Worker`, a critical model for `Reviewer` — or pin one model everywhere via `models.default`.

`Credentials` returns role-specific model handles. `Orchestrator` injects the right handle into each subagent when constructing it.

> **Model capability matters for `coding`.** The Worker plans each PR group into a structured `FileManifest` (JSON). Weak/cheap models often return an **empty manifest** here, which blocks the group with an actionable message (issue #45). If you see "the configured coding model produced no files", set `models.coding` to a more capable model. The `smart` tier (Planner/Reviewer) likewise wants a strong reasoning model.

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
- `./providers.md`
- `./commands/profile.md`
- `./state.md`
- `./commands/start.md`
- `./architecture.md`
