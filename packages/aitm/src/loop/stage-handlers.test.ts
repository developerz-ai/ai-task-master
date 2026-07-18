import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CiFailed } from '../github/errors.ts';
import type { ReviewThread } from '../github/schema.ts';
import type { PrGroup, RunState } from '../state/schema.ts';
import { REVIEW_COMMENTS_GRACE } from './constants.ts';
import {
  type AddressedThreadsStore,
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

// A thread that already carries a reply authored by `botLogin` — the shape freshThreads must skip:
// our reply landed on GitHub but a crash may have lost the addressed-thread record.
function repliedThread(id: string, botLogin: string): ReviewThread {
  const base = thread(id);
  return {
    ...base,
    comments: [...base.comments, { id: `${id}-reply`, body: 'fixed it', author: botLogin }],
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
    waitForChecks: async () => ({ state: 'success', failedChecks: [] }),
    listUnresolvedThreads: async () => [],
    mergePr: async () => {},
    ...over,
  };
}

function makeOrchestrator(over: Partial<StageOrchestrator> = {}): StageOrchestrator {
  return {
    work: async () => ({ kind: 'ok' }),
    openPr: async () => 42,
    fixCi: async () => ({ kind: 'ok' }),
    addressReviews: async () => ({ kind: 'ok' }),
    ...over,
  };
}

// In-memory addressed-threads store. `ids()` exposes what was recorded for assertions.
function makeAddressed(initial: string[] = []): {
  store: AddressedThreadsStore;
  ids: () => string[];
} {
  const set = new Set(initial);
  return {
    store: {
      readAddressedThreads: async () => new Set(set),
      recordAddressedThreads: async (_pr, ids) => {
        for (const id of ids) set.add(id);
      },
    },
    ids: () => [...set].sort(),
  };
}

function makeDeps(over: Partial<StageDeps> = {}): StageDeps {
  return {
    github: makeGithub(),
    orchestrator: makeOrchestrator(),
    state: makeState(baseState([])).state,
    // No-op sleep so the post-CI review grace doesn't block tests on a real 2-minute timer.
    sleep: async () => {},
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
  const deps = makeDeps({
    github: makeGithub({ waitForChecks: async () => ({ state: 'success', failedChecks: [] }) }),
  });
  assert.equal(
    await handleWaitingCi(deps, group({ stage: 'waiting-ci', pr: 5 })),
    'waiting-reviews',
  );
});

test('handleWaitingCi: waits the review grace before advancing on success', async () => {
  const slept: number[] = [];
  const deps = makeDeps({
    github: makeGithub({ waitForChecks: async () => ({ state: 'success', failedChecks: [] }) }),
    sleep: async (ms) => {
      slept.push(ms);
    },
  });
  await handleWaitingCi(deps, group({ stage: 'waiting-ci', pr: 5 }));
  assert.deepEqual(slept, [REVIEW_COMMENTS_GRACE]);
});

test('handleWaitingCi: does not wait the review grace when CI is not success', async () => {
  const slept: number[] = [];
  const deps = makeDeps({
    github: makeGithub({
      waitForChecks: async () => ({
        state: 'failure',
        failedChecks: [{ name: 'build', status: 'failure' }],
      }),
    }),
    sleep: async (ms) => {
      slept.push(ms);
    },
  });
  assert.equal(await handleWaitingCi(deps, group({ stage: 'waiting-ci', pr: 5 })), 'ci-failed');
  assert.deepEqual(slept, []);
});

test('handleWaitingCi: CiFailed timeout → blocked (no admin)', async () => {
  const deps = makeDeps({
    github: makeGithub({
      waitForChecks: async () => {
        throw new CiFailed('boom');
      },
    }),
  });
  assert.equal(await handleWaitingCi(deps, group({ stage: 'waiting-ci', pr: 5 })), 'blocked');
});

test('handleWaitingCi: CiFailed timeout → waiting-reviews with --admin', async () => {
  const deps = makeDeps({
    adminMerge: true,
    github: makeGithub({
      waitForChecks: async () => {
        throw new CiFailed('boom');
      },
    }),
  });
  assert.equal(
    await handleWaitingCi(deps, group({ stage: 'waiting-ci', pr: 5 })),
    'waiting-reviews',
  );
});

test('handleWaitingCi: non-success status → ci-failed', async () => {
  const deps = makeDeps({
    github: makeGithub({
      waitForChecks: async () => ({
        state: 'failure',
        failedChecks: [{ name: 'test', status: 'failure' }],
      }),
    }),
  });
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

test('handleWaitingReviews: every unresolved thread already addressed → ready-to-merge', async () => {
  // A thread the Reviewer replied to (but did not resolve) stays unresolved; subtracting the
  // addressed set is what lets the loop converge to merge instead of re-entering addressing-reviews.
  const addressed = makeAddressed(['T1']);
  const deps = makeDeps({
    github: makeGithub({ listUnresolvedThreads: async () => [thread('T1')] }),
    prContext: addressed.store,
  });
  assert.equal(
    await handleWaitingReviews(deps, group({ stage: 'waiting-reviews', pr: 5 })),
    'ready-to-merge',
  );
});

test('handleWaitingReviews: a not-yet-addressed thread among addressed ones → addressing-reviews', async () => {
  const addressed = makeAddressed(['T1']);
  const deps = makeDeps({
    github: makeGithub({ listUnresolvedThreads: async () => [thread('T1'), thread('T2')] }),
    prContext: addressed.store,
  });
  assert.equal(
    await handleWaitingReviews(deps, group({ stage: 'waiting-reviews', pr: 5 })),
    'addressing-reviews',
  );
});

test('handleWaitingReviews: a thread already carrying our reply → ready-to-merge (self-healing skip)', async () => {
  // The reply landed on GitHub but the addressed record was lost (crash in the gap): no prContext
  // here. The bot-reply skip reads our own reply off the thread and converges to merge instead of
  // re-feeding the thread to the Reviewer for a duplicate reply.
  const deps = makeDeps({
    github: makeGithub({
      authenticatedLogin: async () => 'aitm-bot',
      listUnresolvedThreads: async () => [repliedThread('T1', 'aitm-bot')],
    }),
  });
  assert.equal(
    await handleWaitingReviews(deps, group({ stage: 'waiting-reviews', pr: 5 })),
    'ready-to-merge',
  );
});

test('handleWaitingReviews: a reply from another author is not treated as ours → addressing-reviews', async () => {
  const deps = makeDeps({
    github: makeGithub({
      authenticatedLogin: async () => 'aitm-bot',
      listUnresolvedThreads: async () => [repliedThread('T1', 'someone-else')],
    }),
  });
  assert.equal(
    await handleWaitingReviews(deps, group({ stage: 'waiting-reviews', pr: 5 })),
    'addressing-reviews',
  );
});

test('handleWaitingReviews: authenticatedLogin failure falls back to the addressed-set dedup', async () => {
  // A gh hiccup resolving our login must not break the review loop: without the addressed record the
  // thread is still treated as fresh (today's behavior), not merged past.
  const deps = makeDeps({
    github: makeGithub({
      authenticatedLogin: async () => {
        throw new Error('gh down');
      },
      listUnresolvedThreads: async () => [repliedThread('T1', 'aitm-bot')],
    }),
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

// ---- ci-failed -----------------------------------------------------------

test('handleCiFailed: fix session ok → waiting-ci', async () => {
  let fixed = 0;
  const deps = makeDeps({
    orchestrator: makeOrchestrator({
      fixCi: async () => {
        fixed += 1;
        return { kind: 'ok' };
      },
    }),
  });
  assert.equal(await handleCiFailed(deps, group({ stage: 'ci-failed', pr: 5 })), 'waiting-ci');
  assert.equal(fixed, 1);
});

test('handleCiFailed: fix session blocked → blocked', async () => {
  const deps = makeDeps({
    orchestrator: makeOrchestrator({
      fixCi: async () => ({ kind: 'blocked', reason: 'rebase conflict' }),
    }),
  });
  assert.equal(await handleCiFailed(deps, group({ stage: 'ci-failed', pr: 5 })), 'blocked');
});

test('handleCiFailed: missing PR throws', async () => {
  await assert.rejects(
    () => handleCiFailed(makeDeps(), group({ stage: 'ci-failed', pr: null })),
    /without an open PR/,
  );
});

// ---- addressing-reviews --------------------------------------------------

test('handleAddressingReviews: runs Reviewer over fresh threads, records them → waiting-reviews', async () => {
  const seen: string[][] = [];
  const addressed = makeAddressed();
  const deps = makeDeps({
    github: makeGithub({ listUnresolvedThreads: async () => [thread('T1'), thread('T2')] }),
    orchestrator: makeOrchestrator({
      addressReviews: async (_g, threads) => {
        seen.push(threads.map((t) => t.id));
        return { kind: 'ok' };
      },
    }),
    prContext: addressed.store,
  });
  assert.equal(
    await handleAddressingReviews(deps, group({ stage: 'addressing-reviews', pr: 5 })),
    'waiting-reviews',
  );
  assert.deepEqual(seen, [['T1', 'T2']]);
  assert.deepEqual(addressed.ids(), ['T1', 'T2'], 'addressed threads recorded');
});

test('handleAddressingReviews: skips already-addressed threads', async () => {
  const seen: string[][] = [];
  const addressed = makeAddressed(['T1']);
  const deps = makeDeps({
    github: makeGithub({ listUnresolvedThreads: async () => [thread('T1'), thread('T2')] }),
    orchestrator: makeOrchestrator({
      addressReviews: async (_g, threads) => {
        seen.push(threads.map((t) => t.id));
        return { kind: 'ok' };
      },
    }),
    prContext: addressed.store,
  });
  assert.equal(
    await handleAddressingReviews(deps, group({ stage: 'addressing-reviews', pr: 5 })),
    'waiting-reviews',
  );
  assert.deepEqual(seen, [['T2']], 'only the not-yet-addressed thread reaches the Reviewer');
});

test('handleAddressingReviews: skips threads already carrying our reply, addresses the rest', async () => {
  // T1 was replied to on a prior pass but its record was lost (crash before recordAddressedThreads);
  // T2 is genuinely new. The bot-reply skip drops T1 so only T2 reaches the Reviewer and is recorded.
  const seen: string[][] = [];
  const addressed = makeAddressed();
  const deps = makeDeps({
    github: makeGithub({
      authenticatedLogin: async () => 'aitm-bot',
      listUnresolvedThreads: async () => [repliedThread('T1', 'aitm-bot'), thread('T2')],
    }),
    orchestrator: makeOrchestrator({
      addressReviews: async (_g, threads) => {
        seen.push(threads.map((t) => t.id));
        return { kind: 'ok' };
      },
    }),
    prContext: addressed.store,
  });
  assert.equal(
    await handleAddressingReviews(deps, group({ stage: 'addressing-reviews', pr: 5 })),
    'waiting-reviews',
  );
  assert.deepEqual(seen, [['T2']], 'the already-replied thread never reaches the Reviewer');
  assert.deepEqual(addressed.ids(), ['T2'], 'only the freshly addressed thread is recorded');
});

test('handleAddressingReviews: nothing fresh → waiting-reviews without running the Reviewer', async () => {
  let ran = 0;
  const addressed = makeAddressed(['T1']);
  const deps = makeDeps({
    github: makeGithub({ listUnresolvedThreads: async () => [thread('T1')] }),
    orchestrator: makeOrchestrator({
      addressReviews: async () => {
        ran += 1;
        return { kind: 'ok' };
      },
    }),
    prContext: addressed.store,
  });
  assert.equal(
    await handleAddressingReviews(deps, group({ stage: 'addressing-reviews', pr: 5 })),
    'waiting-reviews',
  );
  assert.equal(ran, 0);
});

test('handleAddressingReviews: Reviewer blocked → blocked, nothing recorded', async () => {
  const addressed = makeAddressed();
  const deps = makeDeps({
    github: makeGithub({ listUnresolvedThreads: async () => [thread('T1')] }),
    orchestrator: makeOrchestrator({
      addressReviews: async () => ({ kind: 'blocked', reason: 'reviewer error' }),
    }),
    prContext: addressed.store,
  });
  assert.equal(
    await handleAddressingReviews(deps, group({ stage: 'addressing-reviews', pr: 5 })),
    'blocked',
  );
  assert.deepEqual(addressed.ids(), [], 'threads not recorded when the Reviewer is blocked');
});

test('handleAddressingReviews: missing PR throws', async () => {
  await assert.rejects(
    () => handleAddressingReviews(makeDeps(), group({ stage: 'addressing-reviews', pr: null })),
    /without an open PR/,
  );
});
