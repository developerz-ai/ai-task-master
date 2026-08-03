import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MockLanguageModelV3 } from 'ai/test';
import type { Plan } from '../plan/schema.ts';
import { emptyUsage } from '../testing/model-fixtures.ts';
import { stallingModel } from '../testing/stalling-model.ts';
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

function basicPlan(groupCount: number): Plan {
  const groups = Array.from({ length: groupCount }, (_, i) => ({
    id: `g${i + 1}`,
    title: `Group ${i + 1}`,
    tasks: [{ description: `task ${i + 1}` }],
    acceptance: `group ${i + 1} check: bun test passes`,
    dependsOn: i === 0 ? [] : [`g${i}`],
  }));
  return { goal: 'do the thing', groups };
}

async function capPlan(plan: Plan, maxPrs: number): Promise<Plan> {
  const agent = createPlannerAgent({
    model: planJsonModel(plan),
    tools: {},
    systemPrompt: PLANNER_SYSTEM_PREFIX,
  });
  const result = await runPlanner(agent, { goal: plan.goal, styleContents: '', maxPrs });
  if (result.kind !== 'ok') throw new Error(`expected ok, got ${result.kind}`);
  return result.plan;
}

function depsOf(plan: Plan, id: string): string[] {
  const group = plan.groups.find((g) => g.id === id);
  assert.ok(group, `group ${id} present`);
  return group.dependsOn;
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

test('runPlanner asks the planner to regroup when it exceeds the cap, then errors if it will not', async () => {
  // The cap is a schema refinement, so an over-cap plan takes runWithSchemaRetry's corrective path —
  // the planner is told to regroup. Truncating instead is what shipped a fraction of the goal.
  let attempts = 0;
  const model = new MockLanguageModelV3({
    doGenerate: async () => {
      attempts += 1;
      return {
        content: [
          {
            type: 'tool-call',
            toolCallId: `submit-over-${attempts}`,
            toolName: 'submit',
            input: JSON.stringify(basicPlan(7)),
          },
        ],
        finishReason: { unified: 'tool-calls', raw: undefined },
        usage: emptyUsage(),
        warnings: [],
      };
    },
  });
  const agent = createPlannerAgent({ model, tools: {}, systemPrompt: PLANNER_SYSTEM_PREFIX });
  const result = await runPlanner(agent, { goal: 'x', styleContents: '', maxPrs: 3 });
  assert.ok(
    attempts > 1,
    'the planner was asked to regroup rather than failed on first submission',
  );
  assert.equal(result.kind, 'error');
  if (result.kind === 'error') {
    assert.match(result.error, /at most 3/);
    assert.match(result.error, /never drop the tail/);
  }
});

test('runPlanner accepts a regrouped plan on retry', async () => {
  // First submission blows the cap, second fits — the run proceeds instead of dying on the first.
  let attempts = 0;
  const model = new MockLanguageModelV3({
    doGenerate: async () => {
      attempts += 1;
      return {
        content: [
          {
            type: 'tool-call',
            toolCallId: `submit-regroup-${attempts}`,
            toolName: 'submit',
            input: JSON.stringify(attempts === 1 ? basicPlan(7) : basicPlan(3)),
          },
        ],
        finishReason: { unified: 'tool-calls', raw: undefined },
        usage: emptyUsage(),
        warnings: [],
      };
    },
  });
  const agent = createPlannerAgent({ model, tools: {}, systemPrompt: PLANNER_SYSTEM_PREFIX });
  const result = await runPlanner(agent, { goal: 'x', styleContents: '', maxPrs: 3 });
  if (result.kind !== 'ok') throw new Error(`expected ok, got ${result.kind}`);
  assert.equal(result.plan.groups.length, 3);
  assert.equal(attempts, 2, 'exactly one corrective round');
});

test('runPlanner accepts a plan exactly at the cap', async () => {
  const capped = await capPlan(basicPlan(3), 3);
  assert.equal(capped.groups.length, 3);
});

test('runPlanner leaves a large plan intact when maxPrs is null (unbounded)', async () => {
  // The default. "Implement the whole system" must be able to plan the whole system.
  const plan = basicPlan(14);
  const agent = createPlannerAgent({
    model: planJsonModel(plan),
    tools: {},
    systemPrompt: PLANNER_SYSTEM_PREFIX,
  });
  const result = await runPlanner(agent, { goal: plan.goal, styleContents: '', maxPrs: null });
  if (result.kind !== 'ok') throw new Error(`expected ok, got ${result.kind}`);
  assert.equal(
    result.plan.groups.length,
    14,
    'every group survives — nothing is dropped or folded',
  );
  assert.deepEqual(depsOf(result.plan, 'g14'), ['g13'], 'deps are untouched, not remapped');
});

test('runPlanner omits the maxPrs line from the prompt when unbounded, and includes it when capped', async () => {
  // The user message only: the system prose legitimately mentions `maxPrs:` when explaining that a
  // cap appears there when set, so scanning the whole prompt would never distinguish the two cases.
  const capture = async (maxPrs: number | null): Promise<string> => {
    let sent = '';
    const model = new MockLanguageModelV3({
      doGenerate: async (opts) => {
        sent = JSON.stringify(opts.prompt.filter((m) => m.role === 'user'));
        return {
          content: [
            {
              type: 'tool-call',
              toolCallId: 'submit-cap',
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
    await runPlanner(agent, { goal: 'ship it', styleContents: '', maxPrs });
    return sent;
  };
  // Handing the Planner a PR budget it never asked for is what made it plan to the budget instead
  // of to the goal, so with no cap the prompt must not mention one at all.
  assert.doesNotMatch(await capture(null), /maxPrs/);
  assert.match(await capture(4), /maxPrs: 4/);
});

test('runPlanner returns error when the model emits an empty plan (schema validation fails)', async () => {
  const empty: Plan = { goal: 'x', groups: [] };
  const agent = createPlannerAgent({
    model: planJsonModel(empty),
    tools: {},
    systemPrompt: PLANNER_SYSTEM_PREFIX,
  });
  const result = await runPlanner(agent, { goal: 'x', styleContents: '', maxPrs: 5 });
  assert.equal(result.kind, 'error');
  assert.match(result.kind === 'error' ? result.error : '', /schema validation|min/i);
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

test('runPlanner: injects the survey brief as a starting map, ahead of "confirm and fill gaps"', async () => {
  let sent = '';
  const model = new MockLanguageModelV3({
    doGenerate: async (opts) => {
      sent = JSON.stringify(opts.prompt);
      return {
        content: [
          {
            type: 'tool-call',
            toolCallId: 'submit-brief',
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
    surveyBrief: 'Repo survey (gathered in parallel)\n## architecture\nMONOREPO-FACT',
  });
  assert.equal(result.kind, 'ok');
  assert.match(sent, /MONOREPO-FACT/, 'the scout brief reached the planner prompt');
  assert.match(sent, /starting map/, 'the brief is framed as a starting map');
  // Without a brief the plain "survey the repo yourself" instruction is used instead.
  let plain = '';
  const model2 = new MockLanguageModelV3({
    doGenerate: async (opts) => {
      plain = JSON.stringify(opts.prompt);
      return {
        content: [
          {
            type: 'tool-call',
            toolCallId: 's',
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
  const agent2 = createPlannerAgent({
    model: model2,
    tools: {},
    systemPrompt: PLANNER_SYSTEM_PREFIX,
  });
  await runPlanner(agent2, { goal: 'ship it', styleContents: '', maxPrs: 5 });
  assert.match(plain, /Survey the repo with the read-only tools/);
  assert.doesNotMatch(plain, /starting map/);
});

test('runPlanner: appends the progressBlock to the END of the first user message, after the task text (slice 04 §4)', async () => {
  let sent = '';
  const model = new MockLanguageModelV3({
    doGenerate: async (opts) => {
      sent = JSON.stringify(opts.prompt);
      return {
        content: [
          {
            type: 'tool-call',
            toolCallId: 'submit-prog',
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
    contextBlock: '<system-reminder>\nCTX-LEAD\n</system-reminder>',
    progressBlock: '<system-reminder>\nPROG-TAIL\n</system-reminder>',
  });
  assert.equal(result.kind, 'ok');
  assert.match(sent, /PROG-TAIL/, 'the progress block reached the first user message');
  // Lead first, task text in the middle, progress last — the volatile bit trails the cacheable prefix.
  assert.ok(
    sent.indexOf('CTX-LEAD') < sent.indexOf('ship it'),
    'the leading context block precedes the task text',
  );
  assert.ok(
    sent.indexOf('ship it') < sent.indexOf('PROG-TAIL'),
    'the progress block trails the task text (out of the cacheable prefix)',
  );
});

test('createPlannerAgent forwards timeout → a stalled step surfaces as a deadline-named error (issue #129)', async () => {
  const stalling = stallingModel();
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

test('runPlanner: a plan whose group omits the acceptance check is rejected after retries', async () => {
  // The check is what the Worker builds against and the self-review judges — a plan without one is
  // not accepted silently, it routes to the schema-retry loop and, unfixed, fails as invalid.
  const agent = createPlannerAgent({
    model: planSubmitModel({
      goal: 'x',
      groups: [{ id: 'g1', title: 'Group g1', tasks: [{ description: 'task g1' }], dependsOn: [] }],
    }),
    tools: {},
    systemPrompt: PLANNER_SYSTEM_PREFIX,
  });
  const result = await runPlanner(agent, { goal: 'x', styleContents: '', maxPrs: 5 });
  assert.equal(result.kind, 'error');
  if (result.kind === 'error') assert.match(result.error, /acceptance/i);
});

test('runPlanner: the accepted plan keeps every group acceptance check', async () => {
  const agent = createPlannerAgent({
    model: planJsonModel(basicPlan(2)),
    tools: {},
    systemPrompt: PLANNER_SYSTEM_PREFIX,
  });
  const result = await runPlanner(agent, { goal: 'x', styleContents: '', maxPrs: 5 });
  assert.equal(result.kind, 'ok');
  if (result.kind === 'ok') {
    assert.deepEqual(
      result.plan.groups.map((g) => g.acceptance),
      ['group 1 check: bun test passes', 'group 2 check: bun test passes'],
    );
  }
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

test('createPlannerAgent forwards the run signal → an abort cancels the in-flight plan generation', async () => {
  // The Planner runs through the schema-retry kernel, which owns its generations — only the agent's
  // own signal can reach them, so a Ctrl-C aborts the leg instead of waiting the provider out.
  const stalling = stallingModel();
  const controller = new AbortController();
  const agent = createPlannerAgent({
    model: stalling,
    tools: {},
    systemPrompt: PLANNER_SYSTEM_PREFIX,
    signal: controller.signal,
    // Safety net: an unwired signal must fail the test rather than hang it forever.
    timeout: { stepMs: 2_000 },
  });
  setTimeout(() => controller.abort(), 5);
  const result = await runPlanner(agent, { goal: 'x', styleContents: '', maxPrs: 5 });
  assert.equal(result.kind, 'error');
  if (result.kind === 'error') {
    assert.match(result.error, /abort/i);
    assert.doesNotMatch(result.error, /deadline/, 'a cancel is never a deadline breach');
  }
});
