// Shared runner for the end-to-end smoke (issue #19): a real sandbox repo crossing BOTH
// commands — `aitm start` → opens a PR → `aitm merge-pr` → merged → file lands on the
// default branch. Imported by `e2e-smoke.test.ts` (gated test) and `scripts/smoke-e2e.ts`
// (local runner) so the flow lives in one place.
//
// This is the real thing: real `gh`, real OpenRouter (a FREE model by default so it never
// spends credits), real git. Nothing is stubbed. It is gated on secrets (see
// `readSmokeConfig`) so CI without them skips cleanly.
//
// PREREQUISITES for a green run (beyond the two gating envs):
//   - `gh` authenticated with the `delete_repo` scope (cleanup deletes the repo).
//   - The `start` half's Worker needs file-edit tools (readFile/writeFile/bash) from an
//     MCP filesystem+shell server, discovered from the standard `mcpServers` config
//     locations (see docs/mcp.md). Without them `aitm start` blocks before opening a PR.
//     (The `merge-pr` half uses aitm's own local fs-tools and needs no MCP.)
//
// Portable Node APIs only so it runs under bun and node alike.

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { main } from '../../src/cli/cli.ts';
import { StateStore } from '../../src/state/state-store.ts';

export type SmokeConfig = {
  apiKey: string;
  // GitHub owner (org or user) under which a fresh throwaway repo is created.
  owner: string;
  model: string;
};

// Returns null when the smoke is not configured — callers use this to skip cleanly.
export function readSmokeConfig(env: Record<string, string | undefined>): SmokeConfig | null {
  const apiKey = env.OPENROUTER_API_KEY;
  const sandbox = env.AITM_SANDBOX_REPO;
  if (!apiKey || !sandbox) return null;
  // AITM_SANDBOX_REPO may be a bare owner or `owner/anything`; we only need the owner and
  // always create a fresh, uniquely-named repo under it.
  const owner = sandbox.split('/')[0] ?? sandbox;
  const model = env.AITM_SMOKE_MODEL ?? 'qwen/qwen3-next-80b-a3b-instruct:free';
  return { apiKey, owner, model };
}

const GOAL = 'add file FOO with content BAR';

export async function runE2ESmoke(cfg: SmokeConfig, log: (s: string) => void): Promise<void> {
  const slug = `${cfg.owner}/aitm-smoke-${Date.now().toString(36)}`;
  const dir = await mkdtemp(join(tmpdir(), 'aitm-smoke-'));
  const env = { ...process.env, OPENROUTER_API_KEY: cfg.apiKey };
  let created = false;
  let succeeded = false;
  try {
    // ---- Fixture: a minimal repo with a CLAUDE.md style hint + free-model config --------
    await execa('git', ['init', '-q'], { cwd: dir });
    await execa('git', ['config', 'user.email', 'smoke@aitm.local'], { cwd: dir });
    await execa('git', ['config', 'user.name', 'aitm-smoke'], { cwd: dir });
    await writeFile(
      join(dir, 'CLAUDE.md'),
      '# CLAUDE.md\n\nSandbox repo for the aitm e2e smoke. Make the smallest change that satisfies the goal.\n',
    );
    await writeFile(
      join(dir, '.aitm.json'),
      `${JSON.stringify({ models: { generic: cfg.model, smart: cfg.model, coding: cfg.model, fast: cfg.model } }, null, 2)}\n`,
    );
    await execa('git', ['add', '-A'], { cwd: dir });
    await execa('git', ['commit', '-q', '-m', 'init: smoke fixture'], { cwd: dir });

    // ---- Create the GitHub repo and push --------------------------------------------------
    log(`creating sandbox repo ${slug}`);
    await execa(
      'gh',
      ['repo', 'create', slug, '--private', '--source=.', '--remote=origin', '--push'],
      {
        cwd: dir,
      },
    );
    created = true;

    // ---- aitm start → expect awaiting-pr with a real PR number ---------------------------
    log(`aitm start "${GOAL}" --max-prs 1 --max-sessions 2 --no-automerge`);
    const startCode = await main(
      ['start', GOAL, '--max-prs', '1', '--max-sessions', '2', '--no-automerge'],
      { cwd: dir, env },
    );
    assert.equal(startCode, 0, 'aitm start should exit 0 with an awaiting-pr outcome');

    const store = new StateStore(join(dir, '.ai-task-master'));
    const state = await store.read();
    assert.ok(
      typeof state.currentPr === 'number' && state.currentPr > 0,
      `state.json should carry a real PR number after start (got ${state.currentPr})`,
    );
    const pr = state.currentPr;
    log(`start opened PR #${pr}`);

    // merge-pr operates in cwd; be on the PR branch (the checkout branch lives elsewhere).
    await execa('gh', ['pr', 'checkout', String(pr)], { cwd: dir });

    // ---- aitm merge-pr (resume from state) → drive CI + threads → merge ------------------
    log('aitm merge-pr (resume from state)');
    const mergeCode = await main(['merge-pr'], { cwd: dir, env });
    assert.equal(mergeCode, 0, 'aitm merge-pr should exit 0 after landing the merge');

    // ---- Assert FOO exists on the default branch with the expected content ---------------
    const def = (
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
    const got = await execa(
      'gh',
      ['api', `repos/${slug}/contents/FOO?ref=${def}`, '-q', '.content'],
      {
        reject: false,
      },
    );
    assert.equal(got.exitCode, 0, `FOO must exist on the default branch (${def})`);
    const decoded = Buffer.from(got.stdout, 'base64').toString('utf8');
    assert.match(decoded, /BAR/, 'FOO should contain BAR');
    log(`FOO present on ${def} with expected content ✓`);

    succeeded = true;
  } finally {
    await rm(dir, { recursive: true, force: true });
    if (created && succeeded) {
      log(`deleting sandbox repo ${slug}`);
      const del = await execa('gh', ['repo', 'delete', slug, '--yes'], { reject: false });
      if (del.exitCode !== 0) {
        log(`warning: could not delete ${slug} (gh needs the delete_repo scope): ${del.stderr}`);
      }
    } else if (created) {
      log(`left sandbox repo ${slug} behind for inspection (run failed)`);
    }
  }
}
