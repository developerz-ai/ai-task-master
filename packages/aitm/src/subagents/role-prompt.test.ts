import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AUTONOMY_CONTRACT_TEXT,
  COMMUNICATION_CONTRACT_TEXT,
  HARNESS_CONTRACT_TEXT,
} from '@developerz.ai/ai-claude-compat';
import { buildRolePrompt } from './role-prompt.ts';

test('buildRolePrompt weaves the always-on contracts, role guidance, step budget, style and env', () => {
  const prompt = buildRolePrompt({
    style: '# coding style digest',
    roleGuidance: 'You are the Worker.',
    cwd: '/tmp/does-not-exist-worktree',
    maxSteps: 30,
    modelId: 'anthropic/claude-sonnet-4',
  });
  assert.ok(prompt.includes(HARNESS_CONTRACT_TEXT), 'harness contract present');
  assert.ok(prompt.includes(COMMUNICATION_CONTRACT_TEXT), 'communication contract present');
  assert.ok(prompt.includes(AUTONOMY_CONTRACT_TEXT), 'autonomy contract present');
  assert.match(prompt, /You are the Worker\./, 'role guidance present');
  assert.match(prompt, /budget of 30 tool steps/, 'step-budget reminder interpolates the cap');
  assert.match(prompt, /# coding style digest/, 'style digest present');
  assert.match(prompt, /<env>/, 'env block present');
  assert.match(prompt, /anthropic\/claude-sonnet-4/, 'self-id present when a modelId is supplied');
});

test('buildRolePrompt renders blocks in canonical order (contracts first, role before style before env, autonomy last)', () => {
  const prompt = buildRolePrompt({
    style: 'STYLE_MARKER',
    roleGuidance: 'ROLE_MARKER',
    cwd: '/tmp/does-not-exist-worktree',
    maxSteps: 20,
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
    cwd: '/tmp/does-not-exist-worktree',
    maxSteps: 20,
  });
  assert.ok(!/running as the model/.test(prompt), 'no self-id block without a modelId');
  assert.ok(prompt.includes(COMMUNICATION_CONTRACT_TEXT), 'contracts still present');
  assert.match(prompt, /You are the Reviewer\./, 'role guidance still present');
});

test('buildRolePrompt injects the memory index (with staleness framing) when memories exist, else nothing (issue #118)', () => {
  const withMemory = buildRolePrompt({
    style: 'S',
    roleGuidance: 'ROLE',
    cwd: '/tmp/does-not-exist-worktree',
    maxSteps: 30,
    memoryIndex: [{ file: 'flaky.md', description: 'e2e flakes on cold cache' }],
  });
  assert.match(withMemory, /point-in-time/i, 'staleness framing present');
  assert.match(withMemory, /e2e flakes on cold cache/, 'index entry present');

  const withoutMemory = buildRolePrompt({
    style: 'S',
    roleGuidance: 'ROLE',
    cwd: '/tmp/does-not-exist-worktree',
    maxSteps: 30,
    memoryIndex: [],
  });
  assert.ok(!/point-in-time/i.test(withoutMemory), 'no memory block when the index is empty');
});

test('buildRolePrompt omits an empty style block (no blank-line artifact)', () => {
  const prompt = buildRolePrompt({
    style: '',
    roleGuidance: 'ROLE',
    cwd: '/tmp/does-not-exist-worktree',
    maxSteps: 12,
  });
  assert.ok(!prompt.includes('\n\n\n'), 'no triple newline from the omitted style block');
});
