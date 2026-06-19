import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isPresetName, PRESET_NAMES, PROVIDER_PRESETS } from './provider-presets.ts';
import { ProfileSchema } from './schema.ts';

test('every preset is a schema-valid profile', () => {
  for (const name of PRESET_NAMES) {
    const parsed = ProfileSchema.safeParse(PROVIDER_PRESETS[name]);
    assert.ok(parsed.success, `preset ${name} should validate: ${parsed.error?.message}`);
  }
});

test('no preset hardcodes an API key', () => {
  for (const name of PRESET_NAMES) {
    assert.equal(PROVIDER_PRESETS[name].openrouterApiKey, undefined, `${name} must not ship a key`);
  }
});

test('zai preset targets the GLM coding endpoint with glm models', () => {
  const zai = PROVIDER_PRESETS.zai;
  assert.equal(zai.baseURL, 'https://api.z.ai/api/coding/paas/v4');
  assert.equal(zai.models?.coding, 'glm-5.2');
  assert.equal(zai.models?.fast, 'glm-5-turbo');
});

test('openrouter preset is the provider default base URL with no pinned models', () => {
  const or = PROVIDER_PRESETS.openrouter;
  assert.equal(or.baseURL, 'https://openrouter.ai/api/v1');
  assert.equal(or.models, undefined);
});

test('isPresetName narrows known names and rejects others', () => {
  assert.equal(isPresetName('zai'), true);
  assert.equal(isPresetName('openrouter'), true);
  assert.equal(isPresetName('anthropic'), false);
  assert.equal(isPresetName(''), false);
});

test('isPresetName rejects inherited Object.prototype names', () => {
  assert.equal(isPresetName('toString'), false);
  assert.equal(isPresetName('constructor'), false);
  assert.equal(isPresetName('hasOwnProperty'), false);
});
