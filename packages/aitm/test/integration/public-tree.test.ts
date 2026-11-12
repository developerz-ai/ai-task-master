import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * A tracked file is a public document: this repository is public. Three rules
 * hold that, and this file is the guard that keeps them true.
 *
 * **No internal service endpoint.** The tracked MCP configuration named our own
 * gateway and the credentials belonging to it. The address is an internal
 * service; a public repository is not the place for it, and the entry has no
 * use outside our own network.
 *
 * **No internal execution environment.** The tracked agent and skill files
 * described the service this repository is worked on in rather than the
 * repository itself: its tool vocabulary, the machine, the runner's ownership of
 * git. A reader learns an internal platform from them. The name of the setup
 * mode that wrote them is the shortest way in, so it is checked for too — the
 * constant below is assembled from parts, so this file never carries it in one
 * piece. The trade is stated plainly: the name is already in this repository's
 * history and in its sibling repositories, and what the guard buys is that the
 * tree stops carrying it again.
 *
 * **Every agent and skill file says whose it is.** The preamble that named the
 * setup mode is what the guard cannot check positively, so the marker it was
 * replaced with is checked instead: a file restored from a sibling repository
 * would not carry this repository's marker, and fails.
 *
 * Git is the oracle for "tracked", invoked as a real `git ls-files`
 * subprocess, so the scope is the tree's own index and not a directory walk
 * that would also read a developer's untracked scratch file. The repository is
 * checked to be this one first, because a checkout nested inside another git
 * repository would have git answer with the outer tree's index.
 *
 * The rules are functions, and the last describe block proves each one fires.
 * A guard that cannot fail is not a guard.
 */

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

/** This file's own path, repo-relative: the sentinel that pins the scope. */
const SELF = 'packages/aitm/test/integration/public-tree.test.ts';

/** The hosts on our own domain a tracked file may name: the public ones. */
const PERMITTED_OWN_HOSTS = new Set(['developerz.ai', 'www.developerz.ai']);

/**
 * Any host on our own domain. DNS names are case-insensitive, so an upper-case
 * spelling is the same host and the match is too.
 */
const OWN_HOST = /\b(?:[a-z0-9-]+\.)*developerz\.ai\b/gi;

/**
 * The setup mode that wrote the agent files, assembled so this file never
 * carries it in one piece.
 */
const SETUP_MODE = ['dz', 'runner'].join('-');

/** The marker this repository's own agent and skill files carry. */
const PREAMBLE_MARKER = "owned by this repository's maintainers";

/** The paths whose files carry a preamble, and so carry the marker. */
const PREAMBLE_PATHS = [/^\.claude\/agents\//, /^\.claude\/skills\//];

/**
 * The platform's own working directory, which it rewrites wholesale: the
 * onboarding scorecard is rewritten whole on every onboarding run, so a rule
 * covering it would fail the platform's own commits rather than a change made
 * here. The exclusion goes when the platform stops writing the name into
 * those files - developerz.ai#8730.
 */
const PLATFORM_OWNED = [/^\.dz\//];

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
 * The tracked files, from git's own index. A `git ls-files` that cannot run is
 * a broken oracle, not an empty tree.
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
 * A file we cannot read as text carries no string for a reader to find. The
 * count comes back too: a read that fails for every file would skip the whole
 * tree and leave the scan with nothing to report, which is the same
 * green-over-a-tree-it-never-read failure as a broken oracle.
 */
function readText(root: string, path: string): { text: string | null; read: boolean } {
  let bytes: Buffer;
  try {
    bytes = readFileSync(`${root}/${path}`);
  } catch {
    return { text: null, read: false };
  }
  if (bytes.includes(0)) return { text: null, read: true };
  return { text: bytes.toString('utf8'), read: true };
}

/** The hosts on our own domain in one text that the rule does not permit. */
function forbiddenOwnHosts(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(OWN_HOST)) {
    if (!PERMITTED_OWN_HOSTS.has(match[0].toLowerCase())) found.push(match[0]);
  }
  return found;
}

/** Whether one text names the internal setup mode, in any case. */
function namesSetupMode(text: string): boolean {
  return text.toLowerCase().includes(SETUP_MODE.toLowerCase());
}

describe('the public tree', () => {
  it('names no internal service on our own domain', () => {
    const root = repoRoot();
    const tracked = trackedFiles();
    // A wrong root narrows `git ls-files` to a subtree, and the scan would
    // pass over a tree it never read. This file must always be in scope.
    assert.ok(
      tracked.includes(SELF),
      `the scan does not see this file (${SELF}): the repository it answered for is not this one`,
    );
    const offenders: string[] = [];
    let read = 0;
    for (const path of tracked) {
      const file = readText(root, path);
      if (!file.read) continue;
      read += 1;
      if (file.text === null) continue;
      if (forbiddenOwnHosts(file.text).length > 0) offenders.push(path);
    }
    assert.ok(read > 0, 'the scan read no file at all');
    assert.deepEqual(
      offenders,
      [],
      `a tracked file names an internal host on our own domain (only ${[...PERMITTED_OWN_HOSTS].join(', ')} may be named): ${offenders.join(', ')}`,
    );
  });

  it('names no internal setup mode', () => {
    const root = repoRoot();
    const tracked = trackedFiles();
    assert.ok(tracked.includes(SELF), 'the scan does not see this file');
    const offenders: string[] = [];
    let read = 0;
    for (const path of tracked) {
      if (PLATFORM_OWNED.some((pattern) => pattern.test(path))) continue;
      const file = readText(root, path);
      if (!file.read) continue;
      read += 1;
      if (file.text === null) continue;
      if (namesSetupMode(file.text)) offenders.push(path);
    }
    assert.ok(read > 0, 'the scan read no file at all');
    assert.deepEqual(
      offenders,
      [],
      `a tracked file names the internal setup mode: ${offenders.join(', ')}`,
    );
  });

  it("gives every tracked agent and skill file this repository's marker", () => {
    const root = repoRoot();
    const tracked = trackedFiles();
    assert.ok(tracked.includes(SELF), 'the scan does not see this file');
    const offenders: string[] = [];
    let checked = 0;
    for (const path of tracked) {
      if (!PREAMBLE_PATHS.some((pattern) => pattern.test(path))) continue;
      const file = readText(root, path);
      if (!file.read || file.text === null) continue;
      checked += 1;
      if (!file.text.includes(PREAMBLE_MARKER)) offenders.push(path);
    }
    // A renamed agent directory, or a read that fails for every file, checks nothing and passes.
    assert.ok(checked > 0, 'the marker rule checked no agent or skill file');
    assert.deepEqual(
      offenders,
      [],
      `a tracked agent or skill file does not carry this repository's marker (${PREAMBLE_MARKER}): ${offenders.join(', ')}`,
    );
  });
});

describe('the guard itself', () => {
  it('catches an internal host in any case, and lets the public hosts through', () => {
    const gateway = ['mcp', 'developerz', 'ai'].join('.');
    assert.equal(forbiddenOwnHosts(`"url": "https://${gateway}/v1/mcp"`).length, 1);
    assert.equal(forbiddenOwnHosts(`"url": "https://DB.${gateway}/mcp"`).length, 1);
    assert.equal(forbiddenOwnHosts('see https://developerz.ai/docs').length, 0);
    assert.equal(forbiddenOwnHosts('see https://www.developerz.ai/docs').length, 0);
    assert.equal(forbiddenOwnHosts('"@developerz.ai/aitm"').length, 0);
    assert.equal(forbiddenOwnHosts('https://router.invalid/v1').length, 0);
  });

  it('catches the setup mode in any case, and lets the rest through', () => {
    assert.equal(namesSetupMode(`established by ${SETUP_MODE} setup mode`), true);
    assert.equal(namesSetupMode(`established by ${SETUP_MODE.toUpperCase()} setup mode`), true);
    assert.equal(namesSetupMode("owned by this repository's maintainers"), false);
  });
});
