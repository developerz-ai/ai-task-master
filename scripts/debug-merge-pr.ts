#!/usr/bin/env bun
// Local debug harness for `aitm merge-pr` (issue #18 — dogfood the merge flow). Spins up a
// temp git repo with a stub CLAUDE.md and invokes `main(['merge-pr', …])` IN-PROCESS so a
// debugger attached to this process steps through the real merge-pr dispatch + flow.
//
// Run it:
//   bun run debug:merge-pr                  # bun --inspect-brk: waits for a debugger
//   bun run debug:merge-pr -- --pr 42       # attach the flow to PR #42 in your own fork
//   bun scripts/debug-merge-pr.ts           # no break — runs straight through
//   node --inspect-brk --import tsx scripts/debug-merge-pr.ts
// Attaching a debugger + a launch.json snippet: see docs/development.md.
//
// PR source:
//   --pr N            attach to an existing PR (state is synthesized from N — your own fork).
//   (no --pr)         seed a throwaway state.json whose currentPr is AITM_DEBUG_PR (default 1).
//
// Knobs (env):
//   AITM_DEBUG_PR      seeded PR number when --pr is absent (default: 1)
//   AITM_DEBUG_MODEL   OpenRouter model id (default: a free model)
//   AITM_DEBUG_KEEP=1  keep the temp repo for inspection (default: tear down on exit)
//
// Only the `gh auth` precondition is stubbed. On the current build `merge-pr` deterministically
// stops at the (still-stubbed) merge-flow adapter; that stop is the point you debug up to.
//
// Portable Node APIs only so it runs under bun and node alike, per the project CLAUDE.md.

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { main } from '../src/cli/cli.ts';

const MODEL = process.env.AITM_DEBUG_MODEL ?? 'qwen/qwen3-next-80b-a3b-instruct:free';
const KEEP = process.env.AITM_DEBUG_KEEP === '1';

// Parse a positive-integer PR input. A present-but-invalid value fails fast with a clear
// message rather than silently falling back — silently seeding the wrong PR (or a NaN that
// serializes to `null` in state.json) hides operator mistakes.
function positivePr(label: string, raw: string | undefined, fallback: number | null): number {
  if (raw === undefined || raw === '') {
    if (fallback !== null) return fallback;
    console.error(`[debug:merge-pr] ${label} is required and must be a positive integer`);
    process.exit(1);
  }
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n <= 0) {
    console.error(`[debug:merge-pr] ${label} must be a positive integer, got "${raw}"`);
    process.exit(1);
  }
  return n;
}

// `--pr N` anywhere in argv attaches to an existing PR; otherwise we seed state. A present
// but malformed `--pr` value is an error (no silent fallback to the seeded PR).
function parsePrFlag(argv: readonly string[]): number | undefined {
  const i = argv.indexOf('--pr');
  if (i === -1) return undefined;
  return positivePr('--pr', argv[i + 1], null);
}

async function setupRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'aitm-debug-mergepr-'));
  await execa('git', ['init', '-q'], { cwd: dir });
  await execa('git', ['config', 'user.email', 'debug@aitm.local'], { cwd: dir });
  await execa('git', ['config', 'user.name', 'aitm-debug'], { cwd: dir });
  await writeFile(
    join(dir, 'CLAUDE.md'),
    '# CLAUDE.md\n\nThrowaway fixture repo for the aitm merge-pr debug harness.\n',
  );
  await writeFile(
    join(dir, '.aitm.json'),
    `${JSON.stringify({ models: { generic: MODEL, smart: MODEL, coding: MODEL, fast: MODEL } }, null, 2)}\n`,
  );
  await execa('git', ['add', '-A'], { cwd: dir });
  await execa('git', ['commit', '-q', '-m', 'init: debug fixture'], { cwd: dir });
  return dir;
}

// Seed a minimal, schema-valid state.json with a currentPr so `merge-pr` (no --pr) has a PR
// to drive — mirrors the take-over state aitm itself synthesizes.
async function seedState(dir: string, pr: number): Promise<void> {
  const now = new Date().toISOString();
  await mkdir(join(dir, '.ai-task-master'), { recursive: true });
  const state = {
    status: 'awaiting-pr',
    prGroups: [],
    currentGroupIndex: 0,
    currentTaskIndex: 0,
    sessionCount: 0,
    currentPr: pr,
    runId: 'debug-mergepr',
    provider: 'openrouter',
    model: MODEL,
    agentConfigFile: 'CLAUDE.md',
    createdAt: now,
    updatedAt: now,
    options: {
      autoMerge: true,
      maxPrs: 5,
      maxSessions: null,
      mergeMethod: 'squash',
      stylePath: null,
      concurrency: 1,
    },
  };
  await writeFile(
    join(dir, '.ai-task-master', 'state.json'),
    `${JSON.stringify(state, null, 2)}\n`,
  );
}

async function reportState(statePath: string): Promise<void> {
  try {
    const raw = await readFile(statePath, 'utf8');
    const s = JSON.parse(raw) as { status: string; currentPr: number | null };
    console.log(`[debug:merge-pr] state.status    = ${s.status}`);
    console.log(`[debug:merge-pr] state.currentPr = ${s.currentPr}`);
  } catch {
    console.log('[debug:merge-pr] state.json not written (stopped before init)');
  }
}

async function run(): Promise<number> {
  const prFlag = parsePrFlag(process.argv.slice(2));
  // Seed mode (no --pr) reads the PR from AITM_DEBUG_PR; validate it only here so a
  // malformed env var never breaks an explicit `--pr` run that doesn't use it.
  const seedPr =
    prFlag === undefined ? positivePr('AITM_DEBUG_PR', process.env.AITM_DEBUG_PR, 1) : undefined;
  const repo = await setupRepo();
  const statePath = join(repo, '.ai-task-master', 'state.json');

  // With --pr, aitm synthesizes state from the number; otherwise seed a currentPr.
  const argv = prFlag !== undefined ? ['merge-pr', '--pr', String(prFlag)] : ['merge-pr'];
  if (seedPr !== undefined) await seedState(repo, seedPr);

  console.log(`[debug:merge-pr] temp repo : ${repo}`);
  console.log(`[debug:merge-pr] state file: ${statePath}`);
  console.log(`[debug:merge-pr] pr        : ${prFlag ?? `${seedPr} (seeded)`}`);
  console.log(`[debug:merge-pr] argv      : ${argv.join(' ')}\n`);

  let aitmCode = 1;
  let harnessOk = true;
  try {
    aitmCode = await main(argv, {
      cwd: repo,
      homeDir: homedir(),
      env: process.env,
      authStatus: async () => ({ ok: true, scopes: ['repo'] }),
    });
  } catch (err) {
    harnessOk = false;
    console.error(
      `[debug:merge-pr] harness threw: ${err instanceof Error ? err.stack : String(err)}`,
    );
  } finally {
    console.log(`\n[debug:merge-pr] aitm exit code: ${aitmCode}`);
    await reportState(statePath);
    if (KEEP) {
      console.log(`[debug:merge-pr] keeping temp repo (AITM_DEBUG_KEEP=1): ${repo}`);
    } else {
      await rm(repo, { recursive: true, force: true });
      console.log('[debug:merge-pr] temp repo torn down');
    }
  }
  return harnessOk ? 0 : 1;
}

process.exit(await run());
