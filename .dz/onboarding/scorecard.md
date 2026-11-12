# AI-first scorecard

> Written by the developerz.ai maintainer agent — owned by this repository's maintainers. Each onboarding run rewrites this file whole; the latest run wins, and the same card is stored on the platform.

- Run: `run_c4f1b97890bf430980033aa28e4827e9`
- Computed: 2026-11-02T04:06:14.881Z
- Proof: **proved** — every command ran green at head.
- Score: 13 of 15 items ok

## `policy` — ok

- .dz/maintainer/maintainer.yml already present, left alone
- .dz/maintainer/reviewer.md established

## `brain` — ok

- CLAUDE.md already present, left alone

## `roster` — ok

- .claude/agents/aitm-cli.md established
- .claude/agents/task-loop.md established
- .claude/agents/provider-presets.md established
- .claude/agents/run-state.md established

## `skills` — ok

- .claude/skills/verify-change/SKILL.md established
- .claude/skills/release-cut/SKILL.md established
- .claude/skills/lockfile-resync/SKILL.md established
- .claude/skills/integration-suite/SKILL.md established

## `scripts` — ok

- bin/setup established
- bin/dev established
- bin/check established
- bin/stop established
- down: ./bin/stop (bin)
- ./bin/setup exited 0 at head (0.1s)

## `wiring` — ok

- .mcp.json established

## `commands` — ok

- .claude/commands already present, left alone

## `access` — gap

- landed 0 of 3 asked
- still missing: OPENROUTER_API_KEY, AITM_SENTRY_DSN, glitchtip

## `layout` — gap

- partial house layout
- no apps/ at the repository root

## `smoke_test` — ok

- packages/aitm/src/cli/args.test.ts in the repository
- run by ./bin/check exited 0 at head (95.8s)

## `env_example` — ok

- .env.example established

## `agents_md` — ok

- AGENTS.md established

## `per_workspace_brains` — ok

- packages/aitm/CLAUDE.md established
- packages/ai-claude-compat/CLAUDE.md established

## `docs_readme` — ok

- docs/README.md established

## `gate_proved` — ok

- ./bin/check exited 0 at head (95.8s)
