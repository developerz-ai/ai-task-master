import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  blockAnchorMatch,
  findFuzzyMatch,
  isDisproportionateMatch,
  lineTrimmedMatch,
  whitespaceNormalizedMatch,
} from './edit-replacers.ts';

// ---- lineTrimmedMatch ----

test('lineTrimmedMatch: locates a line whose indentation differs from the search', () => {
  const content = 'function foo() {\n    return 42;\n}\n';
  // Search indented 2 spaces; the file uses 4. The returned span is the file's REAL text.
  assert.deepEqual(lineTrimmedMatch(content, '  return 42;'), { span: '    return 42;', count: 1 });
});

test('lineTrimmedMatch: matches a multi-line block ignoring per-line indentation', () => {
  const content = '  if (x) {\n    doThing();\n  }\n';
  assert.deepEqual(lineTrimmedMatch(content, 'if (x) {\ndoThing();\n}'), {
    span: '  if (x) {\n    doThing();\n  }',
    count: 1,
  });
});

test('lineTrimmedMatch: tolerates a trailing-whitespace-only difference', () => {
  assert.deepEqual(lineTrimmedMatch('let a = 1;\n', 'let a = 1;  '), {
    span: 'let a = 1;',
    count: 1,
  });
});

test('lineTrimmedMatch: returns undefined when no line trims to the search', () => {
  assert.equal(lineTrimmedMatch('alpha\nbeta\n', 'gamma'), undefined);
});

test('lineTrimmedMatch: counts every indentation-variant location, not just the first', () => {
  // Two lines trim to the same search; neither is a literal hit for a 2-space search, so both are
  // fuzzy candidates and the count must reflect the ambiguity.
  const match = lineTrimmedMatch('  x = 1;\n    x = 1;\n', 'x = 1;');
  assert.equal(match?.span, '  x = 1;'); // the first location's real text
  assert.equal(match?.count, 2);
});

// ---- blockAnchorMatch ----

test('blockAnchorMatch: matches a ≥3-line block with a reworded middle via its anchors', () => {
  const content = 'function calc() {\n  const total = a + b;\n  return total * 2;\n}\n';
  const find = 'function calc() {\n  const total = a + c;\n  return total * 2;\n}';
  assert.deepEqual(blockAnchorMatch(content, find), {
    span: 'function calc() {\n  const total = a + b;\n  return total * 2;\n}',
    count: 1,
  });
});

test('blockAnchorMatch: keeps scanning past an inner closing anchor to the real block end', () => {
  // The first `}` after the opener is an inner brace whose span is too short. The old code broke at
  // it and missed the real end; the scan must continue to the in-range closing anchor (issue #268).
  const block = 'function f() {\n  const a = 1;\n  if (x) {\n  }\n  return a;\n}';
  const match = blockAnchorMatch(`${block}\n`, block);
  assert.equal(match?.span, block);
  assert.equal(match?.count, 1);
});

test('blockAnchorMatch: returns undefined when the anchors do not line up', () => {
  const content = 'function calc() {\n  const total = a + b;\n  return total * 2;\n}\n';
  assert.equal(blockAnchorMatch(content, 'function nope() {\n  x;\n}'), undefined);
});

test('blockAnchorMatch: returns undefined for a block shorter than 3 lines', () => {
  assert.equal(blockAnchorMatch('a\nb\n', 'a\nb'), undefined);
});

test('blockAnchorMatch: rejects a middle too dissimilar to score above threshold', () => {
  const content = 'open {\n  totally unrelated content here\n}\n';
  const find = 'open {\n  const x = compute(alpha, beta, gamma);\n}';
  assert.equal(blockAnchorMatch(content, find), undefined);
});

test('blockAnchorMatch: counts each anchor-aligned block that clears the threshold', () => {
  const content = 'start\n  mid\nend\nstart\n  mid\nend\n';
  const match = blockAnchorMatch(content, 'start\nmid\nend');
  assert.equal(match?.span, 'start\n  mid\nend');
  assert.equal(match?.count, 2);
});

// ---- whitespaceNormalizedMatch ----

test('whitespaceNormalizedMatch: matches a single line with collapsed whitespace', () => {
  assert.deepEqual(whitespaceNormalizedMatch('const  x   =    1;\n', 'const x = 1;'), {
    span: 'const  x   =    1;',
    count: 1,
  });
});

test('whitespaceNormalizedMatch: matches a multi-line block ignoring whitespace runs', () => {
  const content = 'foo(\n    a,\n    b\n)\n';
  assert.deepEqual(whitespaceNormalizedMatch(content, 'foo(\na,\nb\n)'), {
    span: 'foo(\n    a,\n    b\n)',
    count: 1,
  });
});

test('whitespaceNormalizedMatch: returns undefined when tokens differ', () => {
  assert.equal(whitespaceNormalizedMatch('const x = 1;\n', 'const y = 2;'), undefined);
});

test('whitespaceNormalizedMatch: counts every line that normalizes to the search', () => {
  const match = whitespaceNormalizedMatch('a  b\na   b\n', 'a b');
  assert.equal(match?.span, 'a  b');
  assert.equal(match?.count, 2);
});

// ---- isDisproportionateMatch ----

test('isDisproportionateMatch: a 1-line search matching a 20-line span fires the guard', () => {
  const matched = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n');
  assert.equal(isDisproportionateMatch(matched, 'line 0'), true);
});

test('isDisproportionateMatch: a same-size single-line match is proportionate', () => {
  assert.equal(isDisproportionateMatch('    return 42;', 'return 42;'), false);
});

test('isDisproportionateMatch: a multi-line match with a char blowup fires the guard', () => {
  const matched = `a${' '.repeat(600)}\n   b`;
  assert.equal(isDisproportionateMatch(matched, 'a\nb'), true);
});

test('isDisproportionateMatch: a proportionate multi-line match does not fire', () => {
  assert.equal(isDisproportionateMatch('a\n  b\n  c', 'a\nb\nc'), false);
});

// ---- findFuzzyMatch (ladder) ----

test('findFuzzyMatch: returns the first matcher that locates a span', () => {
  // An indentation near-miss is caught by lineTrimmedMatch, first in the ladder.
  assert.deepEqual(findFuzzyMatch('x\n    y = 1;\nz\n', '  y = 1;'), {
    span: '    y = 1;',
    count: 1,
  });
});

test('findFuzzyMatch: propagates the chosen matcher candidate count', () => {
  assert.deepEqual(findFuzzyMatch('  y = 1;\n    y = 1;\n', 'y = 1;'), {
    span: '  y = 1;',
    count: 2,
  });
});

test('findFuzzyMatch: returns undefined when no matcher in the ladder hits', () => {
  assert.equal(findFuzzyMatch('alpha\nbeta\n', 'nothing like this at all'), undefined);
});
