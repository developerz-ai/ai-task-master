import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MockLanguageModelV3 } from 'ai/test';
import { plannerTools } from '../testing/subagent-tools.ts';
import {
  SCOUT_MAX_ASSIGNMENTS,
  type ScoutAssignment,
  type ScoutFinding,
  type ScoutResult,
} from './planner-scouts.ts';
import {
  buildGapPrompt,
  buildLeadPrompt,
  createScoutLeadRunner,
  SCOUT_LEAD_SYSTEM_PREFIX,
  ScoutPlanSchema,
} from './scout-lead.ts';

const finding = (s: string): ScoutFinding => ({
  summary: `${s} summary`,
  facts: [`${s} fact`],
  relevantPaths: [`src/${s}.ts`],
  openQuestions: [`${s} unknown`],
});

const result = (key: string): ScoutResult => ({
  assignment: {
    key,
    question: `what about ${key}?`,
    subQuestions: [],
    startPaths: [],
    mustRead: [],
    searchTerms: [],
  },
  finding: finding(key),
});

// A lead model that submits whatever plan the caller hands it, and records the prompt it saw.
function leadModel(plan: unknown): { model: MockLanguageModelV3; prompt: () => string } {
  let seen = '';
  const model = new MockLanguageModelV3({
    doGenerate: async (opts) => {
      seen = JSON.stringify(opts.prompt);
      return {
        content: [
          {
            type: 'tool-call' as const,
            toolCallId: 'submit-1',
            toolName: 'submit',
            input: JSON.stringify(plan),
          },
        ],
        finishReason: { unified: 'tool-calls' as const, raw: undefined },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 1, text: 1, reasoning: undefined },
          totalTokens: 2,
        },
        warnings: [],
      };
    },
  });
  return { model, prompt: () => seen };
}

test('buildLeadPrompt: asks for a repo-sized wave and a real briefing per scout', () => {
  const prompt = buildLeadPrompt({
    goal: 'add sessions',
    criteria: 'tests pass',
    repoMap: 'Repo map — 416 tracked file(s)',
  });
  assert.match(prompt, /add sessions/);
  assert.match(prompt, /tests pass/);
  assert.match(prompt, /Repo map — 416 tracked file\(s\)/);
  assert.match(prompt, new RegExp(`up to ${SCOUT_MAX_ASSIGNMENTS} scouts`));
  assert.match(prompt, /is ONE scout — that is a good answer/, 'a solo wave is a valid answer');
  assert.match(prompt, /TOO BIG/, 'the lead sizes each assignment before sending it');
  assert.match(prompt, /TOO SMALL/);
  for (const field of ['subQuestions', 'startPaths', 'mustRead', 'searchTerms']) {
    assert.match(prompt, new RegExp(field), `the lead is told to fill ${field}`);
  }
  assert.match(prompt, /starting point, never a limit/, 'scouts keep their own judgment');
});

test('buildGapPrompt: shows the findings and biases toward stopping', () => {
  const prompt = buildGapPrompt({ goal: 'add sessions' }, [result('auth'), result('db')]);
  assert.match(prompt, /## auth/, 'the lead reads its own team’s brief');
  assert.match(prompt, /auth unknown/, 'unsettled questions are what a follow-up aims at');
  assert.match(prompt, /## db/);
  assert.match(prompt, /submit an EMPTY\n?assignments list/);
  assert.match(prompt, /Never re-send a scout over ground already/);
});

test('createScoutLeadRunner: returns the dispatch wave the model submitted', async () => {
  const { model, prompt } = leadModel({
    assignments: [
      { key: 'routing', question: 'how does routing work?', mustRead: ['src/router.ts'] },
      { key: 'auth', question: 'how does auth work?' },
    ],
    rationale: 'two areas the goal touches',
  });
  const lead = createScoutLeadRunner({
    model,
    tools: plannerTools(),
    systemPrompt: SCOUT_LEAD_SYSTEM_PREFIX,
  });
  const wave = await lead({ goal: 'g', repoMap: 'Repo map — 5 tracked file(s)' }, []);
  assert.deepEqual(
    wave.map((a) => a.key),
    ['routing', 'auth'],
  );
  assert.deepEqual(wave[0]?.mustRead, ['src/router.ts']);
  assert.deepEqual(
    wave[1]?.mustRead,
    [],
    'omitted briefing fields default to empty, not undefined',
  );
  assert.match(
    prompt(),
    /Dispatch the survey wave/,
    'an empty prior round uses the dispatch prompt',
  );
});

test('createScoutLeadRunner: a prior round switches it to the gap prompt', async () => {
  const { model, prompt } = leadModel({ assignments: [], rationale: 'map is complete' });
  const lead = createScoutLeadRunner({
    model,
    tools: plannerTools(),
    systemPrompt: SCOUT_LEAD_SYSTEM_PREFIX,
  });
  assert.deepEqual(await lead({ goal: 'g' }, [result('auth')]), []);
  assert.match(prompt(), /aimed ONLY at/, 'the follow-up round asks only about gaps');
});

test('createScoutLeadRunner: duplicate or blank keys collapse to one usable wave', async () => {
  const { model } = leadModel({
    assignments: [
      { key: 'auth', question: 'first' },
      { key: '  ', question: 'nameless' },
      { key: 'auth', question: 'duplicate' },
    ],
  });
  const lead = createScoutLeadRunner({
    model,
    tools: plannerTools(),
    systemPrompt: SCOUT_LEAD_SYSTEM_PREFIX,
  });
  const wave = await lead({ goal: 'g' }, []);
  assert.deepEqual(
    wave.map((a) => a.question),
    ['first'],
    'two scouts under one heading would merge into one brief section',
  );
});

test('createScoutLeadRunner: an unusable submission yields an empty wave, never a throw', async () => {
  // The survey must degrade to the fallback assignments, not take the run down with it.
  const model = new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: 'text' as const, text: 'I think you should look at the auth code.' }],
      finishReason: { unified: 'stop' as const, raw: undefined },
      usage: {
        inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 1, text: 1, reasoning: undefined },
        totalTokens: 2,
      },
      warnings: [],
    }),
  });
  const lead = createScoutLeadRunner({
    model,
    tools: plannerTools(),
    systemPrompt: SCOUT_LEAD_SYSTEM_PREFIX,
  });
  assert.deepEqual(await lead({ goal: 'g' }, []), []);
});

test('ScoutPlanSchema: caps a runaway wave at the assignment ceiling', () => {
  const assignments: ScoutAssignment[] = Array.from(
    { length: SCOUT_MAX_ASSIGNMENTS + 1 },
    (_, i) => ({
      key: `a${i}`,
      question: `q${i}`,
      subQuestions: [],
      startPaths: [],
      mustRead: [],
      searchTerms: [],
    }),
  );
  assert.equal(ScoutPlanSchema.safeParse({ assignments }).success, false);
  assert.equal(
    ScoutPlanSchema.safeParse({ assignments: assignments.slice(0, SCOUT_MAX_ASSIGNMENTS) }).success,
    true,
  );
  // An omitted list is a valid "no scouting needed" answer, not a validation failure.
  assert.deepEqual(ScoutPlanSchema.parse({}).assignments, []);
});
