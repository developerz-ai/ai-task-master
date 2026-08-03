import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { MockLanguageModelV3 } from 'ai/test';
import type { PrGroup } from '../domain/pr-group.ts';
import { textResult } from '../testing/model-fixtures.ts';
import { bootstrapSpecialists, parseSpecialists, sanitizeName } from './specialist-bootstrap.ts';

const OUTPUT = [
  '===AGENT backend-api===',
  'description: Owns Hono routes, services, and drizzle data access. Use for endpoints and queries.',
  'Keep routes thin; services framework-free.',
  'Validate every payload with zod at the boundary.',
  '',
  '===AGENT bun-tests===',
  'description: Owns bun test integration and unit coverage. Use for specs, fixtures, and harnesses.',
  'Use app.request; never spawn a server process.',
  '',
  'SPECIALISTS_COMPLETE',
].join('\n');

function mockModel(text: string): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doGenerate: async () => textResult(text),
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
  assert.equal(parsed[1]?.name, 'bun-tests');
});

// A description long enough to pass the router-entry floor, keyed by domain word.
function desc(domain: string): string {
  return `description: Owns the ${domain} surface. Use for ${domain} tasks, files, and checks.`;
}

test('parseSpecialists drops malformed blocks, duplicates, and caps at 4', () => {
  const raw = [
    '===AGENT stripe-webhooks===',
    desc('stripe webhook'),
    'body',
    '===AGENT MissingDesc===',
    'no description line',
    '===AGENT stripe-webhooks===',
    desc('duplicate'),
    'body again',
    ...['sqlite', 'graphql', 'react', 'kafka'].flatMap((n) => [
      `===AGENT ${n}-layer===`,
      desc(n),
      `body ${n}`,
    ]),
  ].join('\n');
  const parsed = parseSpecialists(raw);
  assert.equal(parsed.length, 4, 'capped at 4');
  assert.deepEqual(
    parsed.map((p) => p.name),
    ['stripe-webhooks', 'sqlite-layer', 'graphql-layer', 'react-layer'],
  );
});

test('parseSpecialists drops a name that carries no routable word', () => {
  // `code-specialist` is every word the router already discards — it would match no task, ever.
  const raw = [
    '===AGENT code-specialist===',
    desc('everything'),
    'body',
    '===AGENT sqlite-migrations===',
    desc('sqlite migration'),
    'body',
  ].join('\n');
  assert.deepEqual(
    parseSpecialists(raw).map((p) => p.name),
    ['sqlite-migrations'],
  );
});

test('parseSpecialists drops a description too thin to route against', () => {
  const raw = ['===AGENT sqlite-migrations===', 'description: db stuff', 'body'].join('\n');
  assert.deepEqual(parseSpecialists(raw), []);
});

test('parseSpecialists drops a specialist whose words a prior one already claims', () => {
  const raw = [
    '===AGENT graphql-schema===',
    desc('graphql schema'),
    'body',
    '===AGENT graphql===',
    desc('graphql'),
    'body',
  ].join('\n');
  assert.deepEqual(
    parseSpecialists(raw).map((p) => p.name),
    ['graphql-schema'],
  );
});

test('sanitizeName: normalizes case and separators to kebab-case', () => {
  assert.equal(sanitizeName('GraphQL_Schema'), 'graphql-schema');
  assert.equal(sanitizeName('  Stripe Webhooks  '), 'stripe-webhooks');
});

test('sanitizeName: strips suffixes that name no domain', () => {
  assert.equal(sanitizeName('stripe-webhooks-agent'), 'stripe-webhooks');
  assert.equal(sanitizeName('react-forms-specialist'), 'react-forms');
});

test('sanitizeName: rejects a name with nothing routable left', () => {
  assert.equal(sanitizeName('code-specialist'), '');
  assert.equal(sanitizeName('agent'), '');
  assert.equal(sanitizeName('---'), '');
});

test('sanitizeName: keeps at most three words and rejects an over-long name', () => {
  assert.equal(sanitizeName('stripe-webhooks-retry-backoff-queue'), 'stripe-webhooks-retry');
  assert.equal(sanitizeName('authentication-authorization-provisioning'), '');
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
      ['backend-api', 'bun-tests'],
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
