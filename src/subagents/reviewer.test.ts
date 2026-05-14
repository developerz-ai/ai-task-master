import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createReviewerAgent, runReviewer } from './reviewer.ts';

test('createReviewerAgent throws until implemented', () => {
  assert.throws(() =>
    createReviewerAgent({
      model: undefined as unknown as never,
      tools: {} as never,
      systemPrompt: '',
    }),
  );
});

test('runReviewer throws until implemented', async () => {
  await assert.rejects(() =>
    runReviewer({} as never, {
      pr: 1,
      threads: [],
      worktreePath: '/tmp',
      styleContents: '',
    }),
  );
});
