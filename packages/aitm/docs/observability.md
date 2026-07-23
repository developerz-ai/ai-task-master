# Observability

`aitm` can report uncaught errors to a [GlitchTip](https://glitchtip.com/) (or Sentry) project. It
is **off by default** and adds nothing to a run unless a DSN is configured.

## Enabling

Set a DSN in the environment before invoking `aitm`:

| Env var | Purpose |
| --- | --- |
| `AITM_SENTRY_DSN` | The GlitchTip/Sentry DSN. Takes precedence over `SENTRY_DSN`. |
| `SENTRY_DSN` | Fallback DSN if `AITM_SENTRY_DSN` is unset. |
| `AITM_ENV` | Environment tag on reported events. Defaults to `production`. |
| `AITM_RELEASE` | Optional release tag on reported events. |

`aitm` is standalone (not a cluster app), so the DSN lives in its own runtime env — not a cluster
secret.

## Behaviour

- With a DSN set, a crash in the CLI entrypoint is captured and flushed before the process exits.
- The Sentry SDK (`@sentry/node`) is an **optional dependency**, dynamically imported only when a DSN
  is present. With no DSN — or on a runtime where the SDK isn't installed (e.g. Deno) — nothing is
  loaded and reporting is a no-op.
- Reporting never affects the run's exit code: any SDK/init failure degrades silently to a no-op.

Only error events are sent — no performance tracing (`tracesSampleRate: 0`).

## Console progress stream

Live run narration goes to **stderr** (structured status to stdout), so piping stdout stays clean. Each harness line carries a cyan `[aitm HH:MM:SS]` prefix (`step-progress.ts`); subagent lines get their own colored bracket. Color is TTY-gated and honors `NO_COLOR`; the same lines are teed to `.ai-task-master/progress.md` as plain markdown.

Two lines are shaped to stand out or inform:

- **Merged milestone.** A group merging is the event the operator waits for, so its transition renders as a green-bold line led by a ★ — spottable in a wall of cyan stage lines. Everything else stays cyan. Non-TTY/`NO_COLOR` sinks still get the ★, just without ANSI.
- **CI summary.** When CI settles, one line lists the checks and their marks — `group g1: CI success — bun (test + lint) ✓, CodeRabbit ✓` — printed once, not per poll (the poll loop itself is silent). See `github-integration.md`.
