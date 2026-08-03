import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_LLM_STEP_TIMEOUT_MS } from '../config/defaults.ts';
import {
  appendReminderBlock,
  forwardInit,
  prependContextBlock,
  type SubagentFactory,
  type SubagentInit,
  type WorkerSubagentInit,
} from './factory.ts';

test('SubagentInit / SubagentFactory types are exported (compile-time check)', () => {
  // The body is only here so the import is preserved through ts-strip / bundlers.
  const _t: SubagentInit | undefined = undefined;
  const _f: SubagentFactory<unknown, unknown> | undefined = undefined;
  assert.equal(_t, undefined);
  assert.equal(_f, undefined);
});

test('DEFAULT_LLM_STEP_TIMEOUT_MS is 900_000 and clears the 600s bash ceiling (issue #129)', () => {
  assert.equal(DEFAULT_LLM_STEP_TIMEOUT_MS, 900_000);
  assert.ok(DEFAULT_LLM_STEP_TIMEOUT_MS > 600_000, 'must exceed MAX_BASH_TIMEOUT_MS');
});

test('prependContextBlock: prepends the block with a blank-line separator, or returns the prompt unchanged (issue #106)', () => {
  assert.equal(
    prependContextBlock('<system-reminder>\nctx\n</system-reminder>', 'Goal: x'),
    '<system-reminder>\nctx\n</system-reminder>\n\nGoal: x',
  );
  assert.equal(prependContextBlock(undefined, 'Goal: x'), 'Goal: x');
  assert.equal(prependContextBlock('', 'Goal: x'), 'Goal: x', 'empty block is a no-op');
});

test('appendReminderBlock: appends the trailing block with a blank-line separator, or returns the prompt unchanged (slice 04 §4)', () => {
  assert.equal(
    appendReminderBlock(
      'Goal: x',
      '<system-reminder>\n# runProgress\nStep 1 of 4\n</system-reminder>',
    ),
    'Goal: x\n\n<system-reminder>\n# runProgress\nStep 1 of 4\n</system-reminder>',
  );
  assert.equal(appendReminderBlock('Goal: x', undefined), 'Goal: x');
  assert.equal(appendReminderBlock('Goal: x', ''), 'Goal: x', 'empty block is a no-op');
});

test('forwardInit: omits every unset optional field so createSubagent defaults stand', () => {
  const minimal: SubagentInit = { model: 'test/model', tools: {}, systemPrompt: 'sys' };
  assert.deepEqual(Object.keys(forwardInit(minimal)), []);
});

test('forwardInit: forwards every createSubagent-shaped field, including the run signal', () => {
  const controller = new AbortController();
  const prepareStep = async () => ({});
  const onStepFinish = () => {};
  const onRetry = () => {};
  const onStream = () => {};
  // model/tools/systemPrompt are placed by the caller, not forwarded, so they are not part of what
  // this takes (issue #333) — passing them would say the helper reads them.
  const forwarded = forwardInit({
    maxSteps: 7,
    prepareStep,
    timeout: { stepMs: 40 },
    providerOptions: { openrouter: { tools: [] } },
    onStepFinish,
    onRetry,
    onStream,
    streamWatchdog: { inactivityMs: 5 },
    signal: controller.signal,
  });
  assert.deepEqual(Object.keys(forwarded).sort(), [
    'maxSteps',
    'onRetry',
    'onStepFinish',
    'onStream',
    'prepareStep',
    'providerOptions',
    'signal',
    'streamWatchdog',
    'timeout',
  ]);
  assert.equal(forwarded.signal, controller.signal);
  assert.equal(forwarded.maxSteps, 7);
  assert.equal(forwarded.prepareStep, prepareStep);
  assert.deepEqual(forwarded.timeout, { stepMs: 40 });
});

test('forwardInit: drops the aitm-only sinks createSubagent does not accept', () => {
  // onUsage / onEditorStepFinish are read by the runners off the init registry, not by the agent.
  // onEditorStepFinish is Worker-only, so it lives on WorkerSubagentInit — type the input as one.
  const workerInit: WorkerSubagentInit = {
    model: 'test/model',
    tools: {},
    systemPrompt: 'sys',
    onUsage: () => {},
    onEditorStepFinish: () => () => {},
  };
  assert.deepEqual(Object.keys(forwardInit(workerInit)), []);
});

test('WorkerSubagentInit is a superset of SubagentInit — forwardInit accepts it, minus the worker sink', () => {
  // Only the Worker consumes onEditorStepFinish, so it is off the shared SubagentInit: setting it on a
  // Planner/Reviewer/scout init is now a compile error, not a silent drop. A worker init still flows
  // through the shared forwardInit unchanged (it is a superset), and createSubagent never sees the sink.
  const workerInit: WorkerSubagentInit = {
    model: 'test/model',
    tools: {},
    systemPrompt: 'sys',
    maxSteps: 3,
    onEditorStepFinish: () => () => {},
  };
  const asBase: SubagentInit = workerInit;
  assert.deepEqual(Object.keys(forwardInit(asBase)), ['maxSteps']);
  assert.deepEqual(Object.keys(forwardInit(workerInit)), ['maxSteps']);
});
