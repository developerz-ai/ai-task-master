import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RunCmd } from '../github/github-client.ts';
import { parseArgs } from './args.ts';
import { AITM_PACKAGE, fetchLatestVersion, pickInstaller, runUpdate } from './update.ts';

// -- helpers ---------------------------------------------------------------

function fetchReturning(body: unknown, ok = true): typeof fetch {
  return (() =>
    Promise.resolve({ ok, json: () => Promise.resolve(body) })) as unknown as typeof fetch;
}

function fetchThrowing(): typeof fetch {
  return (() => Promise.reject(new Error('offline'))) as unknown as typeof fetch;
}

type Call = { file: string; args: readonly string[] };

function recordingRunCmd(opts: { present: string[]; installExit?: number; calls: Call[] }): RunCmd {
  return async (file, args) => {
    opts.calls.push({ file, args });
    if (args[0] === '--version') {
      if (!opts.present.includes(file)) throw new Error(`${file} is not installed`);
      return { stdout: '1.0.0', stderr: '', exitCode: 0 };
    }
    return { stdout: '', stderr: 'boom', exitCode: opts.installExit ?? 0 };
  };
}

// -- parseArgs -------------------------------------------------------------

test('parseArgs: update', () => {
  assert.deepEqual(parseArgs(['update']), { kind: 'update', check: false });
});

test('parseArgs: update --check', () => {
  assert.deepEqual(parseArgs(['update', '--check']), { kind: 'update', check: true });
});

test('parseArgs: update with unknown flag is a usage error', () => {
  assert.deepEqual(parseArgs(['update', '--bogus']), { kind: 'usage-error' });
});

// -- fetchLatestVersion ----------------------------------------------------

test('fetchLatestVersion: reads version from registry payload', async () => {
  assert.equal(await fetchLatestVersion(fetchReturning({ version: '9.9.9' })), '9.9.9');
});

test('fetchLatestVersion: undefined on network failure or bad shape', async () => {
  assert.equal(await fetchLatestVersion(fetchThrowing()), undefined);
  assert.equal(await fetchLatestVersion(fetchReturning({})), undefined);
  assert.equal(await fetchLatestVersion(fetchReturning({ version: '1' }, false)), undefined);
});

// -- pickInstaller ---------------------------------------------------------

test('pickInstaller: prefers bun, falls back to npm, undefined when neither', async () => {
  const bun = await pickInstaller(recordingRunCmd({ present: ['bun', 'npm'], calls: [] }));
  assert.equal(bun?.file, 'bun');
  const npm = await pickInstaller(recordingRunCmd({ present: ['npm'], calls: [] }));
  assert.equal(npm?.file, 'npm');
  assert.equal(await pickInstaller(recordingRunCmd({ present: [], calls: [] })), undefined);
});

// -- runUpdate -------------------------------------------------------------

test('runUpdate: --check never installs', async () => {
  const calls: Call[] = [];
  const out: string[] = [];
  const exit = await runUpdate(
    { kind: 'update', check: true },
    {
      stdout: (chunk) => out.push(chunk),
      currentVersion: '0.0.1',
      fetchFn: fetchReturning({ version: '9.9.9' }),
      runCmd: recordingRunCmd({ present: ['bun'], calls }),
    },
  );
  assert.equal(exit.code, 0);
  assert.equal(calls.length, 0);
  assert.ok(out.join('').includes('Update available'));
});

test('runUpdate: already up to date skips install', async () => {
  const calls: Call[] = [];
  const exit = await runUpdate(
    { kind: 'update', check: false },
    {
      stdout: () => {},
      currentVersion: '9.9.9',
      fetchFn: fetchReturning({ version: '9.9.9' }),
      runCmd: recordingRunCmd({ present: ['bun'], calls }),
    },
  );
  assert.equal(exit.code, 0);
  assert.equal(calls.length, 0);
});

test('runUpdate: installs with bun when newer version exists', async () => {
  const calls: Call[] = [];
  const exit = await runUpdate(
    { kind: 'update', check: false },
    {
      stdout: () => {},
      currentVersion: '0.0.1',
      fetchFn: fetchReturning({ version: '9.9.9' }),
      runCmd: recordingRunCmd({ present: ['bun'], calls }),
    },
  );
  assert.equal(exit.code, 0);
  const install = calls.find((c) => c.args[0] === 'install');
  assert.deepEqual(install, { file: 'bun', args: ['install', '-g', `${AITM_PACKAGE}@latest`] });
});

test('runUpdate: still installs when the registry is unreachable', async () => {
  const calls: Call[] = [];
  const exit = await runUpdate(
    { kind: 'update', check: false },
    {
      stdout: () => {},
      currentVersion: '0.0.1',
      fetchFn: fetchThrowing(),
      runCmd: recordingRunCmd({ present: ['npm'], calls }),
    },
  );
  assert.equal(exit.code, 0);
  assert.ok(calls.some((c) => c.file === 'npm' && c.args[0] === 'install'));
});

test('runUpdate: exit 1 when no installer on PATH', async () => {
  const exit = await runUpdate(
    { kind: 'update', check: false },
    {
      stdout: () => {},
      currentVersion: '0.0.1',
      fetchFn: fetchReturning({ version: '9.9.9' }),
      runCmd: recordingRunCmd({ present: [], calls: [] }),
    },
  );
  assert.equal(exit.code, 1);
  assert.ok(exit.message?.includes('Neither bun nor npm'));
});

test('runUpdate: propagates installer failure', async () => {
  const exit = await runUpdate(
    { kind: 'update', check: false },
    {
      stdout: () => {},
      currentVersion: '0.0.1',
      fetchFn: fetchReturning({ version: '9.9.9' }),
      runCmd: recordingRunCmd({ present: ['bun'], installExit: 7, calls: [] }),
    },
  );
  assert.equal(exit.code, 1);
  assert.ok(exit.message?.includes('exit 7'));
});
