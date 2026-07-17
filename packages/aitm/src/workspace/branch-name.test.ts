import assert from 'node:assert/strict';
import { test } from 'node:test';
import { perTaskBranch, sanitizeBranchComponent } from './branch-name.ts';

test('sanitizeBranchComponent: maps unsafe ids to valid ref components', () => {
  assert.equal(sanitizeBranchComponent('core'), 'core');
  assert.equal(sanitizeBranchComponent('.hidden'), 'hidden');
  assert.equal(sanitizeBranchComponent('foo.lock'), 'foo');
  assert.equal(sanitizeBranchComponent('a b:c'), 'a-b-c');
  assert.equal(sanitizeBranchComponent('trailing.'), 'trailing');
  assert.equal(sanitizeBranchComponent('...'), 'group');
});

test('perTaskBranch: derives a SIBLING branch of the group branch (hyphen, not a nested slash)', () => {
  // A '/' would collide in git's ref store (aitm/core can't be both a ref and a directory); '-' keeps
  // the task branch a sibling that can coexist with the group branch.
  assert.equal(perTaskBranch('aitm/core', 'core-1'), 'aitm/core-core-1');
  assert.equal(perTaskBranch('feature/login', 'api-2'), 'feature/login-api-2');
});

test('perTaskBranch: sanitizes an unsafe task-id segment (raw planner ids are not ref-safe)', () => {
  // The group branch is already ref-safe; only the task-id segment needs sanitizing.
  assert.equal(perTaskBranch('aitm/core', 'a b:c'), 'aitm/core-a-b-c');
  assert.equal(perTaskBranch('aitm/core', '.weird'), 'aitm/core-weird');
  assert.equal(perTaskBranch('aitm/core', '...'), 'aitm/core-group');
});
