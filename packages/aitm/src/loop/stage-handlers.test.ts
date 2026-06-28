import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CiFailed } from '../github/errors.ts';
import type { ReviewThread } from '../github/schema.ts';
import type { PrGroup, RunState } from '../state/schema.ts';
import {
  handleAddressingReviews,
  handleCiFailed,
  handlePrOpen,
  handleReadyToMerge,
  handleWaitingCi,
  handleWaitingReviews,
  handleWorking,
  type StageDeps,
  type StageGithub,
  type StageOrchestrator,
  type StageState,
} from './stage-handlers.ts';

// ---- Fixtures ------------------------------------------------------------

function group(overrides: Partial<PrGroup> = {}): PrGroup {
  return {
    id: 'g1',
    title: 'group one',
    tasks: [{ id: 't1', text: 'do it', complexity: 'normal', done: false }],
    dependsOn: [],
    branch: 'aitm/g1',
    pr: null,
    status: 'in-progress',
    stage: 'working',
    ...overrides,
  };
}

function thread(id: string): ReviewThread {
  return {
    id,
    isResolved: false,
    path: 'src/a.ts',
    comments: [{ id: `${id}-c1`, body: 'please fix', author: 'coderabbit' }],
  };
}

function baseState(groups: PrGroup[]): RunState {
  return {
    status: 'working',
    prGroups: groups,
    currentGroupIndex: 0,
    currentTaskIndex: 0,
    sessionCount: 0,
    currentPr: null,
    runId: 'run-1',
    provider: 'openrouter',
    model: 'm',
    agentConfigFile: 'CLAUDE.md',
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
    options: {
      autoMerge: true,
      maxPrs: 5,
      maxSessions: null,
      mergeMethod: 'squash',
      stylePath: null,
      concurrency: 1,
    },
  };
}

function makeState(initial: RunState): { state: StageState; snapshot: () => RunState } {
  let current = initial;
  return {
    state: {
      update: async (mutator) => {
        current = mutator(current);
        return current;
      },
    },
    snapshot: () => current,
  };
}

function makeGithub(over: Partial<StageGithub> = {}): StageGithub {
  return {
    waitForChecks: async () => 'success',
    listUnresolvedThreads: async () => [],
    mergePr: async () => {},
    ...over,
  };
}

function makeOrchestrator(over: Partial<StageOrchestrator> = {}): StageOrchestrator {
  return {
    work: async () => ({ kind: 'ok' }),
    openPr: async () => 42,
    ...over,
  };
}

function makeDeps(over: Partial<StageDeps> = {}): StageDeps {
  return {
    github: makeGithub(),
    orchestrator: makeOrchestrator(),
    state: makeState(baseState([])).state,
    ...over,
  };
}

// ---- working -------------------------------------------------------------

test('handleWorking: worker ok → pr-open', async () => {
  assert.equal(await handleWorking(makeDeps(), group()), 'pr-open');
});

test('handleWorking: worker blocked → blocked', async () => {
  const deps = makeDeps({
    orchestrator: makeOrchestrator({ work: async () => ({ kind: 'blocked', reason: 'nope' }) }),
  });
  assert.equal(await handleWorking(deps, group()), 'blocked');
});

// ---- pr-open -------------------------------------------------------------

test('handlePrOpen: opens PR, persists number → waiting-ci', async () => {
  const g = group({ stage: 'pr-open' });
  const st = makeState(baseState([g]));
  let opened = 0;
  const deps = makeDeps({
    state: st.state,
    orchestrator: makeOrchestrator({
      openPr: async () => {
        opened += 1;
        return 77;
      },
    }),
  });
  assert.equal(await handlePrOpen(deps, g), 'waiting-ci');
  assert.equal(opened, 1);
  assert.equal(st.snapshot().prGroups[0]?.pr, 77);
});

test('handlePrOpen: PR already open (resume) → waiting-ci, no reopen', async () => {
  let opened = 0;
  const deps = makeDeps({
    orchestrator: makeOrchestrator({
      openPr: async () => {
        opened += 1;
        return 1;
      },
    }),
  });
  assert.equal(await handlePrOpen(deps, group({ stage: 'pr-open', pr: 99 })), 'waiting-ci');
  assert.equal(opened, 0);
});

// ---- waiting-ci ----------------------------------------------------------

test('handleWaitingCi: checks succeed → waiting-reviews', async () => {
  const deps = makeDeps({ github: makeGithub({ waitForChecks: async () => 'success' }) });
  assert.equal(
    await handleWaitingCi(deps, group({ stage: 'waiting-ci', pr: 5 })),
    'waiting-reviews',
  );
});

test('handleWaitingCi: CiFailed → ci-failed', async () => {
  const deps = makeDeps({
    github: makeGithub({
      waitForChecks: async () => {
        throw new CiFailed('boom');
      },
    }),
  });
  assert.equal(await handleWaitingCi(deps, group({ stage: 'waiting-ci', pr: 5 })), 'ci-failed');
});

test('handleWaitingCi: non-success status → ci-failed', async () => {
  const deps = makeDeps({ github: makeGithub({ waitForChecks: async () => 'failure' }) });
  assert.equal(await handleWaitingCi(deps, group({ stage: 'waiting-ci', pr: 5 })), 'ci-failed');
});

test('handleWaitingCi: non-CiFailed error propagates', async () => {
  const deps = makeDeps({
    github: makeGithub({
      waitForChecks: async () => {
        throw new Error('gh exploded');
      },
    }),
  });
  await assert.rejects(
    () => handleWaitingCi(deps, group({ stage: 'waiting-ci', pr: 5 })),
    /gh exploded/,
  );
});

test('handleWaitingCi: missing PR throws', async () => {
  await assert.rejects(
    () => handleWaitingCi(makeDeps(), group({ stage: 'waiting-ci', pr: null })),
    /without an open PR/,
  );
});

// ---- waiting-reviews -----------------------------------------------------

test('handleWaitingReviews: no unresolved threads → ready-to-merge', async () => {
  const deps = makeDeps({ github: makeGithub({ listUnresolvedThreads: async () => [] }) });
  assert.equal(
    await handleWaitingReviews(deps, group({ stage: 'waiting-reviews', pr: 5 })),
    'ready-to-merge',
  );
});

test('handleWaitingReviews: unresolved threads → addressing-reviews', async () => {
  const deps = makeDeps({
    github: makeGithub({ listUnresolvedThreads: async () => [thread('T1')] }),
  });
  assert.equal(
    await handleWaitingReviews(deps, group({ stage: 'waiting-reviews', pr: 5 })),
    'addressing-reviews',
  );
});

// ---- ready-to-merge ------------------------------------------------------

test('handleReadyToMerge: merges the PR → merged', async () => {
  const merged: number[] = [];
  const deps = makeDeps({
    github: makeGithub({
      mergePr: async (pr) => {
        merged.push(pr);
      },
    }),
  });
  assert.equal(await handleReadyToMerge(deps, group({ stage: 'ready-to-merge', pr: 8 })), 'merged');
  assert.deepEqual(merged, [8]);
});

// ---- stubs (slice 04) ----------------------------------------------------

test('handleCiFailed: stubbed → blocks until slice 04', async () => {
  assert.equal(await handleCiFailed(makeDeps(), group({ stage: 'ci-failed', pr: 5 })), 'blocked');
});

test('handleAddressingReviews: stubbed → blocks until slice 04', async () => {
  assert.equal(
    await handleAddressingReviews(makeDeps(), group({ stage: 'addressing-reviews', pr: 5 })),
    'blocked',
  );
});
