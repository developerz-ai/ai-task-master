import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPlannerAgent, runPlanner } from './planner.ts';

test('createPlannerAgent throws until implemented', () => {
  assert.throws(() =>
    createPlannerAgent({
      model: undefined as unknown as never,
      tools: {} as never,
      systemPrompt: '',
    }),
  );
});

test('runPlanner throws until implemented', async () => {
  await assert.rejects(() => runPlanner({} as never, { goal: 'x', styleContents: '', maxPrs: 5 }));
});
