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
 * **No internal lane behind the public config.** The environment template
 * declared a credential no tracked source reads, and a command file granted a
 * tool on an MCP server kept for our own error tracker. Both describe a service
 * that lives on our machines, not in this repository. So every name in the
 * template is read by tracked source, and every MCP server a tracked agent,
 * command or skill file calls is declared in the tracked `.mcp.json`. The trade:
 * a server name cannot say whether it is ours, so re-declaring one is not
 * caught. What is caught is the likely way back in, a command file copied from
 * a sibling repository that calls a server this config dropped.
 *
 * **No one's machine.** A finding quoted an engineer's absolute home directory,
 * and plan files quoted paths on one build box. A path under a home directory
 * names a person and lays out their machine; the tree names a file by its
 * repository path and an upstream project by its name. A `~/` path into a
 * dotfile stays: that is where a tool keeps its config, the same on every
 * machine. A failure names the file, never the path it found, so a red run does
 * not print the path into a public log.
 *
 * **No organisation CI topology.** A workflow comment named the CI provider
 * that runs the organisation's private repositories and the routing rule
 * between providers. The provider's name is checked for, assembled from parts
 * like the setup mode's, with the same trade: it is in the history already, and
 * the guard buys that the tree stops carrying it.
 *
 * **Plan trackers name roles, not people.** The trackers named who created,
 * worked and owns each plan, and told the next executor to write their own name
 * in. A name cannot be checked for in general, but these three fields can be
 * pinned: `created_by: plan-author`, `owner: plan-owner`, `worked_by` empty.
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

/** The CI provider for the organisation's private repositories, assembled from parts. */
const PRIVATE_CI = ['ubi', 'cloud'].join('');

/** The marker this repository's own agent and skill files carry. */
const PREAMBLE_MARKER = "owned by this repository's maintainers";

/** The environment template, and the tracked source that may read its names. */
const ENV_TEMPLATE = '.env.example';
const SOURCE = /^(?:packages\/[^/]+\/src\/|bin\/)/;

/**
 * A home directory: one under `/home` or `/Users`, or a `~/` path whose first
 * segment is a plain directory rather than a dotfile. Not global, so `.test()`
 * keeps no `lastIndex` between files.
 */
const HOME_PATH = /(?:^|[^\w.-])\/(?:home|Users)\/[\w.-]+|~\/[\w-]/m;

/** A plan tracker, and the only values its people fields may hold. */
const PLAN_TRACKER = /^docs\/plans\/.+\/status\.yml$/;
const TRACKER_ROLES: Record<string, string> = {
  created_by: 'plan-author',
  worked_by: '',
  owner: 'plan-owner',
};

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

/** The names the environment template declares that no source text reads. */
function unreadEnvNames(template: string, sources: string[]): string[] {
  const names = [...template.matchAll(/^([A-Za-z_][A-Za-z0-9_]*)=/gm)].map((m) => m[1] ?? '');
  return names.filter((name) => !sources.some((text) => new RegExp(`\\b${name}\\b`).test(text)));
}

/** The MCP servers one text calls a tool on that `declared` does not hold. */
function undeclaredMcpServers(text: string, declared: Set<string>): string[] {
  const named = [...text.matchAll(/\bmcp__([A-Za-z0-9-]+(?:_[A-Za-z0-9-]+)*)/g)].map(
    (m) => m[1] ?? '',
  );
  return [...new Set(named)].filter((server) => !declared.has(server));
}

/** The people fields in one tracker that hold anything but their role. */
function trackerPeople(text: string): string[] {
  const wrong: string[] = [];
  for (const [field, role] of Object.entries(TRACKER_ROLES)) {
    const line = new RegExp(`^${field}:(.*)$`, 'm').exec(text);
    const value = (line?.[1] ?? '')
      .replace(/\s#.*$/, '')
      .trim()
      .replace(/^(["'])(.*)\1$/, '$2');
    if (!line || value !== role) wrong.push(field);
  }
  return wrong;
}

/** Whether one text names the internal setup mode, in any case. */
function namesSetupMode(text: string): boolean {
  return text.toLowerCase().includes(SETUP_MODE.toLowerCase());
}

/** Whether one text names the organisation's private CI provider, in any case. */
function namesPrivateCi(text: string): boolean {
  return text.toLowerCase().includes(PRIVATE_CI);
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

  it("names no CI provider for the organisation's private repositories", () => {
    const root = repoRoot();
    const tracked = trackedFiles();
    assert.ok(tracked.includes(SELF), 'the scan does not see this file');
    const offenders: string[] = [];
    let read = 0;
    for (const path of tracked) {
      const file = readText(root, path);
      if (!file.read) continue;
      read += 1;
      if (file.text !== null && namesPrivateCi(file.text)) offenders.push(path);
    }
    assert.ok(read > 0, 'the scan read no file at all');
    assert.deepEqual(
      offenders,
      [],
      `a tracked file names the organisation's private CI provider: ${offenders.join(', ')}`,
    );
  });

  it('names no home directory', () => {
    const root = repoRoot();
    const tracked = trackedFiles();
    assert.ok(tracked.includes(SELF), 'the scan does not see this file');
    const offenders: string[] = [];
    let read = 0;
    for (const path of tracked) {
      const file = readText(root, path);
      if (!file.read) continue;
      read += 1;
      if (file.text !== null && HOME_PATH.test(file.text)) offenders.push(path);
    }
    assert.ok(read > 0, 'the scan read no file at all');
    assert.deepEqual(
      offenders,
      [],
      `a tracked file carries a home-directory path; name the file by its repository path, the project by its name: ${offenders.join(', ')}`,
    );
  });

  it('names roles, not people, in every plan tracker', () => {
    const root = repoRoot();
    const tracked = trackedFiles();
    assert.ok(tracked.includes(SELF), 'the scan does not see this file');
    const offenders: string[] = [];
    let checked = 0;
    for (const path of tracked.filter((p) => PLAN_TRACKER.test(p))) {
      const file = readText(root, path);
      if (!file.read || file.text === null) continue;
      checked += 1;
      const wrong = trackerPeople(file.text);
      if (wrong.length > 0) offenders.push(`${path} (${wrong.join(', ')})`);
    }
    assert.ok(checked > 0, 'the tracker rule checked no plan tracker');
    assert.deepEqual(
      offenders,
      [],
      `a plan tracker's people fields must hold roles (${JSON.stringify(TRACKER_ROLES)}), never a name: ${offenders.join(', ')}`,
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

describe('the public config', () => {
  it('declares in the environment template only names tracked source reads', () => {
    const root = repoRoot();
    const tracked = trackedFiles();
    assert.ok(tracked.includes(SELF), 'the scan does not see this file');
    assert.ok(tracked.includes(ENV_TEMPLATE), `${ENV_TEMPLATE} is not tracked`);
    const sources = tracked
      .filter((path) => SOURCE.test(path) && !path.endsWith('.test.ts'))
      .map((path) => readText(root, path).text)
      .filter((text): text is string => text !== null);
    assert.ok(sources.length > 0, 'the scan read no source file');
    const unread = unreadEnvNames(readText(root, ENV_TEMPLATE).text ?? '', sources);
    assert.deepEqual(
      unread,
      [],
      `${ENV_TEMPLATE} declares name(s) no tracked source reads, so they belong to a service outside this repository: ${unread.join(', ')}`,
    );
  });

  it('calls no MCP server the tracked config does not declare', () => {
    const root = repoRoot();
    const tracked = trackedFiles();
    assert.ok(tracked.includes(SELF), 'the scan does not see this file');
    const config = JSON.parse(readText(root, '.mcp.json').text ?? '{}') as {
      mcpServers?: Record<string, unknown>;
    };
    const declared = new Set(Object.keys(config.mcpServers ?? {}));
    const offenders: string[] = [];
    let read = 0;
    for (const path of tracked.filter((p) => p.startsWith('.claude/'))) {
      const file = readText(root, path);
      if (!file.read || file.text === null) continue;
      read += 1;
      for (const server of undeclaredMcpServers(file.text, declared)) {
        offenders.push(`${path}: ${server}`);
      }
    }
    assert.ok(read > 0, 'the scan read no .claude file');
    assert.deepEqual(
      offenders,
      [],
      `a tracked agent file calls an MCP server .mcp.json does not declare, so it lives only on our own machines: ${offenders.join(', ')}`,
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

  it('catches the private CI provider in any case, and lets the rest through', () => {
    assert.equal(namesPrivateCi(`routed to ${PRIVATE_CI} for private repositories`), true);
    assert.equal(
      namesPrivateCi(`routed to ${PRIVATE_CI.toUpperCase()} for private repositories`),
      true,
    );
    assert.equal(namesPrivateCi('routed to github actions'), false);
  });

  it('catches an env name no source reads, and lets a read one through', () => {
    const template = '# comment\nREAD_ME=\nNOBODY=\n';
    assert.deepEqual(unreadEnvNames(template, ['process.env.READ_ME']), ['NOBODY']);
    assert.deepEqual(unreadEnvNames(template, ['READ_ME', 'env.NOBODY']), []);
  });

  it('catches an undeclared MCP server, with or without a tool name', () => {
    const declared = new Set(['code-graph']);
    const text = 'allowed-tools: Read, mcp__tracker-mcp, mcp__code-graph__explore, mcp__db_x__q';
    assert.deepEqual(undeclaredMcpServers(text, declared), ['tracker-mcp', 'db_x']);
    assert.deepEqual(undeclaredMcpServers('mcp__code-graph__a_b', declared), []);
  });

  it('catches a home directory, and lets a dotfile under ~ and a repo path through', () => {
    // Assembled from parts, so this file never carries a home-directory path itself.
    assert.equal(HOME_PATH.test(`at \`${['', 'home', 'someone', 'CLAUDE.md'].join('/')}\``), true);
    assert.equal(HOME_PATH.test(['', 'Users', 'someone', 'x'].join('/')), true);
    assert.equal(HOME_PATH.test(`cloned ${['~', 'workspace', 'repo'].join('/')}`), true);
    assert.equal(HOME_PATH.test('reads ~/.aitm.json'), false);
    assert.equal(HOME_PATH.test('packages/home/x.ts, https://x.test/Users/y'), false);
  });

  it('catches a name in a tracker field, and lets the roles through', () => {
    const roles = 'created_by: plan-author\nworked_by: ""  # empty\nowner: plan-owner\n';
    assert.deepEqual(trackerPeople(roles), []);
    assert.deepEqual(trackerPeople(roles.replace('plan-owner', 'someone')), ['owner']);
    assert.deepEqual(trackerPeople(roles.replace('""', '"someone"')), ['worked_by']);
    assert.deepEqual(trackerPeople('worked_by: ""\nowner: plan-owner\n'), ['created_by']);
  });
});
