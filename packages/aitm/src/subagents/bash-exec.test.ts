import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BashInput, BashOutput } from '@developerz.ai/ai-claude-compat';
import { tool } from 'ai';
import { z } from 'zod';
import { isAsyncIterable, requireExec, runBash, shQuote } from './bash-exec.ts';

test('shQuote: wraps in single quotes and escapes an embedded single quote', () => {
  assert.equal(shQuote('plain'), "'plain'");
  assert.equal(shQuote("it's"), "'it'\\''s'");
});

test('isAsyncIterable: true for an async iterable, false for a plain object or primitive', () => {
  assert.equal(isAsyncIterable({ [Symbol.asyncIterator]: () => ({}) }), true);
  assert.equal(isAsyncIterable({}), false);
  assert.equal(isAsyncIterable(null), false);
  assert.equal(isAsyncIterable('x'), false);
});

test('requireExec: returns the execute function when present', () => {
  const bash = tool<BashInput, BashOutput>({
    description: 'run a bash command',
    inputSchema: z.object({
      command: z.string(),
      description: z.string(),
      timeoutMs: z.number().optional(),
      run_in_background: z.boolean().optional(),
    }),
    execute: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
  });
  assert.equal(typeof requireExec(bash), 'function');
});

test('requireExec: throws when the bash tool has no execute function', () => {
  const bash = tool<BashInput, BashOutput>({
    description: 'a client-side tool with no execute',
    inputSchema: z.object({
      command: z.string(),
      description: z.string(),
      timeoutMs: z.number().optional(),
      run_in_background: z.boolean().optional(),
    }),
  });
  assert.throws(() => requireExec(bash), /missing an execute function/);
});

test('runBash: resolves silently on a zero exit', async () => {
  const bash = tool<BashInput, BashOutput>({
    description: 'run a bash command',
    inputSchema: z.object({
      command: z.string(),
      description: z.string(),
      timeoutMs: z.number().optional(),
      run_in_background: z.boolean().optional(),
    }),
    execute: async () => ({ stdout: 'ok', stderr: '', exitCode: 0 }),
  });
  const exec = requireExec(bash);
  await assert.doesNotReject(() => runBash(exec, 'echo ok'));
});

test('runBash: throws with the exit code and stderr on a non-zero exit', async () => {
  const bash = tool<BashInput, BashOutput>({
    description: 'run a bash command',
    inputSchema: z.object({
      command: z.string(),
      description: z.string(),
      timeoutMs: z.number().optional(),
      run_in_background: z.boolean().optional(),
    }),
    execute: async () => ({ stdout: '', stderr: 'boom', exitCode: 7 }),
  });
  const exec = requireExec(bash);
  await assert.rejects(() => runBash(exec, 'false'), /bash failed \(7\).*boom/s);
});
