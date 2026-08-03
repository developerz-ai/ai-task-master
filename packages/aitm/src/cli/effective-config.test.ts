import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ConfigSourceMap, ResolvedConfig } from '../config/schema.ts';
import { formatEffectiveConfig } from './effective-config.ts';

const makeResolved = (overrides: Partial<ResolvedConfig> = {}): ResolvedConfig => ({
  openrouterApiKey: 'sk-or-v1-0123456789abcdef',
  apiKeySource: 'env',
  models: { generic: 'g/model', smart: 's/model', coding: 'c/model', fast: 'f/model' },
  reasoningEffort: {},
  maxPrs: 5,
  maxSessions: null,
  maxCiFixAttempts: 3,
  llmStepTimeoutMs: 600000,
  autoMerge: true,
  prPerTask: false,
  mergeMethod: 'squash',
  stylePath: null,
  formatCommand: null,
  verifyCommand: null,
  selfReview: true,
  skills: false,
  resolveConflicts: true,
  generateSpecialists: true,
  logLevel: 'info',
  concurrency: 1,
  subagentLimit: 10,
  allowForcePush: true,
  bashRules: [
    { pattern: 'git push --force*', action: 'deny' },
    { pattern: 'gh pr merge', action: 'deny' },
  ],
  mcpDeferToolsOver: 20,
  streaming: false,
  mcpServers: {},
  mcpServerSources: {},
  ...overrides,
});

// Pull the value + source columns for a key out of the rendered table.
function row(output: string, key: string): { value: string; source: string } | undefined {
  const line = output.split('\n').find((l) => l.startsWith(`${key}\t`));
  if (line === undefined) return undefined;
  const [, value, source] = line.split('\t');
  return { value: value ?? '', source: source ?? '' };
}

test('effective-config: header names the precedence order and the columns', () => {
  const out = formatEffectiveConfig(makeResolved(), { maxPrs: 'default' });
  assert.match(out, /default < profile < global < project < env < CLI/);
  assert.match(out, /\nkey\tvalue\tsource\n/);
});

test('effective-config: each key renders value and its source label', () => {
  const sources: ConfigSourceMap = { maxPrs: 'global', autoMerge: 'default', logLevel: 'project' };
  const out = formatEffectiveConfig(
    makeResolved({ maxPrs: 8, autoMerge: true, logLevel: 'debug' }),
    sources,
  );
  assert.deepEqual(row(out, 'maxPrs'), { value: '8', source: 'global' });
  assert.deepEqual(row(out, 'autoMerge'), { value: 'true', source: 'default' });
  assert.deepEqual(row(out, 'logLevel'), { value: 'debug', source: 'project' });
});

test('effective-config: openrouterApiKey is display-masked, never cleartext', () => {
  const secret = 'sk-or-v1-0123456789abcdef';
  const out = formatEffectiveConfig(makeResolved({ openrouterApiKey: secret }), {
    openrouterApiKey: 'env',
  });
  assert.ok(!out.includes(secret), 'full key must not appear');
  assert.deepEqual(row(out, 'openrouterApiKey'), { value: 'sk-or-…cdef', source: 'env' });
});

test('effective-config: unset baseURL reads as the provider default', () => {
  const out = formatEffectiveConfig(makeResolved(), { baseURL: 'default' });
  assert.deepEqual(row(out, 'baseURL'), { value: '(provider default)', source: 'default' });
});

test('effective-config: dotted per-tier model keys resolve to their tier value', () => {
  const out = formatEffectiveConfig(makeResolved(), {
    'models.coding': 'profile',
    'models.generic': 'cli',
  });
  assert.deepEqual(row(out, 'models.coding'), { value: 'c/model', source: 'profile' });
  assert.deepEqual(row(out, 'models.generic'), { value: 'g/model', source: 'cli' });
});

test('effective-config: object-valued keys render as compact JSON', () => {
  const out = formatEffectiveConfig(makeResolved({ providerRouting: { sort: 'price' } }), {
    providerRouting: 'global',
  });
  assert.deepEqual(row(out, 'providerRouting'), { value: '{"sort":"price"}', source: 'global' });
});

test('effective-config: bashRules is a merged summary, not a single source', () => {
  const out = formatEffectiveConfig(makeResolved(), {});
  assert.deepEqual(row(out, 'bashRules'), {
    value: '2 rules (first-match-wins)',
    source: 'merged',
  });
});

test('effective-config: MCP servers list transport + per-entry provenance, sorted by name', () => {
  const out = formatEffectiveConfig(
    makeResolved({
      mcpServers: {
        zebra: { type: 'http', url: 'https://z.example' },
        alpha: { command: 'run-alpha' },
      },
      mcpServerSources: { zebra: 'aitm-global', alpha: 'aitm-project' },
    }),
    {},
  );
  assert.deepEqual(row(out, 'mcpServers.alpha'), { value: 'stdio', source: 'aitm-project' });
  assert.deepEqual(row(out, 'mcpServers.zebra'), { value: 'http', source: 'aitm-global' });
  // Sorted: alpha before zebra.
  assert.ok(out.indexOf('mcpServers.alpha') < out.indexOf('mcpServers.zebra'));
});

test('effective-config: null-valued key renders as null, not (unset)', () => {
  const out = formatEffectiveConfig(makeResolved({ maxSessions: null }), {
    maxSessions: 'default',
  });
  assert.deepEqual(row(out, 'maxSessions'), { value: 'null', source: 'default' });
});
