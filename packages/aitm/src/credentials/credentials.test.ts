import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LanguageModel } from 'ai';
import type { ResolvedConfig } from '../config/schema.ts';
import { Credentials, chatSettings, providerSettings, ROLE_CAPABILITY } from './credentials.ts';
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
  reasoningEffort: {},
  ...overrides,
});

function modelIdOf(handle: LanguageModel): string {
  if (typeof handle === 'string') return handle;
  return handle.modelId;
}

// --- chatSettings (issue #124) ---

test('chatSettings: nothing configured → byte-identical to the historical bedrock-ignore default', () => {
  const s = chatSettings('anthropic/x', 'coding', baseResolved());
  assert.deepEqual(s, { provider: { ignore: ['amazon-bedrock'] } });
  // Explicit key-absence: only `ignore` under provider, and no `models`.
  assert.ok(!('models' in s), 'no fallback models key');
  assert.deepEqual(Object.keys(s.provider ?? {}), ['ignore'], 'no unconfigured routing keys');
});

test('chatSettings: configured routing maps camelCase → snake_case under provider; unset keys absent', () => {
  const s = chatSettings(
    'x/y',
    'smart',
    baseResolved({
      providerRouting: {
        order: ['anthropic', 'openai'],
        allowFallbacks: false,
        requireParameters: true,
        sort: 'throughput',
        only: ['anthropic'],
      },
    }),
  );
  assert.deepEqual(s.provider, {
    ignore: ['amazon-bedrock'],
    order: ['anthropic', 'openai'],
    allow_fallbacks: false,
    require_parameters: true,
    sort: 'throughput',
    only: ['anthropic'],
  });
});

test('chatSettings: the built-in amazon-bedrock ignore is always unioned and deduplicated', () => {
  const withUser = chatSettings(
    'x/y',
    'fast',
    baseResolved({ providerRouting: { ignore: ['foo'] } }),
  );
  assert.deepEqual(withUser.provider?.ignore, ['foo', 'amazon-bedrock']);
  const withDup = chatSettings(
    'x/y',
    'fast',
    baseResolved({ providerRouting: { ignore: ['amazon-bedrock'] } }),
  );
  assert.deepEqual(withDup.provider?.ignore, ['amazon-bedrock'], 'exactly one entry');
});

test('chatSettings: models fallback present iff configured for the REQUESTED capability', () => {
  const cfg = baseResolved({ fallbackModels: { coding: ['a/x', 'b/y'] } });
  assert.deepEqual(chatSettings('primary/id', 'coding', cfg).models, ['a/x', 'b/y']);
  // A different capability with no fallback configured → models omitted.
  assert.ok(!('models' in chatSettings('primary/id', 'smart', cfg)));
});

test('chatSettings: capability fallback applies even when the primary id came from generic/DEFAULT', () => {
  // `models.coding` is unset, so the coding primary resolves via generic/DEFAULT — the fallback still
  // keys off the requested capability, not the id-chain link that supplied the primary.
  const cfg = baseResolved({
    models: { ...DEFAULT_MODELS, coding: '' },
    fallbackModels: { coding: ['fallback/coder'] },
  });
  assert.deepEqual(chatSettings(DEFAULT_MODELS.coding, 'coding', cfg).models, ['fallback/coder']);
});

// --- chatSettings reasoning effort (issue #125) ---

test('chatSettings: a configured capability carries reasoning: { effort }', () => {
  for (const [capability, effort] of [
    ['smart', 'high'],
    ['coding', 'medium'],
    ['fast', 'none'],
    ['generic', 'low'],
  ] as const) {
    const s = chatSettings(
      'x/y',
      capability,
      baseResolved({ reasoningEffort: { [capability]: effort } }),
    );
    assert.deepEqual(s.reasoning, { effort });
  }
});

test('chatSettings: an unconfigured capability has no reasoning key at all', () => {
  const cfg = baseResolved({ reasoningEffort: { smart: 'high' } });
  const other = chatSettings('x/y', 'coding', cfg);
  assert.equal('reasoning' in other, false, 'key absence, not undefined');
  // With nothing configured the whole object is still byte-identical to the historical default.
  assert.deepEqual(chatSettings('x/y', 'coding', baseResolved()), {
    provider: { ignore: ['amazon-bedrock'] },
  });
});

test('chatSettings: effort keys off the requested capability even when the primary came from generic', () => {
  // models.smart empty → the smart primary resolves via generic/DEFAULT, but the effort still keys
  // off the requested `smart` capability, not the id-chain link that supplied the model.
  const cfg = baseResolved({
    models: { ...DEFAULT_MODELS, smart: '' },
    reasoningEffort: { smart: 'high' },
  });
  assert.deepEqual(chatSettings(DEFAULT_MODELS.generic, 'smart', cfg).reasoning, {
    effort: 'high',
  });
});

test('chatSettings: routing (#124) and reasoning (#125) coexist in one object from the single helper', () => {
  const s = chatSettings(
    'x/y',
    'coding',
    baseResolved({
      providerRouting: { sort: 'throughput', requireParameters: true },
      fallbackModels: { coding: ['a/x'] },
      reasoningEffort: { coding: 'medium' },
    }),
  );
  assert.deepEqual(s.provider, {
    ignore: ['amazon-bedrock'],
    sort: 'throughput',
    require_parameters: true,
  });
  assert.deepEqual(s.models, ['a/x']);
  assert.deepEqual(s.reasoning, { effort: 'medium' });
});

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

test('modelIdForCapability returns the resolved id via the same fallback chain (issue #102)', () => {
  const override = new Credentials(
    baseResolved({ models: { ...DEFAULT_MODELS, coding: 'custom/coder-pro' } }),
  );
  assert.equal(override.modelIdForCapability('coding'), 'custom/coder-pro');
  assert.equal(override.modelIdForCapability('smart'), DEFAULT_MODELS.smart);
  // generic fallback when the tier is empty
  const generic = new Credentials(
    baseResolved({ models: { generic: 'g/only', smart: '', coding: '', fast: '' } }),
  );
  assert.equal(generic.modelIdForCapability('coding'), 'g/only');
  // built-in default when both tier and generic are empty
  const dflt = new Credentials(
    baseResolved({ models: { generic: '', smart: '', coding: '', fast: '' } }),
  );
  assert.equal(dflt.modelIdForCapability('fast'), DEFAULT_MODELS.fast);
});

test('modelIdFor maps role → capability → id, matching modelFor (issue #102)', () => {
  const creds = new Credentials(baseResolved({ models: { ...DEFAULT_MODELS, coding: 'x/coder' } }));
  assert.equal(creds.modelIdFor('worker'), 'x/coder');
  assert.equal(creds.modelIdFor('planner'), DEFAULT_MODELS.smart);
  assert.equal(creds.modelIdFor('orchestrator'), DEFAULT_MODELS.fast);
  // The id path agrees with the handle path.
  assert.equal(creds.modelIdFor('worker'), modelIdOf(creds.modelFor('worker')));
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

test('providerSettings omits baseURL when unset (provider keeps its default)', () => {
  const settings = providerSettings(baseResolved());
  assert.equal(settings.apiKey, 'sk-or-test');
  assert.equal('baseURL' in settings, false);
});

test('providerSettings forwards baseURL when set', () => {
  const settings = providerSettings(
    baseResolved({ baseURL: 'https://api.z.ai/api/coding/paas/v4' }),
  );
  assert.equal(settings.baseURL, 'https://api.z.ai/api/coding/paas/v4');
});

test('modelFor still resolves the tier when a baseURL override is set', () => {
  const creds = new Credentials(baseResolved({ baseURL: 'https://api.z.ai/api/coding/paas/v4' }));
  assert.equal(modelIdOf(creds.modelFor('worker')), DEFAULT_MODELS.coding);
});
