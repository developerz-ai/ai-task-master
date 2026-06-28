// Downloads PR review context to disk so a subagent can READ it with its file tools, instead of
// being handed a giant prompt. Mirrors claude-task-master's layout under the state dir:
//
//   <stateDir>/debugging/pr/<pr>/
//     ci/failed_<check>.txt        one file per failed CI check, FULL logs (no truncation)
//     ci/summary.txt               which checks failed
//     comments/NNN_<path>.txt      one file per unresolved review thread
//     comments/summary.txt         counts + files touched
//     addressed_threads.json       review-thread IDs already handled, so a re-poll never re-processes them
//
// SRP: this module only persists/clears the context. Fetching the logs is GitHubClient's job
// (getFailedCiLogs + listUnresolvedThreads); wiring lives in the merge-pr flow.

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ReviewThread } from '../github/schema.ts';

export type CiFailure = { check: string; logs: string };

export type PrContextSummary = {
  prDir: string;
  ciDir: string | null;
  commentsDir: string | null;
  ciCount: number;
  commentCount: number;
};

export class PrContextStore {
  constructor(private readonly stateDir: string) {}

  prDir(pr: number): string {
    return join(this.stateDir, 'debugging', 'pr', String(pr));
  }

  // Remove any previously-downloaded context for this PR so a re-run never reads stale logs.
  async clear(pr: number): Promise<void> {
    await rm(this.prDir(pr), { recursive: true, force: true });
  }

  async saveCiFailures(pr: number, failures: readonly CiFailure[]): Promise<string | null> {
    if (failures.length === 0) return null;
    const ciDir = join(this.prDir(pr), 'ci');
    await mkdir(ciDir, { recursive: true });
    const used = new Map<string, number>();
    for (const { check, logs } of failures) {
      const base = sanitize(check);
      // Disambiguate two jobs that sanitize to the same name (e.g. matrix legs).
      const n = used.get(base) ?? 0;
      used.set(base, n + 1);
      const file = n === 0 ? `failed_${base}.txt` : `failed_${base}_${n}.txt`;
      const header = `CI check failed: ${check}\nPR: #${pr}\n${'='.repeat(60)}\n\n`;
      await writeFile(join(ciDir, file), header + logs);
    }
    await writeFile(
      join(ciDir, 'summary.txt'),
      [
        `PR #${pr} — ${failures.length} failed check(s):`,
        ...failures.map((f) => `  - ${f.check}`),
      ].join('\n'),
    );
    return ciDir;
  }

  async saveComments(pr: number, threads: readonly ReviewThread[]): Promise<string | null> {
    if (threads.length === 0) return null;
    const commentsDir = join(this.prDir(pr), 'comments');
    await mkdir(commentsDir, { recursive: true });
    let i = 0;
    for (const thread of threads) {
      i += 1;
      const path = thread.path ?? 'general';
      const body = thread.comments
        .map((c) => `@${c.author}:\n${c.body}`)
        .join(`\n${'-'.repeat(40)}\n`);
      const header = `Review thread on ${path} (thread ${thread.id})\nPR: #${pr}\n${'='.repeat(60)}\n\n`;
      await writeFile(
        join(commentsDir, `${String(i).padStart(3, '0')}_${sanitize(path)}.txt`),
        header + body,
      );
    }
    const paths = [...new Set(threads.map((t) => t.path ?? 'general'))].sort();
    await writeFile(
      join(commentsDir, 'summary.txt'),
      [
        `PR #${pr} — ${threads.length} unresolved review thread(s).`,
        'Files with comments:',
        ...paths.map((p) => `  - ${p}`),
      ].join('\n'),
    );
    return commentsDir;
  }

  // Review threads already replied to/resolved. The addressing-reviews loop subtracts these from
  // the unresolved set so it never re-processes a thread across re-polls. Missing file → none yet.
  async readAddressedThreads(pr: number): Promise<Set<string>> {
    try {
      const raw = await readFile(this.addressedThreadsFile(pr), 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return new Set();
      return new Set(parsed.filter((id): id is string => typeof id === 'string'));
    } catch {
      return new Set();
    }
  }

  // Additive: merges ids into whatever was recorded before, so iterations accumulate.
  async recordAddressedThreads(pr: number, ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    const merged = await this.readAddressedThreads(pr);
    for (const id of ids) merged.add(id);
    await mkdir(this.prDir(pr), { recursive: true });
    await writeFile(
      this.addressedThreadsFile(pr),
      `${JSON.stringify([...merged].sort(), null, 2)}\n`,
    );
  }

  private addressedThreadsFile(pr: number): string {
    return join(this.prDir(pr), 'addressed_threads.json');
  }
}

// Filesystem-safe token from a check name / file path.
function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'unnamed';
}
