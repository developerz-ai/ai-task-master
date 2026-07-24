// Shared primitives for driving the `bash` tool from a non-model caller (the Worker's commit,
// verify, and fanout-dispatch phases all run git/format commands directly rather than through the
// model). One place for the "call it, unwrap the result, throw on a real failure" contract so those
// phase modules don't each reinvent it.

import { randomUUID } from 'node:crypto';
import type { BashInput, BashOutput } from '@developerz.ai/ai-claude-compat';
import type { Tool } from 'ai';

export function requireExec(
  bash: Tool<BashInput, BashOutput>,
): NonNullable<Tool<BashInput, BashOutput>['execute']> {
  const exec = bash.execute;
  if (typeof exec !== 'function') {
    throw new Error('bash tool is missing an execute function');
  }
  return exec;
}

export function isAsyncIterable(v: unknown): v is AsyncIterable<unknown> {
  return v !== null && typeof v === 'object' && Symbol.asyncIterator in (v as object);
}

// POSIX shell-quote: wrap in single quotes, escape embedded single quotes.
export function shQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

// Run a bash command outside the model loop (a harness-driven git/format step), throwing on a
// non-zero exit or a streamed result — every caller here needs the command to have actually
// succeeded before moving on, not a result to interpret.
export async function runBash(
  exec: NonNullable<Tool<BashInput, BashOutput>['execute']>,
  command: string,
): Promise<void> {
  const out = await exec(
    { command, description: 'worker commit-phase git/format step' },
    { toolCallId: `worker-bash-${randomUUID()}`, messages: [] },
  );
  if (isAsyncIterable(out)) {
    throw new Error('bash tool returned an async iterable; expected a single result');
  }
  if (out.exitCode !== 0) {
    throw new Error(`bash failed (${out.exitCode}): ${command}\n${out.stderr}`);
  }
}
