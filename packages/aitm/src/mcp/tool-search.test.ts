import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ToolSet } from 'ai';
import {
  DEFERRED_TOOLS_CONTRACT,
  deferredToolIndexBlock,
  guardDeferred,
  TOOL_SEARCH_TOOL_NAME,
  type ToolSearchInput,
  type ToolSearchOutput,
  toolSearch,
} from './tool-search.ts';

function fakeTool(description: string, extra: Partial<ToolSet[string]> = {}): ToolSet[string] {
  return {
    description,
    inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
    ...extra,
  } as ToolSet[string];
}

const deferred: ToolSet = {
  mcp__gh__create_issue: fakeTool('Create a GitHub issue in a repo. Accepts title and body.'),
  mcp__gh__list_prs: fakeTool('List pull requests for a repository.'),
  mcp__db__query: fakeTool('Run a read-only SQL query against the database.'),
};

function search(surface: ReturnType<typeof toolSearch>, input: ToolSearchInput): ToolSearchOutput {
  const exec = surface.tool.execute;
  if (typeof exec !== 'function') throw new Error('tool_search has no execute');
  return (
    exec as (i: ToolSearchInput, o: { toolCallId: string; messages: never[] }) => ToolSearchOutput
  )(input, { toolCallId: 'c', messages: [] });
}

function renderSearch(
  surface: ReturnType<typeof toolSearch>,
  input: ToolSearchInput,
  output: ToolSearchOutput,
): string {
  const fn = surface.tool.toModelOutput;
  if (typeof fn !== 'function') throw new Error('tool_search has no toModelOutput');
  return (
    fn as (o: { toolCallId: string; input: ToolSearchInput; output: ToolSearchOutput }) => {
      type: string;
      value: string;
    }
  )({ toolCallId: 'c', input, output }).value;
}

test('tool_search select: fetches exact names, activates them, and reports unknowns (issue #119)', () => {
  const surface = toolSearch(deferred);
  assert.equal(surface.activated.size, 0, 'starts fully deferred');
  const out = search(surface, { query: 'select:mcp__gh__create_issue,mcp__nope__x' });
  assert.deepEqual(
    out.matches.map((m) => m.name),
    ['mcp__gh__create_issue'],
  );
  assert.deepEqual(out.notFound, ['mcp__nope__x']);
  assert.ok(surface.activated.has('mcp__gh__create_issue'), 'the match is activated');
  assert.equal(surface.activated.has('mcp__db__query'), false);
  assert.deepEqual(out.matches[0]?.parameters, {
    type: 'object',
    properties: { path: { type: 'string' } },
  });
});

test('tool_search keyword query ranks over names+descriptions and caps at max_results (issue #119)', () => {
  let surface = toolSearch(deferred);
  const all = search(surface, { query: 'repo' });
  assert.equal(all.matches.length, 2, 'both GitHub tools mention a repo');
  assert.equal(
    all.matches.every((m) => m.name.startsWith('mcp__gh__')),
    true,
  );

  surface = toolSearch(deferred);
  const capped = search(surface, { query: 'repo', max_results: 1 });
  assert.equal(capped.matches.length, 1, 'capped to max_results');
  assert.equal(surface.activated.size, 1);
});

test('tool_search keyword query with no hits returns empty matches, activates nothing (issue #119)', () => {
  const surface = toolSearch(deferred);
  const out = search(surface, { query: 'zzz-nonexistent' });
  assert.deepEqual(out.matches, []);
  assert.equal(surface.activated.size, 0);
});

test('tool_search toModelOutput renders name, description, and JSON schema; notes activation (issue #119)', () => {
  const surface = toolSearch(deferred);
  const out = search(surface, { query: 'select:mcp__db__query' });
  const text = renderSearch(surface, { query: 'select:mcp__db__query' }, out);
  assert.match(text, /Activated 1 tool/);
  assert.match(text, /mcp__db__query/);
  assert.match(text, /read-only SQL/);
  assert.match(text, /Parameters \(JSON Schema\)/);
});

test('deferredToolIndexBlock: contract preamble + one first-sentence line per tool (issue #119)', () => {
  const block = deferredToolIndexBlock(deferred);
  assert.ok(block.startsWith(DEFERRED_TOOLS_CONTRACT));
  assert.match(block, /<deferred-tools>/);
  assert.match(block, /mcp__gh__create_issue: Create a GitHub issue in a repo\./);
  assert.equal(block.includes('Accepts title and body'), false, 'only the first sentence');
});

test('deferredToolIndexBlock: empty when nothing is deferred (issue #119)', () => {
  assert.equal(deferredToolIndexBlock({}), '');
});

test('guardDeferred: a call before activation returns the fetch-first result, never throws (issue #119)', async () => {
  const activated = new Set<string>();
  let ran = 0;
  const base = fakeTool('desc', {
    execute: async () => {
      ran += 1;
      return { ok: true };
    },
  });
  const guarded = guardDeferred('mcp__db__query', base, activated);
  const exec = guarded.execute as (i: unknown, o: unknown) => Promise<unknown>;
  const out = await exec({}, { toolCallId: 'c', messages: [] });
  assert.equal(ran, 0, 'the real executor did not run');
  const fn = guarded.toModelOutput as (o: unknown) => { type: string; value: string };
  const text = fn({ toolCallId: 'c', input: {}, output: out }).value;
  assert.match(text, /deferred tool/);
  assert.match(text, /tool_search/);
  assert.match(text, /select:mcp__db__query/);
});

test('guardDeferred: after activation the real executor runs and its result renders normally (issue #119)', async () => {
  const activated = new Set<string>(['mcp__db__query']);
  let ran = 0;
  const base = fakeTool('desc', {
    execute: async () => {
      ran += 1;
      return { rows: 3 };
    },
    toModelOutput: ({ output }: { output: { rows: number } }) => ({
      type: 'text',
      value: `rows=${output.rows}`,
    }),
  });
  const guarded = guardDeferred('mcp__db__query', base, activated);
  const exec = guarded.execute as (i: unknown, o: unknown) => Promise<unknown>;
  const out = await exec({}, { toolCallId: 'c', messages: [] });
  assert.equal(ran, 1);
  assert.deepEqual(out, { rows: 3 });
  const fn = guarded.toModelOutput as (o: unknown) => { type: string; value: string };
  assert.equal(fn({ toolCallId: 'c', input: {}, output: out }).value, 'rows=3');
});

test('TOOL_SEARCH_TOOL_NAME is the Claude Code convention name', () => {
  assert.equal(TOOL_SEARCH_TOOL_NAME, 'tool_search');
});
