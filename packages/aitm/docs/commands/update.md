# `aitm update`

Manual self-update. Reinstalls the published `@developerz.ai/aitm` package globally — **nothing
ever updates automatically**; the command only acts when you run it.

## Signature

```
aitm update [--check]
```

| Flag      | Effect                                                                 |
| --------- | ---------------------------------------------------------------------- |
| `--check` | Only report whether a newer version exists on npm; never install.      |

## Behavior

1. Prints the current version (from the installed package) and the latest version published to
   the npm registry (`@developerz.ai/aitm@latest`).
2. If they match: "Already up to date", exit 0, no install.
3. With `--check`: reports whether an update is available and exits 0 without installing.
4. Otherwise reinstalls globally, preferring `bun install -g @developerz.ai/aitm@latest` and
   falling back to `npm install -g …` when bun is not on PATH. Exit 1 (with the installer's
   stderr) when the install fails or when neither installer exists.

The registry lookup degrades gracefully: if npm's registry is unreachable, the install still
runs — bun/npm resolve `@latest` themselves.

## Seams

`runUpdate` (in `src/cli/update.ts`) takes an injectable `fetchFn`, `runCmd`, `stdout`, and
`currentVersion`, so tests never touch the network or spawn installers.
