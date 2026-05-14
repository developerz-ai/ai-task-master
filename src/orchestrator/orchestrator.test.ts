import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Orchestrator } from './orchestrator.ts';

test('Orchestrator is constructible (skeleton)', () => {
  const o = new Orchestrator({
    credentials: {} as never,
    agentConfig: { flavor: 'claude', path: '/tmp/CLAUDE.md', contents: '' },
    rollingContext: '',
    maxSessions: null,
  });
  assert.ok(o instanceof Orchestrator);
});

test('Orchestrator.build throws until implemented', () => {
  const o = new Orchestrator({
    credentials: {} as never,
    agentConfig: { flavor: 'claude', path: '/tmp/CLAUDE.md', contents: '' },
    rollingContext: '',
    maxSessions: null,
  });
  assert.throws(() => o.build());
});
