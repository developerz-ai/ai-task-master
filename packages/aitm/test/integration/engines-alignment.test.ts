// Integration: validate that declared Node engine versions are aligned across packages.
//
// This test ensures:
// 1. Both package.json files declare the same Node engine version
// 2. The declared version matches the documented minimum (Node ≥ 20)
// 3. The root README's requirements table, both package READMEs, and CLAUDE.md
//    each document that same Node floor

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

// Matches only an explicit Node floor statement ("Node ≥ 20" / "Node >= 20") —
// never a bare ">=20" from a dependency range or the Deno ≥ 1.40 clause, which
// would let a Node-floor drift (e.g. "Node ≥ 22") pass the guard.
const NODE_FLOOR_PATTERN = /Node\s*(?:≥|>=)\s*20\b/;

test('engines-alignment: Node versions match across packages', async () => {
  // Read both package.json files
  const aitmPackageJsonPath = join(import.meta.dirname, '../../package.json');
  const compatPackageJsonPath = join(import.meta.dirname, '../../../ai-claude-compat/package.json');
  const readmeRootPath = join(import.meta.dirname, '../../../../README.md');
  const readmeAitmPath = join(import.meta.dirname, '../../README.md');
  const readmeCompatPath = join(import.meta.dirname, '../../../ai-claude-compat/README.md');
  const claudeMdPath = join(import.meta.dirname, '../../../../CLAUDE.md');

  const aitmContent = await readFile(aitmPackageJsonPath, 'utf-8');
  const compatContent = await readFile(compatPackageJsonPath, 'utf-8');
  const readmeRoot = await readFile(readmeRootPath, 'utf-8');
  const readmeAitm = await readFile(readmeAitmPath, 'utf-8');
  const readmeCompat = await readFile(readmeCompatPath, 'utf-8');
  const claudeMd = await readFile(claudeMdPath, 'utf-8');

  const aitmPackageJson = JSON.parse(aitmContent);
  const compatPackageJson = JSON.parse(compatContent);

  const aitmNodeEngine = aitmPackageJson.engines?.node;
  const compatNodeEngine = compatPackageJson.engines?.node;

  // Assert both packages declare an engine
  assert(aitmNodeEngine, 'aitm package.json must declare engines.node');
  assert(compatNodeEngine, 'ai-claude-compat package.json must declare engines.node');

  // Assert both declare the same version
  assert.strictEqual(
    aitmNodeEngine,
    compatNodeEngine,
    `Node engine versions must match: aitm=${aitmNodeEngine}, compat=${compatNodeEngine}`,
  );

  // Extract the major version number correctly
  // Match patterns like: ">=20", "^20.0.0", ">=20.0.0", "20", etc.
  // Look for the first occurrence of digits that form the major version
  const versionMatch = aitmNodeEngine.match(/>=\s*(\d+)|\^(\d+)|^(\d+)/);
  assert(versionMatch, `Could not parse Node version from: ${aitmNodeEngine}`);
  // Capture group 1, 2, or 3 will have the major version number
  const majorVersion = parseInt(versionMatch[1] || versionMatch[2] || versionMatch[3], 10);

  // Validate that the declared version is exactly >=20 (the documented minimum)
  assert.strictEqual(
    majorVersion,
    20,
    `Declared Node engine major version (${majorVersion}) must match documented minimum (20)`,
  );

  // Verify every document states the Node ≥ 20 floor explicitly — the root README's
  // requirements table is the one readers check, so it is guarded too.
  assert(
    NODE_FLOOR_PATTERN.test(readmeRoot),
    'README.md requirements table must document the Node ≥ 20 requirement',
  );
  assert(
    NODE_FLOOR_PATTERN.test(readmeAitm),
    'packages/aitm/README.md must document the Node ≥ 20 requirement',
  );
  assert(
    NODE_FLOOR_PATTERN.test(readmeCompat),
    'packages/ai-claude-compat/README.md must document the Node ≥ 20 requirement',
  );
  assert(
    NODE_FLOOR_PATTERN.test(claudeMd),
    'CLAUDE.md must document the Node ≥ 20 portability requirement',
  );
});
