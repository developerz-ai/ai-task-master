import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CapabilityModelsSchema, ConfigFileSchema, ProfileSchema } from './schema.ts';

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

test('ConfigFileSchema accepts bashRules and rejects an unknown action / empty pattern (issue #113)', () => {
  const parsed = ConfigFileSchema.parse({
    bashRules: [
      { pattern: 'git push --force*', action: 'deny' },
      { pattern: 'git push --force-with-lease', action: 'allow' },
    ],
  });
  assert.equal(parsed.bashRules?.length, 2);
  assert.equal(parsed.bashRules?.[0]?.action, 'deny');
  assert.throws(() => ConfigFileSchema.parse({ bashRules: [{ pattern: 'x', action: 'ask' }] }));
  assert.throws(() => ConfigFileSchema.parse({ bashRules: [{ pattern: '', action: 'deny' }] }));
  assert.throws(() => ConfigFileSchema.parse({ bashRules: [{ pattern: 'x' }] }));
  // A whitespace-only pattern would split to zero tokens and silently never match — reject it (it is
  // trimmed before the length check), so a deny rule can't fail open.
  assert.throws(() => ConfigFileSchema.parse({ bashRules: [{ pattern: '   ', action: 'deny' }] }));
  assert.equal(
    ConfigFileSchema.parse({ bashRules: [{ pattern: '  git push  ', action: 'deny' }] })
      .bashRules?.[0]?.pattern,
    'git push',
    'a valid pattern is trimmed',
  );
});

test('ConfigFileSchema accepts providerRouting + fallbackModels and rejects a bad sort (issue #124)', () => {
  const parsed = ConfigFileSchema.parse({
    providerRouting: {
      order: ['anthropic', 'openai'],
      allowFallbacks: false,
      requireParameters: true,
      sort: 'throughput',
      only: ['anthropic'],
      ignore: ['amazon-bedrock'],
    },
    fallbackModels: { coding: ['a/x'], smart: ['b/y'] },
  });
  assert.deepEqual(parsed.providerRouting?.order, ['anthropic', 'openai']);
  assert.equal(parsed.providerRouting?.sort, 'throughput');
  assert.deepEqual(parsed.fallbackModels?.coding, ['a/x']);
  assert.throws(() => ConfigFileSchema.parse({ providerRouting: { sort: 'cheapest' } }));
  assert.throws(() => ConfigFileSchema.parse({ providerRouting: { order: 'anthropic' } }));
  assert.throws(() => ConfigFileSchema.parse({ fallbackModels: { coding: 'a/x' } }));
});

test('ProfileSchema also carries providerRouting + fallbackModels (issue #124)', () => {
  const parsed = ProfileSchema.parse({
    baseURL: 'https://api.z.ai/v1',
    providerRouting: { order: ['z-ai'] },
    fallbackModels: { fast: ['x/mini'] },
  });
  assert.deepEqual(parsed.providerRouting?.order, ['z-ai']);
  assert.deepEqual(parsed.fallbackModels?.fast, ['x/mini']);
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
