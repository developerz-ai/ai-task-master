import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ScoutAssignment, ScoutFinding, ScoutRunner } from './planner-scouts.ts';
import type { ScoutLeadRunner } from './scout-lead.ts';
import { runScoutSurvey, SCOUT_MAX_ROUNDS, type ScoutSurveyEvent } from './scout-survey.ts';

const assignment = (key: string): ScoutAssignment => ({
  key,
  question: `what about ${key}?`,
  subQuestions: [],
  startPaths: [],
  mustRead: [],
  searchTerms: [],
});

const finding = (key: string): ScoutFinding => ({
  summary: `${key} summary`,
  facts: [`${key} fact`],
  relevantPaths: [],
  openQuestions: [],
});

// A lead that hands back one scripted wave per round, so a test states the whole survey up front.
const scriptedLead = (waves: ScoutAssignment[][]): ScoutLeadRunner => {
  let round = 0;
  return async () => waves[round++] ?? [];
};

const reportingScout: ScoutRunner = async (a) => finding(a.key);

test('runScoutSurvey: dispatch round then a gap round, keeping both waves', async () => {
  const events: ScoutSurveyEvent[] = [];
  const results = await runScoutSurvey({
    ctx: { goal: 'g' },
    lead: scriptedLead([[assignment('auth'), assignment('db')], [assignment('migrations')]]),
    runScout: reportingScout,
    onProgress: (e) => events.push(e),
  });
  assert.deepEqual(
    results.map((r) => r.assignment.key),
    ['auth', 'db', 'migrations'],
    'the follow-up wave joins the findings the first round produced',
  );
  assert.deepEqual(
    events.filter((e) => e.kind === 'dispatch').map((e) => e.round),
    [1, 2],
  );
  assert.deepEqual(events.at(-1), { kind: 'complete', rounds: 2, findings: 3 });
});

test('runScoutSurvey: an empty follow-up is the lead saying the map is complete', async () => {
  const events: ScoutSurveyEvent[] = [];
  const results = await runScoutSurvey({
    ctx: { goal: 'g' },
    lead: scriptedLead([[assignment('auth')], []]),
    runScout: reportingScout,
    onProgress: (e) => events.push(e),
  });
  assert.equal(results.length, 1);
  assert.equal(events.filter((e) => e.kind === 'dispatch').length, 1, 'no second wave is sent');
});

test('runScoutSurvey: a dead lead means no survey — never a repo-blind fixed wave', async () => {
  // The fixed lens set the lead replaced is GONE, not kept as a fallback: reviving the discarded
  // design on a failure path puts untested, repo-blind behaviour back into production runs. The
  // Planner already has its own read-only tools and the deterministic repo map.
  let scouts = 0;
  const results = await runScoutSurvey({
    ctx: { goal: 'g' },
    lead: async () => {
      throw new Error('lead died');
    },
    runScout: async (a) => {
      scouts += 1;
      return finding(a.key);
    },
  });
  assert.deepEqual(results, []);
  assert.equal(scouts, 0, 'no scout is dispatched without a lead that asked for one');
});

test('runScoutSurvey: a re-sent assignment is dropped, so a looping lead cannot double-survey', async () => {
  const surveyed: string[] = [];
  const results = await runScoutSurvey({
    ctx: { goal: 'g' },
    lead: scriptedLead([[assignment('auth')], [assignment('auth'), assignment('db')]]),
    runScout: async (a) => {
      surveyed.push(a.key);
      return finding(a.key);
    },
  });
  assert.deepEqual(surveyed, ['auth', 'db'], 'auth is surveyed once across the whole survey');
  assert.equal(results.length, 2);
});

test('runScoutSurvey: a first wave where nothing reports back stops instead of re-deciding blind', async () => {
  let leadCalls = 0;
  const results = await runScoutSurvey({
    ctx: { goal: 'g' },
    lead: async () => {
      leadCalls += 1;
      return [assignment(`round-${leadCalls}`)];
    },
    runScout: async () => null,
  });
  assert.deepEqual(results, []);
  assert.equal(leadCalls, 1, 'the gap round would read an empty report and repeat the dead wave');
});

test('runScoutSurvey: rounds are bounded even against a lead that always wants more', async () => {
  let round = 0;
  const results = await runScoutSurvey({
    ctx: { goal: 'g' },
    lead: async () => [assignment(`round-${++round}`)],
    runScout: reportingScout,
  });
  assert.equal(results.length, SCOUT_MAX_ROUNDS);
});

test('runScoutSurvey: a wave that throws wholesale still returns what the survey has', async () => {
  const results = await runScoutSurvey({
    ctx: { goal: 'g' },
    lead: scriptedLead([[assignment('auth')], [assignment('db')]]),
    runScout: async (a) => {
      if (a.key === 'db') throw new Error('provider down');
      return finding(a.key);
    },
  });
  assert.deepEqual(
    results.map((r) => r.assignment.key),
    ['auth'],
    'the survey accelerates planning; it can never fail it',
  );
});
