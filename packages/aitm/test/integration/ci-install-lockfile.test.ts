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
 * added later without an install cannot slip in behind this rule.
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

/** The job names: the two-space-indented keys under `jobs:`. */
function jobNames(text: string): string[] {
  const names: string[] = [];
  let inJobs = false;
  for (const line of text.split('\n')) {
    if (/^jobs:\s*$/.test(line)) {
      inJobs = true;
      continue;
    }
    if (inJobs) {
      const job = /^ {2}([A-Za-z][A-Za-z0-9_-]*):\s*$/.exec(line);
      if (job?.[1]) names.push(job[1]);
    }
  }
  return names;
}

/** The install commands the workflow runs, with the step they belong to. */
function installCommands(text: string): string[] {
  const commands: string[] = [];
  for (const line of text.split('\n')) {
    const run = /^\s*run:\s*(.+?)\s*$/.exec(line);
    if (!run?.[1]) continue;
    const command = run[1];
    if (/^(npm|yarn|pnpm)\s+(install|add|i)\b/.test(command) || /^bun\s+install\b/.test(command)) {
      commands.push(command);
    }
  }
  return commands;
}

describe('the CI workflow', () => {
  it('resolves every install from a lockfile', () => {
    const commands = installCommands(workflow());
    assert.ok(commands.length > 0, 'the workflow installs nothing, so this rule is vacuous');
    const floating = commands.filter(
      (command) => !/--frozen-lockfile\b/.test(command) && !/^npm\s+ci\b/.test(command),
    );
    assert.deepEqual(
      floating,
      [],
      `an install in ${WORKFLOW} resolves from the registry's latest, so a dependency published after the lockfile can break CI on an unrelated push: ${floating.join(' | ')}`,
    );
  });

  it('installs in every job', () => {
    const text = workflow();
    const jobs = jobNames(text);
    const installs = installCommands(text).length;
    assert.ok(jobs.length > 0, 'no job found in the workflow');
    assert.equal(
      installs,
      jobs.length,
      `the workflow has ${jobs.length} job(s) and ${installs} install step(s): every job must install from the lockfile`,
    );
  });
});
