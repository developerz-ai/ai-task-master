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
});

test('CapabilityModelsSchema is permissive about unknown extra keys', () => {
  // passthrough — forward-compat per docs/config.md §Validation.
  const parsed = CapabilityModelsSchema.parse({ smart: 'x', futureTier: 'y' });
  assert.equal(parsed.smart, 'x');
});
