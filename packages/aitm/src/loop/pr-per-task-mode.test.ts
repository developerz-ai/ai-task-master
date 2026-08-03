import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { WorkerDelivery } from '../domain/worker-delivery.ts';
import { CiFailed } from '../github/errors.ts';
import type { ReviewThread } from '../github/schema.ts';
import type { RunState } from '../state/schema.ts';
import { workerHandle } from '../testing/subagent-tools.ts';
import { ciFixFailedError, reviewFailedError } from './pr-per-task-mode.ts';
import type { StageWorkResult } from './stage-handlers.ts';
import { WorkLoop, type WorkLoopGithub, type WorkLoopOrchestrator } from './work-loop.ts';
import {
  ciFailure,
  ciSuccess,
  group,
  makeDeps,
  makeGithub,
  makeGraph,
  makeHome,
  makeOrchestrator,
  makeState,
  steppedClock,
  twoTaskGroup,
} from './work-loop-test-support.ts';

test('self-review runs before each per-task openPr (prPerTask mode)', async () => {
  const events: string[] = [];
  const { orchestrator, calls } = makeOrchestrator({ prNumber: 7, selfReview: true, events });
  const loop = new WorkLoop(makeDeps({ orchestrator, autoMerge: false, prPerTask: true }));
  await loop.runGroup(group('alpha'));

  assert.equal(calls.selfReview.length, 1);
  assert.deepEqual(events, ['selfReview:aitm/alpha', 'openPr:aitm/alpha']);
});

test('prPerTask: opens a PR after every task (autoMerge off)', async () => {
  const { orchestrator, calls } = makeOrchestrator({ prNumber: 7 });
  const { state } = makeState([twoTaskGroup()]);
  const loop = new WorkLoop(makeDeps({ orchestrator, state, autoMerge: false, prPerTask: true }));
  await loop.runGroup(twoTaskGroup());

  assert.equal(calls.runWorker.length, 2);
  assert.equal(calls.openPr.length, 2, 'one PR per task under prPerTask');
});

test('prPerTask: each task PR runs CI then merges under autoMerge', async () => {
  const { orchestrator, calls } = makeOrchestrator({ prNumber: 7 });
  const { github, calls: ghCalls } = makeGithub({ checks: [ciSuccess, ciSuccess], threads: [] });
  const loop = new WorkLoop(makeDeps({ orchestrator, github, autoMerge: true, prPerTask: true }));
  await loop.runGroup(twoTaskGroup());

  assert.equal(calls.openPr.length, 2, 'one PR per task');
  assert.equal(ghCalls.waitForChecks.length, 2, 'CI awaited per task PR');
  assert.equal(ghCalls.mergePr.length, 2, 'each task PR merged');
});

test('prPerTask: each completed task prints a "done in" timing line', async () => {
  const progress: string[] = [];
  const { orchestrator } = makeOrchestrator({ prNumber: 7 });
  const { github } = makeGithub({ checks: [ciSuccess, ciSuccess], threads: [] });
  const loop = new WorkLoop(
    makeDeps({
      orchestrator,
      github,
      autoMerge: true,
      prPerTask: true,
      progress: (m) => progress.push(m),
      now: steppedClock(1000),
    }),
  );
  await loop.runGroup(twoTaskGroup());

  const taskLines = progress.filter((p) => /^group multi task \w+: done in \d+\.\ds$/.test(p));
  assert.equal(taskLines.length, 2, 'one timing line per task');
  const groupLine = progress.find((p) => /^group multi: merged — done in \d+\.\d[sm]$/.test(p));
  assert.ok(groupLine, "group total prints once, on the final task's merge");
});

test('prPerTask: resume skips done tasks and opens a PR only for the remaining one', async () => {
  const resumed = group('multi', {
    tasks: [
      { id: 'a', text: 'already done', complexity: 'normal', done: true },
      { id: 'b', text: 'still pending', complexity: 'normal', done: false },
    ],
  });
  const { orchestrator, calls } = makeOrchestrator({ prNumber: 4 });
  const { state } = makeState([resumed]);
  const loop = new WorkLoop(makeDeps({ orchestrator, state, autoMerge: false, prPerTask: true }));
  await loop.runGroup(resumed);

  assert.equal(calls.runWorker.length, 1, 'only the undone task runs');
  assert.equal(calls.runWorker[0]?.task?.id, 'b');
  assert.equal(calls.openPr.length, 1, 'one PR for the single remaining task');
});

test('prPerTask: multi-task group is marked merged only after the final task', async () => {
  // Regression: marking the whole group terminal after the FIRST task's PR strands the remaining
  // tasks — a crash there leaves a 'merged' group PlanGraph.ready() won't reschedule. The group
  // must stay schedulable (in-progress) until the last task lands.
  const { orchestrator } = makeOrchestrator({ prNumber: 7 });
  const { github } = makeGithub({ checks: [ciSuccess, ciSuccess], threads: [] });
  const { state, updates } = makeState([twoTaskGroup()]);
  const loop = new WorkLoop(
    makeDeps({ orchestrator, github, state, autoMerge: true, prPerTask: true }),
  );
  await loop.runGroup(twoTaskGroup());

  const statusAt = (s: RunState): string | undefined =>
    s.prGroups.find((g) => g.id === 'multi')?.status;
  const mergedIdx = updates.findIndex((s) => statusAt(s) === 'merged');
  assert.equal(mergedIdx, updates.length - 1, 'group reaches merged only on the final write');
  assert.ok(
    !updates.slice(0, -1).some((s) => statusAt(s) === 'merged'),
    'group is never marked merged before the last task',
  );
});

test('prPerTask + autoMerge: each task branches off the merged base; its PR carries only its own changes', async () => {
  // The bug: every per-task PR opened from the SAME branch, so after task a squash-merged, task b's PR
  // re-included a's changes. Fix: each task resets to a fresh branch off origin/<base> (resetToBase),
  // then opens its PR from that branch — so b's PR carries b.ts only, and the reset for b happens after
  // a merges (proving b branches off a's merged result, not a's tip).
  const da: WorkerDelivery = {
    branch: 'unused',
    draftCommitMessage: 'feat: a',
    changes: [{ path: 'a.ts', kind: 'create', summary: 'created a' }],
    progressEntries: ['- a'],
  };
  const db: WorkerDelivery = {
    branch: 'unused',
    draftCommitMessage: 'feat: b',
    changes: [{ path: 'b.ts', kind: 'create', summary: 'created b' }],
    progressEntries: ['- b'],
  };
  const events: string[] = [];
  const { orchestrator, calls } = makeOrchestrator({
    prNumber: 7,
    events,
    workerResults: [
      { kind: 'ok', delivery: da, handle: workerHandle() },
      { kind: 'ok', delivery: db, handle: workerHandle() },
    ],
  });
  const { github } = makeGithub({ checks: [ciSuccess, ciSuccess], threads: [], events });
  const { home, calls: homeCalls } = makeHome({ resetToBase: true, events });
  const loop = new WorkLoop(
    makeDeps({ orchestrator, github, home, autoMerge: true, prPerTask: true }),
  );
  await loop.runGroup(twoTaskGroup());

  // A fresh per-task branch off the base is created for each task, under the group branch.
  assert.deepEqual(homeCalls.resetToBase, [
    { groupId: 'multi', branch: 'aitm/multi-a', baseBranch: 'main' },
    { groupId: 'multi', branch: 'aitm/multi-b', baseBranch: 'main' },
  ]);
  // Each task's PR is opened from ITS OWN base-fresh branch.
  assert.deepEqual(
    calls.openPr.map((c) => c.group.branch),
    ['aitm/multi-a', 'aitm/multi-b'],
  );
  // The second task's PR carries only b.ts — it does NOT re-include the first task's a.ts.
  assert.deepEqual(
    calls.openPr[0]?.delivery.changes.map((c) => c.path),
    ['a.ts'],
  );
  assert.deepEqual(
    calls.openPr[1]?.delivery.changes.map((c) => c.path),
    ['b.ts'],
  );
  // Ordering: task b's base refresh happens AFTER task a's PR merges, so b branches off a's merged
  // result rather than a's branch tip.
  assert.deepEqual(events, [
    'reset:aitm/multi-a',
    'openPr:aitm/multi-a',
    'merge:7',
    'reset:aitm/multi-b',
    'openPr:aitm/multi-b',
    'merge:7',
  ]);
});

test('prPerTask + autoMerge fallback: a home without resetToBase keeps the single group branch', async () => {
  // A home that can't reset to base (e.g. a home that doesn't support it) falls back to the prior
  // single-branch behavior rather than failing — every task's PR opens off the one group branch.
  const { orchestrator, calls } = makeOrchestrator({ prNumber: 7 });
  const { github } = makeGithub({ checks: [ciSuccess, ciSuccess], threads: [] });
  const { home, calls: homeCalls } = makeHome(); // no resetToBase
  const loop = new WorkLoop(
    makeDeps({ orchestrator, github, home, autoMerge: true, prPerTask: true }),
  );
  await loop.runGroup(twoTaskGroup());

  assert.deepEqual(homeCalls.resetToBase, [], 'no base refresh without the seam');
  assert.deepEqual(
    calls.openPr.map((c) => c.group.branch),
    ['aitm/multi', 'aitm/multi'],
    'both PRs open off the single group branch',
  );
});

test('prPerTask + --no-automerge: no base refresh; tasks stay on the single group branch', async () => {
  // Without autoMerge, tasks never merge mid-group, so there is no merged base to branch from — the
  // documented fallback keeps the single group branch even when the home CAN resetToBase.
  const events: string[] = [];
  const { orchestrator, calls } = makeOrchestrator({ prNumber: 7 });
  const { home, calls: homeCalls } = makeHome({ resetToBase: true, events });
  const loop = new WorkLoop(makeDeps({ orchestrator, home, autoMerge: false, prPerTask: true }));
  await loop.runGroup(twoTaskGroup());

  assert.equal(calls.openPr.length, 2, 'a PR per task');
  assert.deepEqual(homeCalls.resetToBase, [], 'no base refresh under --no-automerge');
  assert.deepEqual(
    calls.openPr.map((c) => c.group.branch),
    ['aitm/multi', 'aitm/multi'],
    'both PRs open off the single group branch',
  );
});

test('prPerTask + autoMerge: a red PR routes the fix through runCiFix (pushes), re-polls green, merges', async () => {
  // Regression: autoMergeFlow used to runWorker + finalizeCommit (git commit --amend) WITHOUT
  // pushing, so the recheck polled stale remote CI and the merge landed the unfixed remote. It now
  // routes through runCiFix — the shared fix session that rebases onto origin/<base> and
  // force-with-lease pushes — so the recheck re-polls against the pushed fix.
  const { orchestrator, calls } = makeOrchestrator({ prNumber: 7 });
  const { github, calls: ghCalls } = makeGithub({ checks: [ciFailure, ciSuccess], threads: [] });
  const loop = new WorkLoop(makeDeps({ orchestrator, github, autoMerge: true, prPerTask: true }));
  await loop.runGroup(group('solo'));

  assert.equal(calls.runCiFix.length, 1, 'the CI fix routes through the pushing fix session');
  assert.equal(calls.runCiFix[0]?.pr, 7);
  assert.equal(calls.runWorker.length, 1, 'the fix is not a second raw runWorker pass');
  assert.equal(
    calls.finalizeCommit.length,
    1,
    'the CI fix does not --amend (only the task commit)',
  );
  assert.deepEqual(ghCalls.waitForChecks, [7, 7], 'CI is re-polled after the fix is pushed');
  assert.deepEqual(
    ghCalls.mergePr.map((c) => c.pr),
    [7],
    'PR merged once CI is green on the pushed fix',
  );
});

test('prPerTask + autoMerge: a CI fix that cannot land blocks the group without merging', async () => {
  const { orchestrator, calls } = makeOrchestrator({
    prNumber: 7,
    ciFixResults: [{ kind: 'blocked', reason: 'still red after fix' }],
  });
  const { github, calls: ghCalls } = makeGithub({ checks: [ciFailure], threads: [] });
  const { state, updates } = makeState([group('solo')]);
  const loop = new WorkLoop(
    makeDeps({ orchestrator, github, state, autoMerge: true, prPerTask: true }),
  );
  await loop.runGroup(group('solo'));

  assert.equal(calls.runCiFix.length, 1);
  assert.equal(ghCalls.waitForChecks.length, 1, 'no recheck once the fix fails to land');
  assert.equal(ghCalls.mergePr.length, 0, 'no merge when the fix cannot land');
  const last = updates[updates.length - 1] as RunState;
  assert.equal(last.prGroups.find((p) => p.id === 'solo')?.status, 'blocked');
});

test('prPerTask + autoMerge: unresolved threads route through addressReviews (pushes) before merge', async () => {
  const thread: ReviewThread = {
    id: 't1',
    isResolved: false,
    path: 'a.ts',
    comments: [{ id: 'c1', body: 'nit', author: 'rev' }],
  };
  const { orchestrator, calls } = makeOrchestrator({ prNumber: 7 });
  const { github, calls: ghCalls } = makeGithub({ checks: [ciSuccess], threads: [thread] });
  const loop = new WorkLoop(makeDeps({ orchestrator, github, autoMerge: true, prPerTask: true }));
  await loop.runGroup(group('solo'));

  assert.equal(
    calls.addressReviews.length,
    1,
    'reviewer fixes go through the pushing addressReviews',
  );
  assert.deepEqual(
    calls.addressReviews[0]?.threads.map((t) => t.id),
    ['t1'],
  );
  assert.deepEqual(
    ghCalls.mergePr.map((c) => c.pr),
    [7],
    'PR merged after the reviewer fix is pushed',
  );
});

test('prPerTask + autoMerge: an unaddressable review thread blocks the group without merging', async () => {
  const thread: ReviewThread = {
    id: 't1',
    isResolved: false,
    path: 'a.ts',
    comments: [{ id: 'c1', body: 'nit', author: 'rev' }],
  };
  const { orchestrator, calls } = makeOrchestrator({
    prNumber: 7,
    addressReviewsResult: { kind: 'blocked', reason: 'reviewer error' },
  });
  const { github, calls: ghCalls } = makeGithub({ checks: [ciSuccess], threads: [thread] });
  const { state, updates } = makeState([group('solo')]);
  const loop = new WorkLoop(
    makeDeps({ orchestrator, github, state, autoMerge: true, prPerTask: true }),
  );
  await loop.runGroup(group('solo'));

  assert.equal(calls.addressReviews.length, 1);
  assert.equal(ghCalls.mergePr.length, 0, 'no merge while the thread is unaddressed');
  const last = updates[updates.length - 1] as RunState;
  assert.equal(last.prGroups.find((p) => p.id === 'solo')?.status, 'blocked');
});

test('prPerTask + autoMerge: a persistently red PR blocks after maxCiFixAttempts fixes, not one', async () => {
  // Regression: autoMergeFlow ran exactly one runCiFix + one recheck, ignoring maxCiFixAttempts. It
  // now loops the shared ciOutcomePolicy like driveStages — up to the cap — before blocking, so
  // prPerTask and the group-as-PR stage machine cap the recovery loop identically.
  const { orchestrator, calls } = makeOrchestrator({ prNumber: 7 });
  const { github, calls: ghCalls } = makeGithub({ checks: Array(5).fill(ciFailure), threads: [] });
  const { state, updates } = makeState([group('solo')]);
  const loop = new WorkLoop(
    makeDeps({
      orchestrator,
      github,
      state,
      autoMerge: true,
      prPerTask: true,
      maxCiFixAttempts: 2,
    }),
  );
  await loop.runGroup(group('solo'));

  assert.equal(calls.runCiFix.length, 2, 'the fix loops up to the cap, not exactly once');
  assert.equal(ghCalls.waitForChecks.length, 3, 'CI polled once before each fix, cap + 1 times');
  assert.equal(ghCalls.mergePr.length, 0, 'a still-red PR is never merged');
  const last = updates[updates.length - 1] as RunState;
  assert.equal(last.prGroups.find((p) => p.id === 'solo')?.status, 'blocked');
});

test('prPerTask + autoMerge: a red PR that goes green on the last allowed fix merges (cap boundary)', async () => {
  // The cap allows N fixes, not N − 1: with maxCiFixAttempts 2 a PR that recovers on the 2nd fix
  // must merge, not strand. Guards the same off-by-one the stage machine's cap-boundary test guards.
  const { orchestrator, calls } = makeOrchestrator({ prNumber: 7 });
  const { github, calls: ghCalls } = makeGithub({
    checks: [ciFailure, ciFailure, ciSuccess],
    threads: [],
  });
  const loop = new WorkLoop(
    makeDeps({ orchestrator, github, autoMerge: true, prPerTask: true, maxCiFixAttempts: 2 }),
  );
  await loop.runGroup(group('solo'));

  assert.equal(calls.runCiFix.length, 2, 'both allowed fixes run');
  assert.deepEqual(
    ghCalls.mergePr.map((c) => c.pr),
    [7],
    'the recovered PR merges on the last allowed attempt',
  );
});

test('prPerTask + autoMerge: a CI poll timeout blocks the group (no --admin)', async () => {
  // A waitForChecks CiFailed (checks never settled) blocks rather than merging a PR whose CI never
  // completed — and, unlike the old one-shot flow, without spending a fix pass on a timeout.
  const { orchestrator, calls } = makeOrchestrator({ prNumber: 9 });
  const { github, calls: ghCalls } = makeGithub({
    checks: [new CiFailed('checks did not settle')],
    threads: [],
  });
  const { state, updates } = makeState([group('solo')]);
  const loop = new WorkLoop(
    makeDeps({ orchestrator, github, state, autoMerge: true, prPerTask: true }),
  );
  await loop.runGroup(group('solo'));

  assert.equal(calls.runCiFix.length, 0, 'a timeout blocks — no fix pass runs');
  assert.equal(ghCalls.mergePr.length, 0, 'a PR whose CI never settled is never merged');
  const last = updates[updates.length - 1] as RunState;
  assert.equal(last.prGroups.find((p) => p.id === 'solo')?.status, 'blocked');
});

test('prPerTask + autoMerge + --admin: a CI poll timeout skips past CI to review, then merges', async () => {
  // The --admin CI-timeout override, previously honored only by the stage machine: a timeout
  // force-advances past CI to reviews instead of blocking. Shared via ciOutcomePolicy.
  const { orchestrator, calls } = makeOrchestrator({ prNumber: 9 });
  const { github, calls: ghCalls } = makeGithub({
    checks: [new CiFailed('checks did not settle')],
    threads: [],
  });
  const loop = new WorkLoop(
    makeDeps({
      orchestrator,
      github,
      autoMerge: true,
      prPerTask: true,
      adminMerge: true,
    }),
  );
  await loop.runGroup(group('solo'));

  assert.equal(ghCalls.waitForChecks.length, 1, 'the timeout is not re-polled — it advances');
  assert.equal(calls.runCiFix.length, 0, 'a timeout advances past CI, it does not run a fix');
  assert.deepEqual(
    ghCalls.mergePr.map((c) => c.pr),
    [9],
    '--admin force-advances the timeout to review and merges',
  );
});

test('prPerTask autoMerge: abort during the CI wait → the task PR is not merged', async () => {
  // The prPerTask flow has no stage machine to stop it: without its own post-wait check, a
  // cancelled 'pending' wait reads as "not failing" and falls straight through to the merge.
  const controller = new AbortController();
  const { github, calls: ghCalls } = makeGithub();
  const cancelling: WorkLoopGithub = {
    ...github,
    waitForChecks: async () => {
      controller.abort();
      return { state: 'pending', failedChecks: [] };
    },
  };
  const { orchestrator } = makeOrchestrator({ prNumber: 7 });
  const loop = new WorkLoop(
    makeDeps({
      orchestrator,
      github: cancelling,
      autoMerge: true,
      prPerTask: true,
      signal: controller.signal,
    }),
  );
  await loop.runGroup(group('a'));
  assert.deepEqual(ghCalls.mergePr, [], 'a cancelled run never merges');
});

test('prPerTask: a final no-changes task with nothing to ship completes the group without a PR', async () => {
  const { orchestrator, calls } = makeOrchestrator({
    workerResults: [{ kind: 'no-changes', reason: 'nothing to do' }],
  });
  const nothingToShip: WorkLoopOrchestrator = {
    ...orchestrator,
    openPr: async () => 'nothing-to-ship',
  };
  const { github, calls: ghCalls } = makeGithub({ checks: [ciSuccess], threads: [] });
  const ready = makeGraph([group('solo')], { completeAfter: 1 });
  const loop = new WorkLoop(
    makeDeps({
      orchestrator: nothingToShip,
      github,
      graph: ready.graph,
      autoMerge: true,
      prPerTask: true,
    }),
  );
  const result = await loop.run();

  assert.equal(calls.finalizeCommit.length, 0);
  assert.deepEqual(ghCalls.mergePr, []);
  assert.equal(result.outcomes[0]?.status, 'merged');
  if (result.outcomes[0]?.status === 'merged') assert.equal(result.outcomes[0].pr, null);
  assert.equal(result.kind, 'success');
});

test('ciFixFailedError: same message as before, cause is the blocked StageWorkResult', () => {
  const fix: Extract<StageWorkResult, { kind: 'blocked' }> = {
    kind: 'blocked',
    reason: 'rebase conflict',
  };
  const err = ciFixFailedError(fix);
  assert.equal(err.message, 'worker CI fix failed: rebase conflict');
  assert.equal(err.cause, fix);
});

test('reviewFailedError: same message as before, cause is the blocked StageWorkResult', () => {
  const review: Extract<StageWorkResult, { kind: 'blocked' }> = {
    kind: 'blocked',
    reason: 'push rejected',
  };
  const err = reviewFailedError(review);
  assert.equal(err.message, 'reviewer failed: push rejected');
  assert.equal(err.cause, review);
});
