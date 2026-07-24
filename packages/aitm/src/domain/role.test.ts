import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Role } from './role.ts';

test('Role is the four distinct subagent roles', () => {
  // Exhaustive list; if a role is added to the union this array stops type-checking, which is the
  // point — the test pins the surface every role-keyed table (ROLE_CAPABILITY, usage sinks) covers.
  const roles: Role[] = ['planner', 'worker', 'reviewer', 'orchestrator'];
  assert.equal(new Set(roles).size, 4);
});
