import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ConfigFile, Profile } from '../config/schema.ts';
import type { PrGroup } from '../domain/pr-group.ts';
import {
  autoMergeNotice,
  formatConfigValue,
  formatProfileList,
  prLinksBlock,
  redactConfigKeys,
  redactProfile,
  usageSummaryLine,
} from './format.ts';

function prGroupFixture(over: Partial<PrGroup> = {}): PrGroup {
  return {
    id: 'g1',
    title: 'Todo CRUD API',
    tasks: [],
    dependsOn: [],
    branch: 'aitm/g1-todo-crud-api',
    pr: null,
    status: 'pending',
    stage: 'pending',
    ...over,
  };
}

test('autoMergeNotice: full warning when on, null when off', () => {
  const on = autoMergeNotice(true);
  assert.ok(on, 'notice present when auto-merge on');
  assert.match(on, /auto-merge is ON/);
  // The core surprise: merges run via gh, outside the tool boundary, bypassing git-guard.
  assert.match(on, /gh/);
  assert.match(on, /git-guard/);
  // Both the per-run flag and the persistent disable are offered.
  assert.match(on, /--no-automerge/);
  assert.match(on, /config set autoMerge false/);
  assert.equal(autoMergeNotice(false), null);
});

test('usageSummaryLine: renders overall tokens + per-role breakdown + cost + cache-hit %, or "cost unknown" (issue #114, slice 04b)', () => {
  const line = usageSummaryLine({
    perRole: {
      planner: {
        inputTokens: 100,
        outputTokens: 20,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        calls: 1,
        costUsd: 0.001,
        cacheDiscountUsd: null,
      },
      worker: {
        inputTokens: 500,
        outputTokens: 80,
        cachedInputTokens: 50,
        cacheWriteInputTokens: 0,
        calls: 4,
        costUsd: 0.009,
        cacheDiscountUsd: null,
      },
    },
    overall: {
      inputTokens: 600,
      outputTokens: 100,
      cachedInputTokens: 50,
      cacheWriteInputTokens: 0,
      calls: 5,
      costUsd: 0.01,
      cacheDiscountUsd: null,
    },
  });
  assert.match(
    line,
    /^Usage: 5 calls, 600 in \/ 100 out tokens \(50 cached, 8% cache hit\), \$0\.0100/,
  );
  assert.match(line, /planner 100in\/20out \(0% cache hit\)/);
  assert.match(line, /worker 500in\/80out \(10% cache hit\)/);
  assert.ok(line.endsWith('\n'), 'exactly one line');
  assert.ok(!line.includes('cache discount'), 'no discount line when never reported');

  // Null overall cost (any pricing unavailable) renders "cost unknown"; 0 input tokens → 0% not NaN.
  const unknown = usageSummaryLine({
    perRole: {},
    overall: {
      inputTokens: 10,
      outputTokens: 5,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      calls: 1,
      costUsd: null,
      cacheDiscountUsd: null,
    },
  });
  assert.match(unknown, /cost unknown/);
  assert.match(unknown, /0% cache hit/);
});

test('usageSummaryLine: renders provider-reported cache_discount savings when present (slice 04b)', () => {
  const line = usageSummaryLine({
    perRole: {},
    overall: {
      inputTokens: 100,
      outputTokens: 20,
      cachedInputTokens: 80,
      cacheWriteInputTokens: 0,
      calls: 1,
      costUsd: 0.001,
      cacheDiscountUsd: 0.0025,
    },
  });
  assert.match(line, /80% cache hit/);
  assert.match(line, /\$0\.0025 cache discount/);
});

test('usageSummaryLine: a reference-priced total is labelled an estimate, a provider-priced one is not', () => {
  // On a flat subscription the dollar figure is what the same work costs at OpenRouter list rates,
  // not what was billed. Printing it unlabelled would read as a bill.
  const overall = {
    inputTokens: 1000,
    outputTokens: 100,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    calls: 1,
    costUsd: 1.5,
    cacheDiscountUsd: null,
  };
  assert.match(
    usageSummaryLine({ perRole: {}, overall, costEstimated: true }),
    /\$1\.5000 est\. at OpenRouter list rates/,
  );
  assert.doesNotMatch(
    usageSummaryLine({ perRole: {}, overall, costEstimated: false }),
    /est\. at OpenRouter/,
  );
});

test('prLinksBlock: lists every opened PR with its title and clickable URL', () => {
  const block = prLinksBlock([
    prGroupFixture({ pr: 12, prUrl: 'https://github.com/o/r/pull/12' }),
    prGroupFixture({
      id: 'g2',
      title: 'Session cookie auth',
      pr: 13,
      prUrl: 'https://github.com/o/r/pull/13',
    }),
  ]);
  assert.match(block, /^Pull requests:\n/);
  assert.match(block, /#12 {2}Todo CRUD API — https:\/\/github\.com\/o\/r\/pull\/12/);
  assert.match(block, /#13 {2}Session cookie auth — https:\/\/github\.com\/o\/r\/pull\/13/);
});

test('prLinksBlock: groups without a PR are skipped, and no PRs prints nothing', () => {
  assert.equal(prLinksBlock([prGroupFixture()]), '');
  assert.equal(prLinksBlock([]), '');
  const block = prLinksBlock([
    prGroupFixture(),
    prGroupFixture({ id: 'g2', pr: 7, prUrl: 'https://github.com/o/r/pull/7' }),
  ]);
  assert.equal(block.split('\n').filter((l) => l.trim() !== '').length, 2);
});

test('prLinksBlock: legacy state without a persisted URL still reports the number', () => {
  assert.match(prLinksBlock([prGroupFixture({ pr: 9 })]), /#9 {2}Todo CRUD API — #9/);
});

test('prLinksBlock: a group with no persisted URL borrows a sibling repo prefix', () => {
  // The upgrade-mid-run case, observed for real: G1..G3 finished under a build that never persisted
  // prUrl, G4..G5 under one that did, and the first three printed `#1  title — #1` — a non-link.
  const block = prLinksBlock([
    prGroupFixture({ id: 'g1', title: 'Domain types', pr: 1 }),
    prGroupFixture({ id: 'g2', title: 'API CRUD', pr: 2 }),
    prGroupFixture({
      id: 'g4',
      title: 'Web UI',
      pr: 4,
      prUrl: 'https://github.com/sebyx07/test-todo-app/pull/4',
    }),
  ]);
  assert.match(
    block,
    /#1 {2}Domain types — https:\/\/github\.com\/sebyx07\/test-todo-app\/pull\/1/,
  );
  assert.match(block, /#2 {2}API CRUD — https:\/\/github\.com\/sebyx07\/test-todo-app\/pull\/2/);
  assert.match(block, /#4 {2}Web UI — https:\/\/github\.com\/sebyx07\/test-todo-app\/pull\/4/);
});

test('prLinksBlock: with no sibling URL anywhere it still degrades to the bare number', () => {
  // Nothing in the run knows the repo URL — inventing one would be worse than printing the number.
  assert.match(prLinksBlock([prGroupFixture({ pr: 9 })]), /#9 {2}Todo CRUD API — #9/);
});

test('formatConfigValue: strings pass through, other values pretty-print as JSON, undefined is empty', () => {
  assert.equal(formatConfigValue('plain-string'), 'plain-string');
  assert.equal(formatConfigValue(undefined), '');
  assert.equal(formatConfigValue(42), '42');
  assert.equal(formatConfigValue({ a: 1 }), JSON.stringify({ a: 1 }, null, 2));
});

test('formatProfileList: marks the active profile, shows base URL and a masked key, else says so', () => {
  const profiles: Record<string, Profile> = {
    zai: { baseURL: 'https://api.z.ai', openrouterApiKey: 'sk-or-abcdefgh1234' },
    bare: {},
  };
  const out = formatProfileList('zai', profiles);
  assert.match(out, /\* zai\thttps:\/\/api\.z\.ai\t/);
  assert.match(out, /1234/, 'masked key keeps the last 4 chars');
  assert.doesNotMatch(out, /abcdefgh1234/, 'full key must never appear');
  assert.match(out, /^ {2}bare\t\(provider default\)\t\(no key\)/m);
});

test('formatProfileList: no profiles prints a helpful hint instead of an empty listing', () => {
  assert.match(formatProfileList(undefined, {}), /No profiles configured/);
});

test('redactProfile: masks a profile key, leaves a key-less profile untouched', () => {
  const withKey: Profile = { openrouterApiKey: 'sk-or-abcdefgh1234' };
  const redacted = redactProfile(withKey);
  assert.notEqual(redacted.openrouterApiKey, withKey.openrouterApiKey);
  assert.match(redacted.openrouterApiKey ?? '', /1234$/);

  const noKey: Profile = { baseURL: 'https://api.z.ai' };
  assert.deepEqual(redactProfile(noKey), noKey);
});

test('redactConfigKeys: masks the top-level key and every nested profile key', () => {
  const file: ConfigFile = {
    openrouterApiKey: 'sk-or-topkey1234',
    profiles: {
      a: { openrouterApiKey: 'sk-or-akey1234' },
      b: {},
    },
  };
  const redacted = redactConfigKeys(file);
  assert.notEqual(redacted.openrouterApiKey, file.openrouterApiKey);
  assert.match(redacted.openrouterApiKey ?? '', /1234$/);
  assert.notEqual(redacted.profiles?.a.openrouterApiKey, file.profiles?.a.openrouterApiKey);
  assert.deepEqual(redacted.profiles?.b, {});
});
