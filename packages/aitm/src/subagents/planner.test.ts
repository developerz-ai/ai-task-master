import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MockLanguageModelV3 } from 'ai/test';
import type { Plan } from '../plan/schema.ts';
import { createPlannerAgent, PLANNER_SYSTEM_PREFIX, runPlanner } from './planner.ts';

let submitCallId = 0;

// Structured output now flows through the `submit` tool, so the mock model "delivers" the plan by
// emitting a submit tool-call (input is a JSON string, per the provider spec) instead of text.
function planSubmitModel(value: unknown): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [
        {
          type: 'tool-call',
          toolCallId: `submit-${submitCallId++}`,
          toolName: 'submit',
          input: JSON.stringify(value),
        },
      ],
      finishReason: { unified: 'tool-calls', raw: undefined },
      usage: emptyUsage(),
      warnings: [],
    }),
  });
}

function planJsonModel(plan: Plan): MockLanguageModelV3 {
  return planSubmitModel(plan);
}

function emptyUsage() {
  return {
    inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 1, text: 1, reasoning: undefined },
    totalTokens: 2,
  };
}

function basicPlan(groupCount: number): Plan {
  const groups = Array.from({ length: groupCount }, (_, i) => ({
    id: `g${i + 1}`,
    title: `Group ${i + 1}`,
    tasks: [{ description: `task ${i + 1}` }],
    dependsOn: i === 0 ? [] : [`g${i}`],
  }));
  return { goal: 'do the thing', groups };
}

test('PLANNER_SYSTEM_PREFIX names the read tools including explore, gated on availability (issue #126)', () => {
  assert.match(PLANNER_SYSTEM_PREFIX, /`explore` when present/);
  assert.match(PLANNER_SYSTEM_PREFIX, /glob\/grep\/readFile/);
});

test('PLANNER_SYSTEM_PREFIX is non-empty and mentions maxPrs + the PR-group DAG', () => {
  assert.match(PLANNER_SYSTEM_PREFIX, /maxPrs/);
  assert.match(PLANNER_SYSTEM_PREFIX, /DAG of PR groups/);
  // §2c additions: file:line hints under each task and the `step → verify` acceptance check.
  assert.match(PLANNER_SYSTEM_PREFIX, /file:line when known/);
  assert.match(PLANNER_SYSTEM_PREFIX, /step → verify/);
});

test('createPlannerAgent builds an agent with the injected tools plus a submit tool', () => {
  const model = new MockLanguageModelV3();
  const agent = createPlannerAgent({ model, tools: {}, systemPrompt: 'style' });
  assert.ok(agent);
  // The factory adds the terminal `submit` tool the agent calls to deliver its Plan.
  assert.deepEqual(Object.keys(agent.tools), ['submit']);
});

test('runPlanner returns ok with a valid Plan when the model produces one', async () => {
  const plan = basicPlan(3);
  const agent = createPlannerAgent({
    model: planJsonModel(plan),
    tools: {},
    systemPrompt: PLANNER_SYSTEM_PREFIX,
  });
  const result = await runPlanner(agent, {
    goal: plan.goal,
    styleContents: '',
    maxPrs: 5,
  });
  if (result.kind !== 'ok') {
    throw new Error(`expected ok, got ${result.kind}: ${JSON.stringify(result)}`);
  }
  assert.equal(result.plan.groups.length, 3);
  assert.equal(result.plan.groups[0]?.id, 'g1');
});

test('runPlanner caps groups to maxPrs and folds overflow into a remainder task', async () => {
  const plan = basicPlan(7);
  const agent = createPlannerAgent({
    model: planJsonModel(plan),
    tools: {},
    systemPrompt: PLANNER_SYSTEM_PREFIX,
  });
  const result = await runPlanner(agent, {
    goal: plan.goal,
    styleContents: '',
    maxPrs: 3,
  });
  assert.equal(result.kind, 'ok');
  if (result.kind === 'ok') {
    assert.equal(result.plan.groups.length, 3);
    const last = result.plan.groups[2];
    assert.ok(last);
    // last kept group is g3, gains a remainder task summarizing g4..g7.
    assert.equal(last.id, 'g3');
    assert.equal(last.tasks.length, 2);
    const remainder = last.tasks[1];
    assert.ok(remainder);
    assert.match(remainder.description, /^remainder:/);
    assert.match(remainder.description, /g4/);
    assert.match(remainder.description, /g7/);
  }
});

test('runPlanner returns blocked when the model emits an empty plan', async () => {
  const empty: Plan = { goal: 'x', groups: [] };
  const agent = createPlannerAgent({
    model: planJsonModel(empty),
    tools: {},
    systemPrompt: PLANNER_SYSTEM_PREFIX,
  });
  const result = await runPlanner(agent, { goal: 'x', styleContents: '', maxPrs: 5 });
  assert.equal(result.kind, 'blocked');
});

test('runPlanner: prepends the contextBlock to the first user message, ahead of the task text (issue #106)', async () => {
  let sent = '';
  const model = new MockLanguageModelV3({
    doGenerate: async (opts) => {
      sent = JSON.stringify(opts.prompt);
      return {
        content: [
          {
            type: 'tool-call',
            toolCallId: 'submit-ctx',
            toolName: 'submit',
            input: JSON.stringify(basicPlan(1)),
          },
        ],
        finishReason: { unified: 'tool-calls', raw: undefined },
        usage: emptyUsage(),
        warnings: [],
      };
    },
  });
  const agent = createPlannerAgent({ model, tools: {}, systemPrompt: PLANNER_SYSTEM_PREFIX });
  const result = await runPlanner(agent, {
    goal: 'ship it',
    styleContents: '',
    maxPrs: 5,
    contextBlock: '<system-reminder>\nCTX-BLOCK\n</system-reminder>',
  });
  assert.equal(result.kind, 'ok');
  assert.match(sent, /CTX-BLOCK/, 'the context block reached the first user message');
  assert.ok(
    sent.indexOf('CTX-BLOCK') < sent.indexOf('ship it'),
    'the context block leads, ahead of the task text',
  );
});

test('createPlannerAgent forwards timeout → a stalled step surfaces as a deadline-named error (issue #129)', async () => {
  const stalling = new MockLanguageModelV3({
    doGenerate: (opts) =>
      new Promise((_resolve, reject) => {
        opts.abortSignal?.addEventListener('abort', () =>
          reject(new DOMException('This operation was aborted', 'AbortError')),
        );
      }),
  });
  const agent = createPlannerAgent({
    model: stalling,
    tools: {},
    systemPrompt: PLANNER_SYSTEM_PREFIX,
    timeout: { stepMs: 40 },
  });
  const result = await runPlanner(agent, { goal: 'x', styleContents: '', maxPrs: 5 });
  assert.equal(result.kind, 'error');
  if (result.kind === 'error') assert.match(result.error, /exceeded the configured deadline/);
});

test('runPlanner: never-submits → blocked after retries, with a no-submission reason (issue #101)', async () => {
  // Text-only on every attempt (no submit tool-call) → the retry kernel exhausts → blocked, with a
  // reason distinct from the schema-invalid case.
  const model = new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: 'text', text: 'I could not produce a plan.' }],
      finishReason: { unified: 'stop', raw: undefined },
      usage: emptyUsage(),
      warnings: [],
    }),
  });
  const agent = createPlannerAgent({ model, tools: {}, systemPrompt: PLANNER_SYSTEM_PREFIX });
  const result = await runPlanner(agent, { goal: 'x', styleContents: '', maxPrs: 5 });
  assert.equal(result.kind, 'blocked');
  if (result.kind === 'blocked')
    assert.match(result.reason, /did not submit a plan after retries/i);
});

test('runPlanner: persistently schema-invalid submit → error after retries, naming schema validation (issue #101)', async () => {
  // submit called with args that don't match PlanSchema (missing groups) on every attempt → the
  // retry kernel exhausts → error, distinguished from the no-submission case.
  const agent = createPlannerAgent({
    model: planSubmitModel({ goal: 'x' }),
    tools: {},
    systemPrompt: PLANNER_SYSTEM_PREFIX,
  });
  const result = await runPlanner(agent, { goal: 'x', styleContents: '', maxPrs: 5 });
  assert.equal(result.kind, 'error');
  if (result.kind === 'error') assert.match(result.error, /schema validation after retries/i);
});

test('runPlanner rejects maxPrs < 1 up front', async () => {
  const agent = createPlannerAgent({
    model: new MockLanguageModelV3(),
    tools: {},
    systemPrompt: PLANNER_SYSTEM_PREFIX,
  });
  const result = await runPlanner(agent, { goal: 'x', styleContents: '', maxPrs: 0 });
  assert.equal(result.kind, 'error');
});

test('runPlanner rejects non-integer maxPrs', async () => {
  const agent = createPlannerAgent({
    model: new MockLanguageModelV3(),
    tools: {},
    systemPrompt: PLANNER_SYSTEM_PREFIX,
  });
  const result = await runPlanner(agent, { goal: 'x', styleContents: '', maxPrs: 2.5 });
  assert.equal(result.kind, 'error');
  if (result.kind === 'error') {
    assert.match(result.error, /positive integer/);
  }
});

test('runPlanner rejects NaN maxPrs', async () => {
  const agent = createPlannerAgent({
    model: new MockLanguageModelV3(),
    tools: {},
    systemPrompt: PLANNER_SYSTEM_PREFIX,
  });
  const result = await runPlanner(agent, { goal: 'x', styleContents: '', maxPrs: Number.NaN });
  assert.equal(result.kind, 'error');
});
