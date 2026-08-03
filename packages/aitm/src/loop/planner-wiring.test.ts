// Unit coverage for planner-wiring.ts: turning an accepted Plan into persisted PrGroups (branch
// assignment + dedupe against the remote) and driving the real Planner subagent. Extracted from
// run-loop-adapter.test.ts (split alongside the source module in the loop/ SRP sweep) so this module
// ships with its own paired test file.

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { jsonSchema } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { execa } from 'execa';
import type { RunLoopInput } from '../composition/run-input.ts';
import type { PrGroup } from '../domain/pr-group.ts';
import { McpClientManager } from '../mcp/mcp-client.ts';
import { TOOL_SEARCH_TOOL_NAME } from '../mcp/tool-search.ts';
import { PlanGraph } from '../plan/plan-graph.ts';
import type { Plan } from '../plan/schema.ts';
import { bridgeCredentials, bridgeInput } from '../testing/bridge-ctx.ts';
import { mcpClientDouble } from '../testing/mcp-client-double.ts';
import { makeTempRepo } from '../testing/temp-repo.ts';
import {
  branchFor,
  defaultPlanGroups,
  listTrackedFiles,
  namespaceWaveGroups,
  parseRemoteHeads,
  planToPrGroups,
  remoteBranchNames,
  SURVEY_MIN_TRACKED_FILES,
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
  return bridgeInput({
    cwd: dir,
    goal: 'add a todo list',
    credentials: bridgeCredentials({ modelFor: () => model, modelForCapability: () => model }),
  });
}

// A manager with no servers configured: `toolsForRole` answers with the same empty set the literal
// stub used to fake, and every other method the wiring might reach is the real one.
function fakeMcp(): McpClientManager {
  return new McpClientManager({ servers: {} });
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
  // the one input the planner call reads and nothing before it does — `maxPrs`, since the scout
  // survey now runs first and reads `criteria` — because runPlanner itself is total; the guarantee
  // under test is structural, not a specific failure mode.
  const dir = await mkdtemp(join(tmpdir(), 'aitm-planner-transcript-'));
  try {
    const input = fakeInput(dir, planSubmitModel({}));
    Object.defineProperty(input.resolved, 'maxPrs', {
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

// One model standing in for the whole survey team: it answers the lead's `submit` with a two-scout
// wave and every scout's with a ScoutFinding, telling them apart by the prompt each receives. The
// real ScoutAgentInit this function builds (model, tools, system prompt, timeout, usage sink,
// signal, all derived from a RunLoopInput via applyHooks/resolvePlannerTools/
// reminderAgentSystemPrompt) is constructed nowhere else, so this is its only coverage.
function surveyTeamModel(wave: Array<{ key: string; question: string }>): {
  model: MockLanguageModelV3;
  leadCalls: () => number;
  scoutCalls: () => number;
} {
  let lead = 0;
  let scouts = 0;
  const model = new MockLanguageModelV3({
    doGenerate: async (opts) => {
      const prompt = JSON.stringify(opts.prompt);
      const isLead =
        prompt.includes('Dispatch the survey wave') || prompt.includes('follow-up wave');
      // The gap round is the lead's SECOND call: answer it with an empty wave so the survey ends.
      const input = isLead
        ? JSON.stringify({ assignments: lead++ === 0 ? wave : [], rationale: 'scripted' })
        : JSON.stringify({
            summary: `finding ${++scouts}`,
            facts: [`fact ${scouts}`],
            relevantPaths: [`src/file-${scouts}.ts`],
          });
      return {
        content: [
          { type: 'tool-call', toolCallId: `submit-${lead + scouts}`, toolName: 'submit', input },
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
  return { model, leadCalls: () => lead, scoutCalls: () => scouts };
}

test('surveyRepoForPlanner: drives a real lead and the scouts it dispatched, built from a RunLoopInput', async () => {
  const repo = await makeTempRepo();
  try {
    await writeFile(join(repo.path, 'router.ts'), 'export const route = 1;\n');
    await writeFile(join(repo.path, 'auth.ts'), 'export const auth = 1;\n');
    // Clear SURVEY_MIN_TRACKED_FILES — under it the wave is skipped by design, which is a
    // different test (below). This one is about the lead/scout wiring on a repo worth surveying.
    for (let i = 0; i < SURVEY_MIN_TRACKED_FILES; i++) {
      await writeFile(join(repo.path, `filler-${i}.ts`), `export const f${i} = 1;\n`);
    }
    await execa('git', ['add', '-A'], { cwd: repo.path });

    const { model, leadCalls, scoutCalls } = surveyTeamModel([
      { key: 'routing', question: 'how does routing work?' },
      { key: 'auth', question: 'how does auth work?' },
    ]);
    const input = fakeInput(repo.path, model);

    const brief = await surveyRepoForPlanner({
      input,
      style: '# style\n',
      plannerModelId: 'openai/gpt-5',
      mcp: fakeMcp(),
      fetchHtmlAvailable: false,
    });

    assert.equal(scoutCalls(), 2, 'exactly the wave the lead asked for ran, not a fixed lens set');
    assert.equal(leadCalls(), 2, 'the lead ran again to close the gaps, and ended the survey');
    assert.ok(brief, 'the real survey synthesized a non-empty brief');
    assert.match(brief ?? '', /^Repo map — \d+ tracked file\(s\)/, 'the map leads the brief');
    assert.match(brief ?? '', /## routing/, 'sections are the areas the lead actually chose');
    assert.match(brief ?? '', /finding 1/);
  } finally {
    await repo.cleanup();
  }
});

test('surveyRepoForPlanner: a small repo skips the wave and hands over the map alone', async () => {
  // Measured waste this guards: an 11-file docs-only repo drew 2 rounds / 6 scouts over ~11 minutes,
  // and the Planner then read the same files itself anyway.
  const repo = await makeTempRepo();
  try {
    for (let i = 0; i < 5; i++) {
      await writeFile(join(repo.path, `doc-${i}.md`), `# doc ${i}\n`);
    }
    await execa('git', ['add', '-A'], { cwd: repo.path });

    const { model, leadCalls, scoutCalls } = surveyTeamModel([
      { key: 'never', question: 'should not be dispatched' },
    ]);
    const brief = await surveyRepoForPlanner({
      input: fakeInput(repo.path, model),
      style: '# style\n',
      plannerModelId: 'openai/gpt-5',
      mcp: fakeMcp(),
      fetchHtmlAvailable: false,
    });

    assert.equal(leadCalls(), 0, 'no lead call — the wave is not sized, it is skipped');
    assert.equal(scoutCalls(), 0, 'no scouts dispatched');
    assert.ok(brief, 'the planner still gets the repo map');
    assert.match(brief ?? '', /^Repo map — \d+ tracked file\(s\)/);
    assert.doesNotMatch(brief ?? '', /gathered in parallel/, 'no survey section without scouts');
  } finally {
    await repo.cleanup();
  }
});

test('surveyRepoForPlanner: outside a git repo the survey still runs, just without a map', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aitm-scout-no-repo-'));
  try {
    const { model, scoutCalls } = surveyTeamModel([{ key: 'solo', question: 'what is here?' }]);
    const input = fakeInput(dir, model);

    const brief = await surveyRepoForPlanner({
      input,
      style: '# style\n',
      plannerModelId: 'openai/gpt-5',
      mcp: fakeMcp(),
      fetchHtmlAvailable: false,
    });

    assert.equal(scoutCalls(), 1);
    assert.ok(brief);
    assert.doesNotMatch(brief ?? '', /Repo map/, 'no tracked files, so nothing to map');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('listTrackedFiles: returns the tracked paths, and [] where git cannot answer', async () => {
  const repo = await makeTempRepo();
  try {
    await writeFile(join(repo.path, 'kept.ts'), 'export const a = 1;\n');
    await execa('git', ['add', '-A'], { cwd: repo.path });
    assert.ok((await listTrackedFiles(repo.path)).includes('kept.ts'));
  } finally {
    await repo.cleanup();
  }
  const dir = await mkdtemp(join(tmpdir(), 'aitm-not-a-repo-'));
  try {
    assert.deepEqual(
      await listTrackedFiles(dir),
      [],
      'a non-repo degrades to no map, never a throw',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---- namespaceWaveGroups (pure) --------------------------------------------

function waveGroup(
  id: string,
  opts: { branch?: string | null; dependsOn?: string[] } = {},
): PrGroup {
  return {
    id,
    title: `Group ${id}`,
    acceptance: 'check',
    tasks: [{ id: `${id}-1`, text: 'a', complexity: 'normal', done: false }],
    dependsOn: opts.dependsOn ?? [],
    branch: opts.branch === undefined ? `aitm/${id}` : opts.branch,
    pr: null,
    status: 'pending',
    stage: 'pending',
    reviewGraceApplied: false,
  };
}

test('namespaceWaveGroups: colliding ids, branches, and task ids are all rewritten', () => {
  const landed = [waveGroup('g1'), waveGroup('g2')];
  const next = namespaceWaveGroups([waveGroup('g1'), waveGroup('g2')], landed, 2);
  assert.deepEqual(
    next.map((g) => g.id),
    ['w2-g1', 'w2-g2'],
  );
  assert.deepEqual(
    next.map((g) => g.branch),
    ['aitm/g1-w2', 'aitm/g2-w2'],
  );
  assert.deepEqual(
    next[0]?.tasks.map((t) => t.id),
    ['w2-g1-1'],
    'task ids follow the group id',
  );
});

test('namespaceWaveGroups: dependsOn follows the rename, so the DAG stays closed', () => {
  const landed = [waveGroup('g1')];
  const next = namespaceWaveGroups(
    [waveGroup('g1'), waveGroup('g2', { dependsOn: ['g1'] })],
    landed,
    2,
  );
  // g2 depended on the NEW g1, not the landed one — the edge must point at the renamed id.
  assert.deepEqual(next[1]?.dependsOn, ['w2-g1']);
  assert.doesNotThrow(() => PlanGraph.validate([...landed, ...next]));
});

test('namespaceWaveGroups: non-colliding ids are left completely alone', () => {
  const next = namespaceWaveGroups([waveGroup('api')], [waveGroup('g1')], 2);
  assert.equal(next[0]?.id, 'api');
  assert.equal(next[0]?.branch, 'aitm/api');
});

test('namespaceWaveGroups: a null branch stays null', () => {
  const next = namespaceWaveGroups([waveGroup('g1', { branch: null })], [waveGroup('g1')], 2);
  assert.equal(next[0]?.id, 'w2-g1');
  assert.equal(next[0]?.branch, null);
});

test('namespaceWaveGroups: a third wave does not collide with the second', () => {
  const w1 = [waveGroup('g1')];
  const w2 = namespaceWaveGroups([waveGroup('g1')], w1, 2);
  const w3 = namespaceWaveGroups([waveGroup('g1')], [...w1, ...w2], 3);
  const ids = [...w1, ...w2, ...w3].map((g) => g.id);
  assert.equal(new Set(ids).size, ids.length, 'every id across three waves is unique');
});

// ---- deferred MCP tool loading on the Planner (issue #193) ------------------

// Records the system prompt and the tool names offered on the first step, then submits `plan` so
// defaultPlanGroups still returns ok and the assertions can be about the wiring alone.
function recordingPlanModel(plan: Plan): {
  model: MockLanguageModelV3;
  systemPrompt: () => string;
  offered: () => string[];
} {
  // The same model answers the pre-planning scout survey first, so the Planner's own call has to be
  // picked out by its role prefix rather than taken as the first or last one.
  let systemPrompt = '';
  let offered: string[] = [];
  const model = new MockLanguageModelV3({
    doGenerate: async (opts) => {
      const prompt = JSON.stringify(opts.prompt);
      if (prompt.includes('You are the Planner.')) {
        systemPrompt = prompt;
        offered = (opts.tools ?? []).map((t) => t.name);
      }
      return {
        content: [
          {
            type: 'tool-call',
            toolCallId: 'submit-0',
            toolName: 'submit',
            input: JSON.stringify(plan),
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
  return { model, systemPrompt: () => systemPrompt, offered: () => offered };
}

// One tool-call response, the only shape any model in this file returns.
function submitCall(toolCallId: string, toolName: string, input: unknown) {
  return {
    content: [{ type: 'tool-call' as const, toolCallId, toolName, input: JSON.stringify(input) }],
    finishReason: { unified: 'tool-calls' as const, raw: undefined },
    usage: {
      inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 1, text: 1, reasoning: undefined },
      totalTokens: 2,
    },
    warnings: [],
  };
}

function surplusMcp(deferToolsOver: number): McpClientManager {
  return new McpClientManager({
    servers: { gh: { command: 'gh-mcp' } },
    deferToolsOver,
    createClient: async () =>
      mcpClientDouble({
        tools: {
          create_issue: {
            description: 'Create a GitHub issue.',
            inputSchema: jsonSchema({ type: 'object' }),
          },
          list_prs: { description: 'List open PRs.', inputSchema: jsonSchema({ type: 'object' }) },
        },
      }),
  });
}

const ONE_GROUP_PLAN: Plan = {
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

test('defaultPlanGroups: an over-threshold MCP surface reaches the Planner name-only + tool_search (issue #193)', async () => {
  // Planning is the read-heavy recon pass: what a domain server knows belongs in the plan, not in a
  // Worker's later discovery. Before this, resolvePlannerTools dropped every surplus tool.
  const dir = await mkdtemp(join(tmpdir(), 'aitm-planner-deferred-'));
  const mcp = surplusMcp(1); // 2 surplus tools > 1 → deferred
  await mcp.connectAll();
  try {
    const { model, systemPrompt, offered } = recordingPlanModel(ONE_GROUP_PLAN);
    const outcome = await defaultPlanGroups(fakeInput(dir, model), mcp, false);

    assert.equal(outcome.kind, 'ok');
    assert.match(systemPrompt(), /<deferred-tools>/, 'the name-only index reaches the prompt');
    assert.match(systemPrompt(), /mcp__gh__create_issue/, 'the deferred tool is listed by name');
    assert.ok(offered().includes(TOOL_SEARCH_TOOL_NAME), 'tool_search is callable');
    assert.equal(
      offered().includes('mcp__gh__create_issue'),
      false,
      'a deferred tool stays inactive until tool_search fetches its schema',
    );
    assert.ok(offered().includes('readFile'), 'the read-only fixed slots are untouched');
  } finally {
    await mcp.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('defaultPlanGroups: a below-threshold MCP surface mounts on the Planner directly (issue #193)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aitm-planner-direct-'));
  const mcp = surplusMcp(5); // 2 surplus tools <= 5 → nothing deferred
  await mcp.connectAll();
  try {
    const { model, systemPrompt, offered } = recordingPlanModel(ONE_GROUP_PLAN);
    const outcome = await defaultPlanGroups(fakeInput(dir, model), mcp, false);

    assert.equal(outcome.kind, 'ok');
    assert.doesNotMatch(systemPrompt(), /<deferred-tools>/, 'no index block when nothing deferred');
    assert.ok(offered().includes('mcp__gh__create_issue'), 'the surplus mounts with full schema');
    assert.equal(offered().includes(TOOL_SEARCH_TOOL_NAME), false, 'no tool_search either');
  } finally {
    await mcp.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('defaultPlanGroups: no MCP servers → the Planner prompt and tools are unchanged (issue #193)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aitm-planner-nomcp-'));
  try {
    const { model, systemPrompt, offered } = recordingPlanModel(ONE_GROUP_PLAN);
    const outcome = await defaultPlanGroups(fakeInput(dir, model), fakeMcp(), false);

    assert.equal(outcome.kind, 'ok');
    assert.doesNotMatch(systemPrompt(), /<deferred-tools>/);
    assert.equal(offered().includes(TOOL_SEARCH_TOOL_NAME), false);
    assert.ok(offered().includes('readFile'), 'the fixed slots still reach the model');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('defaultPlanGroups: tool_search activates a deferred tool for the Planner’s next step (issue #193)', async () => {
  // The withheld-until-searched half is asserted above; this is the other half, and it is the one
  // that catches a broken activation link — a `mount.activated` that is a COPY of the set
  // `tool_search` mutates would satisfy every other assertion here and never activate anything.
  const dir = await mkdtemp(join(tmpdir(), 'aitm-planner-activate-'));
  const mcp = surplusMcp(1);
  await mcp.connectAll();
  try {
    const offeredPerStep: string[][] = [];
    let plannerSteps = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async (opts) => {
        if (!JSON.stringify(opts.prompt).includes('You are the Planner.')) {
          // The scout survey shares this handle; answer it and stay out of the way.
          return submitCall('survey-0', 'submit', { assignments: [], rationale: 'none' });
        }
        offeredPerStep.push((opts.tools ?? []).map((t) => t.name));
        plannerSteps += 1;
        return plannerSteps === 1
          ? submitCall('search-0', TOOL_SEARCH_TOOL_NAME, {
              query: 'select:mcp__gh__create_issue',
            })
          : submitCall('submit-0', 'submit', ONE_GROUP_PLAN);
      },
    });

    const outcome = await defaultPlanGroups(fakeInput(dir, model), mcp, false);

    assert.equal(outcome.kind, 'ok');
    assert.equal(plannerSteps, 2, 'the Planner took a search step and then submitted');
    assert.equal(
      offeredPerStep[0]?.includes('mcp__gh__create_issue'),
      false,
      'step one: deferred, schema withheld',
    );
    assert.ok(
      offeredPerStep[1]?.includes('mcp__gh__create_issue'),
      'step two: the searched tool is callable',
    );
  } finally {
    await mcp.close();
    await rm(dir, { recursive: true, force: true });
  }
});
