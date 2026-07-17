// End-to-end: two independently-ready PR groups driven through one WorkLoop.run() against the
// single shared in-place checkout (worktrees removed — audit 02, DECISION 1). Exercises the three
// concurrency-safety guarantees from docs/plans/2026/07/17/101-aitm-audit-remediation/
// 02-parallel-team-shared-checkout.md:
//
//   1. Branch-before-editor-fanout + the driver's checkout mutex: each group's commits land only
//      on its own branch — group B's branch never carries group A's files.
//   2. Clean-tree gate at the checkout boundary (in-place-checkout.ts `ensureCleanTree`): a stray
//      uncommitted edit left on a tracked file after group A's pass is reset away before group B's
//      branch is checked out, not carried forward.
//   3. Reviewer commits to the PR head branch (reviewer.ts `commitFix`'s headBranch assertion,
//      mirrored here by the addressReviews stub): a review fix lands on the PR's own branch.
//
// WorkLoop / PlanGraph / InPlaceCheckout run against real git operations (real temp repo, real
// StateStore). The AI SDK / gh CLI are not exercised — WorkLoopOrchestrator and WorkLoopGithub are
// literal stubs (structural ports), the same pattern as start-flow.test.ts. `concurrency: 1` matches
// the only configuration the adapter ever drives in production (in-place-checkout.ts: "single-slot
// BY DESIGN... the adapter forces concurrency to 1"): both groups are simultaneously *ready*
// (PlanGraph.ready() returns both, no dependsOn between them) and are driven within a single run(),
// reusing the shared checkout back-to-back — the scenario DECISION 1 makes safe.

import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { execa } from 'execa';
import type { ReviewThread } from '../../src/github/schema.ts';
import type {
  WorkLoopGithub,
  WorkLoopOrchestrator,
  WorkLoopState,
} from '../../src/loop/work-loop.ts';
import { WorkLoop } from '../../src/loop/work-loop.ts';
import { PlanGraph } from '../../src/plan/plan-graph.ts';
import type { PrGroup, RunState } from '../../src/state/schema.ts';
import { RunStateSchema } from '../../src/state/schema.ts';
import { StateStore } from '../../src/state/state-store.ts';
import { makeTempRepo } from '../../src/testing/temp-repo.ts';
import { InPlaceCheckout } from '../../src/workspace/in-place-checkout.ts';

const PR_A = 101;
const PR_B = 102;

function baseState(): RunState {
  return RunStateSchema.parse({
    status: 'working',
    prGroups: [],
    currentGroupIndex: 0,
    currentTaskIndex: 0,
    sessionCount: 0,
    currentPr: null,
    runId: '01HFAKERUNID0000000000001',
    provider: 'openrouter',
    model: 'anthropic/claude-opus-4',
    agentConfigFile: 'CLAUDE.md',
    createdAt: '2026-07-17T00:00:00.000Z',
    updatedAt: '2026-07-17T00:00:00.000Z',
    options: {
      autoMerge: true,
      maxPrs: 5,
      maxSessions: null,
      mergeMethod: 'squash',
      stylePath: null,
      concurrency: 1,
    },
  });
}

function makeGroup(id: string): PrGroup {
  return {
    id,
    title: `work for ${id}`,
    tasks: [{ id: `${id}-t1`, text: `implement ${id}`, complexity: 'normal', done: false }],
    dependsOn: [],
    branch: `aitm/${id}`,
    pr: null,
    status: 'pending',
    stage: 'pending',
  };
}

// Files touched by commits unique to `branch` (i.e. excluding the shared base history) — using the
// full branch log would also surface files from commits both branches share (the initial commit),
// which is not what "this group's own commits" means.
async function branchFiles(cwd: string, baseBranch: string, branch: string): Promise<string[]> {
  const { stdout } = await execa(
    'git',
    ['log', '--name-only', '--pretty=format:', `${baseBranch}..${branch}`],
    { cwd },
  );
  return [
    ...new Set(
      stdout
        .split('\n')
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    ),
  ];
}

async function showFile(cwd: string, ref: string): Promise<string> {
  const { stdout } = await execa('git', ['show', ref], { cwd });
  return stdout;
}

async function fileExistsAt(cwd: string, branch: string, path: string): Promise<boolean> {
  try {
    await execa('git', ['cat-file', '-e', `${branch}:${path}`], { cwd });
    return true;
  } catch {
    return false;
  }
}

test('concurrent-groups: two ready groups share one checkout with no branch/tree/state contamination', async () => {
  const repo = await makeTempRepo({ withClaudeMd: true });
  try {
    // scratch.txt is a TRACKED file the "stray edit" test dirties without committing — it must
    // start committed so `git status --porcelain --untracked-files=no` (in-place-checkout.ts
    // ensureCleanTree) actually detects the later modification.
    await writeFile(join(repo.path, 'scratch.txt'), 'original\n');
    await execa('git', ['add', 'CLAUDE.md', 'scratch.txt'], { cwd: repo.path });
    await execa('git', ['commit', '-m', 'initial commit'], { cwd: repo.path });

    const { stdout: rawBranch } = await execa('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: repo.path,
    });
    const defaultBranch = rawBranch.trim();

    const stateDir = join(repo.path, '.ai-task-master');
    const stateStore = new StateStore(stateDir);
    const groupA = makeGroup('group-a');
    const groupB = makeGroup('group-b');
    await stateStore.init({ ...baseState(), prGroups: [groupA, groupB] });

    let liveGroups: readonly PrGroup[] = [groupA, groupB];
    const graph = {
      ready: () => new PlanGraph([...liveGroups]).ready(),
      isComplete: () => new PlanGraph([...liveGroups]).isComplete(),
    };
    // Both groups are ready from the start: neither depends on the other, so PlanGraph.ready()
    // returns both in the same batch even though the checkout only lets one run at a time.
    assert.equal(graph.ready().length, 2, 'both groups must start ready (no dependsOn)');

    const workLoopState: WorkLoopState = {
      update: async (mutator) => {
        const next = await stateStore.update(mutator);
        liveGroups = next.prGroups;
        return next;
      },
      writePlan: (groups) => stateStore.writePlan(groups),
    };

    const home = new InPlaceCheckout(repo.path);

    const prNumberFor: Record<string, number> = { 'group-a': PR_A, 'group-b': PR_B };
    let groupAThreadResolved = false;
    const mergedPrs: number[] = [];

    const orchestrator: WorkLoopOrchestrator = {
      // Simulates the Worker: writes one file named for the group and commits it. Mirrors
      // worker.ts's branch-before-edit contract by relying on the checkout the driver already
      // switched to (checkout.branch), never re-deriving a branch of its own.
      runWorker: async ({ group, checkout }) => {
        const fileName = `${group.id}.ts`;
        await writeFile(join(checkout.path, fileName), `export const id = '${group.id}';\n`);
        await execa('git', ['add', fileName], { cwd: checkout.path });
        await execa('git', ['commit', '-m', `feat: ${group.id} work`], { cwd: checkout.path });
        return {
          kind: 'ok',
          delivery: {
            branch: checkout.branch,
            draftCommitMessage: `feat: ${group.id} work`,
            changes: [{ path: fileName, kind: 'create', summary: `adds ${fileName}` }],
            progressEntries: [`- added ${fileName}`],
          },
        };
      },
      // No-op finalize: read HEAD back without mutating the tree (this test isn't exercising
      // commit-message rewriting).
      finalizeCommit: async (_group, _delivery, checkoutPath) => {
        const { stdout } = await execa('git', ['rev-parse', 'HEAD'], { cwd: checkoutPath });
        return stdout.trim();
      },
      openPr: async (group, delivery, baseBranch) => ({
        number: prNumberFor[group.id] ?? 0,
        state: 'OPEN',
        url: `https://github.com/example/repo/pull/${prNumberFor[group.id]}`,
        headRefName: delivery.branch,
        baseRefName: baseBranch,
      }),
      runReviewer: async () => ({ kind: 'ok', resolutions: [] }),
      runCiFix: async () => ({ kind: 'ok' }),
      // Simulates the Reviewer: refuses to commit unless the checked-out branch IS the PR head
      // (mirrors reviewer.ts commitFix's headBranch assertion) — a review fix committed to the
      // wrong branch under the shared checkout would silently corrupt a concurrent group's PR.
      addressReviews: async ({ pr, checkout }) => {
        const { stdout: current } = await execa('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
          cwd: checkout.path,
        });
        if (current.trim() !== checkout.branch) {
          throw new Error(
            `reviewer refusing to commit: on '${current.trim()}', expected PR head '${checkout.branch}'`,
          );
        }
        await writeFile(join(checkout.path, 'review-fix.ts'), `export const fixedPr = ${pr};\n`);
        await execa('git', ['add', 'review-fix.ts'], { cwd: checkout.path });
        await execa('git', ['commit', '-m', `fix: address review thread on PR #${pr}`], {
          cwd: checkout.path,
        });
        if (pr === PR_A) {
          groupAThreadResolved = true;
          // Simulate a crashed/leftover edit to a TRACKED file left uncommitted after this pass —
          // the next group's checkout boundary (in-place-checkout.ts ensureCleanTree) must reset
          // it away rather than carrying it onto group B's branch (audit 02).
          await writeFile(join(checkout.path, 'scratch.txt'), 'stray-from-group-a\n');
        }
        return { kind: 'ok' };
      },
    };

    const github: WorkLoopGithub = {
      defaultBranch: async () => defaultBranch,
      waitForChecks: async () => ({ state: 'success', failedChecks: [] }),
      listUnresolvedThreads: async (pr): Promise<ReviewThread[]> => {
        if (pr === PR_A && !groupAThreadResolved) {
          return [
            {
              id: 'thread-1',
              isResolved: false,
              path: 'group-a.ts',
              comments: [{ id: 'c1', author: 'reviewer-bot', body: 'please fix this' }],
            },
          ];
        }
        return [];
      },
      mergePr: async (pr) => {
        mergedPrs.push(pr);
      },
    };

    const loop = new WorkLoop({
      orchestrator,
      github,
      state: workLoopState,
      home,
      graph,
      concurrency: 1,
      autoMerge: true,
      maxSessions: null,
      // Skip the real 2-minute post-CI review grace (REVIEW_COMMENTS_GRACE) — no-op sleep.
      sleep: async () => {},
    });

    const result = await loop.run();
    assert.equal(result.kind, 'success', `expected success, got: ${JSON.stringify(result)}`);

    // ── 1. Each group committed only its own files to its own branch ──────────────────────────
    const filesOnA = await branchFiles(repo.path, defaultBranch, 'aitm/group-a');
    const filesOnB = await branchFiles(repo.path, defaultBranch, 'aitm/group-b');
    assert.ok(filesOnA.includes('group-a.ts'), `group-a.ts missing from aitm/group-a: ${filesOnA}`);
    assert.ok(!filesOnA.includes('group-b.ts'), `group-b.ts leaked onto aitm/group-a: ${filesOnA}`);
    assert.ok(filesOnB.includes('group-b.ts'), `group-b.ts missing from aitm/group-b: ${filesOnB}`);
    assert.ok(!filesOnB.includes('group-a.ts'), `group-a.ts leaked onto aitm/group-b: ${filesOnB}`);
    assert.equal(
      await fileExistsAt(repo.path, 'aitm/group-b', 'group-a.ts'),
      false,
      'aitm/group-b tree must not contain group-a.ts',
    );
    assert.equal(
      await fileExistsAt(repo.path, 'aitm/group-a', 'group-b.ts'),
      false,
      'aitm/group-a tree must not contain group-b.ts',
    );

    // ── 2. Dirty tree cleaned at the checkout boundary ─────────────────────────────────────────
    // group A left scratch.txt dirty (stray-from-group-a, uncommitted); group B's checkout
    // acquisition must have reset it away before branching, so group B never saw — let alone
    // committed — that stray edit.
    const scratchOnB = await showFile(repo.path, 'aitm/group-b:scratch.txt');
    assert.equal(
      scratchOnB,
      'original',
      `stray edit from group A leaked onto aitm/group-b: ${JSON.stringify(scratchOnB)}`,
    );
    assert.ok(
      !filesOnB.includes('scratch.txt'),
      `group B must never have committed the stray scratch.txt edit: ${filesOnB}`,
    );
    // --untracked-files=no: aitm's own state dir is deliberately untracked (never committed, see
    // stageAndCommit in worker.ts) and isn't gitignored in this fixture, so it's excluded here the
    // same way in-place-checkout.ts's ensureCleanTree excludes it from the dirty check.
    const { stdout: finalStatus } = await execa(
      'git',
      ['status', '--porcelain', '--untracked-files=no'],
      { cwd: repo.path },
    );
    assert.equal(
      finalStatus.trim(),
      '',
      `working tree must be clean after run(), got:\n${finalStatus}`,
    );

    // ── 3. Reviewer fix landed on the PR head branch ───────────────────────────────────────────
    assert.ok(
      filesOnA.includes('review-fix.ts'),
      `review-fix.ts missing from aitm/group-a (reviewer must commit to the PR head): ${filesOnA}`,
    );
    assert.ok(
      !filesOnB.includes('review-fix.ts'),
      `review fix for PR #${PR_A} leaked onto aitm/group-b: ${filesOnB}`,
    );
    const { stdout: fixLog } = await execa(
      'git',
      ['log', '--pretty=%s', 'aitm/group-a', '--', 'review-fix.ts'],
      { cwd: repo.path },
    );
    assert.match(fixLog, new RegExp(`address review thread on PR #${PR_A}`));

    // ── 4. No state cross-contamination between the two groups ────────────────────────────────
    const state = await stateStore.read();
    const a = state.prGroups.find((g) => g.id === 'group-a');
    const b = state.prGroups.find((g) => g.id === 'group-b');
    assert.ok(a && b, 'both groups must still be present in state');
    assert.equal(a?.status, 'merged');
    assert.equal(a?.pr, PR_A);
    assert.equal(a?.branch, 'aitm/group-a');
    assert.equal(b?.status, 'merged');
    assert.equal(b?.pr, PR_B);
    assert.equal(b?.branch, 'aitm/group-b');
    assert.deepEqual(mergedPrs.slice().sort(), [PR_A, PR_B]);
  } finally {
    await repo.cleanup();
  }
});
