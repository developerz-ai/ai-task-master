import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as api from './index.ts';

test('public surface exports exact documented classes (presence and absence)', () => {
  // Presence: documented main classes
  assert.ok(api.Logger, 'Logger must be exported');
  assert.ok(api.ConfigLoader, 'ConfigLoader must be exported');
  assert.ok(api.ConfigWriter, 'ConfigWriter must be exported');
  assert.ok(api.Credentials, 'Credentials must be exported');
  assert.ok(api.AgentConfigDetector, 'AgentConfigDetector must be exported');
  assert.ok(api.StateStore, 'StateStore must be exported');
  assert.ok(api.GitHubClient, 'GitHubClient must be exported');
  assert.ok(api.PlanGraph, 'PlanGraph must be exported');
  assert.ok(api.InPlaceCheckout, 'InPlaceCheckout must be exported');
  assert.ok(api.Orchestrator, 'Orchestrator must be exported');
  assert.ok(api.WorkLoop, 'WorkLoop must be exported');
  assert.ok(api.main, 'main must be exported');
  assert.ok(api.OpenRouterClient, 'OpenRouterClient must be exported');
  assert.ok(api.ModelLimitsRegistry, 'ModelLimitsRegistry must be exported');
  assert.ok(api.Compactor, 'Compactor must be exported');
  assert.ok(api.McpClientManager, 'McpClientManager must be exported');
  assert.ok(api.ROLE_CAPABILITY, 'ROLE_CAPABILITY must be exported');
  assert.ok(api.DEFAULT_PR_LABEL, 'DEFAULT_PR_LABEL must be exported');

  // Tool/utility exports
  assert.ok(api.datetimeTool, 'datetimeTool must be exported');
  assert.ok(api.fetchHtmlTool, 'fetchHtmlTool must be exported');
  assert.ok(api.isFetchHtmlAvailable, 'isFetchHtmlAvailable must be exported');
  assert.ok(api.webFetchTool, 'webFetchTool must be exported');
  assert.ok(api.webSearchTool, 'webSearchTool must be exported');
  assert.ok(api.providerOptionsWithServerTools, 'providerOptionsWithServerTools must be exported');
  assert.ok(api.webFetchServerTool, 'webFetchServerTool must be exported');
  assert.ok(api.webSearchServerTool, 'webSearchServerTool must be exported');
  assert.ok(api.branchExists, 'branchExists must be exported');
  assert.ok(api.dirtyEntries, 'dirtyEntries must be exported');
  assert.ok(api.DirtyWorkingTree, 'DirtyWorkingTree must be exported');

  // Verified constants and properties
  assert.equal(
    api.DEFAULT_PR_LABEL,
    'ai-task-master',
    'DEFAULT_PR_LABEL must equal ai-task-master',
  );
  assert.equal(api.ROLE_CAPABILITY.worker, 'coding', 'ROLE_CAPABILITY.worker must equal coding');

  // Absence: internal utilities that must not leak
  assert.equal(api.makeTempRepo, undefined, 'makeTempRepo (test utility) must not be exported');
  assert.equal(api.execa, undefined, 'execa (internal) must not be exported');
  assert.equal(api.runGit, undefined, 'runGit (internal) must not be exported');
  assert.equal(api.parseJson, undefined, 'parseJson (internal) must not be exported');
  assert.equal(api.formatJson, undefined, 'formatJson (internal) must not be exported');
  assert.equal(
    (api as Record<string, unknown>).readJsonFile,
    undefined,
    'readJsonFile (internal) must not be exported',
  );
  assert.equal(
    (api as Record<string, unknown>).writeJsonFile,
    undefined,
    'writeJsonFile (internal) must not be exported',
  );
});
