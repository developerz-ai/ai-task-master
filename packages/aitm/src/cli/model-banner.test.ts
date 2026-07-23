import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type BannerEntry, formatRate, formatTokens, modelBanner } from './model-banner.ts';

test('formatTokens: millions and thousands stay readable', () => {
  assert.equal(formatTokens(1_048_576), '1.0M');
  assert.equal(formatTokens(202_752), '202.8K');
  assert.equal(formatTokens(512), '512');
});

test('formatRate: per-token USD renders as dollars per million', () => {
  // The unit every provider quotes. Sub-dollar rates keep a third digit so $0.822 and $0.966 stay
  // distinguishable instead of both collapsing to $0.82/$0.97.
  assert.equal(formatRate(0.0000008246), '$0.825/M');
  assert.equal(formatRate(0.000003), '$3.00/M');
});

test('modelBanner: capabilities sharing a model collapse onto one line', () => {
  const entries: BannerEntry[] = [
    { capability: 'generic', modelId: 'glm-5.2', limits: { modelId: 'glm-5.2', contextLength: 1 } },
    { capability: 'smart', modelId: 'glm-5.2', limits: { modelId: 'glm-5.2', contextLength: 1 } },
    { capability: 'fast', modelId: 'glm-5-turbo', limits: { modelId: 'glm-5-turbo' } },
  ];
  const out = modelBanner(entries, 'z.ai');
  const lines = out.trimEnd().split('\n');
  assert.equal(lines.length, 3, `heading + one line per distinct model, got:\n${out}`);
  assert.match(lines[1] ?? '', /glm-5\.2\s+generic, smart/);
});

test('modelBanner: a missing window names the consequence, not just the gap', () => {
  // The whole reason this line exists — an unknown window means the Compactor cannot fire, and that
  // is invisible until a long run overflows.
  const out = modelBanner([{ capability: 'coding', modelId: 'm', limits: undefined }], 'p');
  assert.match(out, /window unknown — autocompaction off/);
  assert.match(out, /price unknown/);
});

test('modelBanner: reference-sourced values are labelled as borrowed list prices', () => {
  const out = modelBanner(
    [
      {
        capability: 'coding',
        modelId: 'glm-5.2',
        limits: {
          modelId: 'glm-5.2',
          contextLength: 1_048_576,
          contextSource: 'reference',
          promptUsdPerToken: 0.0000008,
          completionUsdPerToken: 0.0000025,
          pricingSource: 'reference',
        },
      },
    ],
    'z.ai',
  );
  assert.match(out, /window \+ price from OpenRouter list/);
});

test('modelBanner: a provider that publishes its own numbers is not labelled', () => {
  // Silence is the signal that the figures are the endpoint's own.
  const out = modelBanner(
    [
      {
        capability: 'coding',
        modelId: 'm',
        limits: {
          modelId: 'm',
          contextLength: 200_000,
          contextSource: 'provider',
          promptUsdPerToken: 0.000001,
          completionUsdPerToken: 0.000002,
          pricingSource: 'provider',
        },
      },
    ],
    'p',
  );
  assert.doesNotMatch(out, /OpenRouter list/);
});

test('modelBanner: only the borrowed half is named when the provider published the other', () => {
  // kimi publishes a window but no pricing; claiming the window was borrowed too would be false.
  const out = modelBanner(
    [
      {
        capability: 'coding',
        modelId: 'k3',
        limits: {
          modelId: 'k3',
          contextLength: 1_048_576,
          contextSource: 'provider',
          promptUsdPerToken: 0.000003,
          completionUsdPerToken: 0.000015,
          pricingSource: 'reference',
        },
      },
    ],
    'kimi',
  );
  assert.match(out, /\(price from OpenRouter list/);
  assert.doesNotMatch(out, /window \+ price/);
});

test('modelBanner: no configured models prints nothing at all', () => {
  assert.equal(modelBanner([], 'p'), '');
});
