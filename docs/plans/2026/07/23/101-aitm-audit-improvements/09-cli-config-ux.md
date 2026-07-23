# 09 — CLI/config paper cuts & missing UX

> Part of [`overview.md`](overview.md). Depends on: none.
> Findings: [`findings/03-cli-config.md`](findings/03-cli-config.md) (bugs 5-13; arch 5-7; capabilities).

## Files to change
- `packages/aitm/src/cli/args.ts` — `:270-277` no `--` end-of-options sentinel (goals starting with `-` unrepresentable); `:300-313` branch-name validation misses control chars + bare `@`; `:11,16` null-arm schema drift; `:434-439` vs `:373-379` inconsistent `--`-value grammar between `profile set` and `config set`.
- `packages/aitm/src/cli/cli.ts:163-174` — help drifted: `--pr-per-task`, `--max-fix-attempts`, `--max-iterations`, `moonshot` preset undocumented; generate HELP_TEXT from the flag tables.
- `packages/aitm/src/cli/commands.ts` — `:552-557` idempotent start re-run drops persisted criteria (fall back to `state.readGoal().criteria`); `:1284` takeover state hardcodes `agentConfigFile: 'CLAUDE.md'`; `:874-883` `ttyConfirm` ignores AbortSignal; `:203-208` `drainStdin` hangs on interactive TTY.
- `packages/aitm/src/config/config-writer.ts:41-47` — `unset` skips `CONFIG_KEYS` validation.
- `packages/aitm/src/config/config-loader.ts:508-543` — stale top-level `baseURL` overrides an active profile's baseURL → key sent to wrong host; profile-supplied key ⇒ profile baseURL wins (or warn).
- `packages/aitm/src/config/` shared helpers — `parseValue`/`splitKey`/dotted get-set/`isNotFound`/`formatZodError` triplicated across writer/profiles/loader; extract `config/json-file.ts` + dotted-path util (already diverged once).
- Warn seams: `commands.ts:335`, `config-loader.ts:124` write to bare `process.stderr` instead of ctx stderr.

## New capabilities (from findings)
- `aitm config list --effective` — print merged `ResolvedConfig` with per-key source labels (profile/global/env/default).
- Env-var overrides for common run settings (`maxSessions`, `logLevel`, …) so CI wrappers don't write files.
- `profile rename` + profile-name validation (validation itself lands in slice 02).

## Steps
1. Add `--` sentinel across all subcommands; unify the twin-command grammar; then the low-risk parser fixes (branch-name regex, null-arm narrowing).
2. Help-text generation from flag tables (kills the drift class, not just today's instances).
3. Point fixes in commands/config-writer/config-loader per list above.
4. Extract shared json-file/dotted-path helpers (second-real-caller rule is satisfied three times over).
5. Implement `config list --effective`, env overrides, `profile rename`.

## Tests
- `args.test.ts`: `--` handling per subcommand, hostile branch names.
- `commands.test.ts`: criteria fallback on re-run, agentConfigFile provenance, ttyConfirm abort, drainStdin TTY error.
- `config-writer/profiles/config-loader` tests: unset validation, precedence warning, shared-helper behavior preserved.
- Help snapshot test asserting every parsed flag appears in help.

## Done when
- Every accepted flag is documented and every documented flag accepted; profile activation can't silently send a key to the wrong host; goals starting with `-` work.
