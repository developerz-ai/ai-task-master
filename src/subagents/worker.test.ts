import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createWorkerAgent, runWorker } from './worker.ts';

test('createWorkerAgent throws until implemented', () => {
  assert.throws(() =>
    createWorkerAgent({
      model: undefined as unknown as never,
      tools: {} as never,
      systemPrompt: '',
    }),
  );
});

test('runWorker throws until implemented', async () => {
  await assert.rejects(() =>
    runWorker({} as never, {
      group: {
        id: 'g1',
        title: 't',
        tasks: ['t'],
        dependsOn: [],
        branch: null,
        pr: null,
        status: 'pending',
      },
      worktreePath: '/tmp',
      baseBranch: 'main',
      styleContents: '',
      rollingContext: '',
    }),
  );
});
