import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BashInput, BashOutput } from '@developerz.ai/ai-claude-compat';
import { tool } from 'ai';
import { z } from 'zod';
import type { PrGroup } from '../domain/pr-group.ts';
import { checkoutBranch, commitOnBranch, commitWithVerify } from './git-commit-phase.ts';
import type { WorkerInput } from './worker.ts';

function baseGroup(overrides: Partial<PrGroup> = {}): PrGroup {
  return {
    id: 'core',
    title: 'Core features',
    tasks: [],
    dependsOn: [],
    branch: null,
    pr: null,
    status: 'pending',
    stage: 'pending',
    reviewGraceApplied: false,
    ...overrides,
  };
}

function baseInput(overrides: Partial<WorkerInput> = {}): WorkerInput {
  return {
    group: baseGroup(),
    checkoutPath: '/tmp/wt',
    baseBranch: 'main',
    styleContents: '',
    rollingContext: '',
    ...overrides,
  };
}

// Records every bash command; verify calls are the ones carrying VERIFY's distinguishing timeoutMs
// (600000 — matches verify-gate.ts's VERIFY_TIMEOUT_MS); everything else (checkout/format/add/commit/
// diff-tree) exits 0 unless scripted otherwise via `verifyExitCodes`.
function makeBashFake(verifyExitCodes: number[], committedNameStatus = 'A\tsrc/a.ts\n') {
  const commands: string[] = [];
  let vi = 0;
  const bash = tool<BashInput, BashOutput>({
    description: 'run a bash command',
    inputSchema: z.object({
      command: z.string(),
      description: z.string(),
      timeoutMs: z.number().optional(),
      run_in_background: z.boolean().optional(),
    }),
    execute: async (input) => {
      if (input.command.includes('diff-tree')) {
        return { stdout: committedNameStatus, stderr: '', exitCode: 0 };
      }
      commands.push(input.command);
      if (input.timeoutMs === 600_000) {
        const i = vi++;
        const code = verifyExitCodes[i] ?? 0;
        return { stdout: '', stderr: code === 0 ? '' : `VERIFY FAILED ${i}`, exitCode: code };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    },
  });
  return { bash, commands };
}

test('checkoutBranch: checks out (or creates) the group branch', async () => {
  const { bash, commands } = makeBashFake([]);
  const exec = bash.execute;
  if (typeof exec !== 'function') throw new Error('unreachable');
  await checkoutBranch(exec, baseInput(), 'aitm/core');
  assert.equal(commands.length, 1);
  assert.match(commands[0] ?? '', /git -C '\/tmp\/wt' checkout -B 'aitm\/core'/);
});

test('commitOnBranch: formats (when configured) then stages and commits', async () => {
  const { bash, commands } = makeBashFake([]);
  await commitOnBranch(bash, baseInput({ formatCommand: 'biome check --write .' }), 'feat: x');
  assert.equal(commands.length, 4);
  assert.match(commands[0] ?? '', /biome check --write \./);
  assert.match(commands[1] ?? '', /add -A/);
  assert.match(commands[2] ?? '', /reset -q -- \.ai-task-master/);
  assert.match(commands[3] ?? '', /commit -m 'feat: x'/);
});

test('commitOnBranch: no formatCommand skips the format step', async () => {
  const { bash, commands } = makeBashFake([]);
  await commitOnBranch(bash, baseInput(), 'feat: x');
  assert.equal(commands.length, 3);
  assert.ok(!commands.some((c) => c.includes('biome')));
});

test('commitWithVerify: a green verify commits without a fix pass', async () => {
  const { bash, commands } = makeBashFake([0]);
  const runFixPass = async () => {
    throw new Error('must not be called on a green verify');
  };
  const result = await commitWithVerify(
    bash,
    baseInput({ verifyCommand: 'bun test' }),
    'aitm/core',
    { changes: [], draftCommitMessage: 'feat: x' },
    runFixPass,
  );
  assert.equal(result.kind, 'ok');
  assert.ok(
    commands.some((c) => c.includes('commit -m')),
    'the green verify is committed',
  );
});

test('commitWithVerify: red then green runs exactly one fix pass, then commits', async () => {
  const { bash, commands } = makeBashFake([1, 0]);
  let fixPassCalls = 0;
  const runFixPass = async () => {
    fixPassCalls++;
    return {
      kind: 'ok' as const,
      changes: [{ path: 'src/b.ts', kind: 'modify' as const, summary: 'fixed' }],
    };
  };
  const result = await commitWithVerify(
    bash,
    baseInput({ verifyCommand: 'bun test' }),
    'aitm/core',
    {
      changes: [{ path: 'src/a.ts', kind: 'create', summary: 'created' }],
      draftCommitMessage: 'feat: x',
    },
    runFixPass,
  );
  assert.equal(fixPassCalls, 1);
  assert.equal(result.kind, 'ok');
  assert.ok(commands.some((c) => c.includes('commit -m')));
});

test('commitWithVerify: still red after the fix pass blocks — nothing is staged or committed', async () => {
  const { bash, commands } = makeBashFake([1, 1]);
  const runFixPass = async () => ({ kind: 'blocked' as const });
  const result = await commitWithVerify(
    bash,
    baseInput({ verifyCommand: 'bun test' }),
    'aitm/core',
    { changes: [], draftCommitMessage: 'feat: x' },
    runFixPass,
  );
  assert.equal(result.kind, 'blocked');
  if (result.kind === 'blocked') assert.match(result.reason, /still failed/i);
  assert.ok(!commands.some((c) => c.includes('add -A') || c.includes('commit -m')));
});

test('commitWithVerify: extraChanges names committed files the first pass never recorded', async () => {
  const { bash } = makeBashFake([0], 'A\tsrc/a.ts\nM\tsrc/formatted.ts\n');
  const runFixPass = async () => {
    throw new Error('must not be called on a green verify');
  };
  const result = await commitWithVerify(
    bash,
    baseInput({ verifyCommand: 'bun test' }),
    'aitm/core',
    {
      changes: [{ path: 'src/a.ts', kind: 'create', summary: 'created' }],
      draftCommitMessage: 'feat: x',
    },
    runFixPass,
  );
  assert.equal(result.kind, 'ok');
  if (result.kind !== 'ok') return;
  assert.deepEqual(result.extraChanges, [
    { path: 'src/formatted.ts', kind: 'modify', summary: 'Changed by the verify fix pass' },
  ]);
});
