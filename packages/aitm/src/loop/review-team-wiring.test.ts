// Paired coverage for review-team-wiring.ts: the ONLY place that turns a RunLoopInput into a real
// read-only lead + investigator init for the review side. review-team.ts's own tests drive those
// runners against hand-built inits, so nothing else exercises this wiring — chiefly that the team
// gets READ-ONLY tools (never the Reviewer's edit/bash/github surface, which would put a second
// writer in the shared checkout) and that a failure anywhere degrades to no briefs.

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { MockLanguageModelV3 } from 'ai/test';
import type { RunLoopInput } from '../composition/run-input.ts';
import type { ReviewThread } from '../github/schema.ts';
import { McpClientManager } from '../mcp/mcp-client.ts';
import { bridgeCredentials, bridgeInput } from '../testing/bridge-ctx.ts';
import { resolvedConfig } from '../testing/domain-fixtures.ts';
import { investigateReviewThreads } from './review-team-wiring.ts';

const thread = (id: string, path: string, body: string): ReviewThread => ({
  id,
  isResolved: false,
  path,
  comments: [{ id: `${id}-c1`, author: 'reviewer-bot', body }],
});

// Answers the lead with a scripted wave and every investigator with one brief per assigned thread,
// telling them apart by the prompt each receives. Records the tool names each call was offered.
function teamModel(wave: Array<{ key: string; threadIds: string[]; question: string }>): {
  model: MockLanguageModelV3;
  toolNames: () => string[][];
  calls: () => number;
} {
  const offered: string[][] = [];
  let calls = 0;
  const model = new MockLanguageModelV3({
    doGenerate: async (opts) => {
      calls += 1;
      offered.push((opts.tools ?? []).map((t) => t.name).sort());
      const prompt = JSON.stringify(opts.prompt);
      const isLead = prompt.includes('read-only investigators');
      const owned = wave.flatMap((a) => (prompt.includes(a.question) ? a.threadIds : []));
      const input = isLead
        ? JSON.stringify({ assignments: wave, rationale: 'scripted' })
        : JSON.stringify({
            briefs: owned.map((threadId) => ({
              threadId,
              summary: `${threadId} investigated`,
              facts: [`${threadId} at src/x.ts:1`],
              relevantPaths: ['src/x.ts'],
              assessment: 'valid',
              reasoning: 'confirmed against the code',
            })),
          });
      return {
        content: [{ type: 'tool-call', toolCallId: `submit-${calls}`, toolName: 'submit', input }],
        finishReason: { unified: 'tool-calls', raw: undefined },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 1, text: 1, reasoning: undefined },
          totalTokens: 2,
        },
        warnings: [],
      };
    },
  });
  return { model, toolNames: () => offered, calls: () => calls };
}

function fakeInput(dir: string, model: MockLanguageModelV3): RunLoopInput {
  return bridgeInput({
    cwd: dir,
    resolved: resolvedConfig({ subagentLimit: 10 }),
    credentials: bridgeCredentials({ modelFor: () => model, modelForCapability: () => model }),
  });
}

// A manager with no servers configured: `toolsForRole` answers with the same empty set the literal
// stub used to fake, and every other method the wiring might reach is the real one.
const fakeMcp = (): McpClientManager => new McpClientManager({ servers: {} });

async function withDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'aitm-review-team-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const params = (dir: string, model: MockLanguageModelV3, threads: ReviewThread[]) => ({
  input: fakeInput(dir, model),
  threads,
  checkoutPath: dir,
  style: '# style\n',
  reviewerModelId: 'openai/gpt-5',
  mcp: fakeMcp(),
  fetchHtmlAvailable: false,
});

test('investigateReviewThreads: drives a real lead + investigators and renders one brief per thread', async () => {
  await withDir(async (dir) => {
    const { model, calls } = teamModel([
      { key: 'auth', threadIds: ['T1'], question: 'how is the token handled?' },
      { key: 'db', threadIds: ['T2'], question: 'is the query n+1?' },
    ]);
    const briefs = await investigateReviewThreads(
      params(dir, model, [
        thread('T1', 'src/auth.ts', 'this leaks the token'),
        thread('T2', 'src/db.ts', 'n+1 query'),
      ]),
    );
    assert.deepEqual([...briefs.keys()].sort(), ['T1', 'T2']);
    assert.match(briefs.get('T1') ?? '', /^<investigation>/);
    assert.match(briefs.get('T1') ?? '', /T1 at src\/x\.ts:1/);
    assert.match(briefs.get('T1') ?? '', /assessment: the comment looks valid/);
    assert.equal(calls(), 3, 'one lead call, then one call per investigator');
  });
});

test('investigateReviewThreads: the team is read-only — no edit, bash, or github tool is offered', async () => {
  // An investigator that could write would be a SECOND writer in the checkout the resolver is about
  // to commit in. That is the invariant the whole read-only/serial-write split rests on.
  await withDir(async (dir) => {
    const { model, toolNames } = teamModel([
      { key: 'auth', threadIds: ['T1'], question: 'how is the token handled?' },
    ]);
    await investigateReviewThreads(params(dir, model, [thread('T1', 'src/auth.ts', 'leaks')]));
    const forbidden = ['writeFile', 'editFile', 'multiEdit', 'bash', 'multiBash', 'github'];
    for (const offered of toolNames()) {
      for (const name of forbidden) {
        assert.ok(!offered.includes(name), `${name} must never reach the review team`);
      }
      assert.ok(offered.includes('readFile'), 'it can still read the code it is judging');
      assert.ok(offered.includes('grep'));
    }
  });
});

test('investigateReviewThreads: a lead that dispatches nothing costs no investigator', async () => {
  await withDir(async (dir) => {
    const { model, calls } = teamModel([]);
    const briefs = await investigateReviewThreads(
      params(dir, model, [thread('T1', 'src/a.ts', 'nit: typo')]),
    );
    assert.equal(briefs.size, 0, 'the Reviewer resolves those threads directly, as before');
    assert.equal(calls(), 1, 'only the lead ran');
  });
});

test('investigateReviewThreads: a dead lead degrades to no briefs, never a throw', async () => {
  await withDir(async (dir) => {
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        throw new Error('provider exploded');
      },
    });
    const briefs = await investigateReviewThreads(
      params(dir, model, [thread('T1', 'src/a.ts', 'x')]),
    );
    assert.equal(briefs.size, 0, 'the review pass still runs — the team only ever accelerates it');
  });
});
