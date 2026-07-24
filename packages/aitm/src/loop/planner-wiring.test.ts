// Unit coverage for planner-wiring.ts: turning an accepted Plan into persisted PrGroups (branch
// assignment + dedupe against the remote) and driving the real Planner subagent. Extracted from
// run-loop-adapter.test.ts (split alongside the source module in the loop/ SRP sweep) so this module
// ships with its own paired test file.

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { MockLanguageModelV3 } from 'ai/test';
import { execa } from 'execa';
import type { RunLoopInput } from '../composition/run-input.ts';
import type { McpClientManager } from '../mcp/mcp-client.ts';
import type { Plan } from '../plan/schema.ts';
import { StateStore } from '../state/state-store.ts';
import { SCOUT_LENSES, SCOUT_REPO_FILE_FLOOR } from '../subagents/planner-scouts.ts';
import { makeTempRepo } from '../testing/temp-repo.ts';
import {
  branchFor,
  defaultPlanGroups,
  parseRemoteHeads,
  planToPrGroups,
  remoteBranchNames,
  surveyRepoForPlanner,
} from './planner-wiring.ts';

// ---- planToPrGroups (pure) -------------------------------------------------

test('planToPrGroups maps plan groups to pending PrGroups with aitm/<id> branches', () => {
  const plan: Plan = {
    goal: 'g',
    groups: [
      {
        id: 'core',
        title: 'Core',
        acceptance: 'the check that proves it done',
        tasks: [
          { description: 'a', complexity: 'complex' },
          { description: 'b', complexity: 'normal' },
        ],
        dependsOn: [],
      },
      {
        id: 'api',
        title: 'API',
        acceptance: 'the check that proves it done',
        tasks: [{ description: 'c', complexity: 'simple' }],
        dependsOn: ['core'],
      },
    ],
  };
  const groups = planToPrGroups(plan);
  assert.deepEqual(
    groups.map((g) => ({
      id: g.id,
      branch: g.branch,
      status: g.status,
      tasks: g.tasks,
      dependsOn: g.dependsOn,
    })),
    [
      {
        id: 'core',
        branch: 'aitm/core',
        status: 'pending',
        tasks: [
          { id: 'core-1', text: 'a', complexity: 'complex', done: false },
          { id: 'core-2', text: 'b', complexity: 'normal', done: false },
        ],
        dependsOn: [],
      },
      {
        id: 'api',
        branch: 'aitm/api',
        status: 'pending',
        tasks: [{ id: 'api-1', text: 'c', complexity: 'simple', done: false }],
        dependsOn: ['core'],
      },
    ],
  );
});

// ---- branchFor / caller-specified branch -----------------------------------

test('branchFor: no requested branch defaults to aitm/<id>', () => {
  assert.equal(branchFor('core', undefined, 1), 'aitm/core');
  assert.equal(branchFor('core', undefined, 3), 'aitm/core');
});

test('branchFor: single group uses the requested branch verbatim', () => {
  assert.equal(branchFor('core', 'feature/login', 1), 'feature/login');
});

test('branchFor: multiple groups prefix the requested branch per group', () => {
  assert.equal(branchFor('core', 'feature/login', 2), 'feature/login/core');
  assert.equal(branchFor('api', 'feature/login', 2), 'feature/login/api');
});

test('branchFor: the group title becomes a readable slug on the branch', () => {
  assert.equal(branchFor('G1', undefined, 2, 'Add todo CRUD'), 'aitm/G1-add-todo-crud');
  assert.equal(
    branchFor('G1', 'feature/login', 2, 'Add todo CRUD'),
    'feature/login/G1-add-todo-crud',
  );
});

test('branchFor: a title that restates the id adds no slug', () => {
  assert.equal(branchFor('core', undefined, 1, 'Core'), 'aitm/core');
  assert.equal(branchFor('G1', undefined, 1, '✨'), 'aitm/G1');
});

test('branchFor: the composed branch stays a single valid ref component under aitm/', () => {
  const branch = branchFor('g 1..lock', undefined, 2, 'Ship: the *whole* thing');
  assert.equal(branch, 'aitm/g-1-ship-the-whole-thing');
  assert.ok(!branch.slice('aitm/'.length).includes('/'), 'no nested ref under the group segment');
});

test('branchFor: sanitizes an unsafe group id in default and prefixed forms', () => {
  // A Planner id that would otherwise produce an invalid ref (leading dot).
  assert.equal(branchFor('.weird', undefined, 1), 'aitm/weird');
  assert.equal(branchFor('.weird', 'feature/x', 2), 'feature/x/weird');
});

test('planToPrGroups: composes a valid ref even when the Planner id is unsafe', () => {
  const plan: Plan = {
    goal: 'g',
    groups: [
      {
        id: 'core',
        title: 'Core',
        acceptance: 'the check that proves it done',
        tasks: [{ description: 'a', complexity: 'normal' }],
        dependsOn: [],
      },
      {
        id: 'api.lock',
        title: 'API',
        acceptance: 'the check that proves it done',
        tasks: [{ description: 'b', complexity: 'simple' }],
        dependsOn: [],
      },
    ],
  };
  const groups = planToPrGroups(plan, 'release/v2');
  assert.deepEqual(
    groups.map((g) => g.branch),
    ['release/v2/core', 'release/v2/api'],
  );
});

test('planToPrGroups: requested branch applied verbatim for a single-group plan', () => {
  const plan: Plan = {
    goal: 'g',
    groups: [
      {
        id: 'core',
        title: 'Core',
        acceptance: 'the check that proves it done',
        tasks: [{ description: 'a', complexity: 'normal' }],
        dependsOn: [],
      },
    ],
  };
  const groups = planToPrGroups(plan, 'release/v2');
  assert.equal(groups[0]?.branch, 'release/v2');
});

test('planToPrGroups: requested branch prefixes each group in a multi-group plan', () => {
  const plan: Plan = {
    goal: 'g',
    groups: [
      {
        id: 'core',
        title: 'Core',
        acceptance: 'the check that proves it done',
        tasks: [{ description: 'a', complexity: 'normal' }],
        dependsOn: [],
      },
      {
        id: 'api',
        title: 'API',
        acceptance: 'the check that proves it done',
        tasks: [{ description: 'b', complexity: 'simple' }],
        dependsOn: ['core'],
      },
    ],
  };
  const groups = planToPrGroups(plan, 'release/v2');
  assert.deepEqual(
    groups.map((g) => g.branch),
    ['release/v2/core', 'release/v2/api'],
  );
});

test('planToPrGroups: carries the acceptance check onto the persisted PrGroup', () => {
  const plan: Plan = {
    goal: 'g',
    groups: [
      {
        id: 'core',
        title: 'Core',
        tasks: [{ description: 'a', complexity: 'normal' }],
        acceptance: 'bun test src/core passes',
        dependsOn: [],
      },
    ],
  };
  assert.equal(planToPrGroups(plan)[0]?.acceptance, 'bun test src/core passes');
});

// ---- Branch dedupe against the remote (two humans, one repo) ----------------

function twoGroupPlan(): Plan {
  return {
    goal: 'g',
    groups: [
      {
        id: 'g1',
        title: 'Add todo CRUD',
        tasks: [{ description: 'a', complexity: 'normal' }],
        acceptance: 'the check',
        dependsOn: [],
      },
      {
        id: 'g2',
        title: 'Add auth',
        tasks: [{ description: 'b', complexity: 'normal' }],
        acceptance: 'the check',
        dependsOn: ['g1'],
      },
    ],
  };
}

test('planToPrGroups: a branch already on the remote is suffixed, never reused', () => {
  const groups = planToPrGroups(
    twoGroupPlan(),
    undefined,
    new Set(['main', 'aitm/g1-add-todo-crud']),
  );
  assert.deepEqual(
    groups.map((g) => g.branch),
    ['aitm/g1-add-todo-crud-2', 'aitm/g2-add-auth'],
  );
});

test('planToPrGroups: an unreadable remote (empty set) keeps the plain branch names', () => {
  assert.deepEqual(
    planToPrGroups(twoGroupPlan()).map((g) => g.branch),
    ['aitm/g1-add-todo-crud', 'aitm/g2-add-auth'],
  );
});

test('planToPrGroups: an explicit single-group --branch is honored verbatim, never suffixed', () => {
  const plan: Plan = {
    goal: 'g',
    groups: [
      {
        id: 'core',
        title: 'Core',
        tasks: [{ description: 'a', complexity: 'normal' }],
        acceptance: 'the check',
        dependsOn: [],
      },
    ],
  };
  const groups = planToPrGroups(plan, 'release/v2', new Set(['release/v2']));
  assert.equal(groups[0]?.branch, 'release/v2');
});

test('planToPrGroups: --branch derived per-group names still dedupe against the remote', () => {
  const groups = planToPrGroups(
    twoGroupPlan(),
    'release/v2',
    new Set(['release/v2/g1-add-todo-crud']),
  );
  assert.deepEqual(
    groups.map((g) => g.branch),
    ['release/v2/g1-add-todo-crud-2', 'release/v2/g2-add-auth'],
  );
});

test('parseRemoteHeads: keeps refs/heads lines, drops tags, junk and blanks', () => {
  const stdout = [
    'a1b2\trefs/heads/main',
    'c3d4\trefs/heads/aitm/g1-add-todo-crud',
    'e5f6\trefs/tags/v1.0.0',
    'e5f6\trefs/heads/',
    '',
    'garbage-without-a-tab',
  ].join('\n');
  assert.deepEqual(parseRemoteHeads(stdout), ['main', 'aitm/g1-add-todo-crud']);
});

test('remoteBranchNames: a non-git directory degrades to an empty set (never throws)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aitm-no-git-'));
  try {
    assert.deepEqual([...(await remoteBranchNames(dir))], []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---- defaultPlanGroups (drives the real Planner subagent) ------------------

// A model that "delivers" the plan by emitting a submit tool-call — structured output flows through
// the `submit` tool, input is a JSON string per the provider spec.
function planSubmitModel(value: unknown): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [
        {
          type: 'tool-call',
          toolCallId: 'submit-0',
          toolName: 'submit',
          input: JSON.stringify(value),
        },
      ],
      finishReason: { unified: 'tool-calls', raw: undefined },
      usage: {
        inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 1, text: 1, reasoning: undefined },
        totalTokens: 2,
      },
      warnings: [],
    }),
  });
}

function fakeInput(dir: string, model: MockLanguageModelV3): RunLoopInput {
  const credentials = {
    modelFor: () => model,
    modelForCapability: () => model,
    modelIdFor: () => 'openai/gpt-5',
    modelIdForCapability: () => 'openai/gpt-5',
  };
  return {
    cwd: dir,
    goal: 'add a todo list',
    criteria: undefined,
    branch: undefined,
    resolved: {
      openrouterApiKey: 'sk-or-test',
      maxPrs: 5,
      maxSessions: null,
      llmStepTimeoutMs: 30_000,
      streaming: false,
    },
    credentials,
    agentConfig: { flavor: 'claude', path: '/tmp/CLAUDE.md', contents: '' },
    state: new StateStore(dir),
    github: {},
  } as never as RunLoopInput;
}

function fakeMcp(): McpClientManager {
  return { toolsForRole: () => ({}) } as never as McpClientManager;
}

test('defaultPlanGroups: an accepted plan becomes ok PR groups with assigned branches', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aitm-plan-groups-'));
  try {
    const plan: Plan = {
      goal: 'add a todo list',
      groups: [
        {
          id: 'core',
          title: 'Core CRUD',
          acceptance: 'bun test passes',
          tasks: [{ description: 'add the model', complexity: 'normal' }],
          dependsOn: [],
        },
      ],
    };
    const outcome = await defaultPlanGroups(
      fakeInput(dir, planSubmitModel(plan)),
      fakeMcp(),
      false,
    );
    assert.equal(outcome.kind, 'ok');
    if (outcome.kind === 'ok') {
      assert.equal(outcome.groups.length, 1);
      assert.equal(outcome.groups[0]?.branch, 'aitm/core-core-crud');
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('defaultPlanGroups: a schema-invalid submission surfaces kind error', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aitm-plan-groups-'));
  try {
    // Not a valid Plan (missing required fields) → schema-retry exhausts → error.
    const outcome = await defaultPlanGroups(
      fakeInput(dir, planSubmitModel({ nonsense: true })),
      fakeMcp(),
      false,
    );
    assert.equal(outcome.kind, 'error');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('defaultPlanGroups: a throw during the planner call still ends its transcript', async () => {
  // The planner stage is recorded but never resumed, so an unfinished record is dead weight nothing
  // ever closes. The `end()` therefore rides the same finally as the heartbeat stop. Injected through
  // the one input the planner call reads and nothing before it does — `criteria` — because runPlanner
  // itself is total; the guarantee under test is structural, not a specific failure mode.
  const dir = await mkdtemp(join(tmpdir(), 'aitm-planner-transcript-'));
  try {
    const input = fakeInput(dir, planSubmitModel({}));
    Object.defineProperty(input, 'criteria', {
      get: () => {
        throw new Error('planner input exploded');
      },
    });

    await assert.rejects(defaultPlanGroups(input, fakeMcp(), false), /planner input exploded/);

    const transcript = await readFile(
      join(dir, 'transcripts', 'planner', 'planner-1.jsonl'),
      'utf8',
    );
    const records = transcript
      .split('\n')
      .filter((line) => line !== '')
      .map((line): { kind?: string; outcome?: string } => JSON.parse(line));
    assert.deepEqual(
      records.filter((r) => r.kind === 'run-end').map((r) => r.outcome),
      ['error'],
      'the planner transcript is closed exactly once, as an error',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---- surveyRepoForPlanner (real scout-runner wiring) -----------------------

// A model that answers every scout's `submit` call with a valid ScoutFinding. defaultPlanGroups'
// own tests use a tempdir with zero tracked files, so shouldSurveyInParallel's file-count gate
// always skips the survey there — the real ScoutAgentInit this function builds (model, tools,
// system prompt, timeout, usage sink, signal, all derived from a RunLoopInput via
// applyHooks/resolvePlannerTools/reminderAgentSystemPrompt) is otherwise never constructed.
function scoutSubmitModel(): { model: MockLanguageModelV3; callCount: () => number } {
  let calls = 0;
  const model = new MockLanguageModelV3({
    doGenerate: async () => {
      calls += 1;
      const n = calls;
      return {
        content: [
          {
            type: 'tool-call',
            toolCallId: `submit-${n}`,
            toolName: 'submit',
            input: JSON.stringify({
              summary: `finding ${n}`,
              facts: [`fact ${n}`],
              relevantPaths: [`src/file-${n}.ts`],
            }),
          },
        ],
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
  return { model, callCount: () => calls };
}

test('surveyRepoForPlanner: above the file floor, drives real scout agents built from a RunLoopInput', async () => {
  const repo = await makeTempRepo();
  try {
    for (let i = 0; i < SCOUT_REPO_FILE_FLOOR; i++) {
      await writeFile(join(repo.path, `file-${i}.ts`), `export const x${i} = ${i};\n`);
    }
    await execa('git', ['add', '-A'], { cwd: repo.path });

    const { model, callCount } = scoutSubmitModel();
    const input = fakeInput(repo.path, model);

    const brief = await surveyRepoForPlanner({
      input,
      style: '# style\n',
      plannerModelId: 'openai/gpt-5',
      mcp: fakeMcp(),
      fetchHtmlAvailable: false,
    });

    assert.equal(
      callCount(),
      SCOUT_LENSES.length,
      'every lens ran its own real scout agent, built via the real ScoutAgentInit wiring',
    );
    assert.ok(brief, 'the real scout survey synthesized a non-empty brief');
    assert.match(brief ?? '', /gathered in parallel by \d+ scout/);
    assert.match(brief ?? '', /finding 1/);
  } finally {
    await repo.cleanup();
  }
});

test('surveyRepoForPlanner: below the file floor, the real scout wiring never runs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aitm-scout-below-floor-'));
  try {
    const { model, callCount } = scoutSubmitModel();
    const input = fakeInput(dir, model);

    const brief = await surveyRepoForPlanner({
      input,
      style: '# style\n',
      plannerModelId: 'openai/gpt-5',
      mcp: fakeMcp(),
      fetchHtmlAvailable: false,
    });

    assert.equal(brief, undefined);
    assert.equal(callCount(), 0, 'no scout agent is built below the file floor');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
