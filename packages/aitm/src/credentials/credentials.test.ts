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

// Reads the `extraBody` the provider stored on a built handle (a public `readonly settings` on the
// OpenRouter model). Narrows through `unknown` — no casts — so a regression that drops the sessionId
// passthrough in modelForCapability is caught end-to-end, not just in the pure helper.
function extraBodyOf(handle: LanguageModel): unknown {
  if (typeof handle === 'string' || !('settings' in handle)) return undefined;
  const settings: unknown = handle.settings;
  if (typeof settings !== 'object' || settings === null || !('extraBody' in settings)) {
    return undefined;
  }
  return settings.extraBody;
}

// --- chatSettings (issue #124) ---

test('chatSettings: nothing configured + non-Anthropic id → byte-identical to the historical default', () => {
  // Post-#109 the byte-identical guarantee holds for non-Anthropic routes; an anthropic/* id adds
  // cache_control (covered below).
  const s = chatSettings('openai/gpt-5', 'coding', baseResolved());
  assert.deepEqual(s, { provider: { ignore: ['amazon-bedrock'] } });
  // Explicit key-absence: only `ignore` under provider, no `models`, no `cache_control`.
  assert.ok(!('models' in s), 'no fallback models key');
  assert.ok(!('cache_control' in s), 'no caching for non-Anthropic id');
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

// --- chatSettings prompt caching (issue #109) ---

test('chatSettings: every DEFAULT_MODELS (anthropic/*) id enables ephemeral prompt caching', () => {
  for (const modelId of Object.values(DEFAULT_MODELS)) {
    const s = chatSettings(modelId, 'coding', baseResolved());
    assert.deepEqual(s.cache_control, { type: 'ephemeral' }, `${modelId} cached`);
    // Coexists with the always-on bedrock ignore.
    assert.deepEqual(s.provider?.ignore, ['amazon-bedrock']);
  }
});

test('chatSettings: a non-Anthropic id has no cache_control key (absence, not undefined)', () => {
  const s = chatSettings('openai/gpt-5', 'smart', baseResolved());
  assert.equal('cache_control' in s, false);
});

test('chatSettings: caching gates on the RESOLVED id — anthropic override cached, non-anthropic not', () => {
  // The helper is called with whatever modelForCapability resolved, so an override flips caching.
  assert.deepEqual(chatSettings('anthropic/custom-opus', 'coding', baseResolved()).cache_control, {
    type: 'ephemeral',
  });
  assert.equal('cache_control' in chatSettings('mistralai/large', 'coding', baseResolved()), false);
});

test('chatSettings: a custom baseURL suppresses caching even for an anthropic/* id (issue #109)', () => {
  // cache_control is an OpenRouter-only directive; a custom endpoint (z.ai, self-hosted, proxy) is
  // not OpenRouter, so the request must stay byte-identical to today's.
  const cfg = baseResolved({ baseURL: 'https://api.z.ai/api/coding/paas/v4' });
  const s = chatSettings('anthropic/claude-opus-4.7', 'coding', cfg);
  assert.equal('cache_control' in s, false, 'no caching on a custom endpoint');
  assert.deepEqual(
    s,
    { provider: { ignore: ['amazon-bedrock'] } },
    'byte-identical on custom baseURL',
  );
});

test('chatSettings: caching composes with routing/fallback/reasoning in one object (issues #124/#125/#109)', () => {
  const s = chatSettings(
    'anthropic/claude-opus-4.7',
    'coding',
    baseResolved({
      providerRouting: { sort: 'throughput' },
      fallbackModels: { coding: ['anthropic/backup'] },
      reasoningEffort: { coding: 'medium' },
    }),
  );
  assert.deepEqual(s.cache_control, { type: 'ephemeral' });
  assert.deepEqual(s.models, ['anthropic/backup']);
  assert.deepEqual(s.reasoning, { effort: 'medium' });
  assert.equal(s.provider?.sort, 'throughput');
});

// --- chatSettings session stickiness + prompt-cache key per family (plan slice 04a) ---

test('chatSettings: no sessionId → no extraBody (byte-identical guarantee preserved)', () => {
  assert.equal('extraBody' in chatSettings('openai/gpt-5', 'coding', baseResolved()), false);
  // An explicit undefined behaves the same as omitting the argument.
  assert.deepEqual(chatSettings('openai/gpt-5', 'coding', baseResolved(), undefined), {
    provider: { ignore: ['amazon-bedrock'] },
  });
});

test('chatSettings: an empty sessionId is treated as absent (no extraBody)', () => {
  assert.equal('extraBody' in chatSettings('openai/gpt-5', 'coding', baseResolved(), ''), false);
});

test('chatSettings: OpenRouter route carries both session_id and prompt_cache_key = sessionId', () => {
  const s = chatSettings('openai/gpt-5', 'coding', baseResolved(), 'run-abc');
  assert.deepEqual(s.extraBody, { session_id: 'run-abc', prompt_cache_key: 'run-abc' });
});

test('chatSettings: a direct baseURL (z.ai) carries prompt_cache_key only — no session_id', () => {
  const s = chatSettings(
    'zai/glm-4.6',
    'coding',
    baseResolved({ baseURL: 'https://api.z.ai/api/coding/paas/v4' }),
    'run-abc',
  );
  assert.deepEqual(s.extraBody, { prompt_cache_key: 'run-abc' });
  assert.equal('session_id' in (s.extraBody ?? {}), false, 'session_id is an OpenRouter-only hint');
});

test('chatSettings: a direct baseURL (moonshot) carries prompt_cache_key only', () => {
  const s = chatSettings(
    'moonshotai/kimi-k2',
    'coding',
    baseResolved({ baseURL: 'https://api.moonshot.ai/v1' }),
    'run-xyz',
  );
  assert.deepEqual(s.extraBody, { prompt_cache_key: 'run-xyz' });
});

test('chatSettings: anthropic on OpenRouter keeps ephemeral breakpoints AND gains session params', () => {
  const s = chatSettings('anthropic/claude-opus-4.7', 'coding', baseResolved(), 'run-abc');
  assert.deepEqual(s.cache_control, { type: 'ephemeral' }, 'breakpoints preserved');
  assert.deepEqual(s.extraBody, { session_id: 'run-abc', prompt_cache_key: 'run-abc' });
});

test('chatSettings: qwen/* and alibaba/* join the cache_control family on OpenRouter', () => {
  for (const id of ['qwen/qwen3-235b-a22b', 'alibaba/qwen-max']) {
    assert.deepEqual(
      chatSettings(id, 'coding', baseResolved()).cache_control,
      { type: 'ephemeral' },
      `${id} enables cache_control`,
    );
  }
  // A non-family id is still uncached.
  assert.equal('cache_control' in chatSettings('mistralai/large', 'coding', baseResolved()), false);
});

test('chatSettings: a custom baseURL suppresses qwen cache_control but keeps prompt_cache_key', () => {
  const s = chatSettings(
    'qwen/qwen3-max',
    'coding',
    baseResolved({ baseURL: 'https://dashscope.example/v1' }),
    'run-abc',
  );
  assert.equal('cache_control' in s, false, 'OpenRouter-only directive suppressed off-OpenRouter');
  assert.deepEqual(s.extraBody, { prompt_cache_key: 'run-abc' });
});

test('chatSettings: session params compose with routing/fallback/reasoning/cache_control', () => {
  const s = chatSettings(
    'anthropic/claude-opus-4.7',
    'coding',
    baseResolved({
      providerRouting: { sort: 'throughput' },
      fallbackModels: { coding: ['anthropic/backup'] },
      reasoningEffort: { coding: 'medium' },
    }),
    'run-abc',
  );
  assert.deepEqual(s.cache_control, { type: 'ephemeral' });
  assert.deepEqual(s.models, ['anthropic/backup']);
  assert.deepEqual(s.reasoning, { effort: 'medium' });
  assert.equal(s.provider?.sort, 'throughput');
  assert.deepEqual(s.extraBody, { session_id: 'run-abc', prompt_cache_key: 'run-abc' });
});

test('Credentials threads the run-scoped sessionId into the built handle (OpenRouter route)', () => {
  const creds = new Credentials(baseResolved(), 'run-scoped-id');
  assert.deepEqual(extraBodyOf(creds.modelForCapability('coding')), {
    session_id: 'run-scoped-id',
    prompt_cache_key: 'run-scoped-id',
  });
});

test('Credentials threads the sessionId as prompt_cache_key only on a custom baseURL', () => {
  const creds = new Credentials(baseResolved({ baseURL: 'https://api.moonshot.ai/v1' }), 'run-id');
  assert.deepEqual(extraBodyOf(creds.modelForCapability('coding')), { prompt_cache_key: 'run-id' });
});

test('Credentials without a sessionId sends no extraBody (back-compat)', () => {
  const creds = new Credentials(baseResolved());
  assert.equal(extraBodyOf(creds.modelForCapability('coding')), undefined);
});

test('modelForCapability routes through chatSettings so default (anthropic) handles are cached', () => {
  // No provider internals mocked: assert the exported helper the constructor uses would cache each
  // default tier. modelForCapability builds the handle from exactly this settings object.
  const creds = new Credentials(baseResolved());
  for (const capability of ['generic', 'smart', 'coding', 'fast'] as const) {
    const id = creds.modelIdForCapability(capability);
    assert.deepEqual(chatSettings(id, capability, baseResolved()).cache_control, {
      type: 'ephemeral',
    });
  }
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

test('providerSettings omits fetch when no keep-alive transport is supplied (byte-identical)', () => {
  const settings = providerSettings(baseResolved());
  assert.equal('fetch' in settings, false, 'absence, not undefined — provider keeps its default');
});

test('providerSettings forwards the keep-alive fetch (plan slice 04b) when supplied', () => {
  const keepAlive: typeof fetch = () => Promise.resolve(new Response('ok'));
  const settings = providerSettings(baseResolved(), keepAlive);
  assert.equal(settings.fetch, keepAlive);
});

test('providerSettings carries both baseURL and the keep-alive fetch when set', () => {
  const keepAlive: typeof fetch = () => Promise.resolve(new Response('ok'));
  const settings = providerSettings(
    baseResolved({ baseURL: 'https://api.moonshot.ai/v1' }),
    keepAlive,
  );
  assert.equal(settings.baseURL, 'https://api.moonshot.ai/v1');
  assert.equal(settings.fetch, keepAlive);
});

test('modelFor still resolves the tier when a baseURL override is set', () => {
  const creds = new Credentials(baseResolved({ baseURL: 'https://api.z.ai/api/coding/paas/v4' }));
  assert.equal(modelIdOf(creds.modelFor('worker')), DEFAULT_MODELS.coding);
});
