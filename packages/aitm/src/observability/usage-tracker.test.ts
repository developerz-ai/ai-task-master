import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LanguageModelUsage } from 'ai';
import {
  type ModelLimits,
  type ModelLimitsLookup,
  ModelNotFound,
} from '../openrouter/model-limits.ts';
import { roleUsageSink, UsageTracker } from './usage-tracker.ts';

// A ModelLimitsLookup over a fixed catalog; an id not in the map throws ModelNotFound like the real one.
function stubLimits(catalog: Record<string, Omit<ModelLimits, 'modelId'>>): ModelLimitsLookup {
  return {
    preload: async () => {},
    forModel: async (id) => {
      const hit = catalog[id];
      if (!hit) throw new ModelNotFound(id);
      return { modelId: id, ...hit };
    },
  };
}

function usage(input: number, output: number, cacheRead = 0): LanguageModelUsage {
  return {
    inputTokens: input,
    inputTokenDetails: {
      noCacheTokens: input - cacheRead,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: undefined,
    },
    outputTokens: output,
    outputTokenDetails: { textTokens: output, reasoningTokens: undefined },
    totalTokens: input + output,
  };
}

const noLimits = stubLimits({});

test('record accumulates per-role + overall; undefined token fields count as 0', async () => {
  const t = new UsageTracker(noLimits);
  t.record('worker', 'm', usage(100, 20));
  t.record('worker', 'm', usage(50, 10));
  t.record('planner', 'm', {
    inputTokens: undefined,
    outputTokens: undefined,
  } as LanguageModelUsage);
  const { perRole, overall } = await t.totals();
  assert.equal(perRole.worker?.inputTokens, 150);
  assert.equal(perRole.worker?.outputTokens, 30);
  assert.equal(perRole.worker?.calls, 2);
  assert.equal(perRole.planner?.inputTokens, 0, 'undefined → 0');
  assert.equal(perRole.planner?.calls, 1);
  assert.equal(overall.inputTokens, 150);
  assert.equal(overall.outputTokens, 30);
  assert.equal(overall.calls, 3);
});

test('cached tokens accumulate from inputTokenDetails.cacheReadTokens', async () => {
  const t = new UsageTracker(noLimits);
  t.record('worker', 'm', usage(100, 10, 80));
  const { perRole } = await t.totals();
  assert.equal(perRole.worker?.cachedInputTokens, 80);
});

test('cache-aware cost math matches catalog pricing for a known model', async () => {
  const limits = stubLimits({
    'anthropic/opus': {
      contextLength: 200000,
      promptUsdPerToken: 5e-6,
      completionUsdPerToken: 1.5e-5,
      cacheReadUsdPerToken: 5e-7,
    },
  });
  const t = new UsageTracker(limits);
  // 1000 input (300 cache-read), 200 output.
  t.record('worker', 'anthropic/opus', usage(1000, 200, 300));
  const { perRole, overall } = await t.totals();
  // (1000-300)*5e-6 + 300*5e-7 + 200*1.5e-5 = 0.0035 + 0.00015 + 0.003 = 0.00665
  assert.ok(Math.abs((perRole.worker?.costUsd ?? 0) - 0.00665) < 1e-9);
  assert.ok(Math.abs((overall.costUsd ?? 0) - 0.00665) < 1e-9);
});

test('cache-read price falls back to the prompt rate when the catalog omits it', async () => {
  const limits = stubLimits({
    m: { contextLength: 1000, promptUsdPerToken: 1e-6, completionUsdPerToken: 2e-6 },
  });
  const t = new UsageTracker(limits);
  t.record('worker', 'm', usage(100, 10, 40)); // cached tokens priced at prompt rate (no cacheRead field)
  const { overall } = await t.totals();
  // 60*1e-6 + 40*1e-6 + 10*2e-6 = 1e-4 + 2e-5 = 1.2e-4
  assert.ok(Math.abs((overall.costUsd ?? 0) - 1.2e-4) < 1e-12);
});

test('unknown model → tokens reported, cost null (role + overall), no throw', async () => {
  const t = new UsageTracker(noLimits); // empty catalog → every forModel throws ModelNotFound
  t.record('worker', 'unknown/model', usage(100, 20));
  const { perRole, overall } = await t.totals();
  assert.equal(perRole.worker?.inputTokens, 100, 'tokens still reported');
  assert.equal(perRole.worker?.costUsd, null);
  assert.equal(overall.costUsd, null);
});

test('a model missing prompt/completion pricing → cost null', async () => {
  const limits = stubLimits({ m: { contextLength: 1000 } }); // no pricing fields
  const t = new UsageTracker(limits);
  t.record('planner', 'm', usage(10, 5));
  const { perRole } = await t.totals();
  assert.equal(perRole.planner?.inputTokens, 10);
  assert.equal(perRole.planner?.costUsd, null);
});

test('one unpriced model in a role poisons that role AND overall cost to null; others keep tokens', async () => {
  const limits = stubLimits({
    priced: { contextLength: 1000, promptUsdPerToken: 1e-6, completionUsdPerToken: 1e-6 },
  });
  const t = new UsageTracker(limits);
  t.record('worker', 'priced', usage(100, 100));
  t.record('worker', 'unpriced', usage(50, 50));
  const { perRole, overall } = await t.totals();
  assert.equal(perRole.worker?.inputTokens, 150, 'tokens summed across models');
  assert.equal(perRole.worker?.costUsd, null, 'one unpriced model → role cost null');
  assert.equal(overall.costUsd, null);
});

test('roleUsageSink binds a role and falls back to the configured model id when none is echoed', async () => {
  const t = new UsageTracker(noLimits);
  const sink = roleUsageSink(t, 'planner', 'fallback/model');
  assert.ok(sink);
  sink?.(usage(10, 5), undefined); // no modelId → fallback
  sink?.(usage(20, 5), 'explicit/model');
  const { perRole } = await t.totals();
  assert.equal(perRole.planner?.inputTokens, 30);
  assert.equal(perRole.planner?.calls, 2);
  // No tracker → no sink (callers omit the seam entirely).
  assert.equal(roleUsageSink(undefined, 'planner', 'x'), undefined);
});
