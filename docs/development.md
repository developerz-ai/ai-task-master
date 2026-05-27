# Development

## Debug harness — dogfood `aitm start` / `merge-pr` locally

We're a CLI, so the equivalent of a docker-compose + REST sandbox is a scripted local
runner. Two scripts spin up a **throwaway** git repo (temp dir + stub `CLAUDE.md` + `git
init`), point aitm at it, invoke `main([...])` from `src/cli/cli.ts` **in-process** (so a
debugger attached to the runner steps through the real flow), print the state-file path,
and tear the repo down on exit.

- `scripts/debug-start.ts` — drives `aitm start "<goal>"`.
- `scripts/debug-merge-pr.ts` — drives `aitm merge-pr` (seeds a throwaway PR, or `--pr N`).

### Run

```bash
# Launches under `bun --inspect-brk` — execution halts before line 1 and WAITS for a
# debugger to attach (see "Attaching a debugger" below), so breakpoints register first.
bun run debug:start
bun run debug:merge-pr                 # seeded currentPr (default 1)
bun run debug:merge-pr -- --pr 42      # attach the flow to PR #42 in your own fork

# Run straight through, no break — prints the state-file path and stops deterministically.
bun scripts/debug-start.ts
node --inspect-brk --import tsx scripts/debug-start.ts   # Node equivalent (waits to attach)
```

Knobs (env):

| Var | Default | Effect |
| --- | --- | --- |
| `AITM_DEBUG_GOAL` | `add a hello.txt with the word hi` | Goal passed to `start`. |
| `AITM_DEBUG_MODEL` | a free OpenRouter model | Pins every model tier — dogfooding never spends paid credits. |
| `AITM_DEBUG_PR` | `1` | Seeded `currentPr` for `merge-pr` when `--pr` is absent. |
| `AITM_DEBUG_KEEP` | unset | `=1` keeps the temp repo so you can inspect `.ai-task-master/`. |

The run reads your `~/.aitm.json` / `OPENROUTER_API_KEY`. The `gh auth` precondition is
stubbed, so **no GitHub login is needed**. The run stops deterministically at the first
boundary a throwaway repo can't satisfy — a missing key (before any LLM call) or, once
planning succeeds, the absent git remote / MCP edit tools in the loop. The state-file path
is printed either way.

### Attaching a debugger

`bun run debug:start` launches with `bun --inspect-brk` and prints an inspector banner on
stderr, then waits:

```
------------------ Bun Inspector ------------------
Inspect in browser:
  https://debug.bun.sh/#localhost:6499/<id>
Listening:
  ws://localhost:6499/<id>
```

- **Bun** inspector listens on `localhost:6499`. Open the `debug.bun.sh` URL, or use
  `chrome://inspect`.
- **Node** (`node --inspect-brk …`) listens on `127.0.0.1:9229`.

#### VS Code (`.vscode/launch.json`)

```jsonc
{
  "version": "0.2.0",
  "configurations": [
    {
      // Needs the "Bun for Visual Studio Code" extension (oven.bun-vscode).
      "type": "bun",
      "request": "launch",
      "name": "Debug aitm start (bun)",
      "program": "${workspaceFolder}/scripts/debug-start.ts",
      "stopOnEntry": true
    },
    {
      // No extra extension — Node with the tsx loader. Source-line breakpoints in
      // src/**/*.ts bind via tsx's source maps.
      "type": "node",
      "request": "launch",
      "name": "Debug aitm start (node+tsx)",
      "runtimeExecutable": "node",
      "runtimeArgs": ["--inspect-brk", "--import", "tsx"],
      "program": "${workspaceFolder}/scripts/debug-start.ts",
      "console": "integratedTerminal"
    },
    {
      // Attach to a manual `node --inspect-brk --import tsx scripts/debug-start.ts`.
      "type": "node",
      "request": "attach",
      "name": "Attach to aitm (node :9229)",
      "port": 9229
    }
  ]
}
```

Set a breakpoint where the interesting work happens — `runStart` in
`src/cli/commands.ts`, `runLoopAdapter` / the Planner in `src/loop/run-loop-adapter.ts`,
or `WorkLoop.runGroup` in `src/loop/work-loop.ts` — then press **F5**. Because the runner
launches with `--inspect-brk` / `stopOnEntry`, execution halts before the first line, so
your breakpoints are registered before anything runs; continue (F5) and you'll stop at
them. Verified: under `--inspect-brk` the runner halts at entry and hands control to the
attached debugger.
