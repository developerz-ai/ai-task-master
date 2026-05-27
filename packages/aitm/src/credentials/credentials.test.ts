import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LanguageModel } from 'ai';
import type { ResolvedConfig } from '../config/schema.ts';
import { Credentials, ROLE_CAPABILITY } from './credentials.ts';
import { DEFAULT_MODELS } from './defaults.ts';

const baseResolved = (overrides: Partial<ResolvedConfig> = {}): ResolvedConfig => ({
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
  ...overrides,
});

function modelIdOf(handle: LanguageModel): string {
  if (typeof handle === 'string') return handle;
  return handle.modelId;
}

test('ROLE_CAPABILITY maps every role to a tier', () => {
  assert.equal(ROLE_CAPABILITY.planner, 'smart');
  assert.equal(ROLE_CAPABILITY.worker, 'coding');
  assert.equal(ROLE_CAPABILITY.reviewer, 'smart');
  assert.equal(ROLE_CAPABILITY.orchestrator, 'fast');
});

test('Credentials is constructible', () => {
  const creds = new Credentials(baseResolved());
  assert.ok(creds instanceof Credentials);
});

test('DEFAULT_MODELS exposes every capability tier', () => {
  assert.ok(DEFAULT_MODELS.fast);
  assert.ok(DEFAULT_MODELS.generic);
  assert.ok(DEFAULT_MODELS.smart);
  assert.ok(DEFAULT_MODELS.coding);
});

test('modelFor(worker) returns the coding-tier model id', () => {
  const creds = new Credentials(baseResolved());
  assert.equal(modelIdOf(creds.modelFor('worker')), DEFAULT_MODELS.coding);
});

test('modelFor maps every role through ROLE_CAPABILITY to the configured tier', () => {
  const creds = new Credentials(baseResolved());
  assert.equal(modelIdOf(creds.modelFor('planner')), DEFAULT_MODELS.smart);
  assert.equal(modelIdOf(creds.modelFor('worker')), DEFAULT_MODELS.coding);
  assert.equal(modelIdOf(creds.modelFor('reviewer')), DEFAULT_MODELS.smart);
  assert.equal(modelIdOf(creds.modelFor('orchestrator')), DEFAULT_MODELS.fast);
});

test('handles() exposes one model per role', () => {
  const creds = new Credentials(baseResolved());
  const h = creds.handles();
  assert.equal(modelIdOf(h.planner), DEFAULT_MODELS.smart);
  assert.equal(modelIdOf(h.worker), DEFAULT_MODELS.coding);
  assert.equal(modelIdOf(h.reviewer), DEFAULT_MODELS.smart);
  assert.equal(modelIdOf(h.orchestrator), DEFAULT_MODELS.fast);
});

test('modelForCapability honors per-tier override', () => {
  const creds = new Credentials(
    baseResolved({
      models: { ...DEFAULT_MODELS, coding: 'custom/coder-pro' },
    }),
  );
  assert.equal(modelIdOf(creds.modelForCapability('coding')), 'custom/coder-pro');
  assert.equal(modelIdOf(creds.modelFor('worker')), 'custom/coder-pro');
  // unrelated tiers untouched
  assert.equal(modelIdOf(creds.modelForCapability('smart')), DEFAULT_MODELS.smart);
});

test('modelForCapability falls back to generic when tier is empty', () => {
  const creds = new Credentials(
    baseResolved({
      models: {
        generic: 'custom/everything',
        smart: '',
        coding: '',
        fast: '',
      },
    }),
  );
  assert.equal(modelIdOf(creds.modelForCapability('smart')), 'custom/everything');
  assert.equal(modelIdOf(creds.modelForCapability('coding')), 'custom/everything');
  assert.equal(modelIdOf(creds.modelForCapability('fast')), 'custom/everything');
});

test('modelForCapability falls back to DEFAULT_MODELS when both tier and generic empty', () => {
  const creds = new Credentials(
    baseResolved({
      models: { generic: '', smart: '', coding: '', fast: '' },
    }),
  );
  assert.equal(modelIdOf(creds.modelForCapability('coding')), DEFAULT_MODELS.coding);
  assert.equal(modelIdOf(creds.modelForCapability('fast')), DEFAULT_MODELS.fast);
});

test('assertApiKeyPresent throws with actionable message when key empty', () => {
  assert.throws(
    () => Credentials.assertApiKeyPresent(baseResolved({ openrouterApiKey: '' })),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /OPENROUTER_API_KEY/);
      assert.match(err.message, /openrouter\.ai\/keys/);
      return true;
    },
  );
});

test('assertApiKeyPresent treats whitespace-only keys as missing', () => {
  assert.throws(() => Credentials.assertApiKeyPresent(baseResolved({ openrouterApiKey: '   ' })));
});

test('assertApiKeyPresent passes when key is set', () => {
  assert.doesNotThrow(() => Credentials.assertApiKeyPresent(baseResolved()));
});

test('modelFor throws when API key is missing (lazy assert)', () => {
  const creds = new Credentials(baseResolved({ openrouterApiKey: '' }));
  assert.throws(() => creds.modelFor('worker'), /OPENROUTER_API_KEY/);
});
