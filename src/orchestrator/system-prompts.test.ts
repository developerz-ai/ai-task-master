import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ORCHESTRATOR_PREFIX,
  PLANNER_PREFIX,
  REVIEWER_PREFIX,
  WORKER_PREFIX,
} from './system-prompts.ts';

test('ORCHESTRATOR_PREFIX is non-empty and mentions its role', () => {
  assert.ok(ORCHESTRATOR_PREFIX.length > 0);
  assert.ok(ORCHESTRATOR_PREFIX.includes('Orchestrator'));
});

test('PLANNER_PREFIX is non-empty and mentions its role', () => {
  assert.ok(PLANNER_PREFIX.length > 0);
  assert.ok(PLANNER_PREFIX.includes('Planner'));
});

test('WORKER_PREFIX is non-empty and mentions its role', () => {
  assert.ok(WORKER_PREFIX.length > 0);
  assert.ok(WORKER_PREFIX.includes('Worker'));
});

test('REVIEWER_PREFIX is non-empty and mentions its role', () => {
  assert.ok(REVIEWER_PREFIX.length > 0);
  assert.ok(REVIEWER_PREFIX.includes('Reviewer'));
});
