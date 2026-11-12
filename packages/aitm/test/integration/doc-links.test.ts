import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * A relative markdown link is a promise to the reader: the file it names is
 * there. Nothing else in the gate keeps that promise — the docs table in the
 * README, the plan cross-links and the interlinked product docs all break
 * silently when a file moves and its links do not. This file is the guard.
 *
 * Git is the oracle for "tracked", invoked as a real `git ls-files`
 * subprocess, so the scope is the tree's own index and not a directory walk
 * that would also read a developer's untracked scratch file. The repository
 * is checked to be this one first, because a checkout nested inside another
 * git repository would have git answer with the outer tree's index.
 *
 * Two deliberate narrowing calls:
 *
 * - `packages/aitm/docs/vendor/` is excluded. Its index states the chunk
 *   files are a verbatim snapshot of upstream llms.txt whose links are
 *   upstream-shaped on purpose, and that link checkers should skip them.
 * - Fenced code blocks are stripped before links are extracted. Command and
 *   plan templates carry links like `(01-<aspect>.md)` that are filled in
 *   when the template is instantiated; they are not broken, they are not
 *   links to anything yet.
 *
 * Only the target's existence is checked, file or directory — never the
 * `#heading` anchor, whose text drifts with edits the guard should not gate.
 * External (`http(s)`, `mailto`, any scheme) and anchor-only targets are a
 * reader's runtime concern, not the filesystem's, and are skipped.
 *
 * The extractor and resolver are functions, and the last describe block
 * proves they fire. A guard that cannot fail is not a guard.
 */

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

/** This file's own path, repo-relative: the sentinel that pins the scope. */
const SELF = 'packages/aitm/test/integration/doc-links.test.ts';

/** The vendored upstream snapshot, whose links are upstream-shaped by design. */
const VENDOR = /^packages\/aitm\/docs\/vendor\//;

/** An inline markdown link; the destination is capture group 1. */
const INLINE_LINK = /\[[^\]]*\]\(([^)]*)\)/g;

/** A scheme (`https:`, `mailto:`, …): not a filesystem path. */
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/**
 * The repository root, from git's own answer. A wrong answer is the whole
 * failure this file exists to prevent: the scan would read a tree that is not
 * ours, or a subtree of ours, and pass over it.
 */
function repoRoot(): string {
  const proc = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: REPO_ROOT });
  if (proc.status !== 0) {
    throw new Error(
      `git rev-parse --show-toplevel exited ${proc.status}: ${proc.stderr?.toString().trim()}`,
    );
  }
  const toplevel = proc.stdout.toString().trim().replace(/\/+$/, '');
  const expected = REPO_ROOT.replace(/\/+$/, '');
  if (toplevel !== expected) {
    throw new Error(
      `git answers for ${toplevel}, not for ${expected}: this checkout is inside another repository, so the scan would read a tree that is not ours`,
    );
  }
  return toplevel;
}

/**
 * The tracked files, from git's own index. A `git ls-files` that cannot run
 * is a broken oracle, not an empty tree.
 */
function trackedFiles(): string[] {
  const proc = spawnSync('git', ['ls-files', '-z'], { cwd: REPO_ROOT });
  if (proc.status !== 0) {
    throw new Error(`git ls-files exited ${proc.status}: ${proc.stderr?.toString().trim()}`);
  }
  return proc.stdout
    .toString()
    .split('\0')
    .filter((path) => path.length > 0);
}

/**
 * The text with fenced code blocks removed. A fence line is up to three
 * spaces of indent then three or more backticks or tildes; the block runs to
 * the next fence of the same character. Template links live inside these
 * blocks, and a template is not a promise.
 */
function stripFencedBlocks(text: string): string {
  const kept: string[] = [];
  let fence: string | null = null;
  for (const line of text.split('\n')) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker !== undefined) {
      if (fence === null) fence = marker[0] ?? '';
      else if (marker.startsWith(fence)) fence = null;
      continue;
    }
    if (fence === null) kept.push(line);
  }
  return kept.join('\n');
}

/**
 * The relative destinations one text's inline links point at: scheme and
 * anchor-only destinations skipped, the optional title and the `#anchor`
 * stripped. A `<...>` destination keeps its spaces; a bare one ends at the
 * first whitespace, where the title begins.
 */
function inlineLinkTargets(text: string): string[] {
  const targets: string[] = [];
  for (const match of text.matchAll(INLINE_LINK)) {
    const raw = (match[1] ?? '').trim();
    const destination = raw.startsWith('<')
      ? raw.slice(1, raw.indexOf('>'))
      : (raw.split(/\s+/)[0] ?? '');
    if (destination === '' || destination.startsWith('#')) continue;
    if (SCHEME.test(destination)) continue;
    const target = destination.split('#')[0] ?? '';
    if (target !== '') targets.push(target);
  }
  return targets;
}

/**
 * The link targets in one markdown file's text that resolve to nothing on
 * disk, resolved against the file's own directory.
 */
function missingTargets(root: string, file: string, text: string): string[] {
  const dir = path.dirname(file);
  return inlineLinkTargets(stripFencedBlocks(text)).filter(
    (target) => !existsSync(path.resolve(root, dir, target)),
  );
}

describe('the tracked documentation', () => {
  it('resolves every relative link in every tracked markdown file', () => {
    const root = repoRoot();
    const tracked = trackedFiles();
    // The root check above already pins the index to this repository; what
    // remains is that this file sits at its expected path in that tree. A
    // tracked-file assertion like public-tree's would fail on this file
    // itself until its first commit, so the check is on disk, not the index.
    assert.ok(
      existsSync(path.join(root, SELF)),
      `the scan does not see this file (${SELF}): the tree it answered for is not this one`,
    );
    const docs = tracked.filter((file) => file.endsWith('.md') && !VENDOR.test(file));
    assert.ok(docs.length > 0, 'the scan found no tracked markdown file at all');
    const offenders: string[] = [];
    let links = 0;
    for (const file of docs) {
      const text = readFileSync(path.join(root, file), 'utf8');
      links += inlineLinkTargets(stripFencedBlocks(text)).length;
      for (const target of missingTargets(root, file, text)) {
        offenders.push(`${file} -> ${target}`);
      }
    }
    // An extractor that matched nothing would green the whole tree over zero
    // checked links; that is the broken-oracle failure, not a clean tree.
    assert.ok(links > 0, 'the scan checked no link at all');
    assert.deepEqual(
      offenders,
      [],
      `a tracked markdown file links to a path that does not exist: ${offenders.join(', ')}`,
    );
  });
});

describe('the guard itself', () => {
  it('catches a broken relative link and lets every resolving kind through', () => {
    const fixture = mkdtempSync(path.join(tmpdir(), 'aitm-doc-links-'));
    try {
      writeFileSync(path.join(fixture, 'real.md'), '# real\n');
      mkdirSync(path.join(fixture, 'dir'));
      const text = [
        '[file](real.md)',
        '[dir](dir/)',
        '[anchor](real.md#section)',
        '[titled](real.md "a title")',
        '[broken](gone.md)',
        '[external](https://example.invalid/x)',
        '[anchor-only](#here)',
        '[mail](mailto:docs@example.invalid)',
      ].join('\n');
      assert.deepEqual(missingTargets(fixture, 'doc.md', text), ['gone.md']);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it('ignores a template link inside a fenced code block', () => {
    const text = '```markdown\n[step](01-<aspect>.md)\n```\n[outside](gone.md)';
    assert.deepEqual(inlineLinkTargets(stripFencedBlocks(text)), ['gone.md']);
    // Without the strip the template destination is extracted: the fence,
    // not the extractor, is what lets it through.
    assert.deepEqual(inlineLinkTargets(text), ['01-<aspect>.md', 'gone.md']);
  });

  it('lets tilde fences and indented fences through the strip', () => {
    const text = '~~~\n[x](gone-a.md)\n~~~\n  ```\n  [y](gone-b.md)\n  ```\n[z](gone-c.md)';
    assert.deepEqual(inlineLinkTargets(stripFencedBlocks(text)), ['gone-c.md']);
  });

  it('does not close a fence on a marker of the other character', () => {
    const text = '~~~\n[x](gone-a.md)\n```\n[y](gone-b.md)\n~~~\n[z](gone-c.md)';
    // The ``` line sits inside the open ~~~ block: everything to the closing
    // ~~~ is stripped. A strip that closed on any fence character would
    // surface gone-b.md.
    assert.deepEqual(inlineLinkTargets(stripFencedBlocks(text)), ['gone-c.md']);
  });

  it('keeps the spaces in a `<...>` destination', () => {
    const fixture = mkdtempSync(path.join(tmpdir(), 'aitm-doc-links-'));
    try {
      writeFileSync(path.join(fixture, 'my file.md'), '# real\n');
      const text = '[spaced](<my file.md>)\n[broken](<gone file.md>)';
      // Without the `<...>` branch the destination ends at the space (`<my`),
      // so the resolving link would be reported missing.
      assert.deepEqual(missingTargets(fixture, 'doc.md', text), ['gone file.md']);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});
