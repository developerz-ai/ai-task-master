import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ResolvedConfig } from '../config/schema.ts';
import { Credentials, ROLE_CAPABILITY } from './credentials.ts';
import { DEFAULT_MODELS } from './defaults.ts';

const baseResolved = (): ResolvedConfig => ({
  openrouterApiKey: 'sk-or-test',
  apiKeySource: 'env',
  models: { ...DEFAULT_MODELS },
  maxPrs: 5,
  maxSessions: null,
  autoMerge: true,
  mergeMethod: 'squash',
  stylePath: null,
  logLevel: 'info',
  concurrency: 1,
});

test('ROLE_CAPABILITY maps every role to a tier', () => {
  assert.equal(ROLE_CAPABILITY.planner, 'smart');
  assert.equal(ROLE_CAPABILITY.worker, 'coding');
  assert.equal(ROLE_CAPABILITY.reviewer, 'smart');
  assert.equal(ROLE_CAPABILITY.orchestrator, 'fast');
});

test('Credentials is constructible (skeleton)', () => {
  const creds = new Credentials(baseResolved());
  assert.ok(creds instanceof Credentials);
});

test('Credentials.handles throws until implemented', () => {
  const creds = new Credentials(baseResolved());
  assert.throws(() => creds.handles());
});

test('DEFAULT_MODELS exposes every capability tier', () => {
  assert.ok(DEFAULT_MODELS.fast);
  assert.ok(DEFAULT_MODELS.generic);
  assert.ok(DEFAULT_MODELS.smart);
  assert.ok(DEFAULT_MODELS.coding);
});
