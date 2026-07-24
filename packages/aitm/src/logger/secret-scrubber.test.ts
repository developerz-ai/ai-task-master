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

test('scrubSecrets: redacts GitHub PAT tokens', () => {
  assert.equal(
    scrubSecrets('token github_pat_abc123def456ghi789jkl012mnopqrstuv used'),
    'token github_pat_[REDACTED] used',
  );
});

test('scrubSecrets: redacts Stripe _live_ and _test_ variants', () => {
  assert.equal(
    scrubSecrets('key sk_live_abc123def456ghij leaked'),
    'key sk_live_[REDACTED] leaked',
  );
  assert.equal(
    scrubSecrets('key pk_test_abc123def456ghi789jkl012mnopqrstuv leaked'),
    'key pk_test_[REDACTED] leaked',
  );
});

test('scrubSecrets: redacts Slack xapp- app tokens', () => {
  assert.equal(
    scrubSecrets('token xapp-abc123def456ghi789jkl012mnopqrstuv used'),
    'token xapp-[REDACTED] used',
  );
});

test('scrubSecrets: redacts GitLab glpat- tokens', () => {
  assert.equal(
    scrubSecrets('token glpat-abc123def456ghi789jkl012mnopqrstuv used'),
    'token glpat-[REDACTED] used',
  );
});

test('scrubSecrets: redacts Google AIza API keys', () => {
  assert.equal(
    scrubSecrets('key AIza_abc123def456ghi789jkl012mnopqrstuv used'),
    'key AIza[REDACTED] used',
  );
});

test('scrubSecrets: redacts Hugging Face hf_ tokens', () => {
  assert.equal(
    scrubSecrets('token hf_abc123def456ghi789jkl012mnopqrstuv used'),
    'token hf_[REDACTED] used',
  );
});

test('scrubSecrets: redacts npm_ tokens', () => {
  assert.equal(
    scrubSecrets('token npm_abc123def456ghi789jkl012mnopqrstuv used'),
    'token npm_[REDACTED] used',
  );
});

test('scrubSecrets: plain text with no secrets passes through unchanged', () => {
  assert.equal(
    scrubSecrets('hello world, nothing secret here'),
    'hello world, nothing secret here',
  );
});
