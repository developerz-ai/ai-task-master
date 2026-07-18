// Integration: mid-write crash → resume reads last good state.
//
// aitm's only durability primitive is atomicWrite (fs/atomic-write.ts): temp file + fsync +
// rename + parent-dir fsync. StateStore and TranscriptStore build .ai-task-master/ persistence on
// top of it. This file exercises the crash boundary those modules promise to survive, using the
// same fault-injection technique as fs/atomic-write.test.ts (patching FileHandle.prototype.sync,
// the shared module boundary) plus direct filesystem surgery to model what a `kill -9` actually
// leaves behind: an orphaned `.tmp` file nobody ran cleanup code for, or a transcript line cut off
// mid-flush. Every scenario re-opens the state dir with a FRESH StateStore/TranscriptStore
// instance afterward — the same thing a resumed process does — and asserts it reads the last
// completed write, never a partial one.
//
// docs/plans/2026/07/17/101-aitm-audit-remediation/07-tests.md success criterion 4: "mid-write
// crash loses no completed rename, leaves no orphan temp; corrupt transcript line skips+warns".

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FileHandle } from 'node:fs/promises';
import {
  appendFile,
  mkdtemp,
  open,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ModelMessage } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { execa } from 'execa';
import { runStart } from '../../src/cli/commands.ts';
import { normalizeResumeStatus } from '../../src/loop/resume-normalize.ts';
import {
  handlePrOpen,
  type StageDeps,
  type StageGithub,
  type StageOrchestrator,
} from '../../src/loop/stage-handlers.ts';
import {
  type CheckoutHome,
  WorkLoop,
  type WorkLoopGithub,
  type WorkLoopGraph,
  type WorkLoopOrchestrator,
  type WorkLoopState,
} from '../../src/loop/work-loop.ts';
import { Orchestrator } from '../../src/orchestrator/orchestrator.ts';
import { PlanGraph } from '../../src/plan/plan-graph.ts';
import { type PrGroup, type RunState, RunStateSchema } from '../../src/state/schema.ts';
import { StateStore } from '../../src/state/state-store.ts';
import { TranscriptStore } from '../../src/state/transcript-store.ts';
import { makeTempRepo } from '../../src/testing/temp-repo.ts';
import { InPlaceCheckout } from '../../src/workspace/in-place-checkout.ts';

function baseState(overrides: Partial<RunState> = {}): RunState {
  return RunStateSchema.parse({
    status: 'planning',
    prGroups: [],
    currentGroupIndex: 0,
    currentTaskIndex: 0,
    sessionCount: 0,
    currentPr: null,
    runId: 'crash-durability-run',
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
    ...overrides,
  });
}

const msg = (role: 'user' | 'assistant', text: string): ModelMessage => ({ role, content: text });

// Arms a one-shot fault on FileHandle.prototype.sync: the next call throws `err`, every call
// before or after runs the real implementation untouched. Mirrors the crash instant a `kill -9`
// models — the process dies between the file write landing on disk and the rename that would have
// made it visible, so atomicWrite's own catch (rm the orphan tmp, rethrow) is what runs, not a
// clean unwind of StateStore.update().
async function withArmedSyncFault<T>(err: Error, body: () => Promise<T>): Promise<T> {
  const probePath = join(tmpdir(), `sync-probe-${randomUUID()}`);
  const probe = await open(probePath, 'w');
  const proto = Object.getPrototypeOf(probe) as { sync: (this: FileHandle) => Promise<void> };
  const real = proto.sync;
  await probe.close();
  await rm(probePath, { force: true });
  let armed = true;
  proto.sync = async function armedSync(this: FileHandle) {
    if (armed) {
      armed = false;
      throw err;
    }
    return real.call(this);
  };
  try {
    return await body();
  } finally {
    proto.sync = real;
  }
}

async function tmpArtifacts(dir: string): Promise<string[]> {
  return (await readdir(dir)).filter((f) => f.endsWith('.tmp'));
}

// ---------------------------------------------------------------------------
// StateStore
// ---------------------------------------------------------------------------

test('crash-durability: fsync failure before rename leaves prior state.json intact, no orphan tmp, resume reads last good state', async () => {
  const repo = await makeTempRepo();
  try {
    const stateDir = join(repo.path, '.ai-task-master');
    const store = new StateStore(stateDir);
    await store.init(baseState({ status: 'planning' }));
    await store.update((s) => ({ ...s, status: 'working' }));

    const crashErr = Object.assign(new Error('power loss mid-fsync'), { code: 'EIO' });
    await withArmedSyncFault(crashErr, async () => {
      await assert.rejects(
        store.update((s) => ({ ...s, status: 'awaiting-pr' })),
        /power loss mid-fsync/,
      );
    });

    // atomicWrite's own failure path removes the orphan temp it created before rethrowing.
    assert.deepEqual(
      await tmpArtifacts(stateDir),
      [],
      'a failed write must not leave a .tmp file behind',
    );

    // Resume: a fresh StateStore (new process) must read the last COMPLETED write, not a partial
    // or missing one — the crashed write never renamed, so state.json is still the pre-crash value.
    const resumed = new StateStore(stateDir);
    const state = await resumed.read();
    assert.equal(
      state.status,
      'working',
      'resume must read the last good state, not the crashed one',
    );

    // The store must remain usable after the crash — the next write is not poisoned by the failure.
    const recovered = await resumed.update((s) => ({ ...s, status: 'awaiting-pr' }));
    assert.equal(recovered.status, 'awaiting-pr');
  } finally {
    await repo.cleanup();
  }
});

test('crash-durability: an orphaned .tmp file left by a hard kill does not block or corrupt resume', async () => {
  const repo = await makeTempRepo();
  try {
    const stateDir = join(repo.path, '.ai-task-master');
    const store = new StateStore(stateDir);
    await store.init(baseState({ status: 'planning' }));
    await store.update((s) => ({ ...s, status: 'working', sessionCount: 1 }));

    // A `kill -9` between the write landing and the rename runs no unwind code at all — unlike the
    // fault-injection case above, the orphan temp is never cleaned up. Model that directly: drop a
    // garbage file matching atomicWrite's naming convention next to the real state.json.
    const orphan = join(stateDir, `state.json.${randomUUID()}.tmp`);
    await appendFile(orphan, '{"status":"working","sessionCount":2, // truncated garbage');

    // Resume: the orphan must be inert — read() only ever looks at state.json.
    const resumed = new StateStore(stateDir);
    const state = await resumed.read();
    assert.equal(state.status, 'working');
    assert.equal(state.sessionCount, 1, 'orphan tmp content must never be read as live state');

    // Further writes must succeed despite the orphan sharing the directory (distinct random
    // suffix per atomicWrite call means no collision).
    const next = await resumed.update((s) => ({ ...s, sessionCount: 2 }));
    assert.equal(next.sessionCount, 2);

    const reread = await resumed.read();
    assert.equal(reread.sessionCount, 2);
  } finally {
    await repo.cleanup();
  }
});

// ---------------------------------------------------------------------------
// TranscriptStore
// ---------------------------------------------------------------------------

test('crash-durability: a transcript line truncated mid-append by a crash is skipped; prior steps resume intact', async () => {
  const repo = await makeTempRepo();
  try {
    const stateDir = join(repo.path, '.ai-task-master');
    const warns: string[] = [];
    const transcripts = new TranscriptStore(stateDir, (m) => warns.push(m));

    const recorder = await transcripts.begin({ group: 'group-a', stage: 'working' });
    await recorder.step([msg('user', 'do the task')]);
    await recorder.step([msg('assistant', 'working on it')]);

    // Find the file begin()/step() just wrote to, then simulate the crash: appendFile writing the
    // NEXT record only got partway to disk before power loss, leaving a truncated, unparseable tail
    // (no closing brace, no trailing newline) after the two good lines.
    const groupDir = join(stateDir, 'transcripts', 'group-a');
    const [file] = (await readdir(groupDir)).filter((f) => f.startsWith('working-'));
    assert.ok(file, 'expected one working-*.jsonl transcript file');
    const transcriptPath = join(groupDir, file);
    await appendFile(transcriptPath, '\n{"kind":"step","ts":"t3","messages":[{"role":"assist');

    // Resume: a fresh TranscriptStore (new process) must reconstruct only the complete steps.
    const resumedWarns: string[] = [];
    const resumed = new TranscriptStore(stateDir, (m) => resumedWarns.push(m));
    const result = await resumed.findResumable('group-a', 'working');
    assert.ok(result !== null, 'an interrupted transcript with good steps must be resumable');
    assert.deepEqual(result.messages, [
      msg('user', 'do the task'),
      msg('assistant', 'working on it'),
    ]);
    assert.ok(
      resumedWarns.length > 0,
      'the truncated tail must be warned about, not silently dropped',
    );
  } finally {
    await repo.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Combined: StateStore + TranscriptStore crash together, one resume
// ---------------------------------------------------------------------------

test('crash-durability: state write and transcript append crash together; resume reads the last good state and transcript', async () => {
  const repo = await makeTempRepo();
  try {
    const stateDir = join(repo.path, '.ai-task-master');
    const store = new StateStore(stateDir);
    await store.init(baseState({ status: 'planning' }));
    await store.update((s) => ({ ...s, status: 'working' }));

    const transcripts = store.transcripts();
    const recorder = await transcripts.begin({ group: 'group-a', stage: 'working' });
    await recorder.step([msg('user', 'goal: add hello')]);

    // Crash: the in-flight state update loses its fsync (before rename) at the same instant the
    // in-flight transcript append gets cut off mid-line — both artifacts a real `kill -9` between
    // two nearly-simultaneous writes would produce.
    const crashErr = Object.assign(new Error('power loss'), { code: 'EIO' });
    await withArmedSyncFault(crashErr, async () => {
      await assert.rejects(store.update((s) => ({ ...s, status: 'awaiting-pr', currentPr: 7 })));
    });
    const groupDir = join(stateDir, 'transcripts', 'group-a');
    const [file] = (await readdir(groupDir)).filter((f) => f.startsWith('working-'));
    assert.ok(file, 'expected one working-*.jsonl transcript file');
    await appendFile(join(groupDir, file), '\n{"kind":"step","ts":"crash","messages":[{"rol');

    // No orphan tmp from the crashed state write.
    assert.deepEqual(await tmpArtifacts(stateDir), []);

    // Resume with fresh instances against the same dir — the production restart path.
    const resumedStore = new StateStore(stateDir);
    const resumedState = await resumedStore.read();
    assert.equal(resumedState.status, 'working', 'resume must see the last committed status');
    assert.equal(
      resumedState.currentPr,
      null,
      'the crashed update must not have partially applied',
    );

    const resumedTranscripts = resumedStore.transcripts();
    const resumable = await resumedTranscripts.findResumable('group-a', 'working');
    assert.ok(resumable !== null);
    assert.deepEqual(resumable.messages, [msg('user', 'goal: add hello')]);

    // The run continues normally after resume: further state and transcript writes succeed. A new
    // ordinal is reserved for the target rather than appending onto the crash-tailed file, so the
    // corrupt tail can never resurface into a live conversation.
    const advanced = await resumedStore.update((s) => ({
      ...s,
      status: 'awaiting-pr',
      currentPr: 7,
    }));
    assert.equal(advanced.currentPr, 7);
    const resumedRecorder = await resumedTranscripts.begin({ group: 'group-a', stage: 'working' });
    await resumedRecorder.step([msg('assistant', 'created hello.ts')]);
    await resumedRecorder.end('submitted');

    const raw = await readFile(join(groupDir, 'working-2.jsonl'), 'utf8');
    assert.match(raw, /"kind":"run-end"/);
    assert.doesNotMatch(
      raw,
      /crash/,
      'the fresh transcript must not carry the crash-tailed content',
    );
  } finally {
    await repo.cleanup();
  }
});

// ---------------------------------------------------------------------------
// PR-lifecycle crash boundary: kill between the PR-open side effect and the stage persist
// ---------------------------------------------------------------------------
//
// docs/plans/2026/07/18/101-parallel-agent-bug-hunt/01-pr-lifecycle-idempotency.md — the crash this
// models is a `kill -9` that lands after `gh pr create` (an external side effect on GitHub, which
// survives the crash) but before WorkLoop persists the PR number to state.json. Before the fix
// (github-client.ts createPr / stage-handlers.ts handlePrOpen), a resume in this window called
// `gh pr create` again, which GitHub rejects for a branch that already has an open PR — permanently
// blocking the group. The fix adopts the existing PR instead. This test drives the real
// `handlePrOpen` stage handler (not a reimplementation) against a real StateStore with the same
// fault-injection technique as the rest of this file, then a real WorkLoop to prove the group
// actually completes on resume instead of landing anywhere near `blocked`.

function crashGroup(overrides: Partial<PrGroup> = {}): PrGroup {
  return {
    id: 'g1',
    title: 'add hello',
    tasks: [{ id: 't1', text: 'add hello', complexity: 'normal', done: true }],
    dependsOn: [],
    branch: 'aitm/g1',
    pr: null,
    status: 'in-progress',
    stage: 'pr-open',
    ...overrides,
  };
}

// Fake GitHub remote: a Map that outlives the crash (an external system, not process memory),
// mirroring the real GitHubClient.createPr contract — adopt the existing PR for a branch instead of
// creating a duplicate. `createCalls` counts genuine creates only; an adopt never increments it.
function makeFakeRemote(): { openPr: StageOrchestrator['openPr']; createCalls: () => number } {
  const remote = new Map<string, number>();
  let createCalls = 0;
  return {
    openPr: async (group) => {
      const branch = group.branch ?? `aitm/${group.id}`;
      const existing = remote.get(branch);
      if (existing !== undefined) return existing;
      createCalls += 1;
      const pr = 501;
      remote.set(branch, pr);
      return pr;
    },
    createCalls: () => createCalls,
  };
}

test('crash-durability: kill between the PR-open side effect and the stage persist — resume adopts the existing PR, group completes without ever blocking', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'aitm-crash-pr-'));
  try {
    const store = new StateStore(stateDir);
    await store.init(baseState({ status: 'working', prGroups: [crashGroup()] }));

    const remote = makeFakeRemote();
    const stageGithub: StageGithub = {
      waitForChecks: async () => ({ state: 'success', failedChecks: [] }),
      listUnresolvedThreads: async () => [],
      mergePr: async () => {},
    };
    const stageOrchestrator: StageOrchestrator = {
      work: async () => {
        assert.fail('work() must not run — the group resumes past the working stage');
      },
      openPr: remote.openPr,
      fixCi: async () => {
        assert.fail('fixCi() must not run — CI succeeds');
      },
      addressReviews: async () => {
        assert.fail('addressReviews() must not run — no unresolved threads');
      },
    };

    // ── Crash: gh pr create lands (createCalls 0 → 1), then handlePrOpen's own state.update dies
    // mid-fsync — the exact instant a `kill -9` between PR creation and persisting the PR number
    // would land. Same fault-injection technique as the rest of this file.
    const crashErr = Object.assign(new Error('power loss mid-fsync'), { code: 'EIO' });
    const deps1: StageDeps = { github: stageGithub, orchestrator: stageOrchestrator, state: store };
    await withArmedSyncFault(crashErr, async () => {
      await assert.rejects(handlePrOpen(deps1, crashGroup()), /power loss mid-fsync/);
    });
    assert.equal(remote.createCalls(), 1, 'the PR-open side effect landed exactly once');
    assert.deepEqual(
      await tmpArtifacts(stateDir),
      [],
      'a failed write must not leave a .tmp file behind',
    );

    // The crashed write never renamed — state.json still shows no PR.
    const crashed = await store.read();
    const crashedGroup = crashed.prGroups[0];
    assert.ok(crashedGroup, 'group must survive the crash');
    assert.equal(crashedGroup.pr, null, 'the crashed write must not have partially applied');
    assert.equal(crashedGroup.stage, 'pr-open');

    // ── Resume, attempt 1: a fresh StateStore (new process) re-reads group.pr as still null, so
    // handlePrOpen calls openPr again. It must adopt the SAME PR rather than create a duplicate.
    const resumedStore = new StateStore(stateDir);
    const resumedState = await resumedStore.read();
    const resumedGroup = resumedState.prGroups[0];
    assert.ok(resumedGroup, 'group must be readable on resume');
    const deps2: StageDeps = {
      github: stageGithub,
      orchestrator: stageOrchestrator,
      state: resumedStore,
    };
    const nextStage = await handlePrOpen(deps2, resumedGroup);
    assert.equal(nextStage, 'waiting-ci');
    assert.equal(
      remote.createCalls(),
      1,
      'resume must adopt the existing PR, not open a duplicate',
    );

    const afterAdopt = await resumedStore.read();
    const afterAdoptGroup = afterAdopt.prGroups[0];
    assert.ok(afterAdoptGroup);
    assert.equal(afterAdoptGroup.pr, 501, 'the adopted PR number must be persisted');
    assert.notEqual(afterAdoptGroup.status, 'blocked', 'no recoverable state may reach blocked');

    // ── Resume, attempt 2: drive the real WorkLoop from the persisted (still stage:'pr-open',
    // status:'in-progress') group through to a clean merge — the same normalization the production
    // resume path applies (normalizeResumeStatus) before the graph schedules the group again.
    await resumedStore.update((s) => ({ ...s, prGroups: normalizeResumeStatus(s.prGroups) }));

    let liveGroups: readonly PrGroup[] = (await resumedStore.read()).prGroups;
    const workLoopState: WorkLoopState = {
      update: async (mutator) => {
        const next = await resumedStore.update(mutator);
        liveGroups = next.prGroups;
        return next;
      },
    };
    const graph: WorkLoopGraph = {
      ready: () => new PlanGraph([...liveGroups]).ready(),
      isComplete: () => new PlanGraph([...liveGroups]).isComplete(),
    };
    const home: CheckoutHome = {
      acquire: async (groupId, branch) => ({ groupId, branch, path: stateDir }),
      release: async () => {},
    };
    let openPrCalls = 0;
    const workLoopOrchestrator: WorkLoopOrchestrator = {
      runWorker: async () => {
        assert.fail('runWorker must not run — the group already has an open PR');
      },
      finalizeCommit: async () => {
        assert.fail('finalizeCommit must not run — the group already has an open PR');
      },
      openPr: async () => {
        // handlePrOpen's own `group.pr !== null` guard must short-circuit before this is ever
        // reached — proves the idempotent-open fix, not just this test's fake.
        openPrCalls += 1;
        return {
          number: 999,
          state: 'OPEN',
          url: 'unused',
          headRefName: 'aitm/g1',
          baseRefName: 'main',
        };
      },
      runCiFix: async () => {
        assert.fail('runCiFix must not run — CI succeeds');
      },
      addressReviews: async () => {
        assert.fail('addressReviews must not run — no unresolved threads');
      },
    };
    let mergeCalls = 0;
    const workLoopGithub: WorkLoopGithub = {
      defaultBranch: async () => 'main',
      waitForChecks: async () => ({ state: 'success', failedChecks: [] }),
      listUnresolvedThreads: async () => [],
      mergePr: async () => {
        mergeCalls += 1;
      },
    };

    const loop = new WorkLoop({
      orchestrator: workLoopOrchestrator,
      github: workLoopGithub,
      state: workLoopState,
      home,
      graph,
      concurrency: 1,
      autoMerge: true,
      maxSessions: null,
      sleep: async () => {},
    });
    const result = await loop.run();

    assert.equal(
      result.kind,
      'success',
      `expected the resumed group to complete cleanly, got: ${JSON.stringify(result)}`,
    );
    assert.equal(openPrCalls, 0, 'openPr must never run again once a PR is already persisted');
    assert.equal(mergeCalls, 1, 'the group must merge exactly once');
    assert.equal(remote.createCalls(), 1, 'exactly one PR must ever exist for the branch');

    const final = await resumedStore.read();
    const finalGroup = final.prGroups[0];
    assert.ok(finalGroup);
    assert.equal(finalGroup.status, 'merged');
    assert.equal(finalGroup.stage, 'merged');
    assert.equal(finalGroup.pr, 501);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Task-commit crash boundary: kill after the Worker's commit lands, before completeTask persists
// ---------------------------------------------------------------------------
//
// docs/plans/2026/07/18/101-parallel-agent-bug-hunt/03-review-loop-idempotency.md, durability #7.
// The crash this models is a `kill -9` that lands after WorkLoop.runOneTask's finalizeCommit (a
// real `git commit --amend`, on GitHub-independent local disk state that survives the crash) but
// before completeTask persists the task as done in state.json. Before the fix, a resume in this
// window re-ran the Worker for the same task, landing a SECOND commit on the reused branch — a
// silent duplicate under merge/rebase merge methods (squash tolerates it, since the whole group
// collapses into one commit anyway). The fix stamps a deterministic trailer on every task commit
// (workspace/task-commit-marker.ts) and greps for it on resume (InPlaceCheckout.hasTaskCommit) so
// runOneTask skips straight to completeTask instead. This test drives the real Orchestrator.
// finalizeCommit (real trailer stamp) and a real InPlaceCheckout (real git-log detection) against a
// real temp repo, then a real WorkLoop resume, and counts actual `git log` commits to prove no
// duplicate lands.

function mockModel(): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: 'text' as const, text: 'feat: add hello' }],
      finishReason: { unified: 'stop' as const, raw: 'stop' },
      usage: {
        inputTokens: {
          total: 10 as number | undefined,
          noCache: 10 as number | undefined,
          cacheRead: undefined as number | undefined,
          cacheWrite: undefined as number | undefined,
        },
        outputTokens: {
          total: 5 as number | undefined,
          text: 5 as number | undefined,
          reasoning: undefined as number | undefined,
        },
      },
      warnings: [],
    }),
  });
}

async function commitCount(cwd: string, branch: string): Promise<number> {
  const { stdout } = await execa('git', ['log', branch, '--oneline'], { cwd });
  return stdout.split('\n').filter((line) => line.trim().length > 0).length;
}

test('crash-durability: kill after a task commit lands but before completeTask persists — resume detects it via git log, skips the Worker, and does not double the commit', async () => {
  const repo = await makeTempRepo();
  try {
    await execa('git', ['symbolic-ref', 'HEAD', 'refs/heads/main'], { cwd: repo.path });
    await execa('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: repo.path });

    const stateDir = join(repo.path, '.ai-task-master');
    const store = new StateStore(stateDir);
    const twoTaskGroup: PrGroup = {
      id: 'g1',
      title: 'add hello and world',
      tasks: [
        { id: 't1', text: 'add hello.ts', complexity: 'normal', done: false },
        { id: 't2', text: 'add world.ts', complexity: 'normal', done: false },
      ],
      dependsOn: [],
      branch: 'aitm/g1',
      pr: null,
      status: 'in-progress',
      stage: 'working',
    };
    await store.init(baseState({ status: 'working', prGroups: [twoTaskGroup] }));

    const orch = new Orchestrator({
      credentials: { modelFor: () => mockModel() },
      agentConfig: { flavor: 'claude', path: '/tmp/CLAUDE.md', contents: '' },
      rollingContext: '',
      maxSessions: null,
      github: {
        createPr: async () => {
          throw new Error('createPr must not be called from finalizeCommit');
        },
      },
    });

    // ── Pre-crash: task t1's Worker pass + finalizeCommit land for real (the trailer-stamped
    // amend), but completeTask (which would persist tasks[0].done = true) never runs — the exact
    // instant a `kill -9` between the two would land.
    const home = new InPlaceCheckout(repo.path);
    const checkout = await home.acquire('g1', 'aitm/g1', 'main');
    await writeFile(join(checkout.path, 'hello.ts'), 'export const hello = "hello";\n');
    await execa('git', ['add', 'hello.ts'], { cwd: checkout.path });
    await execa('git', ['commit', '-m', 'wip: add hello'], { cwd: checkout.path });
    await orch.finalizeCommit(
      twoTaskGroup,
      {
        branch: 'aitm/g1',
        draftCommitMessage: 'feat: add hello',
        changes: [{ path: 'hello.ts', kind: 'create', summary: 'creates hello export' }],
        progressEntries: ['- add hello.ts'],
      },
      checkout.path,
      't1',
    );

    const preResumeCommits = await commitCount(repo.path, 'aitm/g1');

    // state.json still shows both tasks undone — the crash landed before completeTask's write.
    const crashed = await store.read();
    assert.deepEqual(
      crashed.prGroups[0]?.tasks.map((t) => t.done),
      [false, false],
      'the crashed write must not have marked t1 done',
    );

    // The crashed group is still persisted 'in-progress' — the same production normalization
    // runStart applies on resume (normalizeResumeStatus) so PlanGraph.ready() schedules it again.
    await store.update((s) => ({ ...s, prGroups: normalizeResumeStatus(s.prGroups) }));

    // ── Resume: fresh instances (new process) drive the group from persisted state. t1's Worker
    // must never run again; t2's Worker must run exactly once.
    const resumedStore = new StateStore(stateDir);
    let liveGroups: readonly PrGroup[] = (await resumedStore.read()).prGroups;
    const workLoopState: WorkLoopState = {
      update: async (mutator) => {
        const next = await resumedStore.update(mutator);
        liveGroups = next.prGroups;
        return next;
      },
    };
    const graph: WorkLoopGraph = {
      ready: () => new PlanGraph([...liveGroups]).ready(),
      isComplete: () => new PlanGraph([...liveGroups]).isComplete(),
    };
    const resumedHome = new InPlaceCheckout(repo.path);

    let workerCallsForT1 = 0;
    let workerCallsForT2 = 0;
    let finalizeCallsForT1 = 0;
    const workLoopOrchestrator: WorkLoopOrchestrator = {
      runWorker: async ({ task, checkout: co }) => {
        if (task?.id === 't1') {
          workerCallsForT1 += 1;
          return {
            kind: 'blocked',
            reason: 'must not re-run the Worker for an already-committed task',
          };
        }
        workerCallsForT2 += 1;
        await writeFile(join(co.path, 'world.ts'), 'export const world = "world";\n');
        await execa('git', ['add', 'world.ts'], { cwd: co.path });
        await execa('git', ['commit', '-m', 'wip: add world'], { cwd: co.path });
        return {
          kind: 'ok',
          delivery: {
            branch: 'aitm/g1',
            draftCommitMessage: 'feat: add world',
            changes: [{ path: 'world.ts', kind: 'create', summary: 'creates world export' }],
            progressEntries: ['- add world.ts'],
          },
        };
      },
      finalizeCommit: async (group, delivery, checkoutPath, taskId) => {
        if (taskId === 't1') finalizeCallsForT1 += 1;
        return orch.finalizeCommit(group, delivery, checkoutPath, taskId);
      },
      openPr: async (group, _delivery, baseBranch) => ({
        number: 1,
        state: 'OPEN',
        url: 'https://github.com/example/repo/pull/1',
        headRefName: group.branch ?? 'aitm/g1',
        baseRefName: baseBranch,
      }),
      runCiFix: async () => {
        assert.fail('runCiFix must not run — no CI in this scenario');
      },
      addressReviews: async () => {
        assert.fail('addressReviews must not run — no threads in this scenario');
      },
    };
    const workLoopGithub: WorkLoopGithub = {
      defaultBranch: async () => 'main',
      waitForChecks: async () => ({ state: 'success', failedChecks: [] }),
      listUnresolvedThreads: async () => [],
      mergePr: async () => {
        assert.fail('mergePr must not run — autoMerge is off');
      },
    };

    const loop = new WorkLoop({
      orchestrator: workLoopOrchestrator,
      github: workLoopGithub,
      state: workLoopState,
      home: resumedHome,
      graph,
      concurrency: 1,
      autoMerge: false,
      maxSessions: null,
    });
    const result = await loop.run();

    assert.equal(
      workerCallsForT1,
      0,
      'the already-committed task must never re-run the Worker on resume',
    );
    assert.equal(finalizeCallsForT1, 0, 'no second finalizeCommit for the already-committed task');
    assert.equal(workerCallsForT2, 1, 'the still-pending task must run the Worker exactly once');

    const postResumeCommits = await commitCount(repo.path, 'aitm/g1');
    assert.equal(
      postResumeCommits,
      preResumeCommits + 1,
      'exactly one NEW commit (t2) must land on resume — t1 must not be duplicated',
    );

    assert.equal(
      result.kind,
      'awaiting-pr',
      `expected the resumed group to complete cleanly, got: ${JSON.stringify(result)}`,
    );

    const final = await resumedStore.read();
    const finalGroup = final.prGroups[0];
    assert.ok(finalGroup);
    assert.deepEqual(
      finalGroup.tasks.map((t) => t.done),
      [true, true],
      'both tasks are marked done — t1 via the resume detection, t2 via a fresh Worker pass',
    );
  } finally {
    await repo.cleanup();
  }
});

// ---------------------------------------------------------------------------
// prPerTask + no-automerge: rejected up front, before any side effect — nothing to crash-recover
// ---------------------------------------------------------------------------
//
// 01-pr-lifecycle-idempotency.md T2/owner decision: per-task PR isolation resets each task's branch
// off the base the PREVIOUS task's PR merged into. Without auto-merge there is no merged base
// mid-group, so every task piles onto one branch and only the first PR can open — a by-design
// duplicate-PR-create GitHub rejects. The chosen fix (commands.ts runStart) rejects the combo before
// state.init, detect, auth, or the loop ever run, so there is no crash window to test here — the
// integration-level guarantee this asserts is that no side effect (no .ai-task-master dir, no git
// branch, no loop invocation) happens at all for this combo, in a real repo.
test('crash-durability: prPerTask + no-automerge is rejected before any side effect — no state, no branch, no loop', async () => {
  const repo = await makeTempRepo({ withClaudeMd: true });
  try {
    const result = await runStart(
      { kind: 'start', goal: 'add hello', prPerTask: true, autoMerge: false },
      {
        cwd: repo.path,
        homeDir: repo.path,
        env: { OPENROUTER_API_KEY: 'test-key-x' },
        authStatus: async () => ({ ok: true, scopes: ['repo'] }),
        runLoop: async () => {
          assert.fail('runLoop must not run for a rejected --pr-per-task/--no-automerge combo');
        },
      },
    );

    assert.equal(result.code, 1, `expected exit 1, got ${result.code}: ${result.message ?? ''}`);
    assert.match(result.message ?? '', /--pr-per-task/);

    await assert.rejects(
      stat(join(repo.path, '.ai-task-master')),
      /ENOENT/,
      'no .ai-task-master state must be created for a rejected combo',
    );

    const { stdout: branches } = await execa('git', ['branch', '--list', 'aitm/*'], {
      cwd: repo.path,
    });
    assert.equal(branches.trim(), '', 'no aitm/* branch must be created for a rejected combo');
  } finally {
    await repo.cleanup();
  }
});
