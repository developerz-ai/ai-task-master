import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BashInput, BashOutput } from '@developerz.ai/ai-claude-compat';
import { type Tool, tool } from 'ai';
import { z } from 'zod';
import { discardStrayEdits, hasStrayEdit } from './stray-edits.ts';

// A bash-tool double that records every command it runs and answers from a handler keyed on the
// command string. Mirrors the reviewer/worker test doubles so behavior is exercised through the real
// `Tool` surface, not a bare function.
function makeBash(handler: (command: string) => Partial<BashOutput> = () => ({})): {
  bash: Tool<BashInput, BashOutput>;
  cmds: string[];
} {
  const cmds: string[] = [];
  const bash = tool<BashInput, BashOutput>({
    description: 'run a bash command in the checkout',
    inputSchema: z.object({
      command: z.string(),
      description: z.string(),
      timeoutMs: z.number().optional(),
      run_in_background: z.boolean().optional(),
    }),
    execute: async (input) => {
      cmds.push(input.command);
      return { stdout: '', stderr: '', exitCode: 0, ...handler(input.command) };
    },
  });
  return { bash, cmds };
}

test('hasStrayEdit: state-dir entries never count as a dirty tree', () => {
  // In a repo that does not gitignore `.ai-task-master`, aitm's own untracked state files show up in
  // `git status --porcelain`. Counting them would hard-reset the checkout on every non-committing
  // pass — and `git clean` would delete the run's own plan and scratch.
  assert.equal(hasStrayEdit(''), false);
  assert.equal(hasStrayEdit('?? .ai-task-master/\n'), false);
  assert.equal(
    hasStrayEdit('?? .ai-task-master/state.json\n?? .ai-task-master/scratch/fuzz.ts\n'),
    false,
  );
  assert.equal(hasStrayEdit(' M README.md\n'), true);
  assert.equal(hasStrayEdit('?? .ai-task-master/state.json\n M README.md\n'), true);
});

test('discardStrayEdits: a clean tree is a no-op beyond the status probe', async () => {
  const { bash, cmds } = makeBash((c) => (c.includes('status --porcelain') ? { stdout: '' } : {}));
  await discardStrayEdits(bash, '/tmp/wt');
  assert.deepEqual(cmds, [`git -C '/tmp/wt' status --porcelain`]);
});

test('discardStrayEdits: a dirty tree is reset --hard and cleaned (sparing the state dir)', async () => {
  const { bash, cmds } = makeBash((c) =>
    c.includes('status --porcelain') ? { stdout: ' M src/a.ts\n?? junk.txt\n' } : {},
  );
  await discardStrayEdits(bash, '/tmp/wt');
  assert.deepEqual(cmds, [
    `git -C '/tmp/wt' status --porcelain`,
    `git -C '/tmp/wt' reset --hard HEAD`,
    `git -C '/tmp/wt' clean -fd -e .ai-task-master`,
  ]);
});

test('discardStrayEdits: a tree dirty only with state-dir files is left untouched', async () => {
  const { bash, cmds } = makeBash((c) =>
    c.includes('status --porcelain') ? { stdout: '?? .ai-task-master/state.json\n' } : {},
  );
  await discardStrayEdits(bash, '/tmp/wt');
  assert.deepEqual(cmds, [`git -C '/tmp/wt' status --porcelain`]);
});

test('discardStrayEdits: a failed status probe bails without resetting (best-effort)', async () => {
  const { bash, cmds } = makeBash((c) =>
    c.includes('status --porcelain')
      ? { stdout: '', stderr: 'fatal: not a git repository', exitCode: 128 }
      : {},
  );
  await discardStrayEdits(bash, '/tmp/wt');
  assert.deepEqual(cmds, [`git -C '/tmp/wt' status --porcelain`]);
});

test('discardStrayEdits: a reset/clean fault never throws (best-effort cleanup)', async () => {
  const { bash, cmds } = makeBash((c) => {
    if (c.includes('status --porcelain')) return { stdout: ' M src/a.ts\n' };
    if (c.includes('reset --hard')) return { stderr: 'boom', exitCode: 1 };
    return {};
  });
  // A non-zero reset must be swallowed, and the clean still attempted — the pass's real result stands.
  await discardStrayEdits(bash, '/tmp/wt');
  assert.deepEqual(cmds, [
    `git -C '/tmp/wt' status --porcelain`,
    `git -C '/tmp/wt' reset --hard HEAD`,
    `git -C '/tmp/wt' clean -fd -e .ai-task-master`,
  ]);
});

test('discardStrayEdits: no runnable bash execute → no-op', async () => {
  const bash = { description: 'x', inputSchema: z.object({}) } as unknown as Tool<
    BashInput,
    BashOutput
  >;
  await discardStrayEdits(bash, '/tmp/wt'); // must not throw
});
