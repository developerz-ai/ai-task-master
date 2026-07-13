// Per-subagent conversation transcripts (issue #108): one JSONL file per ToolLoopAgent conversation
// under the state dir, so an interrupted run can resume a subagent from what it had already read and
// tried instead of cold-starting. Records are appended as steps complete (a crash loses at most the
// in-flight step), and each line is one self-contained JSON object with `kind` + `ts`.
//
// State-dir-scoped class, like PrContextStore. Appends are serialized per file (a promise chain, the
// Logger.appendToFile pattern) so records never interleave — atomicWrite would rewrite the whole file
// every step (O(n²)) and lose the crash-tail property. Records pass through Logger.redact before
// serialization (best-effort key-name redaction of key/token/secret/authorization).

import { appendFile, mkdir, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { LanguageModelUsage, ModelMessage } from 'ai';
import { Logger } from '../logger/logger.ts';
import type { GroupStage } from './schema.ts';

const TRANSCRIPTS_DIR = 'transcripts';
const PLANNER_SUBDIR = 'planner';

export type RunEndOutcome = 'submitted' | 'no-submission' | 'error';

// A conversation is either a group's stage run (resumable) or the planner (recorded, never resumed).
export type TranscriptTarget = { group: string; stage: GroupStage } | { planner: true };

export type ReconstructedTranscript = { messages: ModelMessage[]; complete: boolean };

// A recorder bound to one conversation's file. Its append order is serialized.
export type TranscriptRecorder = {
  step(messages: readonly ModelMessage[], usage?: LanguageModelUsage): Promise<void>;
  compaction(messages: readonly ModelMessage[]): Promise<void>;
  end(outcome: RunEndOutcome): Promise<void>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

// Filesystem-safe token from a planner-supplied group id (no separators/traversal), mirroring
// PrContextStore.sanitize.
function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'unnamed';
}

// (subdir under transcripts/, filename prefix) for a target.
function locate(target: TranscriptTarget): { subdir: string; prefix: string } {
  return 'planner' in target
    ? { subdir: PLANNER_SUBDIR, prefix: PLANNER_SUBDIR }
    : { subdir: sanitize(target.group), prefix: target.stage };
}

function ordinalOf(file: string, prefix: string): number | null {
  const m = new RegExp(`^${prefix}-(\\d+)\\.jsonl$`).exec(file);
  return m ? Number(m[1]) : null;
}

// Reconstruct the message array the agent would see next from a transcript's raw JSONL, plus whether
// the run completed (a `run-end` record present). `step` messages concatenate; a `compaction` record
// replaces the accumulated array (its summary subsumes earlier steps), and steps after it append. A
// corrupt/truncated line is skipped with a warning; unknown `kind`s are ignored (forward-compatible).
export function reconstructTranscript(
  raw: string,
  onWarn: (message: string) => void = () => {},
): ReconstructedTranscript {
  let messages: ModelMessage[] = [];
  let complete = false;
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      onWarn('skipping a corrupt transcript line');
      continue;
    }
    if (!isRecord(record)) continue;
    if (record.kind === 'step' && Array.isArray(record.messages)) {
      messages.push(...(record.messages as ModelMessage[]));
    } else if (record.kind === 'compaction' && Array.isArray(record.messages)) {
      messages = [...(record.messages as ModelMessage[])];
    } else if (record.kind === 'run-end') {
      complete = true;
    }
  }
  return { messages, complete };
}

class FileRecorder implements TranscriptRecorder {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly file: string) {}

  step(messages: readonly ModelMessage[], usage?: LanguageModelUsage): Promise<void> {
    return this.append({ kind: 'step', messages, ...(usage ? { usage } : {}) });
  }

  compaction(messages: readonly ModelMessage[]): Promise<void> {
    return this.append({ kind: 'compaction', messages });
  }

  end(outcome: RunEndOutcome): Promise<void> {
    return this.append({ kind: 'run-end', outcome });
  }

  private append(record: Record<string, unknown>): Promise<void> {
    const line = `${JSON.stringify(Logger.redact({ ts: new Date().toISOString(), ...record }))}\n`;
    const step = this.chain.then(() => appendFile(this.file, line));
    this.chain = step.catch(() => undefined);
    return step;
  }
}

export class TranscriptStore {
  constructor(
    private readonly stateDir: string,
    private readonly onWarn: (message: string) => void = (m) =>
      void process.stderr.write(`warning: ${m}\n`),
  ) {}

  private dir(): string {
    return join(this.stateDir, TRANSCRIPTS_DIR);
  }

  // Start a new transcript for a target, allocating the next 1-based ordinal per (subdir, prefix).
  // The file is created lazily on the first record.
  async begin(target: TranscriptTarget): Promise<TranscriptRecorder> {
    const { subdir, prefix } = locate(target);
    const dir = join(this.dir(), subdir);
    await mkdir(dir, { recursive: true });
    const ordinal = await this.nextOrdinal(dir, prefix);
    return new FileRecorder(join(dir, `${prefix}-${ordinal}.jsonl`));
  }

  private async nextOrdinal(dir: string, prefix: string): Promise<number> {
    let max = 0;
    for (const file of await readdir(dir)) {
      const n = ordinalOf(file, prefix);
      if (n !== null && n > max) max = n;
    }
    return max + 1;
  }

  // The newest INTERRUPTED transcript for (group, stage) — highest ordinal without a `run-end` — with
  // its reconstructed messages, or null when none is resumable (no dir, or all complete). Never throws.
  async findResumable(
    group: string,
    stage: GroupStage,
  ): Promise<{ messages: ModelMessage[] } | null> {
    const { subdir, prefix } = locate({ group, stage });
    const dir = join(this.dir(), subdir);
    let files: string[];
    try {
      files = await readdir(dir);
    } catch {
      return null;
    }
    const ordered = files
      .map((f) => ({ f, n: ordinalOf(f, prefix) }))
      .filter((x): x is { f: string; n: number } => x.n !== null)
      .sort((a, b) => b.n - a.n);
    for (const { f } of ordered) {
      try {
        const parsed = reconstructTranscript(await readFile(join(dir, f), 'utf8'), this.onWarn);
        if (!parsed.complete) return { messages: parsed.messages };
      } catch {
        // Unreadable transcript → try the next; resume must never block the run.
      }
    }
    return null;
  }
}
