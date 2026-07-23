# 01 — Fuzzy edit fallback (exact-first, guarded)

> Part of [`overview.md`](overview.md). Depends on: none. **Highest leverage — build first.**

## The mechanism

**OpenCode** (`~/workspace/opencode/packages/opencode/src/tool/edit.ts`):
- `replace()` (`:682`) tries a cascade of `Replacer` generators in order until one yields a locatable span: `SimpleReplacer` → `LineTrimmedReplacer` → `BlockAnchorReplacer` → `WhitespaceNormalizedReplacer` → `IndentationFlexibleReplacer` → `EscapeNormalizedReplacer` → `TrimmedBoundaryReplacer` → `ContextAwareReplacer` → `MultiOccurrenceReplacer` (`:694`).
- `LineTrimmedReplacer` (`:248`) matches ignoring per-line leading/trailing whitespace; `BlockAnchorReplacer` (`:288`) matches a ≥3-line block by its first+last line as anchors, scoring the middle with Levenshtein similarity ≥ 0.65; `WhitespaceNormalizedReplacer` (`:427`) collapses runs of whitespace.
- Anti-clobber: every candidate span is re-checked — uniqueness `index === lastIndex` unless `replaceAll` (`:717`), and `isDisproportionateMatch` (`:731`, called `:709`) **throws** if the matched span is far larger than `oldString` (≥ `max(oldLines+3, oldLines*2)` lines, or > `max(len+500, len*4)` chars). So a loose matcher can never silently swallow a huge region.

**aitm today** (`packages/ai-claude-compat/src/edit-tools.ts`):
- `applyEdit()` (`:124`) is exact-only: `content.split(oldString)`. 0 occurrences → `throw "oldString not found"` (`:135`); >1 without `replaceAll` → `throw "not unique"` (`:138`). No fuzzy fallback.
- Wrapped by `editFileTool` (`:38`) and `multiEditTool` (`:59`); both first pass through `readForEdit` (`:96`) which enforces read-before-edit + hash-staleness (`fileState.isStale`, `:116`) — **aitm's edge over OpenCode, keep it untouched.**
- Impact: the dominant weak-model failure aitm already codes around — `EMPTY_MANIFEST_REASON` (`worker.ts:242`), `editorNoChangeReason` (`worker.ts:426`), phantom-edit blocks — is frequently a *near-miss* `oldString` (indentation off, a tab vs spaces, trailing space). Today that fails the leaf → fails the whole PR group. A fallback lands it.

**Contrast — Aider** (`~/workspace/aider`, `aider/coders/`): Aider avoids brittle string-match by using coarser edit *formats* — `editblock_coder.py` (SEARCH/REPLACE with its own flexible matcher `search_replace.py`) and `udiff_coder.py` (unified diff, applied with fuzzy hunk placement), plus whole-file mode. Same lesson from the other end: **never require a byte-exact anchor.** aitm keeps its exact-string tool (cheap, precise) and only *degrades gracefully* — the OpenCode approach, not a format change.

## Files to change
- New: `packages/ai-claude-compat/src/edit-replacers.ts` (+ `.test.ts`) — port the 3 highest-value replacers as pure generators: `lineTrimmedMatch`, `blockAnchorMatch`, `whitespaceNormalizedMatch`, plus `isDisproportionateMatch`. Named exports, no `any`. Port from `opencode/.../edit.ts:248,288,427,731` but rewrite to aitm house style (kebab file, camelCase fns, `type` shapes) — do not import OpenCode.
- `packages/ai-claude-compat/src/edit-tools.ts:124` — `applyEdit`: after the exact `split` finds `occurrences === 0`, run the fallback ladder instead of throwing immediately. Keep the identical/empty/uniqueness guards ahead of it byte-identical.
- `packages/ai-claude-compat/src/index.ts` — export the new module's public surface if the package re-exports per-file (match existing pattern).

## Steps
1. **`edit-replacers.ts`**: each matcher is `(content: string, find: string) => string | undefined` returning the *actual substring of `content`* to replace (so the caller still does one literal `indexOf`/`split` on a real span — no regex substitution surprises; mirror OpenCode returning `content.substring(...)`). Include `isDisproportionateMatch(matched, oldString): boolean` verbatim in spirit (`edit.ts:731`).
2. **`applyEdit` fallback** (`edit-tools.ts:124`): restructure the tail:
   - Keep `:127` empty-guard, `:131` identical-guard.
   - `const occurrences = content.split(oldString).length - 1`.
   - If `occurrences >= 1`: **unchanged** exact path (`:138`–`:148`) — exact match always wins, byte-identical.
   - If `occurrences === 0`: run `[lineTrimmedMatch, blockAnchorMatch, whitespaceNormalizedMatch]` in order; first that returns a span `matched`:
     - `if (isDisproportionateMatch(matched, oldString)) throw` (OpenCode's wording, `edit.ts:711`).
     - re-derive `occurrences = content.split(matched).length - 1`; apply the **same** uniqueness rule (`>1 && !replaceAll` → the existing not-unique throw) so fuzzy never bypasses the uniqueness contract.
     - replace via the existing `split(matched).join(newString)` / single-`indexOf` code path (reuse, don't duplicate).
   - No matcher hits → the existing `oldString not found` throw (`:135`), now truthfully "not found even fuzzily".
3. **`multiEdit`** (`:59`) needs no change — it calls `applyEdit` per edit (`:71`), so the fallback flows through; keep atomic all-or-nothing.
4. **Descriptions**: leave the tool descriptions (`:41`, `:62`) as-is — they still instruct exact strings; the fallback is a silent safety net, not a new contract to advertise (avoids the model getting lazy about anchors).

## Tests (`edit-replacers.test.ts`, extend `edit-tools.test.ts`)
- `lineTrimmedMatch`: `oldString` indented 2 spaces vs file indented 4 → returns the file's real span; whitespace-only diff.
- `blockAnchorMatch`: 4-line block, middle line reworded < 35% → matches; anchors mismatch → `undefined`.
- `isDisproportionateMatch`: 1-line `oldString` matching a 20-line span → `true` (guard fires).
- `applyEdit` integration: (a) indentation-off `oldString` now applies + correct `count`/`snippet`; (b) a fuzzy match that is disproportionate still **throws** (no clobber); (c) a fuzzy match with 2 occurrences + no `replaceAll` throws not-unique; (d) exact-match cases byte-identical (regression).
- `edit-tools.test.ts`: read-before-edit + staleness gates (`:102`,`:116`) still fire ahead of any fuzzy logic.
- Gates: `bun test`, `bun run test:node`, `bun run typecheck`, `bun run lint`.

## Done when
- An edit whose `oldString` differs from disk only by leading/trailing whitespace or a collapsed-whitespace run succeeds and returns the correct numbered snippet.
- No fuzzy path can clobber: disproportionate span → throw; non-unique fuzzy span → throw; stale/unread file → throw (unchanged).
- Exact-match and error-wording regressions all pass on Bun and Node.
