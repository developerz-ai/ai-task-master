import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  EDITOR_SYSTEM_PREFIX,
  EXPLORE_SYSTEM_PROMPT,
  PLANNER_SYSTEM_PREFIX,
  WORKER_SYSTEM_PREFIX,
} from './role-guidance.ts';

const ALL_PROSE = [
  ['PLANNER_SYSTEM_PREFIX', PLANNER_SYSTEM_PREFIX],
  ['WORKER_SYSTEM_PREFIX', WORKER_SYSTEM_PREFIX],
  ['EDITOR_SYSTEM_PREFIX', EDITOR_SYSTEM_PREFIX],
  ['EXPLORE_SYSTEM_PROMPT', EXPLORE_SYSTEM_PROMPT],
] as const;

test('role guidance: each built-in role prose is non-empty and identifies its role', () => {
  for (const [name, prose] of ALL_PROSE) {
    assert.ok(prose.trim().length > 0, `${name} is non-empty`);
  }
  assert.match(PLANNER_SYSTEM_PREFIX, /You are the Planner\./);
  assert.match(WORKER_SYSTEM_PREFIX, /You are the Coordinator/);
  assert.match(EDITOR_SYSTEM_PREFIX, /You are a leaf editor\./);
  assert.match(EXPLORE_SYSTEM_PROMPT, /read-only survey agent/);
});

test("role guidance: prose carries NO cross-cutting frame — contracts, <env>, and step-budget are the role template's job", () => {
  for (const [name, prose] of ALL_PROSE) {
    assert.ok(
      !prose.includes('Harness contract:'),
      `${name}: no harness contract baked into the prose`,
    );
    assert.ok(
      !prose.includes('Communication contract:'),
      `${name}: no communication contract in the prose`,
    );
    assert.ok(!prose.includes('<env>'), `${name}: no <env> block in the prose`);
    assert.ok(!/hard budget of/.test(prose), `${name}: no step-budget reminder in the prose`);
  }
});
