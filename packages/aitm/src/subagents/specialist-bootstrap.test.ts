import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { MockLanguageModelV3 } from 'ai/test';
import type { PrGroup } from '../state/schema.ts';
import { bootstrapSpecialists, parseSpecialists } from './specialist-bootstrap.ts';

const OUTPUT = [
  '===AGENT backend-api===',
  'description: Hono routes, services, drizzle data access',
  'Keep routes thin; services framework-free.',
  'Validate every payload with zod at the boundary.',
  '',
  '===AGENT test-writer===',
  'description: bun test integration and unit coverage',
  'Use app.request; never spawn a server process.',
  '',
  'SPECIALISTS_COMPLETE',
].join('\n');

function mockModel(text: string): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: 'text', text }],
      finishReason: 'stop',
      usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
      warnings: [],
    }),
  });
}

function groups(): PrGroup[] {
  return [
    {
      id: 'g1',
      title: 'Auth infra',
      tasks: [{ id: 't1', text: 'signup and login routes', complexity: 'normal', done: false }],
      dependsOn: [],
      branch: 'aitm/g1',
      pr: null,
      status: 'pending',
      stage: 'pending',
    },
  ] as unknown as PrGroup[];
}

async function tempStateDir(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'aitm-bootstrap-'));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test('parseSpecialists extracts named blocks with description and guidance', () => {
  const parsed = parseSpecialists(OUTPUT);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0]?.name, 'backend-api');
  assert.match(parsed[0]?.description ?? '', /drizzle/);
  assert.match(parsed[0]?.guidance ?? '', /framework-free/);
  assert.equal(parsed[1]?.name, 'test-writer');
});

test('parseSpecialists drops malformed blocks, duplicates, and caps at 4', () => {
  const raw = [
    '===AGENT ok-one===',
    'description: fine',
    'body',
    '===AGENT MissingDesc===',
    'no description line',
    '===AGENT ok-one===',
    'description: duplicate name',
    'body again',
    ...[2, 3, 4, 5].flatMap((n) => [`===AGENT ok-${n}===`, `description: d${n}`, `b${n}`]),
  ].join('\n');
  const parsed = parseSpecialists(raw);
  assert.equal(parsed.length, 4, 'capped at 4');
  assert.deepEqual(
    parsed.map((p) => p.name),
    ['ok-one', 'ok-2', 'ok-3', 'ok-4'],
  );
});

test('bootstrapSpecialists generates, persists loadAgents-compatible files, and returns the roster', async () => {
  const { dir, cleanup } = await tempStateDir();
  try {
    const progress: string[] = [];
    const roster = await bootstrapSpecialists(
      { model: mockModel(OUTPUT), onProgress: (m) => progress.push(m) },
      { goal: 'build todo app', groups: groups(), styleDigest: '# Coding Style', stateDir: dir },
    );
    assert.deepEqual(
      roster.map((a) => a.name),
      ['backend-api', 'test-writer'],
    );
    assert.match(roster[0]?.systemPrompt ?? '', /framework-free/);
    const onDisk = await readFile(join(dir, 'agents', 'backend-api.md'), 'utf8');
    assert.match(onDisk, /^---\nname: backend-api\ndescription: /);
    assert.ok(progress.some((m) => m.includes('generated 2')));
  } finally {
    await cleanup();
  }
});

test('bootstrapSpecialists reuses a previously generated team without calling the model', async () => {
  const { dir, cleanup } = await tempStateDir();
  try {
    await mkdir(join(dir, 'agents'), { recursive: true });
    await writeFile(
      join(dir, 'agents', 'cached.md'),
      '---\nname: cached\ndescription: from a prior run\n---\n\nbody\n',
    );
    let calls = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        calls++;
        throw new Error('must not be called');
      },
    });
    const roster = await bootstrapSpecialists(
      { model },
      { goal: 'g', groups: groups(), stateDir: dir },
    );
    assert.deepEqual(
      roster.map((a) => a.name),
      ['cached'],
    );
    assert.equal(calls, 0);
  } finally {
    await cleanup();
  }
});

test('bootstrapSpecialists degrades to [] on a model failure or unparseable output', async () => {
  const { dir, cleanup } = await tempStateDir();
  try {
    const failing = new MockLanguageModelV3({
      doGenerate: async () => {
        throw new Error('provider down');
      },
    });
    assert.deepEqual(
      await bootstrapSpecialists(
        { model: failing },
        { goal: 'g', groups: groups(), stateDir: dir },
      ),
      [],
    );
    assert.deepEqual(
      await bootstrapSpecialists(
        { model: mockModel('no agent blocks here') },
        { goal: 'g', groups: groups(), stateDir: dir },
      ),
      [],
    );
  } finally {
    await cleanup();
  }
});
