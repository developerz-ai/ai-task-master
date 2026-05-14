import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makePlannerTool, makeReviewerTool, makeWorkerTool } from './subagent-tools.ts';

test('subagent tool factories throw until implemented', () => {
  const deps = {
    credentials: {} as never,
    styleContents: '',
    rollingContext: '',
  };
  assert.throws(() => makePlannerTool(deps));
  assert.throws(() => makeWorkerTool(deps));
  assert.throws(() => makeReviewerTool(deps));
});
