import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * CI resolves its dependencies from the tracked lockfile, or it does not.
 *
 * The defect this guards: two of the three CI jobs installed with `npm
 * install`, and the npm lockfile is gitignored — so those jobs resolved
 * dependencies to whatever was newest on the registry, on every run. A
 * dependency published six hours after the last green run broke them, and the
 * next push to `main` turned the `node` job red on a type error in files the
 * push never touched. "CI green on `main`" was true as history and not as a
 * fact.
 *
 * The workflow is the artifact under test: it is read, not re-implemented. The
 * rule is that no install in it may resolve from the registry's latest — each
 * one must come from a lockfile — and that every job installs at all, so a job
 * added later without an install cannot slip in behind this rule. The reader is
 * proven against fixtures first, so a rule that could not fail cannot pass.
 */

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const WORKFLOW = '.github/workflows/ci.yml';

/** The repository root, from git's own answer. */
function repoRoot(): string {
  const proc = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: REPO_ROOT });
  if (proc.status !== 0) {
    throw new Error(
      `git rev-parse --show-toplevel exited ${proc.status}: ${proc.stderr?.toString().trim()}`,
    );
  }
  return proc.stdout.toString().trim().replace(/\/+$/, '');
}

/** The workflow's own text, from the tree. */
function workflow(): string {
  return readFileSync(`${repoRoot()}/${WORKFLOW}`, 'utf8');
}

/**
 * Each job's shell commands: every `run:` body — single-line or a `|` / `>` block
 * scalar — split on `&&`, `||` and `;`, attributed to the job it sits under.
 */
function jobCommands(text: string): Map<string, string[]> {
  const jobs = new Map<string, string[]>();
  let inJobs = false;
  let commands: string[] | undefined;
  let blockKeyColumn: number | undefined;
  const push = (body: string) => {
    for (const part of body.split(/&&|\|\||;/)) {
      if (part.trim()) commands?.push(part.trim());
    }
  };
  for (const line of text.split('\n')) {
    if (blockKeyColumn !== undefined) {
      const indent = line.search(/\S/);
      if (indent === -1) continue;
      if (indent > blockKeyColumn) {
        push(line);
        continue;
      }
      blockKeyColumn = undefined;
    }
    if (/^\S/.test(line)) {
      inJobs = /^jobs:\s*$/.test(line);
      commands = undefined;
      continue;
    }
    if (!inJobs) continue;
    const job = /^ {2}([A-Za-z_][\w-]*):\s*$/.exec(line);
    if (job?.[1]) {
      commands = [];
      jobs.set(job[1], commands);
      continue;
    }
    const run = /^(\s*(?:-\s+)?)run:\s*(.*?)\s*$/.exec(line);
    if (!run || !commands) continue;
    if (/^[|>][-+]?\d*$/.test(run[2] ?? '')) blockKeyColumn = run[1]?.length ?? 0;
    else push(run[2] ?? '');
  }
  return jobs;
}

const INSTALL = /^(npm|yarn|pnpm|bun)\s+(install|i|add|ci)\b/;
// npm has no `--frozen-lockfile`: it ignores the flag and resolves from the registry.
const LOCKED = /^npm\s+ci\b|^(bun|yarn|pnpm)\s+(install|i)\b.*\s--frozen-lockfile\b/;

/** Every install, and each job with none. */
function installs(text: string): { floating: string[]; jobsWithout: string[]; jobs: number } {
  const floating: string[] = [];
  const jobsWithout: string[] = [];
  const jobs = jobCommands(text);
  for (const [job, commands] of jobs) {
    const own = commands.filter((command) => INSTALL.test(command));
    if (own.length === 0) jobsWithout.push(job);
    floating.push(...own.filter((command) => !LOCKED.test(command)).map((c) => `${job}: ${c}`));
  }
  return { floating, jobsWithout, jobs: jobs.size };
}

describe('the workflow reader', () => {
  const wf = (steps: string) =>
    `on: push\njobs:\n  a:\n    steps:\n${steps}\n  b:\n    steps:\n      - run: npm ci\n`;

  it('reads an install inside a block scalar', () => {
    const r = installs(
      wf('      - run: |\n          echo hi\n          npm install\n        shell: bash'),
    );
    assert.deepEqual(r.floating, ['a: npm install']);
  });

  it('reads an install chained after another command', () => {
    assert.deepEqual(installs(wf('      - run: cd x && pnpm install')).floating, [
      'a: pnpm install',
    ]);
  });

  it('refuses a flag npm does not have, and accepts npm ci', () => {
    const r = installs(wf('      - run: npm install --frozen-lockfile'));
    assert.deepEqual(r.floating, ['a: npm install --frozen-lockfile']);
  });

  it('names the job that does not install, even when another installs twice', () => {
    const r = installs(
      wf('      - run: bun install --frozen-lockfile\n      - run: bun install --frozen-lockfile'),
    );
    assert.deepEqual(r, { floating: [], jobsWithout: [], jobs: 2 });
    const s = installs(
      `jobs:\n  a:\n    steps:\n      - run: npm ci\n      - run: npm ci\n  b:\n    steps:\n      - run: echo\n`,
    );
    assert.deepEqual(s.jobsWithout, ['b']);
  });
});

describe('the CI workflow', () => {
  it('resolves every install from a lockfile', () => {
    const { floating, jobs } = installs(workflow());
    assert.ok(jobs > 0, `no job found in ${WORKFLOW}, so this rule is vacuous`);
    assert.deepEqual(
      floating,
      [],
      `an install in ${WORKFLOW} resolves from the registry's latest, so a dependency published after the lockfile can break CI on an unrelated push: ${floating.join(' | ')}`,
    );
  });

  it('installs in every job', () => {
    const { jobsWithout } = installs(workflow());
    assert.deepEqual(
      jobsWithout,
      [],
      `job(s) in ${WORKFLOW} install nothing: ${jobsWithout.join(', ')} — every job must install from the lockfile`,
    );
  });
});
