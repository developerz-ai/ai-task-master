import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  providerOptionsWithServerTools,
  webFetchServerTool,
  webSearchServerTool,
} from './server-tools.ts';

test('webSearchServerTool builds the documented payload', () => {
  const payload = webSearchServerTool({ engine: 'exa', max_results: 3 });
  assert.equal(payload.type, 'openrouter:web_search');
  assert.deepEqual(payload.parameters, { engine: 'exa', max_results: 3 });
});

test('webFetchServerTool defaults to no parameters', () => {
  const payload = webFetchServerTool();
  assert.equal(payload.type, 'openrouter:web_fetch');
  assert.deepEqual(payload.parameters, {});
});

test('providerOptionsWithServerTools nests under openrouter key', () => {
  const opts = providerOptionsWithServerTools([webSearchServerTool(), webFetchServerTool()]);
  assert.equal(opts.openrouter.tools.length, 2);
  assert.equal(opts.openrouter.tools[0]?.type, 'openrouter:web_search');
});
