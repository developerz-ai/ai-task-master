import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stallingModel } from '../testing/stalling-model.ts';
import {
  buildScoutPrompt,
  createScoutRunner,
  FALLBACK_SCOUT_ASSIGNMENTS,
  SCOUT_MAX_ASSIGNMENTS,
  SCOUT_SYSTEM_PREFIX,
  type ScoutAssignment,
  type ScoutFinding,
  type ScoutRunner,
  surveyRepoInParallel,
  synthesizeSurveyBrief,
} from './planner-scouts.ts';

const assignment = (key: string, overrides: Partial<ScoutAssignment> = {}): ScoutAssignment => ({
  key,
  question: `what about ${key}?`,
  subQuestions: [],
  startPaths: [],
  mustRead: [],
  searchTerms: [],
  ...overrides,
});

const finding = (s: string): ScoutFinding => ({
  summary: `${s} summary`,
  facts: [`${s} fact one`, `${s} fact two`],
  relevantPaths: [`src/${s}.ts`],
  openQuestions: [],
});

test('buildScoutPrompt: carries the goal, the map, and the whole briefing', () => {
  const prompt = buildScoutPrompt(
    assignment('domain-and-data', {
      subQuestions: ['which tables exist?', 'who writes them?'],
      startPaths: ['src/db', 'src/models'],
      mustRead: ['src/db/schema.ts'],
      searchTerms: ['createSession', 'session_id'],
    }),
    { goal: 'add user sessions', criteria: 'tests pass', repoMap: 'Repo map — 42 tracked file(s)' },
  );
  assert.match(prompt, /add user sessions/);
  assert.match(prompt, /tests pass/);
  assert.match(prompt, /Repo map — 42 tracked file\(s\)/);
  assert.match(prompt, /what about domain-and-data\?/);
  assert.match(
    prompt,
    /Settle each of these:\n {2}- which tables exist\?\n {2}- who writes them\?/,
  );
  assert.match(prompt, /Start in: src\/db, src\/models/);
  assert.match(prompt, /Read IN FULL: src\/db\/schema\.ts/);
  assert.match(prompt, /Grep for: createSession, session_id/);
  assert.match(prompt, /call submit/i);
});

test('buildScoutPrompt: the briefing is framed as a floor, never a ceiling', () => {
  // The lead picked its leads off a map, not off the code — a scout that treats them as the whole
  // job inherits the lead's blind spots, which is the failure the fixed-lens survey already had.
  const prompt = buildScoutPrompt(assignment('auth', { mustRead: ['src/auth.ts'] }), { goal: 'g' });
  assert.match(prompt, /starting points, not your limits/);
  assert.match(prompt, /correct them where they are wrong/);
  assert.match(prompt, /file:line/, 'facts must come back anchored to real code');
});

test('buildScoutPrompt: names sibling territory to dedupe, and frees the scout inside its own', () => {
  const wave = [assignment('a'), assignment('b'), assignment('c')];
  const prompt = buildScoutPrompt(wave[0] as ScoutAssignment, { goal: 'g' }, wave);
  assert.match(prompt, /Other scouts are covering: b, c/);
  assert.doesNotMatch(prompt, /covering: a/, 'a scout is never told it is covering itself');
  assert.match(prompt, /wherever it\n?actually leads/, 'the assignment is a question, not a fence');
});

test('buildScoutPrompt: omits the optional lines rather than emitting empty ones', () => {
  const prompt = buildScoutPrompt(assignment('solo'), { goal: 'g' });
  assert.doesNotMatch(prompt, /Acceptance criteria/);
  assert.doesNotMatch(prompt, /Start here/);
  assert.doesNotMatch(prompt, /Other scouts/);
  assert.doesNotMatch(prompt, /Repo map/);
});

test('surveyRepoInParallel: runs every assignment and collects the findings in dispatch order', async () => {
  const seen: string[] = [];
  const siblingsSeen: string[][] = [];
  const runScout: ScoutRunner = async (a, _ctx, siblings) => {
    seen.push(a.key);
    siblingsSeen.push(siblings.map((s) => s.key));
    return finding(a.key);
  };
  const results = await surveyRepoInParallel(
    [assignment('a'), assignment('b'), assignment('c')],
    { goal: 'g' },
    runScout,
  );
  assert.deepEqual(seen.sort(), ['a', 'b', 'c']);
  assert.deepEqual(
    results.map((r) => r.assignment.key),
    ['a', 'b', 'c'],
    'results follow dispatch order regardless of completion order',
  );
  assert.deepEqual(siblingsSeen[0], ['a', 'b', 'c'], 'each scout is handed the whole wave');
});

test('surveyRepoInParallel: one dead or throwing scout drops itself, never the wave', async () => {
  const runScout: ScoutRunner = async (a) => {
    if (a.key === 'b') return null; // failed submission
    if (a.key === 'c') throw new Error('scout died');
    return finding(a.key);
  };
  const results = await surveyRepoInParallel(
    [assignment('a'), assignment('b'), assignment('c')],
    { goal: 'g' },
    runScout,
  );
  assert.deepEqual(
    results.map((r) => r.assignment.key),
    ['a'],
    'only the surviving scout is kept',
  );
});

test('surveyRepoInParallel: never exceeds the concurrency cap', async () => {
  let inFlight = 0;
  let peak = 0;
  const runScout: ScoutRunner = async (a) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 1));
    inFlight -= 1;
    return finding(a.key);
  };
  const wave = Array.from({ length: 6 }, (_, i) => assignment(`a${i}`));
  await surveyRepoInParallel(wave, { goal: 'g' }, runScout, 2);
  assert.ok(peak <= 2, `peak concurrency ${peak} respected the cap`);
});

test('synthesizeSurveyBrief: leads with the map, then a section per finding, framed as leads', () => {
  const brief = synthesizeSurveyBrief(
    [
      { assignment: assignment('architecture'), finding: finding('arch') },
      { assignment: assignment('domain-and-data'), finding: finding('domain') },
    ],
    'Repo map — 8 tracked file(s)',
  );
  assert.ok(brief.startsWith('Repo map — 8 tracked file(s)'), 'the map orients the Planner first');
  assert.match(brief, /gathered in parallel by 2 scout/);
  assert.match(brief, /treat as leads/);
  assert.match(
    brief,
    /## architecture\narch summary\n- arch fact one\n- arch fact two\nrelevant: src\/arch\.ts/,
  );
  assert.match(brief, /## domain-and-data\ndomain summary/);
});

test('synthesizeSurveyBrief: an unsettled question reaches the Planner as an explicit hole', () => {
  const brief = synthesizeSurveyBrief([
    {
      assignment: assignment('auth'),
      finding: { ...finding('auth'), openQuestions: ['which middleware validates the cookie?'] },
    },
  ]);
  assert.match(brief, /open: which middleware validates the cookie\?/);
});

test('synthesizeSurveyBrief: a dead survey still hands over the map, not nothing', () => {
  assert.match(synthesizeSurveyBrief([], 'Repo map — 8 tracked file(s)'), /^Repo map/);
  // Nothing at all to say → empty, so the caller falls back to the plain single-planner prompt.
  assert.equal(synthesizeSurveyBrief([]), '');
  assert.equal(
    synthesizeSurveyBrief([
      {
        assignment: assignment('x'),
        finding: { summary: '', facts: [], relevantPaths: [], openQuestions: [] },
      },
    ]),
    '',
  );
});

test('FALLBACK_SCOUT_ASSIGNMENTS: distinct, substantive, and within the wave cap', () => {
  assert.ok(FALLBACK_SCOUT_ASSIGNMENTS.length >= 3);
  assert.ok(FALLBACK_SCOUT_ASSIGNMENTS.length <= SCOUT_MAX_ASSIGNMENTS);
  const keys = FALLBACK_SCOUT_ASSIGNMENTS.map((a) => a.key);
  assert.equal(new Set(keys).size, keys.length, 'keys are unique');
  for (const a of FALLBACK_SCOUT_ASSIGNMENTS) {
    assert.ok(a.question.length > 20, `${a.key} asks a substantive question`);
  }
});

test('createScoutRunner: forwards the run signal → an abort cancels an in-flight scout survey', async () => {
  // Scouts sweep concurrently outside the Planner's own generate, so without the signal an abort
  // would leave a whole wave of surveys running until each provider answered.
  const stalling = stallingModel();
  const controller = new AbortController();
  const runScout = createScoutRunner({
    model: stalling,
    tools: {},
    systemPrompt: SCOUT_SYSTEM_PREFIX,
    signal: controller.signal,
    // Safety net: an unwired signal must fail the test rather than hang it forever.
    timeout: { stepMs: 2_000 },
  });
  setTimeout(() => controller.abort(), 5);
  await assert.rejects(runScout(assignment('architecture'), { goal: 'x' }, []), (err: unknown) => {
    assert.match((err as Error).message, /abort/i);
    assert.doesNotMatch((err as Error).message, /deadline/, 'a cancel is not a deadline breach');
    return true;
  });
});
