import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LoggerLike } from '../logger/logger.ts';
import { UsageTracker } from '../observability/usage-tracker.ts';
import type { ModelLimitsLookup } from '../openrouter/model-limits.ts';
import type { RunLoopInput, RunMergeFlowInput } from './run-input.ts';

// The optional run-scoped wiring is the reason these input contracts exist: cancellation (signal),
// the structured logger, and token/cost accounting (usage/modelLimits). These tests pin that this
// wiring stays OPTIONAL — so a caller or a loop-stubbing unit test that omits it keeps compiling —
// and that each field carries its declared type. The heavy required service handles
// (resolved/credentials/state/github/runState) are exercised end-to-end by the adapter tests; their
// field contract is enforced by the adapters that consume them under the production typecheck.

const noopLimits: ModelLimitsLookup = {
  forModel: async () => ({ modelId: 'test-model' }),
  preload: async () => {},
};

const noopLogger: LoggerLike = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  status() {},
  flush: async () => {},
};

type RunLoopWiring = Pick<
  RunLoopInput,
  'styleDigest' | 'branch' | 'criteria' | 'usage' | 'modelLimits' | 'signal' | 'logger'
>;

type MergeFlowFields = Pick<
  RunMergeFlowInput,
  'pr' | 'resume' | 'styleDigest' | 'maxIterations' | 'usage' | 'signal' | 'logger'
>;

test('run-input: RunLoopInput run-scoped wiring is omittable → optional', () => {
  // `branch`/`criteria` are required keys with undefinable values; the ?-keys may be dropped.
  const wiring: RunLoopWiring = { branch: undefined, criteria: undefined };
  assert.equal(wiring.styleDigest, undefined);
  assert.equal(wiring.usage, undefined);
  assert.equal(wiring.modelLimits, undefined);
  assert.equal(wiring.signal, undefined);
  assert.equal(wiring.logger, undefined);
});

test('run-input: RunLoopInput run-scoped wiring carries the declared types', () => {
  const usage = new UsageTracker(noopLimits);
  const controller = new AbortController();
  const wiring: RunLoopWiring = {
    styleDigest: 'DIGEST',
    branch: 'aitm/core',
    criteria: 'done when checks are green',
    usage,
    modelLimits: noopLimits,
    signal: controller.signal,
    logger: noopLogger,
  };
  assert.equal(wiring.styleDigest, 'DIGEST');
  assert.equal(wiring.branch, 'aitm/core');
  assert.equal(wiring.criteria, 'done when checks are green');
  assert.ok(wiring.usage instanceof UsageTracker);
  assert.equal(wiring.modelLimits, noopLimits);
  assert.equal(wiring.signal, controller.signal);
  assert.equal(wiring.logger, noopLogger);
});

test('run-input: RunMergeFlowInput optional wiring is omittable → optional', () => {
  const merge: MergeFlowFields = { pr: 1, resume: false };
  assert.equal(merge.styleDigest, undefined);
  assert.equal(merge.maxIterations, undefined);
  assert.equal(merge.usage, undefined);
  assert.equal(merge.signal, undefined);
  assert.equal(merge.logger, undefined);
});

test('run-input: RunMergeFlowInput carries merge-flow fields + optional wiring', () => {
  const usage = new UsageTracker(noopLimits);
  const controller = new AbortController();
  const merge: MergeFlowFields = {
    pr: 42,
    resume: true,
    maxIterations: 12,
    usage,
    signal: controller.signal,
    logger: noopLogger,
  };
  assert.equal(merge.pr, 42);
  assert.equal(merge.resume, true);
  assert.equal(merge.maxIterations, 12);
  assert.equal(merge.styleDigest, undefined);
  assert.ok(merge.usage instanceof UsageTracker);
  assert.equal(merge.signal, controller.signal);
  assert.equal(merge.logger, noopLogger);
});
