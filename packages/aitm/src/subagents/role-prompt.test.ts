import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AUTONOMY_CONTRACT_TEXT,
  COMMUNICATION_CONTRACT_TEXT,
  contextReminder,
  HARNESS_CONTRACT_TEXT,
  SYSTEM_REMINDER_CONTRACT,
} from '@developerz.ai/ai-claude-compat';
import {
  EDITOR_SYSTEM_PREFIX,
  PLANNER_SYSTEM_PREFIX,
  WORKER_SYSTEM_PREFIX,
} from './prompts/role-guidance.ts';
import {
  buildEditorRolePrompt,
  buildRolePrompt,
  harnessContextBlock,
  reminderAgentSystemPrompt,
} from './role-prompt.ts';

test('buildRolePrompt weaves the always-on contracts, role guidance, style and env', () => {
  const prompt = buildRolePrompt({
    style: '# coding style digest',
    roleGuidance: 'You are the Worker.',
    cwd: '/tmp/does-not-exist-checkout',
    modelId: 'anthropic/claude-sonnet-4',
  });
  assert.ok(prompt.includes(HARNESS_CONTRACT_TEXT), 'harness contract present');
  assert.ok(prompt.includes(COMMUNICATION_CONTRACT_TEXT), 'communication contract present');
  assert.ok(prompt.includes(AUTONOMY_CONTRACT_TEXT), 'autonomy contract present');
  assert.match(prompt, /You are the Worker\./, 'role guidance present');
  assert.doesNotMatch(
    prompt,
    /budget of/,
    'no step-budget reminder — agents run until they submit',
  );
  assert.match(prompt, /# coding style digest/, 'style digest present');
  assert.match(prompt, /<env>/, 'env block present');
  assert.match(prompt, /anthropic\/claude-sonnet-4/, 'self-id present when a modelId is supplied');
});

test('buildRolePrompt renders blocks in canonical order (contracts first, role before style before env, autonomy last)', () => {
  const prompt = buildRolePrompt({
    style: 'STYLE_MARKER',
    roleGuidance: 'ROLE_MARKER',
    cwd: '/tmp/does-not-exist-checkout',
    modelId: 'prov/model-x',
  });
  const idx = (needle: string) => prompt.indexOf(needle);
  assert.ok(idx(HARNESS_CONTRACT_TEXT) < idx(COMMUNICATION_CONTRACT_TEXT), 'harness before comms');
  assert.ok(idx(COMMUNICATION_CONTRACT_TEXT) < idx('prov/model-x'), 'comms before selfId');
  assert.ok(idx('prov/model-x') < idx('ROLE_MARKER'), 'selfId before role guidance');
  assert.ok(idx('ROLE_MARKER') < idx('STYLE_MARKER'), 'role guidance before style');
  assert.ok(idx('STYLE_MARKER') < idx('<env>'), 'style before env');
  assert.ok(idx('<env>') < idx(AUTONOMY_CONTRACT_TEXT), 'autonomy is the final block');
});

test('buildRolePrompt omits the self-id block when no modelId is supplied (take-over flows)', () => {
  const prompt = buildRolePrompt({
    style: '',
    roleGuidance: 'You are the Reviewer.',
    cwd: '/tmp/does-not-exist-checkout',
  });
  assert.ok(!/running as the model/.test(prompt), 'no self-id block without a modelId');
  assert.ok(prompt.includes(COMMUNICATION_CONTRACT_TEXT), 'contracts still present');
  assert.match(prompt, /You are the Reviewer\./, 'role guidance still present');
});

test('buildRolePrompt injects the memory index (with staleness framing) when memories exist, else nothing (issue #118)', () => {
  const withMemory = buildRolePrompt({
    style: 'S',
    roleGuidance: 'ROLE',
    cwd: '/tmp/does-not-exist-checkout',
    memoryIndex: [{ file: 'flaky.md', description: 'e2e flakes on cold cache' }],
  });
  assert.match(withMemory, /point-in-time/i, 'staleness framing present');
  assert.match(withMemory, /e2e flakes on cold cache/, 'index entry present');

  const withoutMemory = buildRolePrompt({
    style: 'S',
    roleGuidance: 'ROLE',
    cwd: '/tmp/does-not-exist-checkout',
    memoryIndex: [],
  });
  assert.ok(!/point-in-time/i.test(withoutMemory), 'no memory block when the index is empty');
});

test('buildRolePrompt: every non-leaf built-in role prompt carries the contract/<env> frame (baked into the template, not the prose)', () => {
  // The editor is deliberately excluded: it is a leaf (worker.ts's Layer B fanout) and renders
  // through buildEditorRolePrompt instead, which drops this frame — see the buildEditorRolePrompt
  // tests below.
  const roles = [
    { name: 'planner', roleGuidance: PLANNER_SYSTEM_PREFIX, marker: /You are the Planner\./ },
    { name: 'worker', roleGuidance: WORKER_SYSTEM_PREFIX, marker: /You are the Coordinator/ },
  ] as const;
  for (const { name, roleGuidance, marker } of roles) {
    const prompt = buildRolePrompt({
      style: '',
      roleGuidance,
      cwd: '/tmp/does-not-exist-checkout',
    });
    assert.ok(prompt.includes(HARNESS_CONTRACT_TEXT), `${name}: harness contract present`);
    assert.ok(
      prompt.includes(COMMUNICATION_CONTRACT_TEXT),
      `${name}: communication contract present`,
    );
    assert.ok(prompt.includes(AUTONOMY_CONTRACT_TEXT), `${name}: autonomy contract present`);
    assert.match(prompt, /<env>/, `${name}: <env> block present`);
    assert.doesNotMatch(prompt, /budget of/, `${name}: no step-budget reminder`);
    assert.match(prompt, marker, `${name}: role prose flows through the sessionGuidance slot`);
  }
});

test('buildRolePrompt omits an empty style block (no blank-line artifact)', () => {
  const prompt = buildRolePrompt({
    style: '',
    roleGuidance: 'ROLE',
    cwd: '/tmp/does-not-exist-checkout',
  });
  assert.ok(!prompt.includes('\n\n\n'), 'no triple newline from the omitted style block');
});

test('buildEditorRolePrompt: lean leaf frame — role guidance, style, computed <env>; no contracts, no self-id (issue #221)', () => {
  const prompt = buildEditorRolePrompt({
    style: '# coding style digest',
    roleGuidance: EDITOR_SYSTEM_PREFIX,
    cwd: '/tmp/does-not-exist-checkout',
  });
  assert.match(prompt, /You are a leaf editor\./, 'role guidance present');
  assert.doesNotMatch(prompt, /budget of/, 'no step-budget reminder on the leaf either');
  assert.match(prompt, /# coding style digest/, 'style digest present');
  assert.match(prompt, /<env>/, 'env block computed and present');
  assert.ok(!prompt.includes(HARNESS_CONTRACT_TEXT), 'no harness contract — a leaf cannot spawn');
  assert.ok(!prompt.includes(COMMUNICATION_CONTRACT_TEXT), 'no communication contract');
  assert.ok(!prompt.includes(AUTONOMY_CONTRACT_TEXT), 'no autonomy contract');
  assert.ok(
    !/running as the model/.test(prompt),
    'no self-id block — buildEditorRolePrompt takes no modelId',
  );
});

test('buildEditorRolePrompt omits an empty style block (no blank-line artifact)', () => {
  const prompt = buildEditorRolePrompt({
    style: '',
    roleGuidance: EDITOR_SYSTEM_PREFIX,
    cwd: '/tmp/does-not-exist-checkout',
  });
  assert.ok(!prompt.includes('\n\n\n'), 'no triple newline from the omitted style block');
  assert.match(prompt, /You are a leaf editor\./, 'role guidance still present');
});

test('reminderAgentSystemPrompt: the role prompt plus the #106 provenance contract, appended last', () => {
  const input = {
    style: '# style',
    roleGuidance: 'You are the Worker.',
    cwd: '/tmp/does-not-exist-checkout',
  };
  const prompt = reminderAgentSystemPrompt(input);
  // It is exactly the role prompt with the provenance contract on the end — nothing else changes.
  assert.equal(prompt, `${buildRolePrompt(input)}\n\n${SYSTEM_REMINDER_CONTRACT}`);
  assert.ok(prompt.includes(HARNESS_CONTRACT_TEXT), 'still carries the role contract frame');
  assert.ok(prompt.endsWith(SYSTEM_REMINDER_CONTRACT), 'provenance contract is the final block');
});

test('harnessContextBlock: a <system-reminder> carrying only the day-granular currentDate (issue #106)', () => {
  const block = harnessContextBlock();
  assert.match(block, /system-reminder/i, 'framed as advisory system-reminder context');
  assert.match(block, /currentDate/, 'carries the date label');
  const date = block.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? '';
  assert.match(date, /^\d{4}-\d{2}-\d{2}$/, 'carries an ISO date');
  // Byte-stable and cacheable: the block is EXACTLY a single-field currentDate reminder — no style
  // digest and no per-step run position — so the leading prompt prefix never moves within a day.
  // Rebuilt from the block's own date (not a second clock read) so this can't flake at UTC midnight.
  assert.equal(block, contextReminder([{ label: 'currentDate', body: date }]));
  assert.ok(!/Step \d+ of/.test(block), 'no run position — that rides a trailing reminder');
});

test('buildEditorRolePrompt: injects a team brief when given one, omits it otherwise', () => {
  const base = {
    style: '# style',
    roleGuidance: EDITOR_SYSTEM_PREFIX,
    cwd: '/tmp/does-not-exist-checkout',
  };
  const withBrief = buildEditorRolePrompt({
    ...base,
    teamBrief: '<team-brief>\nTEAM_MARK\n</team-brief>',
  });
  const without = buildEditorRolePrompt(base);
  assert.match(withBrief, /TEAM_MARK/, 'the brief rides in the leaf system prompt');
  assert.doesNotMatch(without, /team-brief/, 'no brief when none is supplied');
});
