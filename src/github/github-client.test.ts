import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CiFailed, GhAuthRequired, PrNotFound } from './errors.ts';
import { GitHubClient } from './github-client.ts';

test('GitHubClient is constructible (skeleton)', () => {
  const g = new GitHubClient('/tmp/repo');
  assert.ok(g instanceof GitHubClient);
});

test('domain errors carry their name', () => {
  assert.equal(new PrNotFound().name, 'PrNotFound');
  assert.equal(new GhAuthRequired().name, 'GhAuthRequired');
  assert.equal(new CiFailed().name, 'CiFailed');
});

test('GitHubClient.authStatus throws until implemented', async () => {
  const g = new GitHubClient('/tmp/repo');
  await assert.rejects(() => g.authStatus());
});
