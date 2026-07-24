// The live benchmark runner (issue #184). Generalizes the #19 e2e smoke into a per-scenario run: seed
// the scenario's fixture repo, drive `aitm start` (+ `merge-pr`) against a REAL sandbox GitHub repo,
// then derive one BenchRow from the persisted state.json (issue #114 usage totals) and the scenario's
// own verify() verdict. Real `gh`, real OpenRouter (a FREE model by default), real git — nothing stubbed.
//
// Unlike the smoke, the sandbox repo is KEPT after the run (never deleted): the produced code is the
// artifact a model comparison reviews by hand, so the row records `repo`/`pr` to find it later.
//
// Gated exactly like the smoke (OPENROUTER_API_KEY + AITM_SANDBOX_REPO) so CI without secrets skips.
// Portable Node APIs only (bun + node).

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execa } from 'execa';
import { main } from '../../../src/cli/cli.ts';
import { StateStore } from '../../../src/state/state-store.ts';
import { buildFixtureConfig } from '../e2e-smoke.ts';
import type { BenchRow } from './bench-row.ts';
import { buildBenchRow } from './bench-row.ts';
import type { BenchScenario } from './scenarios.ts';

export type BenchConfig = {
  apiKey: string;
  // GitHub owner (org or user) a fresh throwaway repo is created under.
  owner: string;
  model: string;
};

// Null when the benchmark is not configured — callers skip cleanly. Reuses the smoke's two gating envs
// so an operator who can run the smoke can run the benchmark; the model is overridable per comparison
// (AITM_BENCH_MODEL) and defaults to the same free model the smoke uses (never spends by default).
export function readBenchConfig(env: Record<string, string | undefined>): BenchConfig | null {
  const apiKey = env.OPENROUTER_API_KEY;
  const sandbox = env.AITM_SANDBOX_REPO;
  if (!apiKey || !sandbox) return null;
  const owner = sandbox.split('/')[0] ?? sandbox;
  const model =
    env.AITM_BENCH_MODEL ?? env.AITM_SMOKE_MODEL ?? 'qwen/qwen3-next-80b-a3b-instruct:free';
  return { apiKey, owner, model };
}

// Read a file's decoded content from a repo ref via gh, or null when it is absent (non-zero exit).
function fileReader(slug: string): (path: string, ref: string) => Promise<string | null> {
  return async (path, ref) => {
    const got = await execa(
      'gh',
      ['api', `repos/${slug}/contents/${path}?ref=${ref}`, '-q', '.content'],
      { reject: false },
    );
    if (got.exitCode !== 0) return null;
    return Buffer.from(got.stdout, 'base64').toString('utf8');
  };
}

async function seedFile(dir: string, rel: string, contents: string): Promise<void> {
  const abs = join(dir, rel);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, contents);
}

// Run one scenario end to end and return its BenchRow. Throws only on infrastructure failure (the run
// never produced a state.json); a scenario the model got WRONG returns a row with outcome:'fail', which
// is exactly the signal a comparison keeps. The sandbox repo is left behind for inspection.
export async function runScenario(
  cfg: BenchConfig,
  scenario: BenchScenario,
  log: (s: string) => void,
): Promise<BenchRow> {
  const slug = `${cfg.owner}/aitm-bench-${scenario.id}-${Date.now().toString(36)}`;
  const dir = await mkdtemp(join(tmpdir(), 'aitm-bench-'));
  const env = { ...process.env, OPENROUTER_API_KEY: cfg.apiKey };
  const merge = scenario.merge !== false;
  try {
    // ---- Fixture: CLAUDE.md style hint + free-model config + the scenario's seed files ----
    await execa('git', ['init', '-q'], { cwd: dir });
    await execa('git', ['config', 'user.email', 'bench@aitm.local'], { cwd: dir });
    await execa('git', ['config', 'user.name', 'aitm-bench'], { cwd: dir });
    await writeFile(
      join(dir, 'CLAUDE.md'),
      '# CLAUDE.md\n\nSandbox repo for the aitm benchmark. Make the smallest change that satisfies the goal.\n',
    );
    await writeFile(
      join(dir, '.aitm.json'),
      `${JSON.stringify(buildFixtureConfig(cfg.model), null, 2)}\n`,
    );
    for (const [rel, contents] of Object.entries(scenario.seedFiles ?? {})) {
      await seedFile(dir, rel, contents);
    }
    await execa('git', ['add', '-A'], { cwd: dir });
    await execa('git', ['commit', '-q', '-m', `init: bench fixture (${scenario.id})`], {
      cwd: dir,
    });

    // ---- Create the GitHub repo (kept afterwards) and push --------------------------------
    log(`[${scenario.id}] creating sandbox repo ${slug}`);
    await execa(
      'gh',
      ['repo', 'create', slug, '--private', '--source=.', '--remote=origin', '--push'],
      { cwd: dir },
    );

    // ---- aitm start → open a PR -----------------------------------------------------------
    log(`[${scenario.id}] aitm start "${scenario.goal.slice(0, 60)}…"`);
    const startCode = await main(
      ['start', scenario.goal, '--max-prs', '1', '--max-sessions', '3', '--no-automerge'],
      { cwd: dir, env },
    );

    const store = new StateStore(join(dir, '.ai-task-master'));
    const state = await store.read();
    const pr = state.currentPr;
    log(`[${scenario.id}] start exit=${startCode} pr=${pr ?? 'none'}`);

    let verifyRef: string | null = null;
    if (pr && merge) {
      await execa('gh', ['pr', 'checkout', String(pr)], { cwd: dir });
      log(`[${scenario.id}] aitm merge-pr`);
      await main(['merge-pr'], { cwd: dir, env });
      verifyRef = (
        await execa('gh', [
          'repo',
          'view',
          slug,
          '--json',
          'defaultBranchRef',
          '-q',
          '.defaultBranchRef.name',
        ])
      ).stdout.trim();
    } else if (pr) {
      // No-merge scenario: verify against the PR head branch instead of the default branch.
      verifyRef = (
        await execa('gh', ['pr', 'view', String(pr), '--json', 'headRefName', '-q', '.headRefName'])
      ).stdout.trim();
    }

    // ---- Scenario verdict on the produced code (independent of the loop's self-reported status) --
    let outcome: 'pass' | 'fail' = 'fail';
    if (verifyRef) {
      const read = fileReader(slug);
      const result = await scenario.verify({
        slug,
        defaultBranch: verifyRef,
        readFile: (path) => read(path, verifyRef),
      });
      outcome = result.ok ? 'pass' : 'fail';
      log(`[${scenario.id}] verify: ${outcome} — ${result.detail}`);
    } else {
      log(`[${scenario.id}] no PR opened — outcome fail`);
    }

    const row = buildBenchRow({
      scenario: scenario.id,
      outcome,
      state,
      repo: slug,
      costEstimated: false,
    });
    log(`[${scenario.id}] kept sandbox repo for inspection: https://github.com/${slug}`);
    return row;
  } finally {
    // Only the local checkout is cleaned up; the GitHub repo is deliberately kept.
    await rm(dir, { recursive: true, force: true });
  }
}
