// Fuzzy fallback matchers for `applyEdit` (issue #268). When an exact `oldString` lookup finds no
// occurrence, these locate the *real* span in the file that the model most likely meant — an
// `oldString` whose only difference from disk is leading/trailing whitespace, block indentation, or
// a collapsed run of whitespace. Ported in spirit from OpenCode's replacer cascade
// (`sst/opencode`, `packages/opencode/src/tool/edit.ts`), rewritten to aitm house style.
//
// Each matcher reports EVERY distinct location it matched — each as the ACTUAL substring of `content`
// to replace (so the caller does one literal replacement on a genuine span, never a regex
// substitution) in file order — or `undefined` when it cannot place the edit. That candidate list is
// what lets `applyEdit` hold a fuzzy match to the SAME uniqueness contract as an exact one: it runs
// the exact path first, falls through here only on zero exact hits, then rejects the edit when the
// chosen matcher found more than one candidate (without `replaceAll`), refuses a `replaceAll` whose
// candidates are not identically formatted, and refuses a span disproportionately larger than
// `oldString` — so a loose match can neither clobber an ambiguous or heterogeneous location nor
// swallow a region far larger than what was asked for.

/**
 * A fuzzy match: every distinct location that matched, each the real substring of `content` to
 * replace, in file order. A unique match yields exactly one span; more than one means the `find` was
 * ambiguous. Never empty — a matcher returns `undefined` instead.
 */
export type SpanMatch = { readonly spans: readonly string[] };

/** Locates every span of `content` fuzzily matching `find`, or `undefined` when none. */
export type SpanMatcher = (content: string, find: string) => SpanMatch | undefined;

// Block-anchor similarity floor: a candidate block whose middle lines score below this against the
// search block is rejected. 0.65 mirrors OpenCode's threshold.
const BLOCK_ANCHOR_SIMILARITY_THRESHOLD = 0.65;

/** Drop a single trailing empty line produced by a `find` that ends in `\n`. */
function trimTrailingEmpty(lines: string[]): string[] {
  return lines.length > 0 && lines[lines.length - 1] === '' ? lines.slice(0, -1) : lines;
}

// The array indices below are all bounded by their callers' loops, so a `?? ''`/`?? 0` fallback is
// never actually taken — it exists only to satisfy `noUncheckedIndexedAccess`.

/** Trimmed line at index `i` (empty string if out of range). */
function trimmedAt(lines: string[], i: number): string {
  return (lines[i] ?? '').trim();
}

/** Byte offset in `content` of the start of line index `line` (0-based, `\n`-separated). */
function lineStartOffset(lines: string[], line: number): number {
  let offset = 0;
  for (let k = 0; k < line; k++) {
    offset += (lines[k]?.length ?? 0) + 1; // +1 for the newline
  }
  return offset;
}

/** The real substring of `content` spanning original lines `[startLine, endLine]` inclusive. */
function spanOfLines(content: string, lines: string[], startLine: number, endLine: number): string {
  const start = lineStartOffset(lines, startLine);
  let end = start;
  for (let k = startLine; k <= endLine; k++) {
    end += lines[k]?.length ?? 0;
    if (k < endLine) end += 1; // interior newline, not the trailing one
  }
  return content.substring(start, end);
}

/**
 * Match ignoring each line's leading/trailing whitespace — the dominant near-miss (indentation off,
 * a tab vs spaces, a trailing space). Returns the first block of original lines whose trimmed text
 * equals the trimmed `find`, verbatim from disk.
 */
export const lineTrimmedMatch: SpanMatcher = (content, find) => {
  const originalLines = content.split('\n');
  const searchLines = trimTrailingEmpty(find.split('\n'));
  if (searchLines.length === 0) return undefined;

  const spans: string[] = [];
  for (let i = 0; i <= originalLines.length - searchLines.length; i++) {
    let matches = true;
    for (let j = 0; j < searchLines.length; j++) {
      if (trimmedAt(originalLines, i + j) !== trimmedAt(searchLines, j)) {
        matches = false;
        break;
      }
    }
    if (matches) spans.push(spanOfLines(content, originalLines, i, i + searchLines.length - 1));
  }
  return spans.length > 0 ? { spans } : undefined;
};

/**
 * Match a ≥3-line block by its first and last lines as anchors, scoring the interior lines with
 * Levenshtein similarity. Tolerates a reworded middle (a comment changed, a value edited) as long
 * as the anchors line up and interior similarity clears the threshold. Returns the real span of
 * every candidate block that clears the floor, in file order, or `undefined`.
 */
export const blockAnchorMatch: SpanMatcher = (content, find) => {
  const originalLines = content.split('\n');
  const searchLines = trimTrailingEmpty(find.split('\n'));
  if (searchLines.length < 3) return undefined;

  const firstAnchor = trimmedAt(searchLines, 0);
  const lastAnchor = trimmedAt(searchLines, searchLines.length - 1);
  const searchBlockSize = searchLines.length;
  const maxLineDelta = Math.max(1, Math.floor(searchBlockSize * 0.25));

  // A closing anchor like `}` recurs, so the first line matching `lastAnchor` after a first anchor is
  // often an inner brace whose span is too short. Keep scanning past it to the real block end, taking
  // every in-range candidate that also clears the similarity floor, and stop only once the span grows
  // past the largest permitted size (later lines only make it longer).
  const spans: string[] = [];
  for (let i = 0; i < originalLines.length; i++) {
    if (trimmedAt(originalLines, i) !== firstAnchor) continue;
    for (let j = i + 2; j < originalLines.length; j++) {
      if (j - i + 1 > searchBlockSize + maxLineDelta) break;
      if (
        trimmedAt(originalLines, j) === lastAnchor &&
        Math.abs(j - i + 1 - searchBlockSize) <= maxLineDelta &&
        middleSimilarity(originalLines, searchLines, { startLine: i, endLine: j }) >=
          BLOCK_ANCHOR_SIMILARITY_THRESHOLD
      ) {
        spans.push(spanOfLines(content, originalLines, i, j));
      }
    }
  }
  return spans.length > 0 ? { spans } : undefined;
};

/** Mean per-line Levenshtein similarity of the interior lines; 1 when there are no interior lines. */
function middleSimilarity(
  originalLines: string[],
  searchLines: string[],
  candidate: { startLine: number; endLine: number },
): number {
  const actualBlockSize = candidate.endLine - candidate.startLine + 1;
  const linesToCheck = Math.min(searchLines.length - 2, actualBlockSize - 2);
  if (linesToCheck <= 0) return 1;

  let total = 0;
  for (let j = 1; j <= linesToCheck; j++) {
    const original = trimmedAt(originalLines, candidate.startLine + j);
    const search = trimmedAt(searchLines, j);
    const maxLen = Math.max(original.length, search.length);
    if (maxLen === 0) {
      total += 1;
      continue;
    }
    total += 1 - levenshtein(original, search) / maxLen;
  }
  return total / linesToCheck;
}

/**
 * Match after collapsing every run of whitespace to a single space and trimming — catches a
 * reflowed line or re-indented block whose tokens are otherwise identical. Tries a single-line
 * match first, then a multi-line window.
 */
export const whitespaceNormalizedMatch: SpanMatcher = (content, find) => {
  const normalize = (text: string): string => text.replace(/\s+/g, ' ').trim();
  const normalizedFind = normalize(find);
  if (normalizedFind === '') return undefined;
  const lines = content.split('\n');

  const singleLines = lines.filter((line) => normalize(line) === normalizedFind);
  if (singleLines.length > 0) return { spans: singleLines };

  const findLines = find.split('\n');
  if (findLines.length > 1) {
    const blocks: string[] = [];
    for (let i = 0; i <= lines.length - findLines.length; i++) {
      const block = lines.slice(i, i + findLines.length).join('\n');
      if (normalize(block) === normalizedFind) blocks.push(block);
    }
    if (blocks.length > 0) return { spans: blocks };
  }
  return undefined;
};

/** The fallback ladder, tried in order after an exact match fails. Cheapest/safest matcher first. */
export const spanMatchers: readonly SpanMatcher[] = [
  lineTrimmedMatch,
  blockAnchorMatch,
  whitespaceNormalizedMatch,
];

/** Run the ladder in order; return the first matcher's match, or `undefined` if none locate `find`. */
export function findFuzzyMatch(content: string, find: string): SpanMatch | undefined {
  for (const matcher of spanMatchers) {
    const match = matcher(content, find);
    if (match !== undefined) return match;
  }
  return undefined;
}

/**
 * True when `matched` is disproportionately larger than `oldString` — a signal the fuzzy match
 * swallowed a region far bigger than intended, which `applyEdit` refuses rather than replacing.
 * Ported from OpenCode (`edit.ts` `isDisproportionateMatch`).
 */
export function isDisproportionateMatch(matched: string, oldString: string): boolean {
  const oldLines = oldString.split('\n').length;
  const matchedLines = matched.split('\n').length;
  if (matchedLines >= Math.max(oldLines + 3, oldLines * 2)) return true;
  if (oldLines === 1) return false;
  const oldLen = oldString.trim().length;
  return matched.trim().length > Math.max(oldLen + 500, oldLen * 4);
}

/** Standard Levenshtein edit distance between two strings. */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let previous: number[] = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current: number[] = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current.push(
        Math.min((current[j - 1] ?? 0) + 1, (previous[j] ?? 0) + 1, (previous[j - 1] ?? 0) + cost),
      );
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
}
