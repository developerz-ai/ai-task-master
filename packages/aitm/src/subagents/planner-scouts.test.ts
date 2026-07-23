import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildScoutPrompt,
  SCOUT_LENSES,
  SCOUT_REPO_FILE_FLOOR,
  type ScoutFinding,
  type ScoutLens,
  type ScoutRunner,
  shouldSurveyInParallel,
  surveyRepoInParallel,
  synthesizeSurveyBrief,
} from './planner-scouts.ts';

const lens = (key: string): ScoutLens => ({ key, focus: `answer about ${key}` });

test('shouldSurveyInParallel: gates on the file floor, with an explicit override winning', () => {
  assert.equal(shouldSurveyInParallel(SCOUT_REPO_FILE_FLOOR - 1), false);
  assert.equal(shouldSurveyInParallel(SCOUT_REPO_FILE_FLOOR), true);
  assert.equal(shouldSurveyInParallel(10_000), true);
  // Override beats the heuristic in both directions.
  assert.equal(shouldSurveyInParallel(1, true), true);
  assert.equal(shouldSurveyInParallel(10_000, false), false);
});

test('buildScoutPrompt: names the goal and scopes the survey to this lens only', () => {
  const prompt = buildScoutPrompt(lens('domain-and-data'), {
    goal: 'add user sessions',
    criteria: 'tests pass',
  });
  assert.match(prompt, /add user sessions/);
  assert.match(prompt, /tests pass/);
  assert.match(prompt, /answer about domain-and-data/);
  assert.match(prompt, /THIS lens only/);
  assert.match(prompt, /call submit/i);
});

test('surveyRepoInParallel: runs every lens and collects the findings', async () => {
  const seen: string[] = [];
  const runScout: ScoutRunner = async (l) => {
    seen.push(l.key);
    return { summary: `summary for ${l.key}`, facts: [`fact ${l.key}`], relevantPaths: [] };
  };
  const results = await surveyRepoInParallel(
    [lens('a'), lens('b'), lens('c')],
    { goal: 'g' },
    runScout,
  );
  assert.deepEqual(seen.sort(), ['a', 'b', 'c']);
  assert.deepEqual(
    results.map((r) => r.lens.key),
    ['a', 'b', 'c'],
    'results follow lens order regardless of completion order',
  );
});

test('surveyRepoInParallel: one dead or throwing scout drops its lens, never the sweep', async () => {
  const runScout: ScoutRunner = async (l) => {
    if (l.key === 'b') return null; // failed submission
    if (l.key === 'c') throw new Error('scout died');
    return { summary: `ok ${l.key}`, facts: [], relevantPaths: [] };
  };
  const results = await surveyRepoInParallel(
    [lens('a'), lens('b'), lens('c')],
    { goal: 'g' },
    runScout,
  );
  assert.deepEqual(
    results.map((r) => r.lens.key),
    ['a'],
    'only the surviving lens is kept',
  );
});

test('synthesizeSurveyBrief: renders a section per finding, framed as leads', () => {
  const finding = (s: string): ScoutFinding => ({
    summary: `${s} summary`,
    facts: [`${s} fact one`, `${s} fact two`],
    relevantPaths: [`src/${s}.ts`],
  });
  const brief = synthesizeSurveyBrief([
    { lens: lens('architecture'), finding: finding('arch') },
    { lens: lens('domain-and-data'), finding: finding('domain') },
  ]);
  assert.match(brief, /gathered in parallel by 2 scout/);
  assert.match(brief, /treat as leads/);
  assert.match(
    brief,
    /## architecture\narch summary\n- arch fact one\n- arch fact two\nrelevant: src\/arch\.ts/,
  );
  assert.match(brief, /## domain-and-data\ndomain summary/);
});

test('synthesizeSurveyBrief: nothing usable → empty string (caller falls back to the plain prompt)', () => {
  assert.equal(synthesizeSurveyBrief([]), '');
  // A finding with no content contributes no section.
  assert.equal(
    synthesizeSurveyBrief([
      { lens: lens('x'), finding: { summary: '', facts: [], relevantPaths: [] } },
    ]),
    '',
  );
});

test('SCOUT_LENSES: the built-in lenses are distinct and non-empty', () => {
  assert.ok(SCOUT_LENSES.length >= 3);
  const keys = SCOUT_LENSES.map((l) => l.key);
  assert.equal(new Set(keys).size, keys.length, 'lens keys are unique');
  for (const l of SCOUT_LENSES) {
    assert.ok(l.focus.length > 20, `${l.key} has a substantive focus`);
  }
});
