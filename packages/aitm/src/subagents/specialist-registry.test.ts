import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { AgentDefinition } from '@developerz.ai/ai-claude-compat';
import type { PrGroup } from '../domain/pr-group.ts';
import type { Task } from '../domain/task.ts';
import {
  buildSpecialistSignal,
  composeSpecialistGuidance,
  discoverSpecialists,
  selectSpecialist,
  selectSpecialistWithScore,
} from './specialist-registry.ts';

function agent(
  name: string,
  description: string,
  systemPrompt = `body of ${name}`,
): AgentDefinition {
  return { name, description, systemPrompt, path: `/repo/.claude/agents/${name}.md` };
}

const roster: AgentDefinition[] = [
  agent('android', 'Kotlin Android app UI and Jetpack Compose screens'),
  agent('backend', 'Server-side APIs, database migrations and business logic'),
  agent('frontend', 'React web UI components and styling'),
  agent('ios', 'Swift iOS app views and navigation'),
];

function task(id: string, text: string, subtasks?: string[]): Task {
  return { id, text, complexity: 'normal', done: false, ...(subtasks ? { subtasks } : {}) };
}

function group(title: string, tasks: Task[]): PrGroup {
  return {
    id: 'g1',
    title,
    tasks,
    dependsOn: [],
    branch: null,
    pr: null,
    status: 'pending',
    stage: 'pending',
    reviewGraceApplied: false,
  };
}

test('selectSpecialist: routes by an agent name token in the signal', () => {
  const picked = selectSpecialist(roster, 'Add a new backend endpoint for user profiles');
  assert.equal(picked?.name, 'backend');
});

test('selectSpecialist: routes by description tokens when no name token matches', () => {
  const picked = selectSpecialist(roster, 'Build a React component for the settings page');
  assert.equal(picked?.name, 'frontend');
});

test('selectSpecialist: a name-token match outweighs description-only matches', () => {
  // "database migrations" are backend description words, but the signal names the frontend agent.
  const picked = selectSpecialist(roster, 'frontend styling that reads a database value');
  assert.equal(picked?.name, 'frontend');
});

test('selectSpecialist: no meaningful overlap → null (fall back to generic Worker)', () => {
  assert.equal(selectSpecialist(roster, 'Update the project changelog wording'), null);
});

test('selectSpecialist: empty roster → null', () => {
  assert.equal(selectSpecialist([], 'anything at all here'), null);
});

test('selectSpecialist: a signal of only stopwords → null', () => {
  assert.equal(selectSpecialist(roster, 'the and for with use'), null);
});

test('selectSpecialist: ties break deterministically toward the earlier (name-sorted) agent', () => {
  const tied: AgentDefinition[] = [
    agent('alpha', 'shared payments domain'),
    agent('bravo', 'shared payments domain'),
  ];
  assert.equal(selectSpecialist(tied, 'work on the payments domain')?.name, 'alpha');
});

test('selectSpecialistWithScore: routes to the same agent as selectSpecialist, plus its winning score', () => {
  const signal = 'Add a new backend endpoint for user profiles';
  const scored = selectSpecialistWithScore(roster, signal);
  assert.equal(scored?.agent.name, 'backend');
  // Two name-token hits ("backend", "endpoint" is not a name token, but "profiles"/"user" aren't
  // either) — assert only that it matches the unweighted picker's agent and is a positive int.
  assert.equal(scored?.agent.name, selectSpecialist(roster, signal)?.name);
  assert.ok(Number.isInteger(scored?.score) && (scored?.score ?? 0) > 0);
});

test('selectSpecialistWithScore: a name-token match scores higher than the same agent scored on description alone', () => {
  const nameHit = selectSpecialistWithScore(roster, 'backend database migrations');
  const descOnly = selectSpecialistWithScore(roster, 'database migrations only');
  assert.equal(nameHit?.agent.name, 'backend');
  assert.ok((nameHit?.score ?? 0) > (descOnly?.score ?? 0));
});

test('selectSpecialistWithScore: no meaningful overlap → null', () => {
  assert.equal(selectSpecialistWithScore(roster, 'Update the project changelog wording'), null);
});

test('selectSpecialistWithScore: empty roster → null', () => {
  assert.equal(selectSpecialistWithScore([], 'anything at all here'), null);
});

test('buildSpecialistSignal: focused task includes title, task text and subtasks', () => {
  const g = group('Auth work', [task('t1', 'other task')]);
  const signal = buildSpecialistSignal(g, task('t2', 'wire login', ['add token refresh']));
  assert.match(signal, /Auth work/);
  assert.match(signal, /wire login/);
  assert.match(signal, /token refresh/);
  assert.ok(!signal.includes('other task'), 'a focused task ignores sibling tasks');
});

test('buildSpecialistSignal: no task → title plus every group task', () => {
  const g = group('Group title', [task('t1', 'first task'), task('t2', 'second task')]);
  const signal = buildSpecialistSignal(g);
  assert.match(signal, /Group title/);
  assert.match(signal, /first task/);
  assert.match(signal, /second task/);
});

test('composeSpecialistGuidance: null specialist returns the base guidance unchanged', () => {
  const base = 'You are the Worker.';
  assert.equal(composeSpecialistGuidance(base, null), base);
});

test('composeSpecialistGuidance: layers the specialist prompt after the base, keeping both', () => {
  const base = 'BASE_WORKER_GUIDANCE';
  const out = composeSpecialistGuidance(base, agent('backend', 'apis', 'SPECIALIST_BODY'));
  assert.ok(out.startsWith(base), 'base guidance stays first');
  assert.match(out, /Domain specialist: backend/);
  assert.match(out, /SPECIALIST_BODY/);
  assert.ok(out.indexOf(base) < out.indexOf('SPECIALIST_BODY'), 'specialist layered on top');
});

test('discoverSpecialists: loads the target repo .claude/agents, empty when the dir is absent', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aitm-specialist-'));
  try {
    assert.deepEqual(await discoverSpecialists(dir), [], 'no .claude/agents → []');
    const agentsDir = join(dir, '.claude', 'agents');
    await mkdir(agentsDir, { recursive: true });
    await writeFile(
      join(agentsDir, 'backend.md'),
      '---\nname: backend\ndescription: server APIs\n---\nYou are the backend specialist.\n',
    );
    const found = await discoverSpecialists(dir);
    assert.equal(found.length, 1);
    assert.equal(found[0]?.name, 'backend');
    assert.equal(found[0]?.systemPrompt, 'You are the backend specialist.');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
