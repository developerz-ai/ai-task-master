import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  dedupeBranchNames,
  perTaskBranch,
  sanitizeBranchComponent,
  slugifyTitle,
} from './branch-name.ts';

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

test('slugifyTitle: lowercases and joins words with dashes', () => {
  assert.equal(slugifyTitle('Add Todo CRUD'), 'add-todo-crud');
});

test('slugifyTitle: collapses punctuation and trims edges', () => {
  assert.equal(slugifyTitle('  Auth: login & signup!  '), 'auth-login-signup');
});

test('slugifyTitle: truncates at a word boundary, never trailing a dash', () => {
  const slug = slugifyTitle(
    'Implement the complete authentication subsystem including refresh tokens',
  );
  assert.ok(slug.length <= 40, `slug is capped, got ${slug.length}`);
  assert.ok(!slug.endsWith('-'), 'no trailing dash');
  assert.ok(
    slug.split('-').every((w) => w !== ''),
    'no empty segments',
  );
  assert.match(slug, /^implement-the-complete-authentication/);
});

test('slugifyTitle: a single over-long word is hard-truncated rather than dropped', () => {
  assert.equal(slugifyTitle('x'.repeat(60)), 'x'.repeat(40));
});

test('slugifyTitle: a title with nothing usable yields an empty slug', () => {
  assert.equal(slugifyTitle('— ✨ —'), '');
  assert.equal(slugifyTitle(''), '');
});

test('dedupeBranchNames: names free on the remote are returned untouched', () => {
  assert.deepEqual(
    dedupeBranchNames(['aitm/g1-add-todo-crud', 'aitm/g2-add-auth'], new Set(['main', 'develop'])),
    ['aitm/g1-add-todo-crud', 'aitm/g2-add-auth'],
  );
});

test('dedupeBranchNames: a name already on the remote gets a numeric suffix', () => {
  // The other person's run is already on aitm/g1-add-todo-crud — ours must not force-push over it.
  assert.deepEqual(
    dedupeBranchNames(['aitm/g1-add-todo-crud'], new Set(['aitm/g1-add-todo-crud'])),
    ['aitm/g1-add-todo-crud-2'],
  );
});

test('dedupeBranchNames: suffixes climb past every taken variant', () => {
  const taken = new Set(['aitm/g1', 'aitm/g1-2', 'aitm/g1-3']);
  assert.deepEqual(dedupeBranchNames(['aitm/g1'], taken), ['aitm/g1-4']);
});

test('dedupeBranchNames: groups within one run never collide with each other', () => {
  // Two groups whose id+slug compose the same branch (a Planner that reused a title).
  assert.deepEqual(dedupeBranchNames(['aitm/g1-auth', 'aitm/g1-auth'], new Set()), [
    'aitm/g1-auth',
    'aitm/g1-auth-2',
  ]);
});

test('dedupeBranchNames: own-run collisions stack on top of remote collisions', () => {
  assert.deepEqual(
    dedupeBranchNames(['aitm/g1', 'aitm/g1', 'aitm/g1'], new Set(['aitm/g1', 'aitm/g1-2'])),
    ['aitm/g1-3', 'aitm/g1-4', 'aitm/g1-5'],
  );
});

test('dedupeBranchNames: an empty taken set (unreadable remote) is a pass-through', () => {
  const desired = ['aitm/g1-a', 'aitm/g2-b'];
  assert.deepEqual(dedupeBranchNames(desired, new Set()), desired);
  assert.deepEqual(dedupeBranchNames([], new Set(['aitm/g1-a'])), []);
});
