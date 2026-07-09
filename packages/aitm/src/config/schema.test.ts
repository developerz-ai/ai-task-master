import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CapabilityModelsSchema, ConfigFileSchema } from './schema.ts';

test('ConfigFileSchema accepts empty object (all fields optional)', () => {
  const parsed = ConfigFileSchema.parse({});
  assert.deepEqual(parsed, {});
});

test('ConfigFileSchema accepts the documented shape', () => {
  const parsed = ConfigFileSchema.parse({
    openrouterApiKey: 'sk-or-test',
    models: {
      generic: 'anthropic/claude-sonnet-4.6',
      smart: 'anthropic/claude-opus-4.7',
      coding: 'anthropic/claude-opus-4.7',
      fast: 'anthropic/claude-haiku-4.5',
    },
    maxPrs: 5,
    autoMerge: true,
    mergeMethod: 'squash',
    logLevel: 'info',
    concurrency: 2,
  });
  assert.equal(parsed.maxPrs, 5);
  assert.equal(parsed.models?.smart, 'anthropic/claude-opus-4.7');
});

test('ConfigFileSchema rejects bad types', () => {
  assert.throws(() => ConfigFileSchema.parse({ maxPrs: 'five' }));
  assert.throws(() => ConfigFileSchema.parse({ mergeMethod: 'rebase-merge' }));
  assert.throws(() => ConfigFileSchema.parse({ verifyCommand: 123 }));
});

test('ConfigFileSchema accepts a positive maxCiFixAttempts and rejects non-positive/non-int (issue #128)', () => {
  assert.equal(ConfigFileSchema.parse({ maxCiFixAttempts: 2 }).maxCiFixAttempts, 2);
  assert.throws(() => ConfigFileSchema.parse({ maxCiFixAttempts: 0 }));
  assert.throws(() => ConfigFileSchema.parse({ maxCiFixAttempts: -1 }));
  assert.throws(() => ConfigFileSchema.parse({ maxCiFixAttempts: 1.5 }));
  assert.throws(() => ConfigFileSchema.parse({ maxCiFixAttempts: 'three' }));
});

test('ConfigFileSchema accepts a valid llmStepTimeoutMs and rejects < 1000 / non-integer (issue #129)', () => {
  assert.equal(ConfigFileSchema.parse({ llmStepTimeoutMs: 900_000 }).llmStepTimeoutMs, 900_000);
  assert.equal(ConfigFileSchema.parse({ llmStepTimeoutMs: 1000 }).llmStepTimeoutMs, 1000);
  assert.throws(() => ConfigFileSchema.parse({ llmStepTimeoutMs: 999 }));
  assert.throws(() => ConfigFileSchema.parse({ llmStepTimeoutMs: 0 }));
  assert.throws(() => ConfigFileSchema.parse({ llmStepTimeoutMs: -1 }));
  assert.throws(() => ConfigFileSchema.parse({ llmStepTimeoutMs: 1500.5 }));
  assert.throws(() => ConfigFileSchema.parse({ llmStepTimeoutMs: '900000' }));
});

test('ConfigFileSchema accepts formatCommand + verifyCommand as strings (issue #122)', () => {
  const parsed = ConfigFileSchema.parse({
    formatCommand: 'bun run lint:fix',
    verifyCommand: 'bun test',
  });
  assert.equal(parsed.verifyCommand, 'bun test');
});

test('CapabilityModelsSchema is permissive about unknown extra keys', () => {
  // passthrough — forward-compat per docs/config.md §Validation.
  const parsed = CapabilityModelsSchema.parse({ smart: 'x', futureTier: 'y' });
  assert.equal(parsed.smart, 'x');
});

test('ConfigFileSchema accepts a baseURL that is a valid URL', () => {
  const parsed = ConfigFileSchema.parse({ baseURL: 'https://api.z.ai/api/coding/paas/v4' });
  assert.equal(parsed.baseURL, 'https://api.z.ai/api/coding/paas/v4');
});

test('ConfigFileSchema rejects a baseURL that is not a URL', () => {
  assert.throws(() => ConfigFileSchema.parse({ baseURL: 'not a url' }));
});
