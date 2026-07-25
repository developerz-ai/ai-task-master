import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SUBAGENT_LIMIT_DEFAULT } from './subagent-limit.ts';

test('SUBAGENT_LIMIT_DEFAULT: a usable fan-out ceiling, not a work budget', () => {
  assert.ok(Number.isInteger(SUBAGENT_LIMIT_DEFAULT));
  // At least 2, or no lead could ever fan out and every phase would be sequential by construction.
  assert.ok(SUBAGENT_LIMIT_DEFAULT >= 2);
  // The lead's judgment is meant to size a wave, not this number — but it still has to stay inside
  // ordinary provider concurrency limits, so it is a ceiling and not an open door.
  assert.ok(SUBAGENT_LIMIT_DEFAULT <= 16);
});
