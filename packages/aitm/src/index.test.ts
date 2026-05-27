import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as api from './index.ts';

test('public surface exports the documented classes', () => {
  assert.ok(api.Logger);
  assert.ok(api.ConfigLoader);
  assert.ok(api.ConfigWriter);
  assert.ok(api.Credentials);
  assert.ok(api.AgentConfigDetector);
  assert.ok(api.StateStore);
  assert.ok(api.GitHubClient);
  assert.ok(api.PlanGraph);
  assert.ok(api.WorktreePool);
  assert.ok(api.Orchestrator);
  assert.ok(api.WorkLoop);
  assert.ok(api.main);
  assert.ok(api.OpenRouterClient);
  assert.ok(api.ModelLimitsRegistry);
  assert.ok(api.Compactor);
  assert.equal(api.DEFAULT_PR_LABEL, 'ai-task-master');
  assert.equal(api.ROLE_CAPABILITY.worker, 'coding');
});
