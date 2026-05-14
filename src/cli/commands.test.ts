import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runConfig, runMergePr, runStart } from './commands.ts';

test('runStart throws until implemented', async () => {
  await assert.rejects(() => runStart({ kind: 'start', goal: 'x' }));
});

test('runMergePr throws until implemented', async () => {
  await assert.rejects(() => runMergePr({ kind: 'merge-pr', resume: true }));
});

test('runConfig throws until implemented', async () => {
  await assert.rejects(() =>
    runConfig({ kind: 'config-set', scope: 'global', key: 'models.smart', value: 'x' }),
  );
});
