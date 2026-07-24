import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  clearRegisteredSecrets,
  redactRegisteredSecrets,
  registerSecretValues,
} from './secret-registry.ts';

// The registry is process-wide, so every test that registers restores the empty state afterwards.
function withSecrets(values: Array<string | null | undefined>, body: () => void): void {
  clearRegisteredSecrets();
  try {
    registerSecretValues(values);
    body();
  } finally {
    clearRegisteredSecrets();
  }
}

test('secret-registry: redacts a shapeless key no pattern could match', () => {
  // A custom OpenAI-compatible endpoint's key: no vendor prefix, no separator, nothing to match on.
  withSecrets(['7f3a9c21e4b84d0fa1c6', 'b7e1-2f44-90aa-31de'], () => {
    assert.equal(
      redactRegisteredSecrets('POST /v1/chat auth=7f3a9c21e4b84d0fa1c6 model=gpt-4o'),
      'POST /v1/chat auth=[REDACTED] model=gpt-4o',
    );
    assert.equal(redactRegisteredSecrets('key b7e1-2f44-90aa-31de'), 'key [REDACTED]');
  });
});

test('secret-registry: redacts every occurrence, not just the first', () => {
  withSecrets(['abcdefgh12345678'], () => {
    assert.equal(
      redactRegisteredSecrets('abcdefgh12345678 retried with abcdefgh12345678'),
      '[REDACTED] retried with [REDACTED]',
    );
  });
});

test('secret-registry: refuses values below the minimum length, so prose survives', () => {
  withSecrets(['test', 'x', 'abcdefg'], () => {
    const line = 'test run x abcdefg finished';
    assert.equal(redactRegisteredSecrets(line), line);
  });
});

test('secret-registry: skips blank and non-string entries', () => {
  withSecrets([undefined, null, '', '        '], () => {
    assert.equal(redactRegisteredSecrets('nothing registered here'), 'nothing registered here');
  });
});

test('secret-registry: trims before registering, so an env key with a trailing newline matches', () => {
  withSecrets(['  sk-custom-9f8e7d6c5b4a\n'], () => {
    assert.equal(
      redactRegisteredSecrets('Authorization: sk-custom-9f8e7d6c5b4a'),
      'Authorization: [REDACTED]',
    );
  });
});

test('secret-registry: longer secret wins when one contains another', () => {
  withSecrets(['abcdefgh1234', 'abcdefgh1234-suffix-5678'], () => {
    assert.equal(redactRegisteredSecrets('abcdefgh1234-suffix-5678'), '[REDACTED]');
  });
});

test('secret-registry: registering the same value twice redacts once', () => {
  withSecrets(['duplicate-key-0123', 'duplicate-key-0123'], () => {
    assert.equal(redactRegisteredSecrets('key=duplicate-key-0123'), 'key=[REDACTED]');
  });
});

test('secret-registry: nothing registered → text passes through unchanged', () => {
  clearRegisteredSecrets();
  assert.equal(redactRegisteredSecrets('plain status line'), 'plain status line');
});

test('secret-registry: clearRegisteredSecrets drops previously registered values', () => {
  registerSecretValues(['forgettable-key-9876']);
  clearRegisteredSecrets();
  assert.equal(redactRegisteredSecrets('key=forgettable-key-9876'), 'key=forgettable-key-9876');
});
