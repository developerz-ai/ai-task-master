# 🤖 @developerz.ai/aitm

> Autonomous task orchestrator. Goal in, merged PRs out.

Give `aitm` a sentence, walk away, come back to a stack of merged pull requests.
It runs a **Planner → Worker → Reviewer** loop against a real repo using the
[Vercel AI SDK](https://ai-sdk.dev) and [OpenRouter](https://openrouter.ai), and
ships the work as PR-sized commits with CI gating and review-comment handling
baked in.

> 💡 Spiritual successor to the (deprecated)
> [`developerz-ai/claude-task-master`](https://github.com/developerz-ai/claude-task-master)
> — same idea, rebuilt on the AI SDK + OpenRouter: provider-agnostic, concurrent
> PR groups, MCP client support, smaller surface area.

## ⚡ Install

```bash
npm  install -g @developerz.ai/aitm
bun  install -g @developerz.ai/aitm
deno install -A npm:@developerz.ai/aitm
```

The package is scoped; the installed command is just **`aitm`**.

## 🚀 Quickstart

```bash
export OPENROUTER_API_KEY=sk-or-...
cd path/to/your/repo
aitm start "add JWT auth to /login" --max-prs 3
```

`aitm` plans the goal into up to 3 PR-sized groups, opens a branch per group,
works through them in parallel, opens each PR, watches CI, addresses review
comments, and **auto-merges**. Want a human gate?

```bash
aitm start "migrate Mongo → Postgres" --no-automerge
# ... review the PR in your browser ...
aitm merge-pr
```

## 🧠 How it works

| Role | Responsibility |
| --- | --- |
| **Orchestrator** | Top-level agent; drives the run group-by-group |
| **Planner** | Goal in → ordered PR groups (each a list of tasks) out |
| **Worker** | One PR group in → commits + an opened PR out |
| **Reviewer** | Review comments in → follow-up commits out |

Subagents are wired with the [subagents-as-tools](https://ai-sdk.dev/docs/agents/subagents)
pattern (isolated context windows, focused prompts, natural parallelism), built
on [`@developerz.ai/ai-claude-compat`](https://www.npmjs.com/package/@developerz.ai/ai-claude-compat).

## 🎯 Use cases

| What you type | What `aitm` does |
| --- | --- |
| `aitm start "add password reset flow"` | Splits into schema + endpoint + email + tests, one PR per slice |
| `aitm start "rename Logger to Tracer everywhere" --max-prs 1` | Single sweeping PR, full test pass before merge |
| `aitm start "add tests for src/billing/* until 90% coverage"` | Iterates until the coverage target hits, or the session cap |
| `aitm start "bump zod to v4 and fix all type errors"` | Bumps, fixes, runs tests, opens PR; conflicts surface as `blocked` |

## ⚙️ Configuration

User config lives at `~/.aitm.json`; per-project overrides at
`.ai-task-master/config.json`:

```bash
aitm config set models.smart  anthropic/claude-opus-4.7
aitm config set models.coding anthropic/claude-sonnet-4.6
aitm config set models.fast   openai/gpt-5-mini
aitm config set autoMerge true --project
aitm config list
```

- **Provider**: any OpenAI-compatible endpoint via one credential — OpenRouter by
  default, or set `baseURL` to run on z.ai GLM, a self-hosted gateway, etc. No
  Anthropic SDK. **Profiles** switch the whole provider in one command:

  ```bash
  aitm profile add z.ai --preset zai --api-key "<your z.ai key>"
  aitm profile use z.ai     # ✅ verified end-to-end on z.ai GLM (glm-4.6 / glm-4.5-air)
  aitm profile use openrouter
  ```

  See [providers](https://github.com/developerz-ai/ai-task-master/blob/main/packages/aitm/docs/providers.md)
  and [`aitm profile`](https://github.com/developerz-ai/ai-task-master/blob/main/packages/aitm/docs/commands/profile.md).
- **Coding style**: `aitm` reads your repo's `CLAUDE.md` / `AGENTS.md` and feeds
  it to subagents as a style signal (the provider stays OpenRouter).
- **MCP**: `aitm` is an MCP **client** — declare `mcpServers` in config and their
  tools mount into the subagent tool surfaces.

## 🛠 Requirements

- `OPENROUTER_API_KEY` in the environment.
- The [`gh`](https://cli.github.com) CLI, authenticated (PRs, CI status, reviews).
- Node ≥ 20, Bun, or Deno ≥ 1.40 — ESM, no runtime lock-in.

## License

MIT · [source & full docs](https://github.com/developerz-ai/ai-task-master#readme)
