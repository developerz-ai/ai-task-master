import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentToolConstructionError } from '@developerz.ai/ai-claude-compat';
import { type ToolSet, tool } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { z } from 'zod';
import { emptyUsage } from '../testing/model-fixtures.ts';
import { buildExploreTool, EXPLORE_ALLOWED_TOOLS, EXPLORE_TOOL_NAME } from './explore.ts';

function textModel(text: string): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: 'text', text }],
      finishReason: { unified: 'stop', raw: undefined },
      usage: emptyUsage(),
      warnings: [],
    }),
  });
}

const readOnly = (name: string) =>
  tool({ description: name, inputSchema: z.object({ q: z.string() }), execute: async () => 'ok' });

const trio: ToolSet = {
  readFile: readOnly('readFile'),
  grep: readOnly('grep'),
  glob: readOnly('glob'),
};

test('EXPLORE_ALLOWED_TOOLS is exactly the read-only trio', () => {
  assert.deepEqual([...EXPLORE_ALLOWED_TOOLS], ['readFile', 'grep', 'glob']);
  assert.equal(EXPLORE_TOOL_NAME, 'explore');
});

test('buildExploreTool wires the fast model + trio into a callable survey tool', async () => {
  const t = buildExploreTool({
    model: textModel('Auth lives in src/auth.ts:12.'),
    readTools: trio,
  });
  assert.ok(
    t.description && /self-contained/i.test(t.description),
    'description states the prompt must be self-contained',
  );
  const exec = t.execute;
  assert.equal(typeof exec, 'function');
  const out = await (exec as (i: { prompt: string }, o: unknown) => Promise<string>)(
    { prompt: 'Where does auth live?' },
    { toolCallId: 'c', messages: [] },
  );
  assert.equal(out, 'Auth lives in src/auth.ts:12.');
});

test('buildExploreTool enforces the read-only allowlist: a write-capable tool fails construction', () => {
  const withWriter: ToolSet = { ...trio, writeFile: readOnly('writeFile') };
  assert.throws(
    () => buildExploreTool({ model: textModel('x'), readTools: withWriter }),
    (err: unknown) =>
      err instanceof AgentToolConstructionError && /writeFile/.test((err as Error).message),
  );
});

test('buildExploreTool requires the full trio: a missing read tool fails construction', () => {
  for (const omit of EXPLORE_ALLOWED_TOOLS) {
    const partial: ToolSet = { ...trio };
    delete partial[omit];
    assert.throws(
      () => buildExploreTool({ model: textModel('x'), readTools: partial }),
      (err: unknown) =>
        err instanceof AgentToolConstructionError && new RegExp(omit).test((err as Error).message),
      `omitting ${omit} must throw naming it`,
    );
  }
});

test('buildExploreTool rejects an empty toolset (no silent no-op survey child)', () => {
  assert.throws(
    () => buildExploreTool({ model: textModel('x'), readTools: {} }),
    (err: unknown) => err instanceof AgentToolConstructionError,
  );
});
