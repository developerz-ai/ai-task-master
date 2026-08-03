import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MockLanguageModelV3 } from 'ai/test';
import type { ReviewThread } from '../github/schema.ts';
import { plannerTools } from '../testing/subagent-tools.ts';
import {
  buildInvestigatorPrompt,
  buildReviewLeadPrompt,
  createReviewInvestigatorRunner,
  createReviewLeadRunner,
  InvestigationSchema,
  investigateThreads,
  REVIEW_INVESTIGATOR_SYSTEM_PREFIX,
  REVIEW_LEAD_SYSTEM_PREFIX,
  REVIEW_MAX_ASSIGNMENTS,
  type ReviewAssignment,
  type ReviewInvestigatorRunner,
  ReviewPlanSchema,
  renderThreadBrief,
  type ThreadBrief,
} from './review-team.ts';

const thread = (id: string, path: string | null, body: string): ReviewThread => ({
  id,
  isResolved: false,
  path,
  comments: [{ id: `${id}-c1`, author: 'reviewer-bot', body }],
});

const assignment = (key: string, threadIds: string[]): ReviewAssignment => ({
  key,
  threadIds,
  question: `what is going on with ${key}?`,
  startPaths: [],
  mustRead: [],
  searchTerms: [],
});

const brief = (threadId: string, over: Partial<ThreadBrief> = {}): ThreadBrief => ({
  threadId,
  summary: `${threadId} summary`,
  facts: [`${threadId} fact at src/x.ts:10`],
  relevantPaths: ['src/x.ts'],
  assessment: 'valid',
  reasoning: 'the code does what the comment says it does',
  ...over,
});

// Submits whatever payload the caller scripts, and records the prompt it was given.
function submittingModel(payload: unknown): { model: MockLanguageModelV3; prompt: () => string } {
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
            input: JSON.stringify(payload),
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

test('buildReviewLeadPrompt: shows every thread and asks for a ground-shaped split', () => {
  const prompt = buildReviewLeadPrompt([
    thread('T1', 'src/auth.ts', 'this leaks the token on error'),
    thread('T2', null, 'general: please add a changelog entry'),
  ]);
  assert.match(prompt, /2 unresolved review thread/);
  assert.match(prompt, /id: T1\n {2}file: src\/auth\.ts\n {2}@reviewer-bot: this leaks the token/);
  assert.match(prompt, /id: T2\n {2}@reviewer-bot: general/, 'a thread with no file still renders');
  assert.match(prompt, new RegExp(`at most ${REVIEW_MAX_ASSIGNMENTS} read-only investigators`));
  assert.match(prompt, /Group by what shares GROUND/);
  assert.match(prompt, /EMPTY assignments list/, 'no investigation is a valid answer');
});

test('buildInvestigatorPrompt: carries only the threads it owns, plus its briefing', () => {
  const threads = [
    thread('T1', 'src/auth.ts', 'leaks the token'),
    thread('T2', 'src/db.ts', 'n+1 query here'),
  ];
  const prompt = buildInvestigatorPrompt(
    {
      ...assignment('auth', ['T1']),
      startPaths: ['src/'],
      mustRead: ['src/auth.ts'],
      searchTerms: ['redactToken'],
    },
    threads,
  );
  assert.match(prompt, /leaks the token/);
  assert.doesNotMatch(prompt, /n\+1 query/, "another investigator's thread never leaks in");
  assert.match(prompt, /Start in: src\//);
  assert.match(prompt, /Read IN FULL: src\/auth\.ts/);
  assert.match(prompt, /Grep for: redactToken/);
  assert.match(prompt, /starting points, not limits/);
  assert.match(prompt, /valid,\ninvalid, or unclear/);
});

test('createReviewLeadRunner: returns the wave, dropping ids not in this pass', async () => {
  const { model, prompt } = submittingModel({
    assignments: [
      { key: 'auth', threadIds: ['T1', 'GHOST'], question: 'how is the token handled?' },
      { key: 'ghost-only', threadIds: ['GHOST'], question: 'nothing real' },
    ],
    rationale: 'one real area',
  });
  const lead = createReviewLeadRunner({
    model,
    tools: () => plannerTools(),
    systemPrompt: REVIEW_LEAD_SYSTEM_PREFIX,
  });
  const wave = await lead([thread('T1', 'src/auth.ts', 'leaks')]);
  assert.deepEqual(
    wave.map((a) => [a.key, a.threadIds]),
    [['auth', ['T1']]],
    'an invented thread id is dropped, and an assignment left empty by that drop goes with it',
  );
  assert.match(prompt(), /unresolved review thread/);
});

test('createReviewLeadRunner: an unusable submission yields no wave, never a throw', async () => {
  const model = new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: 'text' as const, text: 'looks fine to me' }],
      finishReason: { unified: 'stop' as const, raw: undefined },
      usage: {
        inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 1, text: 1, reasoning: undefined },
        totalTokens: 2,
      },
      warnings: [],
    }),
  });
  const lead = createReviewLeadRunner({
    model,
    tools: () => plannerTools(),
    systemPrompt: REVIEW_LEAD_SYSTEM_PREFIX,
  });
  assert.deepEqual(await lead([thread('T1', 'a.ts', 'x')]), []);
});

test('createReviewInvestigatorRunner: keeps only briefs for the threads it was assigned', async () => {
  const { model } = submittingModel({
    briefs: [brief('T1'), brief('T2'), brief('NOT-MINE')],
  });
  const investigate = createReviewInvestigatorRunner({
    model,
    tools: () => plannerTools(),
    systemPrompt: REVIEW_INVESTIGATOR_SYSTEM_PREFIX,
  });
  const out = await investigate(assignment('auth', ['T1', 'T2']), [
    thread('T1', 'a.ts', 'x'),
    thread('T2', 'b.ts', 'y'),
  ]);
  assert.deepEqual(
    out.map((b) => b.threadId),
    ['T1', 'T2'],
  );
});

test('investigateThreads: collects the wave into one map, first brief per thread winning', async () => {
  const seen: string[] = [];
  const runner: ReviewInvestigatorRunner = async (a) => {
    seen.push(a.key);
    return a.threadIds.map((id) => brief(id, { summary: `${a.key} on ${id}` }));
  };
  const briefs = await investigateThreads(
    [assignment('auth', ['T1']), assignment('dup', ['T1', 'T2'])],
    [thread('T1', 'a.ts', 'x'), thread('T2', 'b.ts', 'y')],
    runner,
  );
  assert.deepEqual(seen.sort(), ['auth', 'dup']);
  assert.equal(briefs.get('T1')?.summary, 'auth on T1', 'the first assignment owns the thread');
  assert.equal(briefs.get('T2')?.summary, 'dup on T2');
});

test('investigateThreads: a dead investigator drops only its own threads', async () => {
  const runner: ReviewInvestigatorRunner = async (a) => {
    if (a.key === 'broken') throw new Error('investigator died');
    return a.threadIds.map((id) => brief(id));
  };
  const briefs = await investigateThreads(
    [assignment('broken', ['T1']), assignment('fine', ['T2'])],
    [thread('T1', 'a.ts', 'x'), thread('T2', 'b.ts', 'y')],
    runner,
  );
  assert.deepEqual([...briefs.keys()], ['T2'], 'T1 falls back to being resolved from zero');
});

test('investigateThreads: respects the concurrency cap', async () => {
  let inFlight = 0;
  let peak = 0;
  const runner: ReviewInvestigatorRunner = async (a) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 1));
    inFlight -= 1;
    return a.threadIds.map((id) => brief(id));
  };
  const wave = Array.from({ length: 6 }, (_, i) => assignment(`a${i}`, [`T${i}`]));
  const threads = Array.from({ length: 6 }, (_, i) => thread(`T${i}`, 'a.ts', 'x'));
  await investigateThreads(wave, threads, runner, 2);
  assert.ok(peak <= 2, `peak ${peak} respected the cap`);
});

test('renderThreadBrief: leads, never a verdict the resolver is bound by', () => {
  const rendered = renderThreadBrief(
    brief('T1', { assessment: 'invalid', reasoning: 'already handled' }),
  );
  assert.match(rendered, /^<investigation>/);
  assert.match(rendered, /you decide\nthe outcome/);
  assert.match(rendered, /- T1 fact at src\/x\.ts:10/);
  assert.match(rendered, /relevant: src\/x\.ts/);
  assert.match(rendered, /assessment: the comment looks invalid — already handled/);
  assert.match(rendered, /<\/investigation>$/);
});

test('schemas: a wave is capped, and both default to empty rather than failing', () => {
  const many = Array.from({ length: REVIEW_MAX_ASSIGNMENTS + 1 }, (_, i) => ({
    key: `a${i}`,
    threadIds: ['T1'],
    question: 'q',
  }));
  assert.equal(ReviewPlanSchema.safeParse({ assignments: many }).success, false);
  assert.deepEqual(ReviewPlanSchema.parse({}).assignments, []);
  assert.deepEqual(InvestigationSchema.parse({}).briefs, []);
  // An assignment owning no thread is meaningless — the schema refuses it rather than dispatching
  // an investigator with nothing to look at.
  assert.equal(
    ReviewPlanSchema.safeParse({ assignments: [{ key: 'a', threadIds: [], question: 'q' }] })
      .success,
    false,
  );
});
