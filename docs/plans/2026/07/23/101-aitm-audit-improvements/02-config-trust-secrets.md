# 02 — Config trust boundaries & secret redaction

> Part of [`overview.md`](overview.md). Depends on: none.
> Findings: [`findings/03-cli-config.md`](findings/03-cli-config.md) (bugs 1, 2, 4), [`findings/06-observability-logger-compaction-plan-tools.md`](findings/06-observability-logger-compaction-plan-tools.md) (bugs 1, 5, 6, 13, 14; capability 1), [`findings/04-github-state-workspace-fs.md`](findings/04-github-state-workspace-fs.md) (bug 11).

## Files to change
- `packages/aitm/src/config/config-loader.ts:160-163,70-76` — project-scope `bashRules` can re-enable `git push --force`/`gh pr merge` from an untrusted checked-in config.
- `packages/aitm/src/config/profiles.ts:77-84,43,57,239-248` — profile names unchecked → prototype pollution via `__proto__`/`constructor`.
- `packages/aitm/src/config/config-writer.ts:29-39` — writer happily stores secrets/shell commands into project scope that the loader then strips.
- `packages/aitm/src/workspace/git-exec.ts:46-47` — `assertGitAllowed` bypassed by `-C`/`-c` global options before `push`.
- `packages/aitm/src/observability/step-progress.ts:235-255,282,290` — progress stream never runs `scrubSecrets`.
- `packages/aitm/src/logger/secret-scrubber.ts:15` — misses `github_pat_`, `sk_live_`/`sk_test_` families.
- `packages/aitm/src/logger/logger.ts:67-69` — `status()` unscrubbed.
- `packages/aitm/src/observability/error-reporter.ts:32-50` — `scrubEvent` misses `frames[].vars`, `breadcrumb.data`, `extra`, `tags`, `contexts`.
- `packages/aitm/src/tools/web-fetch.ts:151-159` — SSRF denylist misses 100.64/10 (CGNAT), 192.0.0/24, 198.18/15, `64:ff9b::/96`.

## Steps
1. Treat project `bashRules` as untrusted: merge project rules *after* global deny rules; forbid project `allow` overriding `DEFAULT_BASH_RULES` (or strip entirely, matching `hooks`/`formatCommand`).
2. Validate profile names: `Object.hasOwn` membership, reject `FORBIDDEN_KEY_SEGMENTS` (mirror `provider-presets.ts:52-56`). Add hostile-name tests (`add/use/set __proto__`).
3. Export `UNTRUSTED_PROJECT_FIELDS` from config-loader; make `ConfigWriter.set` reject those keys in `--project` scope.
4. `assertGitAllowed`: skip leading `-C <dir>` / `-c k=v` global options before locating the subcommand; test both bypass forms.
5. Secret redaction sweep: pipe `step-progress` `clip()` output and `logger.status()` through `scrubSecrets`; extend scrubber regex (`github_pat_`, `(?:sk|pk|rk)_(?:live|test)_`); deep-walk Sentry events in `scrubEvent`.
6. Env-value scrubbing (new capability): collect literal values of `OPENROUTER_API_KEY` + profile keys at startup, redact those exact strings in every output channel (logger, progress, reporter) — pattern matching can't catch arbitrary-format keys from custom OpenAI-compatible endpoints.
7. Extend web-fetch SSRF ranges per findings.

## Tests
- Paired unit tests per module; hostile-config fixture proving a checked-in project config cannot loosen bash governance; secret-leak regression: run a fake step whose tool input embeds a `Bearer` token / `github_pat_` and assert scrubbed output on every channel.

## Done when
- No checked-in repo file can widen shell permissions; no output channel emits an unredacted credential; both `git push` bypasses are closed.
