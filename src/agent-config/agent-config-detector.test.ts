import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentConfigDetector } from './agent-config-detector.ts';

test('AgentConfigDetector is constructible (skeleton)', () => {
  const d = new AgentConfigDetector('/tmp/repo');
  assert.ok(d instanceof AgentConfigDetector);
});

test('AgentConfigDetector.detect throws until implemented', async () => {
  const d = new AgentConfigDetector('/tmp/repo');
  await assert.rejects(() => d.detect({}));
});
