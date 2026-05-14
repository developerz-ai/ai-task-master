import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MockLanguageModelV3 } from 'ai/test';
import type { Plan } from '../plan/schema.ts';
import { createPlannerAgent, PLANNER_SYSTEM_PREFIX, runPlanner } from './planner.ts';

function planJsonModel(plan: Plan): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: 'text', text: JSON.stringify(plan) }],
      finishReason: { unified: 'stop', raw: undefined },
      usage: emptyUsage(),
      warnings: [],
    }),
  });
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

test('PLANNER_SYSTEM_PREFIX is non-empty and mentions maxPrs + Plan', () => {
  assert.match(PLANNER_SYSTEM_PREFIX, /maxPrs/);
  assert.match(PLANNER_SYSTEM_PREFIX, /Plan/);
});

test('createPlannerAgent builds an agent that exposes injected tools', () => {
  const model = new MockLanguageModelV3();
  const agent = createPlannerAgent({ model, tools: {}, systemPrompt: 'style' });
  assert.ok(agent);
  assert.deepEqual(agent.tools, {});
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

test('runPlanner returns error when the model emits invalid JSON', async () => {
  const model = new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: 'text', text: 'not json at all' }],
      finishReason: { unified: 'stop', raw: undefined },
      usage: emptyUsage(),
      warnings: [],
    }),
  });
  const agent = createPlannerAgent({ model, tools: {}, systemPrompt: PLANNER_SYSTEM_PREFIX });
  const result = await runPlanner(agent, { goal: 'x', styleContents: '', maxPrs: 5 });
  assert.equal(result.kind, 'error');
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
