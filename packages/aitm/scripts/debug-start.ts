#!/usr/bin/env bun
// Local debug harness for `aitm start` (issue #18 — dogfood the start flow against a
// throwaway repo). Spins up a temp git repo with a stub CLAUDE.md, points aitm at it, and
// invokes `main(['start', …])` IN-PROCESS so a debugger attached to *this* process steps
// through the real start flow (commands → planner → run-loop adapter → WorkLoop).
//
// Run it:
//   bun run debug:start            # bun --inspect-brk: waits for a debugger to attach
//   node --inspect-brk --import tsx scripts/debug-start.ts   # node equivalent
//   bun scripts/debug-start.ts     # no break — runs straight through to the stop
// Attaching a debugger + a launch.json snippet: see docs/development.md.
//
// Knobs (env):
//   AITM_DEBUG_GOAL    goal string           (default: "add a hello.txt with the word hi")
//   AITM_DEBUG_MODEL   OpenRouter model id   (default: a free model — never spends credits)
//   AITM_DEBUG_KEEP=1  keep the temp repo for inspection (default: tear down on exit)
//
// Only the `gh auth` precondition is stubbed so the harness needs no real GitHub login. The
// rest runs for real against the throwaway repo, so the run deterministically stops at the
// first boundary the throwaway can't satisfy: a missing OPENROUTER_API_KEY (before any LLM
// call) or — once planning succeeds — the absent git remote / MCP edit tools in the loop.
// Either way the state-file path is printed; that stop is the point you debug up to.
//
// Portable Node APIs only (no Bun-only globals) so it runs under bun and node alike, per the
// project CLAUDE.md runtime stance.

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { main } from '../src/cli/cli.ts';

const GOAL = process.env.AITM_DEBUG_GOAL ?? 'add a hello.txt with the word hi';
const MODEL = process.env.AITM_DEBUG_MODEL ?? 'qwen/qwen3-next-80b-a3b-instruct:free';
const KEEP = process.env.AITM_DEBUG_KEEP === '1';

async function setupRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'aitm-debug-'));
  await execa('git', ['init', '-q'], { cwd: dir });
  await execa('git', ['config', 'user.email', 'debug@aitm.local'], { cwd: dir });
  await execa('git', ['config', 'user.name', 'aitm-debug'], { cwd: dir });
  await writeFile(
    join(dir, 'CLAUDE.md'),
    '# CLAUDE.md\n\nThrowaway fixture repo for the aitm debug harness.\n',
  );
  // Force every model tier to a free model so dogfooding never spends paid credits.
  await writeFile(
    join(dir, '.aitm.json'),
    `${JSON.stringify({ models: { generic: MODEL, smart: MODEL, coding: MODEL, fast: MODEL } }, null, 2)}\n`,
  );
  await execa('git', ['add', '-A'], { cwd: dir });
  await execa('git', ['commit', '-q', '-m', 'init: debug fixture'], { cwd: dir });
  return dir;
}

async function reportState(statePath: string): Promise<void> {
  try {
    const raw = await readFile(statePath, 'utf8');
    const s = JSON.parse(raw) as { status: string; prGroups: unknown[] };
    console.log(`[debug:start] state.status   = ${s.status}`);
    console.log(`[debug:start] state.prGroups = ${s.prGroups.length} group(s)`);
  } catch {
    console.log('[debug:start] state.json not written (stopped before init — e.g. missing key)');
  }
}

async function run(): Promise<number> {
  const repo = await setupRepo();
  const statePath = join(repo, '.ai-task-master', 'state.json');
  console.log(`[debug:start] temp repo : ${repo}`);
  console.log(`[debug:start] state file: ${statePath}`);
  console.log(`[debug:start] model     : ${MODEL}`);
  console.log(`[debug:start] goal      : ${GOAL}\n`);

  let aitmCode = 1;
  let harnessOk = true;
  try {
    aitmCode = await main(['start', GOAL], {
      cwd: repo,
      homeDir: homedir(), // pick up ~/.aitm.json for OPENROUTER_API_KEY
      env: process.env,
      authStatus: async () => ({ ok: true, scopes: ['repo'] }),
    });
  } catch (err) {
    harnessOk = false;
    console.error(`[debug:start] harness threw: ${err instanceof Error ? err.stack : String(err)}`);
  } finally {
    console.log(`\n[debug:start] aitm exit code: ${aitmCode}`);
    await reportState(statePath);
    if (KEEP) {
      console.log(`[debug:start] keeping temp repo (AITM_DEBUG_KEEP=1): ${repo}`);
    } else {
      await rm(repo, { recursive: true, force: true });
      console.log('[debug:start] temp repo torn down');
    }
  }
  return harnessOk ? 0 : 1;
}

process.exit(await run());
