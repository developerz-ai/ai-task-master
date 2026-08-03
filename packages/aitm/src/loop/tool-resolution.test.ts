// Unit coverage for tool-resolution.ts: the local (no-MCP) tool builders, MCP partial-fill, and
// deferred-loading machinery. Extracted from run-loop-adapter.test.ts (split alongside the source
// module in the loop/ SRP sweep) so this module ships with its own paired test file.

import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { backgroundProcessTools, SUBMIT_TOOL_NAME } from '@developerz.ai/ai-claude-compat';
import type { ToolSet } from 'ai';
import { jsonSchema, tool } from 'ai';
import { z } from 'zod';
import { McpClientManager } from '../mcp/mcp-client.ts';
import { TOOL_SEARCH_TOOL_NAME } from '../mcp/tool-search.ts';
import { buildMemoryTool } from '../subagents/memory-tool.ts';
import { resolvedConfig } from '../testing/domain-fixtures.ts';
import { mcpClientDouble } from '../testing/mcp-client-double.ts';
import { prepareStepArg } from '../testing/step-results.ts';
import { runTool } from '../testing/tool-harness.ts';
import {
  activeToolNames,
  applyHooks,
  exploreReadTools,
  localEditTools,
  localReadTools,
  mcpTool,
  mountDeferredTools,
  resolvePlannerTools,
  resolveWorkerTools,
  withActiveTools,
} from './tool-resolution.ts';

test('mcpTool: partial-fill matches a namespaced MCP tool by canonical name, first in config order (issue #115)', () => {
  const a = mcpFake('a');
  const b = mcpFake('b');
  // Namespaced ToolSet as toolsForRole now produces it; insertion order = server/config order.
  const set = {
    mcp__fs__readFile: a,
    mcp__other__readFile: b,
    mcp__git__status: mcpFake('status'),
  };
  assert.strictEqual(mcpTool(set, 'readFile'), a, 'first server in config order wins');
  assert.strictEqual(mcpTool(set, 'status'), set.mcp__git__status);
  // A canonical name no server exports → undefined (caller falls back to the local tool).
  assert.equal(mcpTool(set, 'writeFile'), undefined);
  // A bare (non-namespaced) key is never matched.
  assert.equal(mcpTool({ readFile: a }, 'readFile'), undefined);
  // Empty set (no MCP servers) → undefined → all-local fallback (bare `aitm start`).
  assert.equal(mcpTool({}, 'readFile'), undefined);
});

test('localEditTools supplies checkout-scoped readFile/writeFile/bash (no-MCP fallback)', () => {
  // When no MCP server provides edit tools, the Worker/Reviewer fall back to these so a bare
  // `aitm start` can still edit, commit and open a PR (instead of blocking).
  const tools = localEditTools('/tmp/some-checkout');
  assert.equal(typeof tools.readFile.execute, 'function');
  assert.equal(typeof tools.writeFile.execute, 'function');
  assert.equal(typeof tools.bash.execute, 'function');
});

test('localEditTools: threads bash deny/allow rules into the bash + multiBash tools (issue #113)', async () => {
  const tools = localEditTools('/tmp/wt', [{ pattern: 'git push --force*', action: 'deny' }]);
  const bashOut = await runTool(tools.bash, {
    command: 'git push --force',
    description: 'force push',
  });
  assert.equal(bashOut.exitCode, 126);
  assert.equal(bashOut.denied, true);
  const multiOut = await runTool(tools.multiBash, { commands: ['git push --force'] });
  assert.equal(multiOut.failedAt, 0);
  assert.equal(multiOut.exitCode, 126);
});

test('localEditTools: a wired ProcessManager routes bash({ run_in_background: true }) to a backgrounded process (issue #103)', async () => {
  const bg = backgroundProcessTools({ cwd: process.cwd() });
  try {
    const tools = localEditTools(process.cwd(), undefined, false, bg.manager);
    const out = await runTool(tools.bash, {
      command: 'sleep 30',
      description: 'start a long-lived process',
      run_in_background: true,
    });
    // The manager path returns the background id/hint, not the no-manager foreground-degradation notice.
    assert.match(out.stdout, /Started background process bg-1/);
    assert.equal(
      bg.manager.list().some((p) => p.running),
      true,
      'the command is tracked as a running background process',
    );
  } finally {
    bg.manager.killAll('SIGKILL');
  }
});

// Flatten a tool-result rendering to text for reminder assertions.
function renderedText(rendered: unknown): string {
  const r = rendered as { type: string; value: unknown };
  if (r.type === 'text') return r.value as string;
  if (r.type === 'content') {
    return (r.value as Array<{ type: string; text?: string }>)
      .map((p) => (p.type === 'text' ? (p.text ?? '') : ''))
      .join('\n');
  }
  return JSON.stringify(r.value);
}

test('localEditTools: a file changed on disk after its Read surfaces one file-changed reminder on the next file-tool result (issue #106)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aitm-reminder-'));
  try {
    await writeFile(join(dir, 'a.ts'), 'v1', 'utf8');
    const tools = localEditTools(dir);
    // Model reads A (the tracker records its content hash).
    await runTool(tools.readFile, { path: 'a.ts' });
    // A is modified on disk out from under the model.
    await writeFile(join(dir, 'a.ts'), 'v2-changed-on-disk', 'utf8');
    // An edit against the since-changed file is rejected (read-before-edit staleness, #104) — the
    // rejection is what flags A stale in the tracker.
    await assert.rejects(
      runTool(tools.editFile, { path: 'a.ts', oldString: 'v2-changed-on-disk', newString: 'x' }),
      /modified since you read it/,
    );
    // The next successful file-tool result now carries exactly one file-changed-externally envelope.
    const rendered = await tools.readFile.toModelOutput?.({
      toolCallId: 't2',
      input: { path: 'b.ts' },
      output: { content: '1\tcontents of b' },
    });
    const text = renderedText(rendered);
    assert.equal((text.match(/<system-reminder>/g) ?? []).length, 1, 'exactly one envelope');
    assert.match(text, /a\.ts was modified on disk since you last read it/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('localEditTools mounts webFetch + datetime; fetchHtml only when its binary is available', () => {
  const tools = localEditTools('/tmp/x');
  assert.ok(tools.webFetch, 'webFetch present');
  assert.ok(tools.datetime, 'datetime present');
  assert.equal('fetchHtml' in tools, false, 'no fetchHtml when unavailable (default)');
  const withHtml = localEditTools('/tmp/x', undefined, true);
  assert.ok(withHtml.fetchHtml, 'fetchHtml mounted when available');
});

test('localReadTools (planner) mounts webFetch + datetime alongside the read-only set', () => {
  const tools = localReadTools('/tmp/x');
  assert.ok(tools.readFile && tools.grep && tools.glob, 'read-only core present');
  assert.ok(tools.webFetch && tools.datetime, 'web + time tools present');
  assert.equal('fetchHtml' in tools, false);
  assert.ok(localReadTools('/tmp/x', true).fetchHtml, 'fetchHtml mounted when available');
});

// ---- explore fan-out wiring (issue #126) -----------------------------------

const stubExplore = () =>
  tool({
    description: 'stub explore',
    inputSchema: z.object({ prompt: z.string() }),
    execute: async () => 'surveyed',
  });

test('exploreReadTools exposes exactly the checkout-confined read trio', () => {
  const tools = exploreReadTools('/tmp/some-checkout');
  assert.deepEqual(Object.keys(tools).sort(), ['glob', 'grep', 'readFile']);
  assert.equal(typeof tools.readFile?.execute, 'function');
});

test('exploreReadTools: the explore child readFile rejects a path escaping the worktree', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aitm-explore-'));
  try {
    const tools = exploreReadTools(dir);
    const exec = tools.readFile?.execute;
    assert.equal(typeof exec, 'function');
    await assert.rejects(
      () =>
        (exec as (i: unknown, o: unknown) => Promise<unknown>)(
          { path: '../escape' },
          { toolCallId: 't', messages: [] },
        ),
      /escapes worktree/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('resolveWorkerTools mounts explore only when the caller wires it (never MCP-filled)', () => {
  // Bare no-MCP `aitm start`: empty server set, explore supplied → the manifest Worker gets the local
  // trio plus explore.
  const withExplore = resolveWorkerTools({}, '/tmp/wt', undefined, false, stubExplore());
  assert.equal('explore' in withExplore, true, 'explore present when wired');
  assert.equal(typeof withExplore.readFile.execute, 'function', 'local trio still filled');
  // Omitted (take-over flow / bare stubs) → absent, record behaves exactly as before.
  const withoutExplore = resolveWorkerTools({}, '/tmp/wt');
  assert.equal('explore' in withoutExplore, false, 'absent when not wired');
});

// One directory for the whole file, removed in teardown: `buildMemoryTool` does not own the
// directory's lifetime, so a per-call mkdtemp would leave one behind on every test.
const memoryDirs: string[] = [];
const stubMemory = () => {
  const dir = mkdtempSync(join(tmpdir(), 'aitm-mem-'));
  memoryDirs.push(dir);
  return buildMemoryTool(dir);
};

after(async () => {
  await Promise.all(memoryDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

test('applyHooks wraps the tool record when hooks are configured, no-op otherwise (issue #121)', () => {
  const base = resolveWorkerTools({}, '/tmp/wt');
  assert.equal(
    applyHooks(base, { resolved: resolvedConfig() }, '/tmp/wt'),
    base,
    'no hooks → same record reference',
  );

  const hooked = {
    resolved: resolvedConfig({ hooks: { preToolUse: [{ command: './guard.sh' }] } }),
  };
  const wrapped = applyHooks(base, hooked, '/tmp/wt');
  assert.notEqual(wrapped, base, 'hooks configured → a new wrapped record');
  assert.deepEqual(
    Object.keys(wrapped).sort(),
    Object.keys(base).sort(),
    'same tool names preserved',
  );
});

test('resolveWorkerTools mounts memory only when the caller wires it (never MCP-filled) — issue #118', () => {
  const withMemory = resolveWorkerTools({}, '/tmp/wt', undefined, false, undefined, stubMemory());
  assert.equal('memory' in withMemory, true, 'memory present when wired');
  const withoutMemory = resolveWorkerTools({}, '/tmp/wt');
  assert.equal('memory' in withoutMemory, false, 'absent when not wired');
});

test('resolveWorkerTools mounts the background trio only when a manager is wired (issues #103, #182)', () => {
  const bg = backgroundProcessTools({ cwd: '/tmp/wt' });
  const withBg = resolveWorkerTools({}, '/tmp/wt', undefined, false, undefined, undefined, bg);
  assert.equal('bashOutput' in withBg, true, 'bashOutput present when wired');
  assert.equal('killBash' in withBg, true, 'killBash present when wired');
  // An id lives only in the tool result that minted it, so after compaction drops that turn the
  // agent can poll an id it still remembers but cannot discover one it forgot (issue #182).
  assert.equal('listBackground' in withBg, true, 'listBackground present when wired');
  // Deliberately absent: backgroundBash duplicates bash({ run_in_background: true }), and two tools
  // for one act is a worse surface than one.
  assert.equal('backgroundBash' in withBg, false, 'backgroundBash is not mounted');
  const withoutBg = resolveWorkerTools({}, '/tmp/wt');
  assert.equal('bashOutput' in withoutBg, false, 'absent when not wired');
  assert.equal('killBash' in withoutBg, false, 'absent when not wired');
  assert.equal('listBackground' in withoutBg, false, 'absent when not wired');
});

test('resolvePlannerTools mounts explore only when the caller wires it', () => {
  const withExplore = resolvePlannerTools({}, '/tmp/repo', false, stubExplore());
  assert.equal('explore' in withExplore, true);
  const withoutExplore = resolvePlannerTools({}, '/tmp/repo');
  assert.equal('explore' in withoutExplore, false);
  // The Planner never gets a memory tool — it reads memory files directly (issue #118).
  assert.equal('memory' in withExplore, false, 'planner has no memory tool');
});

// ---- deferred MCP tool loading (issue #119) ----

function mcpFake(desc: string): ToolSet[string] {
  return { description: desc, inputSchema: jsonSchema({ type: 'object' }) };
}

test('mountDeferredTools: below threshold (nothing deferred) mounts surplus direct, no tool_search (issue #119)', () => {
  const mount = mountDeferredTools({
    direct: { mcp__gh__create_issue: mcpFake('Create an issue.') },
    deferred: {},
  });
  assert.deepEqual(Object.keys(mount.extraTools), ['mcp__gh__create_issue']);
  assert.equal(mount.indexBlock, '');
  assert.equal(mount.activated, null);
  assert.equal(mount.deferredNames.size, 0);
  assert.equal(
    TOOL_SEARCH_TOOL_NAME in mount.extraTools,
    false,
    'no tool_search when nothing deferred',
  );
});

test('mountDeferredTools: above threshold defers surplus behind tool_search + a name-only index (issue #119)', () => {
  const mount = mountDeferredTools({
    direct: {},
    deferred: {
      mcp__gh__create_issue: mcpFake('Create an issue.'),
      mcp__db__query: mcpFake('Query the DB.'),
    },
  });
  assert.ok(TOOL_SEARCH_TOOL_NAME in mount.extraTools, 'tool_search mounted');
  assert.ok(
    'mcp__gh__create_issue' in mount.extraTools,
    'deferred tool guard-wrapped into the record',
  );
  assert.ok('mcp__db__query' in mount.extraTools);
  assert.match(mount.indexBlock, /mcp__gh__create_issue: Create an issue\./);
  assert.notEqual(mount.activated, null);
  assert.deepEqual([...mount.deferredNames].sort(), ['mcp__db__query', 'mcp__gh__create_issue']);
});

test('mountDeferredTools: fixed-slot-named MCP tools are not surplus — excluded from the mount (issue #119)', () => {
  const mount = mountDeferredTools({
    direct: {},
    deferred: { mcp__fs__readFile: mcpFake('read'), mcp__gh__x: mcpFake('x') },
  });
  // readFile is a fixed slot (partial-filled elsewhere) → not deferred here; only true surplus is.
  assert.deepEqual([...mount.deferredNames], ['mcp__gh__x']);
  assert.equal('mcp__fs__readFile' in mount.extraTools, false);
});

test('activeToolNames: hides un-activated deferred tools, always keeps submit + non-deferred (issue #119)', () => {
  const tools: ToolSet = {
    readFile: mcpFake('r'),
    mcp__gh__x: mcpFake('x'),
    [TOOL_SEARCH_TOOL_NAME]: mcpFake('search'),
  };
  const deferredNames = new Set(['mcp__gh__x']);
  const before = activeToolNames(tools, deferredNames, new Set());
  assert.equal(before.includes('mcp__gh__x'), false, 'deferred tool inactive until fetched');
  assert.ok(before.includes('readFile') && before.includes(TOOL_SEARCH_TOOL_NAME));
  assert.ok(before.includes(SUBMIT_TOOL_NAME), 'submit always active');
  const after = activeToolNames(tools, deferredNames, new Set(['mcp__gh__x']));
  assert.ok(after.includes('mcp__gh__x'), 'an activated deferred tool becomes active');
});

test('deferred loading end-to-end: an over-threshold MCP server surfaces name-only + tool_search on the Worker (issue #119)', async () => {
  const surplus: ToolSet = {
    create_issue: mcpFake('Create a GitHub issue.'),
    list_prs: mcpFake('List PRs.'),
  };
  const mcp = new McpClientManager({
    servers: { gh: { command: 'gh-mcp' } },
    deferToolsOver: 1, // 2 surplus tools > 1 → deferred
    createClient: async () => mcpClientDouble({ tools: surplus }),
  });
  await mcp.connectAll();
  const mount = mountDeferredTools(mcp.toolSurfaceForRole('worker'));
  // resolveWorkerTools fills the fixed slots (local, since the server supplies none); the surplus is
  // added by the mount — proving tools beyond the fixed slots now reach the Worker (dropped pre-#119).
  const workerTools: ToolSet = {
    ...resolveWorkerTools(mcp.toolsForRole('worker'), '/tmp/wt'),
    ...mount.extraTools,
  };
  assert.ok(TOOL_SEARCH_TOOL_NAME in workerTools, 'tool_search reaches the Worker');
  assert.ok(
    'mcp__gh__create_issue' in workerTools,
    'surplus tools reach the Worker (were dropped before #119)',
  );
  assert.ok('readFile' in workerTools, 'fixed slots still present');
  const active = activeToolNames(workerTools, mount.deferredNames, mount.activated ?? new Set());
  assert.equal(
    active.includes('mcp__gh__create_issue'),
    false,
    'deferred schema absent from active tools until fetched',
  );
  assert.ok(
    active.includes('readFile') && active.includes(SUBMIT_TOOL_NAME),
    'fixed slots + submit stay active',
  );
  await mcp.close();
});

test('resolveWorkerTools mounts Skill only when a skill is model-invocable (issue #181)', () => {
  const invocable = {
    name: 'usable',
    description: 'a procedure the model may call',
    body: 'do it',
    path: '',
    extra: {},
  };
  // `disable-model-invocation: true` skills are excluded by skillTool itself, so a set made only of
  // them resolves to zero names — mounting on `skills.length` would advertise a tool whose every
  // call fails.
  const disabled = {
    ...invocable,
    name: 'opted-out',
    extra: { 'disable-model-invocation': 'true' },
  };

  const withSkill = resolveWorkerTools(
    {},
    '/tmp/wt',
    undefined,
    false,
    undefined,
    undefined,
    undefined,
    [invocable],
  );
  assert.equal('Skill' in withSkill, true, 'mounted when something is invocable');

  const allDisabled = resolveWorkerTools(
    {},
    '/tmp/wt',
    undefined,
    false,
    undefined,
    undefined,
    undefined,
    [disabled],
  );
  assert.equal('Skill' in allDisabled, false, 'not mounted when every skill opted out');

  const none = resolveWorkerTools(
    {},
    '/tmp/wt',
    undefined,
    false,
    undefined,
    undefined,
    undefined,
    [],
  );
  assert.equal('Skill' in none, false, 'not mounted with no skills at all');
});

test('withActiveTools: with no base step, activation alone is the whole prepareStep (issue #193)', async () => {
  // The CI-fix session and the Planner build a prepareStep only when a Compactor is configured, so
  // the deferred-loading wrapper has to work with nothing underneath it.
  const tools: ToolSet = { readFile: mcpFake('Read a file.'), mcp__gh__x: mcpFake('Do a thing.') };
  const deferred = new Set(['mcp__gh__x']);

  const beforeSearch = await withActiveTools<ToolSet>(
    undefined,
    tools,
    deferred,
    new Set(),
  )(prepareStepArg([], []));
  assert.deepEqual(
    beforeSearch?.activeTools,
    ['readFile', SUBMIT_TOOL_NAME],
    'the deferred tool is withheld and nothing else is dropped',
  );

  const afterSearch = await withActiveTools<ToolSet>(
    undefined,
    tools,
    deferred,
    new Set(['mcp__gh__x']),
  )(prepareStepArg([], []));
  assert.ok(
    afterSearch?.activeTools?.includes('mcp__gh__x'),
    'an activated tool becomes callable on the next step',
  );
});

test('withActiveTools: a base step keeps its own result alongside activeTools (issue #119)', async () => {
  const tools: ToolSet = { readFile: mcpFake('Read a file.') };
  const base = async (): Promise<{ messages: [] }> => ({ messages: [] });
  const out = await withActiveTools<ToolSet>(
    base,
    tools,
    new Set(),
    new Set(),
  )(prepareStepArg([], []));
  assert.deepEqual(out?.messages, [], "the base step's override survives");
  assert.ok(out?.activeTools?.includes('readFile'));
});
