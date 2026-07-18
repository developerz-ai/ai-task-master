import assert from 'node:assert/strict';
import { test } from 'node:test';
import { scrubSecrets } from './secret-scrubber.ts';

test('scrubSecrets: redacts Bearer token, keeps the scheme prefix', () => {
  const out = scrubSecrets('calling API with Authorization: Bearer sk-abcdef1234567890');
  assert.equal(out, 'calling API with Authorization: Bearer [REDACTED]');
});

test('scrubSecrets: redacts vendor-prefixed API keys embedded in text, keeps the prefix', () => {
  assert.equal(scrubSecrets('key=sk-proj-abcdefghijklmnop leaked'), 'key=sk-[REDACTED] leaked');
  assert.equal(
    scrubSecrets('token ghp_1234567890abcdefghijklmnopqrstuvwxyz used'),
    'token ghp_[REDACTED] used',
  );
});

test('scrubSecrets: redacts JWT-shaped strings', () => {
  const jwt =
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
  assert.equal(scrubSecrets(`token=${jwt}`), 'token=[REDACTED]');
});

test('scrubSecrets: redacts token-bearing URL query params, keeps the param name', () => {
  assert.equal(
    scrubSecrets('fetched https://api.example.com/v1?api_key=abcd1234efgh5678&other=1'),
    'fetched https://api.example.com/v1?api_key=[REDACTED]&other=1',
  );
});

test('scrubSecrets: redacts basic-auth URL credentials, keeps scheme and host', () => {
  assert.equal(
    scrubSecrets('cloning https://user:hunter2@github.com/org/repo.git'),
    'cloning https://[REDACTED]github.com/org/repo.git',
  );
});

test('scrubSecrets: plain text with no secrets passes through unchanged', () => {
  assert.equal(
    scrubSecrets('hello world, nothing secret here'),
    'hello world, nothing secret here',
  );
});
