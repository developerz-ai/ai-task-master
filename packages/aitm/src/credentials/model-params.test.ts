import assert from 'node:assert/strict';
import { test } from 'node:test';
import { samplingParamsFor } from './model-params.ts';

test('samplingParamsFor: GLM is pinned to 1.0 — the family this table exists for', () => {
  // Observed on a real run at the endpoint default: double-encoded tool arguments, an editor
  // narrating an edit instead of writing it, an 8-minute reasoning block before the first tool call.
  assert.deepEqual(samplingParamsFor('glm-5.2'), { temperature: 1.0 });
  assert.deepEqual(samplingParamsFor('glm-4.6'), { temperature: 1.0 });
});

test('samplingParamsFor: matches a family however the provider spells the id', () => {
  // The same model arrives as a bare id, an OpenRouter route, and a HuggingFace-style org path.
  for (const id of ['glm-5.2', 'z-ai/glm-5.2', 'zai-org/GLM-5.2', 'GLM-5.2-Air']) {
    assert.deepEqual(samplingParamsFor(id), { temperature: 1.0 }, id);
  }
});

test('samplingParamsFor: a family with no entry contributes nothing', () => {
  // Not a stylistic choice — an unset parameter keeps the request byte-identical to before this
  // table existed, so adding it cannot regress the models that were already fine.
  assert.deepEqual(samplingParamsFor('anthropic/claude-opus-4.8'), {});
  assert.deepEqual(samplingParamsFor('openai/gpt-5'), {});
  assert.deepEqual(samplingParamsFor('some-model-nobody-has-heard-of'), {});
});

test('samplingParamsFor: the more specific Kimi entry wins over its family', () => {
  assert.deepEqual(samplingParamsFor('moonshot/kimi-k2-thinking'), {
    temperature: 1.0,
    topP: 0.95,
  });
  assert.deepEqual(samplingParamsFor('moonshot/kimi-k2'), { temperature: 0.6 });
});

test('samplingParamsFor: carries topP/topK for the families that need them', () => {
  assert.deepEqual(samplingParamsFor('google/gemini-3-pro'), {
    temperature: 1.0,
    topP: 0.95,
    topK: 64,
  });
  assert.deepEqual(samplingParamsFor('qwen/qwen3-coder'), { temperature: 0.55, topP: 1 });
});

test('samplingParamsFor: never returns a mutable view of the table', () => {
  // Callers spread the result into request settings; handing out the shared entry would let one
  // call's mutation leak into every later request for that family.
  const first = samplingParamsFor('glm-5.2') as { temperature?: number };
  const second = samplingParamsFor('glm-5.2');
  first.temperature = 0.1;
  assert.deepEqual(second, { temperature: 1.0 }, 'a later lookup is unaffected');
});
