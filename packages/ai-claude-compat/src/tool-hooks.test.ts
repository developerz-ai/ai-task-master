import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type ToolSet, tool } from 'ai';
import { z } from 'zod';
import { type HookExec, hookMatches, withHooks } from './tool-hooks.ts';

type ExecResult = { exitCode?: number; stdout?: string; stderr?: string; timedOut?: boolean };

// A fake HookExec that returns a scripted result and records the JSON payload it received on stdin.
function fakeExec(result: ExecResult | ((payload: unknown) => ExecResult)): {
  exec: HookExec;
  payloads: unknown[];
} {
  const payloads: unknown[] = [];
  const exec: HookExec = async (_command, options) => {
    const payload = JSON.parse(options.input);
    payloads.push(payload);
    return typeof result === 'function' ? result(payload) : result;
  };
  return { exec, payloads };
}

function run(tool: ReturnType<typeof withHooks>[string], input: unknown): Promise<unknown> {
  const exec = tool.execute;
  assert.equal(typeof exec, 'function');
  return (exec as (i: unknown, o: unknown) => Promise<unknown>)(input, {
    toolCallId: 'c',
    messages: [],
  });
}

const bashTool = (record: unknown[]) =>
  tool({
    description: 'bash',
    inputSchema: z.object({ command: z.string() }),
    execute: async (i) => {
      record.push(i);
      return { stdout: 'ran', stderr: '', exitCode: 0 };
    },
  });

const writeTool = (record: unknown[]) =>
  tool({
    description: 'write',
    inputSchema: z.object({ path: z.string(), content: z.string() }),
    execute: async (i) => {
      record.push(i);
      return { ok: true };
    },
  });

test('hookMatches: glob on the tool name (* wildcard, omitted = all)', () => {
  assert.equal(hookMatches(undefined, 'bash'), true);
  assert.equal(hookMatches('*', 'anything'), true);
  assert.equal(hookMatches('bash', 'bash'), true);
  assert.equal(hookMatches('bash', 'writeFile'), false);
  assert.equal(hookMatches('mcp__*', 'mcp__gh__createPr'), true);
  assert.equal(hookMatches('mcp__*', 'writeFile'), false);
});

test('withHooks with no hooks returns the registry untouched', () => {
  const tools: ToolSet = { bash: bashTool([]) };
  assert.equal(withHooks(tools, {}), tools, 'same reference — no wrapping');
});

test('PreToolUse exit 2 blocks a bash tool with the #113 BashOutput shape (exit 126), execute not called', async () => {
  const ran: unknown[] = [];
  const { exec } = fakeExec({ exitCode: 2, stderr: 'no force pushes' });
  const wrapped = withHooks(
    { bash: bashTool(ran) },
    {
      preToolUse: [{ matcher: 'bash', command: './guard' }],
    },
    { exec, onWarn: () => {} },
  );

  const out = (await run(wrapped.bash, { command: 'git push --force' })) as {
    exitCode: number;
    denied: boolean;
    stderr: string;
  };
  assert.equal(out.exitCode, 126, 'bash denial exit code');
  assert.equal(out.denied, true);
  assert.match(out.stderr, /no force pushes/);
  assert.equal(ran.length, 0, 'execute never ran');
});

test('PreToolUse exit 2 blocks a non-bash tool with the generic blocked-result shape', async () => {
  const ran: unknown[] = [];
  const { exec } = fakeExec({ exitCode: 2, stderr: 'outside allowed dir' });
  const wrapped = withHooks(
    { writeFile: writeTool(ran) },
    {
      preToolUse: [{ command: './guard' }],
    },
    { exec, onWarn: () => {} },
  );

  const out = (await run(wrapped.writeFile, { path: '/etc/x', content: 'y' })) as {
    ok: boolean;
    blockedByHook: boolean;
    reason: string;
  };
  assert.deepEqual(
    { ok: out.ok, blockedByHook: out.blockedByHook },
    { ok: false, blockedByHook: true },
  );
  assert.match(out.reason, /outside allowed dir/);
  assert.equal(ran.length, 0);
});

test('PreToolUse exit 0 with stdout JSON rewrites the tool input', async () => {
  const ran: unknown[] = [];
  const { exec } = fakeExec({ exitCode: 0, stdout: '{"input":{"path":"safe.txt","content":"z"}}' });
  const wrapped = withHooks(
    { writeFile: writeTool(ran) },
    {
      preToolUse: [{ command: './rewrite' }],
    },
    { exec, onWarn: () => {} },
  );

  await run(wrapped.writeFile, { path: 'orig.txt', content: 'a' });
  assert.deepEqual(ran, [{ path: 'safe.txt', content: 'z' }], 'input replaced by the hook');
});

test('a rewrite that fails the tool schema is discarded, warned, and the original input used', async () => {
  const ran: unknown[] = [];
  const warns: string[] = [];
  const { exec } = fakeExec({ exitCode: 0, stdout: '{"input":{"path":123}}' }); // wrong types
  const wrapped = withHooks(
    { writeFile: writeTool(ran) },
    {
      preToolUse: [{ command: './rewrite' }],
    },
    { exec, onWarn: (m) => warns.push(m) },
  );

  await run(wrapped.writeFile, { path: 'orig.txt', content: 'a' });
  assert.deepEqual(ran, [{ path: 'orig.txt', content: 'a' }], 'original input kept');
  assert.ok(
    warns.some((w) => /failed the tool schema/.test(w)),
    'discard warned',
  );
});

test('PostToolUse stdout is surfaced: appended for string results, hookFeedback for object results', async () => {
  const strTool = tool({
    description: 's',
    inputSchema: z.object({ x: z.string() }),
    execute: async () => 'result text',
  });
  const { exec } = fakeExec({ exitCode: 0, stdout: 'lint: 2 warnings' });
  const wrapped = withHooks(
    { s: strTool, writeFile: writeTool([]) },
    {
      postToolUse: [{ command: './notice' }],
    },
    { exec, onWarn: () => {} },
  );

  const strOut = (await run(wrapped.s, { x: '1' })) as string;
  assert.match(strOut, /result text/);
  assert.match(strOut, /<hook-feedback>\nlint: 2 warnings\n<\/hook-feedback>/);

  const objOut = (await run(wrapped.writeFile, { path: 'a', content: 'b' })) as {
    ok: boolean;
    hookFeedback: string;
  };
  assert.equal(objOut.ok, true);
  assert.equal(objOut.hookFeedback, 'lint: 2 warnings');
});

test('a hook that exits non-2 non-zero, times out, or crashes fails open (execute runs with original input)', async () => {
  for (const result of [
    { exitCode: 1, stderr: 'boom' } as ExecResult,
    { timedOut: true } as ExecResult,
  ]) {
    const ran: unknown[] = [];
    const warns: string[] = [];
    const { exec } = fakeExec(result);
    const wrapped = withHooks(
      { bash: bashTool(ran) },
      {
        preToolUse: [{ command: './flaky' }],
      },
      { exec, onWarn: (m) => warns.push(m) },
    );
    await run(wrapped.bash, { command: 'ls' });
    assert.deepEqual(ran, [{ command: 'ls' }], 'proceeded with original input');
    assert.ok(warns.length > 0, 'fail-open warned');
  }

  // A spawn failure (exec throws) also fails open.
  const ran: unknown[] = [];
  const throwingExec: HookExec = async () => {
    throw new Error('ENOENT');
  };
  const wrapped = withHooks(
    { bash: bashTool(ran) },
    {
      preToolUse: [{ command: './missing' }],
    },
    { exec: throwingExec, onWarn: () => {} },
  );
  await run(wrapped.bash, { command: 'ls' });
  assert.deepEqual(ran, [{ command: 'ls' }]);
});

test('the PreToolUse payload carries event/toolName/input/cwd', async () => {
  const { exec, payloads } = fakeExec({ exitCode: 0 });
  const wrapped = withHooks(
    { bash: bashTool([]) },
    {
      preToolUse: [{ command: './g' }],
    },
    { exec, cwd: '/work', onWarn: () => {} },
  );
  await run(wrapped.bash, { command: 'ls' });
  assert.deepEqual(payloads[0], {
    event: 'PreToolUse',
    toolName: 'bash',
    input: { command: 'ls' },
    cwd: '/work',
  });
});
