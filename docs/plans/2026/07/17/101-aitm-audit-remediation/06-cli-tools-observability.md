# 06 — CLI, tools & observability hygiene

> Part of [`overview.md`](overview.md). Depends on: none. Independent, parallelizable.

Lower-severity correctness, SRP, and hygiene fixes. Secret-scrubbing and ANSI-sanitization matter more under autonomous operation (no human watching the terminal/logs).

## Files to change
| `file:line` | Sev | Problem | Fix |
| --- | --- | --- | --- |
| `observability/step-progress.ts:149-154` (via `clip` :89-92) | MED | Model text + tool inputs written to stderr with only newline-collapse → raw ANSI/control seqs can spoof the cyan `[aitm …]` prefix / manipulate the terminal. | Strip C0/ANSI control sequences in `clip` before emit. |
| `observability/error-reporter.ts:35-52` | LOW | `Sentry.init` has no `beforeSend`/`ignoreErrors`; raw top-level throws (with possibly a token-bearing URL or resolved config value) go to GlitchTip. | Add `beforeSend` that redacts secret-shaped substrings. |
| `logger/logger.ts:70-73, 96-101` | LOW | `redactValue` redacts by **key name** only; a secret interpolated into `msg` or a `url:"…?api_key=…"` value logs in cleartext. | Also scrub value contents for secret patterns, at least in `msg`. |
| `cli/cli.ts:89-95` (`emit`) | MED | All `exit.message`s go to **stderr**, but code-0 statuses (`session-cap`, `awaiting-pr`, `commands.ts:681-687`) are user-facing status that belongs on stdout per the Logger contract. | Route code-0 messages to stdout; keep code 1/2 diagnostics on stderr. |
| `cli/commands.ts:864-947` (`defaultRunMergeFlow`), `runStart` | MED | ~80 lines of orchestration (subagent models, tool surfaces, conflict resolver, step-progress labels; usage-tracker + ModelLimits + style-distill) inline in the dispatch module — CLAUDE.md scopes CLI to arg-parsing + exit codes. | Move merge-flow + start wiring into a `loop`/adapter module behind the existing `runMergeFlow`/adapter seam. |
| `tools/web-fetch.ts:191` + `tools/web-search.ts:13` | MED | `Accept-Encoding: …, zstd`; Node 20 undici can't decode zstd → garbled body / unparseable DDG HTML (silent "no results"). | Drop `zstd` from advertised encodings (or don't hand-set Accept-Encoding). |
| `tools/web-search.ts:181` | LOW | `response.text()` with no size cap / content-type check (web-fetch caps via `readBodyCapped`). | Cap the body length like web-fetch. |
| `tools/web-fetch.ts:165-170` | LOW | Returns hardcoded `truncated:true` even when the body ended exactly on `maxChars` with nothing cut. | Return the locally-computed `truncated`. |
| `cli/args.ts:101-104, 149-163` | LOW | `--criteria`/`--style`/`--model`/`--branch` swallow a following `--flag` token as their value (unlike `--base-url`/`--api-key`). | Apply the same next-token flag-guard. |
| `cli/args.ts:164-168` | LOW | Only `--`-prefixed tokens are treated as unknown flags; `aitm start -x` accepts `-x` as the goal. | Reject a leading single `-` in positionals (or validate the goal). |
| `tools/github-thread-tool.ts:45-47` | LOW | `replyToThread(threadId, input.body ?? '')` posts an **empty** comment when `body` omitted (schema optional, "enforced in execute" — it isn't). | Return an error result when `replyToThread` has no non-empty `body`. |
| `config/config-writer.ts:21-36` (`KNOWN_KEYS`) | MED | Stale subset of loader keys — omits `maxCiFixAttempts`, `llmStepTimeoutMs`, `webSearch`, `formatCommand`, `verifyCommand`, `selfReview`, `resolveConflicts`, `allowForcePush`, `bashRules`, `mcpRoleAllowlist`, `mcpDeferToolsOver`, `prBodySections`, `hooks` → `config set selfReview false` throws "Unknown config key". | Derive the writer's key table and the loader's from **one** shared constant. |
| `openrouter/model-limits.ts:47-60` (`forModel`) | LOW | Concurrent `forModel` both see `!this.cache`, both call `client.listModels()` (guard re-checked only after `await`) → duplicate authenticated round-trip. | Memoize the in-flight `preload()` promise. |
| `mcp/tool-search.ts:174-199` (`guardDeferred`) | LOW | `baseExecute(input as never,…)` + function-shape cast + whole-object `as AnyTool` bypass typing at the deferred-tool boundary. | Narrow via the tool's own input schema instead of `as never`. |
| `tools/datetime.ts:41-47` | LOW | Returns a locale string (not ISO-8601); with no `timezone` arg, formats in host zone but reports `timezone:''`. | Return ISO-8601 + echo the resolved zone (`Intl.DateTimeFormat().resolvedOptions().timeZone`). |

## Steps
1. Security-adjacent first: ANSI strip in `step-progress`, `beforeSend` scrub in error-reporter, value-scrub in logger.
2. Stream routing in `cli.emit`; shared config-key constant (fixes `config set` for documented keys).
3. SRP: lift `defaultRunMergeFlow`/`runStart` wiring behind the adapter seam.
4. Tool hygiene: drop zstd, cap web-search body, fix `truncated`, arg flag-guards, github-thread empty-reply, model-limits memo, tool-search narrowing, datetime output.

## Tests
- Unit: `clip` strips ANSI. logger/error-reporter redact a secret embedded in `msg`/error. code-0 status → stdout, code≥1 → stderr. `config set selfReview false` succeeds; writer/loader key tables come from one source. arg parser rejects `--criteria --model`. web-search caps body; `truncated` correct on exact-boundary body. `forModel` concurrent calls → one `listModels`. github-thread empty reply → error. datetime → ISO + resolved zone.
- Commands: `bun test`, `bun run test:node`, `bun run typecheck`, `bun run lint`.

## Done when
- No ANSI/secret leakage to terminal, logs, or GlitchTip.
- CLI is arg-parsing + exit codes; status on the right stream; every documented config key is settable.
- Tool edge-cases (zstd, body caps, truncation flag, arg guards, empty reply, datetime) are correct.
