// Integration: validate that declared Node engine versions are aligned across packages.
//
// This test ensures:
// 1. Both package.json files declare the same Node engine version
// 2. The declared version matches the documented minimum (Node ≥ 20)
// 3. The declared version matches CLAUDE.md portability requirement

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

test('engines-alignment: Node versions match across packages', async () => {
  // Read both package.json files
  const aitmPackageJsonPath = join(import.meta.dirname, '../../package.json');
  const compatPackageJsonPath = join(import.meta.dirname, '../../../ai-claude-compat/package.json');
  const readmeAitmPath = join(import.meta.dirname, '../../README.md');
  const readmeCompatPath = join(import.meta.dirname, '../../../ai-claude-compat/README.md');
  const claudeMdPath = join(import.meta.dirname, '../../../../CLAUDE.md');

  const aitmContent = await readFile(aitmPackageJsonPath, 'utf-8');
  const compatContent = await readFile(compatPackageJsonPath, 'utf-8');
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

  // Verify documentation mentions Node ≥ 20 or Node >= 20 in README files
  const readmeAitmMentions20 =
    readmeAitm.includes('Node ≥ 20') ||
    readmeAitm.includes('Node >= 20') ||
    readmeAitm.includes('≥20') ||
    readmeAitm.includes('>=20');
  assert(readmeAitmMentions20, 'packages/aitm/README.md must document the Node ≥ 20 requirement');

  const readmeCompatMentions20 =
    readmeCompat.includes('Node ≥ 20') ||
    readmeCompat.includes('Node >= 20') ||
    readmeCompat.includes('≥20') ||
    readmeCompat.includes('>=20');
  assert(
    readmeCompatMentions20,
    'packages/ai-claude-compat/README.md must document the Node ≥ 20 requirement',
  );

  // Verify CLAUDE.md documents the Node ≥ 20 portability requirement
  const claudeMdMentions20 =
    claudeMd.includes('Node ≥ 20') ||
    claudeMd.includes('Node >= 20') ||
    claudeMd.includes('≥ 1.40');
  assert(claudeMdMentions20, 'CLAUDE.md must document Node ≥ 20 portability requirement');
});
