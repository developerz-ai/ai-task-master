import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_STEALTH_HEADERS, webFetchTool } from './web-fetch.ts';

test('webFetchTool throws until implemented', () => {
  assert.throws(() => webFetchTool());
});

test('webFetchTool factory accepts local boolean (default true)', () => {
  assert.throws(() => webFetchTool({ local: true }));
  assert.throws(() => webFetchTool({ local: false }));
});

test('DEFAULT_STEALTH_HEADERS look like a real browser', () => {
  assert.match(DEFAULT_STEALTH_HEADERS['User-Agent'] ?? '', /Chrome\/\d+/);
  assert.equal(DEFAULT_STEALTH_HEADERS['Sec-Ch-Ua-Mobile'], '?0');
  // Frozen so callers can't mutate the canonical set.
  assert.throws(() => {
    (DEFAULT_STEALTH_HEADERS as Record<string, string>)['User-Agent'] = 'x';
  });
});
