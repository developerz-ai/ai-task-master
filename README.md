# 🤖 AI Task Master (`aitm`)

> **Autonomous task orchestrator. Goal in, merged PRs out.**

Give `aitm` a sentence, walk away, come back to a stack of merged pull requests. It runs a Planner → Worker → Reviewer loop against a real repo using the [Vercel AI SDK](https://ai-sdk.dev) and [OpenRouter](https://openrouter.ai), and ships the work as PR-sized commits with CI gating and review-comment handling baked in.

> 💡 **Inspired by** the (now deprecated) [`developerz-ai/claude-task-master`](https://github.com/developerz-ai/claude-task-master). `aitm` is the spiritual successor — same idea (a task-master that drives the work to merge), rebuilt on the Vercel AI SDK + OpenRouter, provider-agnostic, with concurrent PR groups, MCP client support, and a much smaller surface area.

[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript&logoColor=white)](./tsconfig.json)
[![Bun](https://img.shields.io/badge/Bun-≥1.1-fbf0df?logo=bun&logoColor=black)](https://bun.sh)
[![Node](https://img.shields.io/badge/Node-≥20-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

---

## ✨ Why aitm?

Coding agents are great at single steps, terrible at staying on task across hours. `aitm` closes that gap:

- 🧭 **Planner** splits a goal into ordered, PR-sized **task groups**.
- 🛠️ **Worker** branches, codes, and opens the PR.
- 👀 **Reviewer** drives review-comment resolution and pushes fixes.
- 🚀 **Auto-merge** waits for CI green, then merges — by default.
- 🧱 **Two commands** to learn (`aitm start`, `aitm merge-pr`). That's it.

No babysitting. No prompt-stuffing. No bespoke agent framework.

## ⚡ Install

```bash
bun  install -g @developerz.ai/aitm    # recommended for local dev
npm  install -g @developerz.ai/aitm    # works the same
deno install -A npm:@developerz.ai/aitm
```

The package is scoped (`@developerz.ai/aitm`); the installed command is still `aitm`.

Plain ESM + a `bun build --compile` single-file binary. No runtime lock-in.

## 🚀 Quickstart

```bash
export OPENROUTER_API_KEY=sk-or-...
cd path/to/your/repo
aitm start "add JWT auth to /login" --max-prs 3
```

`aitm` plans the goal into up to 3 PR-sized groups, opens a branch per group, works through them in parallel, opens each PR, watches CI, addresses review comments, and **auto-merges**. Need a human gate?

```bash
aitm start "migrate Mongo → Postgres" --no-automerge
# ... review the PR in your browser ...
aitm merge-pr
```

## 🎯 Use cases

| Scenario | What you type | What aitm does |
| --- | --- | --- |
| 🔐 Add a feature end-to-end | `aitm start "add password reset flow"` | Splits into schema + endpoint + email + tests, one PR per slice |
| 🧹 Refactor across many files | `aitm start "rename Logger to Tracer everywhere" --max-prs 1` | Single sweeping PR, full test pass before merge |
| 🐛 Bug ticket → fix | `aitm start "$(gh issue view 412 --json title,body -q '.title + \"\\n\\n\" + .body')"` | Reads the issue, ships a PR, links it back |
| 🧪 Raise coverage | `aitm start "add tests for src/billing/* until 90% coverage" --max-sessions 20` | Iterates until coverage target hits, or sessions cap is reached |
| 📚 Docs sweep | `aitm start "document every public export in src/api"` | One PR per package, opens drafts for review |
| ⬆️ Dependency upgrade | `aitm start "bump zod to v4 and fix all type errors"` | Bumps, fixes, runs tests, opens PR; conflicts surface as `blocked` |

## 🧠 How it works

```
                                   ┌───────────────┐
                                   │  CLAUDE.md /  │  (coding style for subagents)
                                   │   AGENTS.md   │
                                   └──────┬────────┘
                                          │
   goal ──▶ Planner ──▶ task groups ──▶ Orchestrator ──▶ Worker  ──▶  PR
                                              │             │           │
                                              │             └──▶  ✅ CI / 👀 Reviewer
                                              ▼                         │
                                          StateStore ◀──── auto-merge ◀─┘
```

- **Provider**: any OpenAI-compatible endpoint through one credential — OpenRouter by default, or point `baseURL` at z.ai GLM, a self-hosted gateway, or another provider. No Anthropic SDK. See [🔀 Providers & profiles](#-providers--profiles).
- **Coding style**: `aitm` reads your repo's `CLAUDE.md` or `AGENTS.md` and feeds it to subagents as a style signal.
- **State**: every run persists to `.ai-task-master/` so resume-after-crash is one command.
- **Worktrees**: concurrent groups run in isolated `git worktree`s — no branch trampling.

## 🧰 Requirements

| Requirement | Note |
| --- | --- |
| 🟢 JS runtime | Bun ≥ 1.1, Node ≥ 20, or Deno ≥ 1.40. Bun preferred locally. |
| 🟣 `gh` CLI | authenticated against the target repo's remote |
| 📝 Agent config | `CLAUDE.md` or `AGENTS.md` at the target repo root |
| 🔑 Credentials | `OPENROUTER_API_KEY` env. That's it. |

> 💡 **Claude-conventioned projects**: `aitm` will pick up `CLAUDE.md` as its coding-style source automatically. The provider is still OpenRouter — the file is only a style signal.

## 🧩 Two-command philosophy

`start` and `merge-pr` are the only user-facing commands.

- 🟢 With automerge on (default): `start` runs the whole loop end-to-end.
- 🟡 With `--no-automerge`: `start` stops after each PR opens; you call `aitm merge-pr` once you're happy.

Everything else — planning, task grouping, branch management, retries, review-comment handling — happens inside those two calls.

## 🚩 Key flags

| Flag | Default | Effect |
| --- | --- | --- |
| `--max-prs N` | 5 | Hard cap on PR groups Planner may emit. |
| `--max-sessions N` | unlimited | Hard cap on subagent sessions per run. |
| `--concurrency N` | 1 | How many groups to run in parallel (isolated worktrees). |
| `--no-automerge` | off | Stop after each PR opens; require manual `aitm merge-pr`. |
| `--admin` | off | Merge via `gh pr merge --admin` to override base-branch protection (requires repo-admin rights). Also accepted by `aitm merge-pr`. |
| `--style <path>` | `CLAUDE.md` / `AGENTS.md` | Override the coding-style file fed to subagents. |
| `--model <id>` | provider default | Pin the model (e.g. `anthropic/claude-opus-4.7`). |
| `--criteria <text>` | — | Acceptance criteria appended to the goal. |

> 💡 Both `--key value` and `--key=value` forms are accepted: `--max-prs=3` works the same as `--max-prs 3`.

## ⚙️ Configuration

User config lives at `~/.aitm.json`; per-project overrides at `.ai-task-master/config.json`:

```bash
aitm config set models.smart anthropic/claude-opus-4.7
aitm config set models.coding anthropic/claude-sonnet-4.6
aitm config set models.fast    openai/gpt-5-mini
aitm config set autoMerge true --project
aitm config list
```

See [`docs/config.md`](docs/config.md) for the full schema.

## 🔀 Providers & profiles

`aitm` talks to **one OpenAI-compatible endpoint**. The default is [OpenRouter](https://openrouter.ai); override the base URL to run against any other OpenAI-compatible provider — [z.ai](https://z.ai)'s GLM coding plan, a self-hosted gateway, OpenAI, … One credential, no Anthropic SDK. The only hard requirement is OpenAI-style **function/tool calling** (OpenRouter, z.ai GLM, and OpenAI all support it).

**Profiles** bundle the provider triple (key + base URL + per-tier models) under a name, so you switch the whole provider in one command — version-manager style (think `nvm use`):

```bash
# Create profiles from built-in presets (openrouter | zai), add your key:
aitm profile add openrouter --preset openrouter --api-key "sk-or-..."
aitm profile add z.ai       --preset zai        --api-key "<your z.ai key>"

aitm profile use z.ai                  # switch the active provider…
aitm start "add a /healthz endpoint with a test" --max-prs 1   # …now running on z.ai GLM
aitm profile use openrouter            # …and back

aitm profile list                      # '*' marks the active profile; keys shown masked
```

> ✅ **Verified end-to-end against z.ai GLM** — the Planner/Worker/Reviewer loop runs on `glm-5.2` / `glm-5-turbo` through the GLM coding endpoint (`https://api.z.ai/api/coding/paas/v4`).

Prefer editing JSON? The same thing as plain config:

```jsonc
// ~/.aitm.json
{
  "openrouterApiKey": "<your z.ai key>",
  "baseURL": "https://api.z.ai/api/coding/paas/v4",
  "models": { "generic": "glm-5.2", "smart": "glm-5.2", "coding": "glm-5.2", "fast": "glm-5-turbo" }
}
```

Full walkthrough in [`docs/providers.md`](docs/providers.md); profile command reference in [`docs/commands/profile.md`](docs/commands/profile.md).

## 🧪 Try it on a sandbox repo

```bash
# 1. Clone a throwaway repo
git clone https://github.com/you/scratch && cd scratch

# 2. Drop a tiny CLAUDE.md so subagents know the style
echo "# CLAUDE.md\n- TypeScript strict.\n- No comments unless necessary." > CLAUDE.md

# 3. Set your key and go
export OPENROUTER_API_KEY=sk-or-...
aitm start "add a /healthz endpoint with a test" --max-prs 1
```

A single PR opens, CI runs, it merges. Total wall-clock: a few minutes.

## 📚 Docs

| Topic | Path |
| --- | --- |
| 🏗️ Architecture | [`docs/architecture.md`](docs/architecture.md) |
| 🟢 `aitm start` | [`docs/commands/start.md`](docs/commands/start.md) |
| 🟡 `aitm merge-pr` | [`docs/commands/merge-pr.md`](docs/commands/merge-pr.md) |
| 🔀 `aitm profile` | [`docs/commands/profile.md`](docs/commands/profile.md) |
| 🌐 Providers (OpenRouter / z.ai / generic) | [`docs/providers.md`](docs/providers.md) |
| ⚙️ Config | [`docs/config.md`](docs/config.md) |
| 📝 Agent config detection | [`docs/agent-config-detection.md`](docs/agent-config-detection.md) |
| 🎨 Coding style | [`docs/coding-style.md`](docs/coding-style.md) |
| 🧱 Task groups (PRs) | [`docs/task-groups.md`](docs/task-groups.md) |
| 🤝 Subagents | [`docs/subagents.md`](docs/subagents.md) |
| 💾 State | [`docs/state.md`](docs/state.md) |
| 🔐 Auth | [`docs/auth.md`](docs/auth.md) |
| 🐙 GitHub integration | [`docs/github-integration.md`](docs/github-integration.md) |
| 🏃 Runtime | [`docs/runtime.md`](docs/runtime.md) |
| 📖 Vercel AI SDK reference (chunked) | [`docs/vendor/ai-sdk/index.md`](docs/vendor/ai-sdk/index.md) |

## 🤝 Contributing

PRs welcome. House style is in [`CLAUDE.md`](CLAUDE.md): SOLID, one responsibility per module, every module ships with a paired `*.test.ts`, no `any`, no default exports, conventional commits, no emoji in source.

```bash
bun install
bun test          # unit + integration
bun run typecheck
bun run lint
```

## 📄 License

MIT.
