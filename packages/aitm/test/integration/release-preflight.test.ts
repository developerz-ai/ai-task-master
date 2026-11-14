import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * A release is refused before anything is built, or it fails late at the registry.
 *
 * The defect this guards: both manifests carried the version already on npm, so every publish
 * from `main` was refused by the registry, at the very end of the release, and `main` could never
 * ship. npm versions are immutable, so the only fix is a bump. `bin/release-preflight` makes the
 * release workflow refuse first and say why: the packages out of lockstep, the pin not matching,
 * a tag that is not the version, a commit that is not on `main`, or a version already published.
 * A registry it cannot reach is a refusal too, never a pass.
 *
 * The script is the artifact under test: it runs for real, in a throwaway repository, with a stub
 * `npm` on PATH standing in for the registry.
 */

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const SCRIPT = 'bin/release-preflight';

type Registry = 'published' | 'missing' | 'down';

interface Fixture {
  compat?: string;
  aitm?: string;
  pin?: string;
  onMain?: boolean;
}

function git(cwd: string, ...args: string[]): void {
  const proc = spawnSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args],
    {
      cwd,
    },
  );
  assert.equal(proc.status, 0, `git ${args.join(' ')}: ${proc.stderr?.toString()}`);
}

/** A throwaway repository holding the real script, two manifests and an `origin/main`. */
function fixture({
  compat = '0.0.57',
  aitm = '0.0.57',
  pin = aitm,
  onMain = true,
}: Fixture): string {
  const root = mkdtempSync(join(tmpdir(), 'aitm-preflight-'));
  mkdirSync(join(root, 'bin'));
  copyFileSync(join(REPO_ROOT, SCRIPT), join(root, SCRIPT));
  chmodSync(join(root, SCRIPT), 0o755);
  for (const [dir, manifest] of [
    ['ai-claude-compat', { name: '@developerz.ai/ai-claude-compat', version: compat }],
    [
      'aitm',
      {
        name: '@developerz.ai/aitm',
        version: aitm,
        dependencies: { '@developerz.ai/ai-claude-compat': pin },
      },
    ],
  ] as const) {
    mkdirSync(join(root, 'packages', dir), { recursive: true });
    writeFileSync(join(root, 'packages', dir, 'package.json'), JSON.stringify(manifest));
  }
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'release');
  git(root, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  if (!onMain) git(root, 'commit', '-q', '--allow-empty', '-m', 'not on main');
  return root;
}

/** A stub `npm` whose `view` answers like the registry in the given state. */
function stubNpm(registry: Registry): string {
  const dir = mkdtempSync(join(tmpdir(), 'aitm-preflight-npm-'));
  const answers: Record<Registry, string> = {
    published: 'echo "$2" | sed "s/.*@//"; exit 0',
    missing: 'echo "npm error code E404" >&2; exit 1',
    down: 'echo "npm error code ECONNREFUSED" >&2; exit 1',
  };
  writeFileSync(join(dir, 'npm'), `#!/usr/bin/env bash\n${answers[registry]}\n`);
  chmodSync(join(dir, 'npm'), 0o755);
  return dir;
}

function preflight(root: string, registry: Registry, tag?: string) {
  // The stub goes first so it shadows any real npm; the inherited PATH supplies node, git and bash
  // (under Bun, process.execPath is bun, not node, so it cannot stand in for node's directory).
  const path = [stubNpm(registry), process.env.PATH ?? '/usr/bin:/bin'].join(':');
  const proc = spawnSync('bash', [join(root, SCRIPT), ...(tag === undefined ? [] : [tag])], {
    cwd: root,
    env: { PATH: path, HOME: root },
  });
  return { status: proc.status, out: `${proc.stdout?.toString()}${proc.stderr?.toString()}` };
}

describe('the release preflight', () => {
  it('passes an unpublished version in lockstep, on main', () => {
    const run = preflight(fixture({}), 'missing');
    assert.equal(run.status, 0, run.out);
    assert.match(run.out, /v0\.0\.57 is unpublished, in lockstep, and on main/);
  });

  it('passes a release tag that is the version', () => {
    const run = preflight(fixture({}), 'missing', 'v0.0.57');
    assert.equal(run.status, 0, run.out);
  });

  it('refuses a version already on npm', () => {
    const run = preflight(fixture({}), 'published');
    assert.equal(run.status, 1);
    assert.match(run.out, /already on npm, and npm versions are immutable/);
  });

  it('refuses when the registry cannot be asked, instead of passing', () => {
    const run = preflight(fixture({}), 'down');
    assert.equal(run.status, 1);
    assert.match(run.out, /could not check whether .* is on npm/);
  });

  it('refuses packages out of lockstep', () => {
    const run = preflight(fixture({ compat: '0.0.56' }), 'missing');
    assert.equal(run.status, 1);
    assert.match(run.out, /out of lockstep/);
  });

  it('refuses a pin that is not the version', () => {
    const run = preflight(fixture({ pin: '0.0.56' }), 'missing');
    assert.equal(run.status, 1);
    assert.match(run.out, /aitm pins ai-claude-compat 0\.0\.56/);
  });

  it('refuses a release tag that is not the version', () => {
    const run = preflight(fixture({}), 'missing', 'v0.0.56');
    assert.equal(run.status, 1);
    assert.match(run.out, /release tag v0\.0\.56 does not match/);
  });

  it('refuses a commit that is not on main', () => {
    const run = preflight(fixture({ onMain: false }), 'missing');
    assert.equal(run.status, 1);
    assert.match(run.out, /not on main/);
  });
});

describe('the tree the release is cut from', () => {
  it('keeps both packages in lockstep, with aitm pinning that exact version', () => {
    const read = (dir: string) =>
      JSON.parse(readFileSync(join(REPO_ROOT, 'packages', dir, 'package.json'), 'utf8'));
    const compat = read('ai-claude-compat');
    const aitm = read('aitm');
    assert.equal(aitm.version, compat.version);
    assert.equal(aitm.dependencies['@developerz.ai/ai-claude-compat'], compat.version);
  });

  it('runs the preflight before it publishes anything, with the history it needs', () => {
    const workflow = readFileSync(join(REPO_ROOT, '.github/workflows/release.yml'), 'utf8');
    const preflightAt = workflow.indexOf(SCRIPT);
    // The publish STEP, not a mention of it: the npm-upgrade comment above names `npm publish` too.
    const publishAt = workflow.indexOf('run: npm publish');
    assert.ok(preflightAt > 0, 'the release workflow does not run the preflight');
    assert.ok(publishAt > preflightAt, 'the release workflow publishes before the preflight runs');
    assert.match(workflow, /fetch-depth: 0/, 'the checkout needs full history to see origin/main');
  });
});
