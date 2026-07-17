# 04 — Persistence durability

> Part of [`overview.md`](overview.md). Depends on: none. Coordinate `atomicWrite` changes with `02` (which routes more writers through it).

The whole resume contract is "survive a crash and continue." The durability primitive and the reload path have gaps that break that promise.

## Files to change
| `file:line` | Problem | Fix |
| --- | --- | --- |
| `fs/atomic-write.ts:21` | Data file is fsynced, but after `rename(tmp,path)` the **parent directory is never fsynced** → on power-loss the rename can vanish though the module promises crash-durability. | After rename, `open` parent dir + `fh.sync()`; tolerate EISDIR/EINVAL on platforms that reject dir-fsync. |
| `fs/atomic-write.ts:13-19` | If `writeFile`/`sync` throws, the orphan `${path}.<uuid>.tmp` is never removed (cleanup only in the rename catch) → stale temp files accumulate in the state dir. | Wrap write/sync in a try that `rm(tmp,{force:true})`s before rethrow. |
| `state/transcript-store.ts:93,98` | `record.messages as ModelMessage[]` validates only `Array.isArray`; a structurally-valid-but-wrong on-disk line is trusted and fed back into the resumed agent loop. | Validate each element against a Zod `ModelMessage` shape; drop/skip on mismatch. |
| `compaction/compactor.ts:80-91` | Empty summarizer output → `compact` returns `''` → `compaction-step.ts:113` emits a header-only summary, silently dropping the older prefix instead of passing it through. | Treat empty/whitespace summary as a compaction failure; return `undefined` (passthrough), like the other error paths. |

## Steps
1. Harden `atomicWrite`: dir-fsync after rename + temp cleanup on write/sync failure. This is the base primitive — do it first; `02` depends on it being solid.
2. Add a minimal Zod `ModelMessage` guard in `transcript-store` reload; skip invalid lines with a warning (don't abort the whole transcript).
3. `compactor`: empty-summary ⇒ passthrough, not header-only replacement.

## Tests
- Unit: `atomicWrite` leaves no `.tmp` after a simulated write failure; (where observable) dir-fsync path is exercised. Transcript reload with a corrupt/mistyped line skips it and keeps valid ones. Compactor returning empty text ⇒ messages pass through uncompacted, no context lost.
- Commands: `bun test`, `bun run test:node`, `bun run typecheck`, `bun run lint`.

## Done when
- A mid-write crash never loses a completed rename or leaves orphan temp files.
- A corrupt transcript line degrades to a skip+warn, never silently poisons the resumed loop.
- An empty summary never silently discards context.
