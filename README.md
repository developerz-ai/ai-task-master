# aitm

Autonomous task orchestrator. Give it a goal, it drives an LLM in a loop until one or more PRs are merged.

## Why

Coding agents are good at single steps, bad at staying on task across hours. `aitm` runs a Planner/Worker/Reviewer loop against a target repo, splits the goal into **task groups (one PR per group)**, and merges them with automerge on by default. TypeScript on the Vercel AI SDK subagents pattern. Bun for local dev; any modern JS runtime in production.

## Install

```
bun install -g aitm   # recommended for dev
npm install -g aitm   # works the same
```

Distributed as plain ESM + a `bun build --compile` single-file binary. No runtime lock-in.

## Quickstart

Start work on a goal:

```
aitm start "add JWT auth to /login" --max-prs 3
```

`aitm` plans the goal as up to 3 PR-sized task groups, opens a branch per group, and works through them. Each PR is opened, CI watched, review comments addressed by `Reviewer`, then **auto-merged**. Want a human gate? `--no-automerge` stops after each PR, and you continue with:

```
aitm merge-pr
```

## Requirements

| Requirement | Note |
| --- | --- |
| JS runtime | Bun ≥ 1.1, Node ≥ 20, or Deno ≥ 1.40. Bun preferred locally. |
| `gh` CLI | authenticated against the target repo's remote |
| Agent config | `CLAUDE.md` or `AGENTS.md` at the target repo root |
| Credentials | `OPENROUTER_API_KEY` env. That's it. |

`aitm` itself only talks to **OpenRouter** (OpenAI-compatible API). It does not call Anthropic. The only Claude-related thing it does is recognise `CLAUDE.md` in a target repo and use it as the coding-style source — useful when `aitm` is driving a Claude-conventioned project. `AgentConfigDetector` picks the coding-style flavor (`CLAUDE.md` vs `AGENTS.md`); the provider is always OpenRouter.

## Two-command philosophy

`start` and `merge-pr` are the only user-facing commands. With automerge on (default), `start` runs the whole loop end-to-end. `merge-pr` exists for the `--no-automerge` flow where a human gates every PR. Everything else — planning, task grouping, branch management, retries, review-comment handling — happens inside those two calls.

## Key flags

| Flag | Default | Effect |
| --- | --- | --- |
| `--max-prs N` | 5 | Hard cap on PR groups Planner may emit. |
| `--no-automerge` | off | Stop after each PR opens; require manual `aitm merge-pr`. |
| `--style <path>` | `CLAUDE.md` / `AGENTS.md` | Override the coding-style file fed to subagents. |
| `--model <id>` | provider default | Pin the model. |
| `--max-sessions N` | unlimited | Hard cap on subagent sessions per run. |

## Docs

| Topic | Path |
| --- | --- |
| Architecture | `docs/architecture.md` |
| `aitm start` | `docs/commands/start.md` |
| `aitm merge-pr` | `docs/commands/merge-pr.md` |
| Config (`~/.aitm.json`, `.ai-task-master/config.json`) | `docs/config.md` |
| Agent config detection | `docs/agent-config-detection.md` |
| Coding style | `docs/coding-style.md` |
| Task groups (PRs) | `docs/task-groups.md` |
| Subagents | `docs/subagents.md` |
| State | `docs/state.md` |
| Auth | `docs/auth.md` |
| GitHub integration | `docs/github-integration.md` |
| Runtime | `docs/runtime.md` |
| Vercel AI SDK reference (chunked `llms.txt`) | `docs/vendor/ai-sdk/index.md` |

## License

MIT.
