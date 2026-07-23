# 02 — Bash timeout notice (killed ≠ failed)

> Part of [`overview.md`](overview.md). Depends on: none.

## The mechanism

**OpenCode** (`~/workspace/opencode/packages/opencode/src/tool/shell.ts`):
- The run races `handle.exitCode` vs `abort` vs a `timeout` sleep (`:540`). On the timeout branch it sets `expired = true` and force-kills (`handle.kill({ forceKillAfter: "3 seconds" })`, `:552`).
- The result appends a **distinct, actionable** block (`:562`): `shell tool terminated command after exceeding timeout <N> ms. If this command is expected to take longer and is not waiting for interactive input, retry with a larger timeout value in milliseconds.` — wrapped in `<shell_metadata>` (`:583`). The model can tell *killed-on-timeout* from *exited non-zero* and self-corrects.

**aitm today** (`packages/ai-claude-compat/src/bash-tool.ts`):
- `execBash` (`:185`) runs `execa('bash', ['-c', command], { timeout, detached })` plus a manual `setTimeout` that group-SIGKILLs the process tree (`:204`) — needed because the cwd epilogue makes every command multi-statement, so a child could hold the stdout pipe open past execa's own timeout.
- On kill, the awaited subprocess rejects → the `catch (ExecaError)` branch (`:218`) returns `{ stdout, stderr: err.stderr || err.message, exitCode: err.exitCode ?? 1 }`. **The model sees a generic non-zero result with no signal that it was a timeout, and no hint to raise `timeoutMs`.** Worse, on SIGKILL the cwd epilogue never runs (documented `:99`), so cwd tracking silently freezes with no notice.
- `BashOutput` (`:42`) already carries an additive optional marker (`denied?`) — the same pattern extends cleanly.

**Contrast — OpenCode also streams** (`shell.ts:486`) so a long command is visible mid-run; aitm is non-streaming (plan 102 §07 owns streaming). This slice is orthogonal: even once streaming lands, the model still needs the *termination cause* in the tool result. aitm already leads on cwd-persistence (the epilogue, `:106`) which OpenCode lacks — so this is a targeted gap-fill, not parity chase.

## Files to change
- `packages/ai-claude-compat/src/bash-tool.ts`:
  - `BashOutput` type (`:42`) — add optional `timedOut?: boolean` (additive, mirrors `denied?`).
  - `execBash` (`:185`) — set a `killedByTimer` flag **only inside** the `setTimeout` callback (`:204`), and **clear the timer the instant the subprocess settles** (a `finally`), so a command that exits on its own — even one whose non-zero exit races the deadline — never trips the flag. On the catch path, stamp `timedOut: true` only when the flag is set. Deterministic — don't rely on execa's `.timedOut`/`.signal`, since our own group-kill, not execa's timeout, is what fires first; the flag, owned solely by the fired timer, is the single source of truth for "killed on timeout".
  - `bashTool.execute` (`:241`) — propagate `timedOut` onto the returned `BashOutput`.
  - `renderBashSection` (`:279`) — when `timedOut`, append a `<bash_metadata>` line mirroring OpenCode's wording, naming the effective timeout + the 600 000 ms ceiling (`MAX_BASH_TIMEOUT_MS`, `:96`) + a note that cwd tracking is paused for this call.
  - `multiBashTool` (`:304`) — same propagation; a timed-out command already stops the sequence (non-zero exit), so `failedAt` + the notice explain the stop.

## Steps
1. Thread the effective `timeout` (post-`Math.min(..., MAX_BASH_TIMEOUT_MS)`, `:255`) into `execBash` (currently passed as `timeout` arg — reuse) so the notice can quote the real value the model must exceed.
2. `execBash`: `let killedByTimer = false;` set it inside the existing timer callback (`:205`) right before `process.kill(-pid, 'SIGKILL')`, and `clearTimeout(timer)` in a `finally` once the awaited subprocess settles. Ownership is thus explicit at the exit boundary: a process that completes before the timer fires clears it and is never marked, while one the timer actually killed is. In `catch`, return `{ ...result, timedOut: killedByTimer }` (only when true, to keep clean-exit output byte-identical).
3. Notice text (single source, shared by both tools): `command exceeded the <N> ms timeout and was terminated. If it needs longer and is not waiting for interactive input, retry with a larger timeoutMs (ceiling 600000). cwd tracking is paused for this call.` Append via `renderBashSection` only when `timedOut` — so `toModelOutput` (`:272`) carries it into context.
4. Do **not** change `denied` (exit 126) handling or the spill/`capStream` path — timeout is a separate axis; a command can be both truncated and timed-out and both notices should render.

## Tests (`bash-tool.test.ts`)
- `sleep 5` with `timeoutMs: 100` → `exitCode !== 0`, `timedOut === true`, `renderBashSection` output contains the `100 ms` + `600000` + retry hint.
- Normal `false` (exit 1) → `timedOut` unset, no timeout notice.
- Boundary case (through the `exec` seam): a command that exits non-zero right around the deadline — the timer cleared on settle — is **not** marked `timedOut` and carries no notice; only a command the timer actually killed is.
- `multiBash` with a slow first command + `timeoutMs` small → sequence stops, `failedAt === 0`, the timed-out result carries the notice.
- cwd regression: a timed-out `cd /tmp && sleep 5` leaves the tracked cwd unchanged (epilogue didn't run) — assert the next call still runs from the prior cwd, and the notice warned about it.
- Use the `exec` test seam (`BashToolInit.exec`, `:62`) or a real `bash` gated behind an env check — keep portable (no `Bun.*`).
- Gates: `bun test`, `bun run test:node`, `bun run typecheck`, `bun run lint`.

## Done when
- A command killed at its timeout returns `timedOut: true` and a model-visible notice naming the ceiling + retry hint; a normal non-zero exit does not.
- No change to clean-exit output bytes, `denied` handling, or cwd-persistence behavior.
