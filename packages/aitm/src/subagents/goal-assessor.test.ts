// Unit coverage for goal-assessor.ts: the verdict that decides whether a run plans another wave.
// Every degraded path here must resolve to `complete: true` — an assessor that fails open would plan
// work off no evidence and spend the operator's money on a guess.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MockLanguageModelV3 } from 'ai/test';
import { emptyUsage } from '../testing/model-fixtures.ts';
import { stallingModel } from '../testing/stalling-model.ts';
import { plannerTools } from '../testing/subagent-tools.ts';
import {
  createGoalAssessorAgent,
  GOAL_ASSESSOR_SYSTEM_PREFIX,
  runGoalAssessor,
} from './goal-assessor.ts';

let callId = 0;

function verdictModel(value: unknown, capture?: (prompt: string) => void): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doGenerate: async (opts) => {
      capture?.(JSON.stringify(opts.prompt));
      return {
        content: [
          {
            type: 'tool-call',
            toolCallId: `submit-${callId++}`,
            toolName: 'submit',
            input: JSON.stringify(value),
          },
        ],
        finishReason: { unified: 'tool-calls', raw: undefined },
        usage: emptyUsage(),
        warnings: [],
      };
    },
  });
}

function agentFor(model: MockLanguageModelV3) {
  return createGoalAssessorAgent({
    model,
    tools: plannerTools(),
    systemPrompt: GOAL_ASSESSOR_SYSTEM_PREFIX,
  });
}

test('GOAL_ASSESSOR_SYSTEM_PREFIX judges against the goal, not the plan', () => {
  assert.match(GOAL_ASSESSOR_SYSTEM_PREFIX, /never against the plan/);
  assert.match(GOAL_ASSESSOR_SYSTEM_PREFIX, /Unsure → `complete: true`/);
  // Scope creep is the failure mode that makes a wave loop never terminate.
  assert.match(GOAL_ASSESSOR_SYSTEM_PREFIX, /NEVER remaining work/);
});

test('runGoalAssessor returns a complete verdict unchanged', async () => {
  const result = await runGoalAssessor(
    agentFor(verdictModel({ complete: true, rationale: 'all shipped' })),
    {
      goal: 'add a todo API',
      delivered: ['g1: Todo CRUD API (PR #1, merged)'],
    },
  );
  assert.equal(result.complete, true);
});

test('runGoalAssessor returns remaining work a planner can plan from', async () => {
  const result = await runGoalAssessor(
    agentFor(
      verdictModel({ complete: false, remaining: 'implement the web client', rationale: 'no ui' }),
    ),
    { goal: 'build the whole app', delivered: ['g1: API (PR #1, merged)'] },
  );
  assert.equal(result.complete, false);
  assert.equal(result.remaining, 'implement the web client');
});

test('runGoalAssessor treats an incomplete verdict naming no work as complete', async () => {
  // Otherwise the caller would hand the Planner an empty goal and plan a wave out of nothing.
  const result = await runGoalAssessor(
    agentFor(verdictModel({ complete: false, remaining: '   ', rationale: 'vibes' })),
    { goal: 'g', delivered: [] },
  );
  assert.equal(result.complete, true);
  assert.match(result.rationale, /no remaining work named/);
});

test('runGoalAssessor reports complete when the model never submits', async () => {
  const result = await runGoalAssessor(agentFor(verdictModel({ nope: true })), {
    goal: 'g',
    delivered: [],
  });
  assert.equal(result.complete, true, 'a broken assessor stops the run, it does not extend it');
});

test('runGoalAssessor reports complete when the model call throws', async () => {
  // A stalled provider hits the step deadline, which surfaces as a throw out of the agent call.
  const agent = createGoalAssessorAgent({
    model: stallingModel(),
    tools: plannerTools(),
    systemPrompt: GOAL_ASSESSOR_SYSTEM_PREFIX,
    timeout: { stepMs: 40 },
  });
  const result = await runGoalAssessor(agent, { goal: 'g', delivered: [], criteria: 'c' });
  assert.equal(result.complete, true);
});

test('runGoalAssessor prompt carries the goal, criteria, and what already landed', async () => {
  let sent = '';
  await runGoalAssessor(agentFor(verdictModel({ complete: true }, (p) => (sent = p))), {
    goal: 'build the whole app',
    criteria: 'every endpoint has a test',
    delivered: ['g1: Rust sync engine (PR #1, merged)'],
  });
  assert.match(sent, /build the whole app/);
  assert.match(sent, /every endpoint has a test/);
  assert.match(sent, /Rust sync engine/);
});

test('runGoalAssessor prompt says so explicitly when nothing has landed', async () => {
  let sent = '';
  await runGoalAssessor(agentFor(verdictModel({ complete: true }, (p) => (sent = p))), {
    goal: 'g',
    delivered: [],
  });
  assert.match(sent, /nothing yet/);
});
