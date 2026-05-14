# Runtime

Bun is the local dev runtime. Shipped code runs unchanged on **Bun ≥ 1.1, Node ≥ 20, or Deno ≥ 1.40**. Runtime portability is a hard constraint — treat Bun-only API leaks as bugs.

## Why Bun for dev

| Capability | Use in dev |
| --- | --- |
| Native TypeScript | No build step. `bun run src/cli.ts`. |
| Fast cold start | Tight feedback loop. |
| Built-in test runner | `bun test` works out of the box. |
| `bun build --compile` | Single-file binary for distribution. |

Bun is a convenience, not a dependency.

## Portability rules

| Need | Use (portable) | Avoid (Bun-only) |
| --- | --- | --- |
| Read a file | `await readFile` from `node:fs/promises` | `Bun.file` |
| Write a file | `await writeFile`, atomic via `rename` | `Bun.write` |
| Run `gh`, `git` | `execa` or `node:child_process` | `Bun.$` |
| Stream subprocess output | `spawn` from `node:child_process` | `Bun.spawn` |
| HTTP | global `fetch` | `Bun.fetch` |
| SQLite (if ever needed) | `better-sqlite3` or `node:sqlite` (Node 22+) | `bun:sqlite` |

Bun-only APIs are allowed in `scripts/` and in test setup gated behind `if (process.versions.bun)`. They are never allowed in `src/`.

## Packaging

| Concern | Choice |
| --- | --- |
| Package manager (dev) | `bun install` |
| Package manager (consumer) | any — `npm`, `pnpm`, `yarn`, `bun` |
| Lockfile | `bun.lockb` committed for dev reproducibility |
| Distribution | Plain ESM published to npm, plus a `bun build --compile` binary attached to GitHub releases |
| Module system | ESM only. `"type": "module"`. |

## TypeScript

| Setting | Value |
| --- | --- |
| `strict` | `true` |
| `moduleResolution` | `bundler` |
| `module` | `esnext` |
| `target` | `es2022` |
| `noUncheckedIndexedAccess` | `true` |

`es2022` for Node 20 compatibility.

## Testing

- `bun test` locally for speed.
- CI matrix runs the same suite under `bun test` and `node --test` (or `vitest run` with a Node target). Both must pass.
- Integration tests spin up a throwaway git repo in a tempdir and use a sandboxed `gh` token scoped to a disposable fixture repo.
- Every module has a paired `*.test.ts`. SRP + tested is the bar.

## AI SDK

| Package | Role |
| --- | --- |
| `ai` | Vercel AI SDK core. `experimental_Agent`, subagents-as-tools. |
| `@openrouter/ai-sdk-provider` | The only provider. OpenRouter speaks the OpenAI Chat Completions schema, so the same wiring serves every model OpenRouter routes to. |

No `@ai-sdk/anthropic`. No `@ai-sdk/openai` direct. OpenRouter is the single egress point — model swaps happen by changing a string id, not by wiring a new SDK.

## Cross-links

- `./architecture.md`
- `./state.md`
- `./agent-config-detection.md`
- `./subagents.md`
- `./auth.md`
