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

test('worker prose: the inline/fanout rule is stated ONCE, with an explicit not-justified-by list', () => {
  assert.equal(
    WORKER_SYSTEM_PREFIX.match(/inline/gi)?.length,
    3,
    'INLINE label, the "do those inline instead" carve-out, and the not-justified-by close — no fourth restatement',
  );
  assert.match(WORKER_SYSTEM_PREFIX, /NOT justified by/);
  assert.ok(
    !/pure overhead/.test(WORKER_SYSTEM_PREFIX),
    'the "spawning is pure overhead" restatement is gone',
  );
  assert.ok(
    !/when in doubt, inline/i.test(WORKER_SYSTEM_PREFIX),
    'the "when in doubt, inline" restatement is gone',
  );
});

test('worker prose: test mandate is a gate, and the verification budget names the unmergeable scratch yard', () => {
  assert.match(WORKER_SYSTEM_PREFIX, /would fail on the base commit/);
  assert.match(WORKER_SYSTEM_PREFIX, /a gate, not a\s+preference: no test, not done/);
  assert.match(WORKER_SYSTEM_PREFIX, /proving yourself WRONG/);
  assert.match(WORKER_SYSTEM_PREFIX, /`\.ai-task-master\/scratch\/`/);
  assert.match(WORKER_SYSTEM_PREFIX, /git add -A/);
  assert.match(WORKER_SYSTEM_PREFIX, /structurally unmergeable/);
  assert.match(WORKER_SYSTEM_PREFIX, /Never merge a fuzz harness/);
  assert.match(WORKER_SYSTEM_PREFIX, /DO merge a regression test/);
});

test('worker prose: concurrent-branch discipline, no predicted leaf results, honest delivery, follow-up outlet', () => {
  assert.match(WORKER_SYSTEM_PREFIX, /Other agents may be changing this branch/);
  assert.match(WORKER_SYSTEM_PREFIX, /Never modify code you do not understand/);
  assert.match(
    WORKER_SYSTEM_PREFIX,
    /never state or\s+predict a leaf result you have not received/,
  );
  assert.match(WORKER_SYSTEM_PREFIX, /never\s+imply work you did not do/);
  assert.match(WORKER_SYSTEM_PREFIX, /follow-ups, not into\s+this PR/);
});

test('editor prose: no verify re-read, comment discipline, failure protocol, return-value framing', () => {
  assert.match(EDITOR_SYSTEM_PREFIX, /Do NOT re-read a file you just edited/);
  assert.match(EDITOR_SYSTEM_PREFIX, /the edit tool errors if it\s+failed/);
  assert.match(EDITOR_SYSTEM_PREFIX, /comment only to state a constraint the code cannot show/);
  assert.match(EDITOR_SYSTEM_PREFIX, /noise the moment the PR merges/);
  assert.match(EDITOR_SYSTEM_PREFIX, /stop and explain/);
  assert.match(EDITOR_SYSTEM_PREFIX, /state the assumption/);
  assert.match(EDITOR_SYSTEM_PREFIX, /Never retry a failed approach unchanged/);
  assert.match(EDITOR_SYSTEM_PREFIX, /handed back to the Coordinator, not a message to a human/);
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
    assert.ok(
      !prose.includes('autonomous agent working directly on a real repository'),
      `${name}: no safety preamble baked into the prose — it is the template's job (issue #186)`,
    );
    assert.ok(!/hard budget of/.test(prose), `${name}: no step-budget reminder in the prose`);
    assert.ok(
      !/resume from the summary/i.test(prose),
      `${name}: the compaction contract lives in the contextManagement block, not per role`,
    );
  }
});
