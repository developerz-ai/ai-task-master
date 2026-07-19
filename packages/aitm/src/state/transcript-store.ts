// Per-subagent conversation transcripts (issue #108): one JSONL file per ToolLoopAgent conversation
// under the state dir, so an interrupted run can resume a subagent from what it had already read and
// tried instead of cold-starting. Records are appended as steps complete (a crash loses at most the
// in-flight step), and each line is one self-contained JSON object with `kind` + `ts`.
//
// State-dir-scoped class, like PrContextStore. Appends are serialized per file (a promise chain, the
// Logger.appendToFile pattern) so records never interleave — atomicWrite would rewrite the whole file
// every step (O(n²)) and lose the crash-tail property. Records pass through Logger.redact before
// serialization (best-effort key-name redaction of key/token/secret/authorization).

import { access, appendFile, mkdir, open, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { LanguageModelUsage, ModelMessage } from 'ai';
import { modelMessageSchema } from 'ai';
import { Logger } from '../logger/logger.ts';
import type { GroupStage } from './schema.ts';

const TRANSCRIPTS_DIR = 'transcripts';
const PLANNER_SUBDIR = 'planner';

// Consecutive FileRecorder.append failures before we flag the transcript as having a dead
// recording (as opposed to a run truncated by a crash — see FileRecorder.append).
const PERSISTENT_FAILURE_THRESHOLD = 3;

// Sentinel written beside a transcript file once its recorder crosses the failure threshold. Its
// mere existence is the signal; content is irrelevant.
function failureMarkerFile(transcriptFile: string): string {
  return `${transcriptFile}.recording-failed`;
}

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

function isEexist(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: unknown }).code === 'EEXIST'
  );
}

// True when `prefix` is a leading run of `arr` (deep-equal, element by element with an early exit).
// Used to drop the cumulative overlap in pre-#175 transcripts during reconstruction.
function isLeadingRun(arr: readonly ModelMessage[], prefix: readonly ModelMessage[]): boolean {
  if (prefix.length === 0) return true;
  if (arr.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (JSON.stringify(arr[i]) !== JSON.stringify(prefix[i])) return false;
  }
  return true;
}

// Keep only a record's messages that match the ModelMessage shape, tallying skips into `tally` (one
// aggregated warning per reconstruct, not one per element — see reconstructTranscript). A crash
// mid-write or a hand-edit can leave a JSON-valid line whose message shape is wrong; dropping the bad
// element (not the whole line) keeps the rest of the transcript replayable on resume. The failing
// field is logged at debug so the aggregate warning stays a one-liner while detail is still reachable.
function validMessages(raw: readonly unknown[], tally: { skipped: number }): ModelMessage[] {
  const out: ModelMessage[] = [];
  for (const item of raw) {
    const parsed = modelMessageSchema.safeParse(item);
    if (parsed.success) {
      out.push(parsed.data);
    } else {
      tally.skipped++;
      console.debug('skipping invalid transcript message', {
        issues: parsed.error.issues.map((issue) => issue.path.join('.')),
      });
    }
  }
  return out;
}

// Reconstruct the message array the agent would see next from a transcript's raw JSONL, plus whether
// the run completed (a `run-end` record present). `step` messages concatenate; a `compaction` record
// replaces the accumulated array (its summary subsumes earlier steps), and steps after it append. A
// corrupt/truncated line warns immediately per line; messages failing the ModelMessage shape are
// dropped silently in the moment and rolled into one `skipped N invalid transcript messages` warning
// at the end, so a bad transcript can't flood the log with a warning per element. Unknown `kind`s are
// ignored (forward-compatible).
//
// Transcripts written before issue #175 stored `step.messages` as the CUMULATIVE response list per
// step (each record re-includes the whole conversation), so a record whose leading run equals the
// accumulated messages is de-overlapped to just its new suffix. Post-fix (per-step-delta) records
// don't overlap and append whole — the same rule handles both, keeping resume context duplicate-free.
export function reconstructTranscript(
  raw: string,
  onWarn: (message: string) => void = () => {},
): ReconstructedTranscript {
  let messages: ModelMessage[] = [];
  let complete = false;
  const tally = { skipped: 0 };
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
      const recorded = validMessages(record.messages, tally);
      messages.push(
        ...(isLeadingRun(recorded, messages) ? recorded.slice(messages.length) : recorded),
      );
    } else if (record.kind === 'compaction' && Array.isArray(record.messages)) {
      messages = validMessages(record.messages, tally);
    } else if (record.kind === 'run-end') {
      complete = true;
    }
  }
  if (tally.skipped > 0) onWarn(`skipped ${tally.skipped} invalid transcript messages`);
  return { messages, complete };
}

class FileRecorder implements TranscriptRecorder {
  private chain: Promise<unknown> = Promise.resolve();
  private consecutiveFailures = 0;

  constructor(
    private readonly file: string,
    private readonly onWarn: (message: string) => void,
  ) {}

  step(messages: readonly ModelMessage[], usage?: LanguageModelUsage): Promise<void> {
    return this.append({ kind: 'step', messages, ...(usage ? { usage } : {}) });
  }

  compaction(messages: readonly ModelMessage[]): Promise<void> {
    return this.append({ kind: 'compaction', messages });
  }

  end(outcome: RunEndOutcome): Promise<void> {
    return this.append({ kind: 'run-end', outcome });
  }

  // Best-effort (issue #108 CR): a serialize or disk failure warns and resolves — a transcript write
  // must never reject into and abort the agent loop. The serialize runs inside the try so a
  // synchronous JSON.stringify failure is caught too, and the chain still advances so ordering holds.
  //
  // A single failure is noise (a transient disk hiccup); PERSISTENT_FAILURE_THRESHOLD consecutive
  // failures means this recording is dead, not just this record. That distinction matters on resume:
  // a transcript that stops mid-run because the PROCESS crashed still has a healthy append history,
  // while one that stops because appends kept failing needs findResumable to say so rather than hand
  // back a transcript nobody was able to keep writing.
  private append(record: Record<string, unknown>): Promise<void> {
    const step = this.chain.then(async () => {
      try {
        const line = `${JSON.stringify(Logger.redact({ ts: new Date().toISOString(), ...record }))}\n`;
        await appendFile(this.file, line);
        this.consecutiveFailures = 0;
      } catch (err) {
        this.onWarn(`transcript write failed: ${err instanceof Error ? err.message : String(err)}`);
        this.consecutiveFailures += 1;
        if (this.consecutiveFailures === PERSISTENT_FAILURE_THRESHOLD) {
          await this.markPersistentFailure();
        }
      }
    });
    this.chain = step;
    return step;
  }

  // Never throws: this is a best-effort signal on top of an already-best-effort recorder.
  private async markPersistentFailure(): Promise<void> {
    try {
      await writeFile(failureMarkerFile(this.file), '');
    } catch (err) {
      this.onWarn(
        `transcript failure marker write failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
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
  // The ordinal's file is created empty to reserve it (see reserveOrdinalFile); records append to it.
  async begin(target: TranscriptTarget): Promise<TranscriptRecorder> {
    const { subdir, prefix } = locate(target);
    const dir = join(this.dir(), subdir);
    await mkdir(dir, { recursive: true });
    const file = await this.reserveOrdinalFile(dir, prefix);
    return new FileRecorder(file, this.onWarn);
  }

  // Reserve the next ordinal race-free: a bare readdir→max+1 lets two concurrent begins (in this
  // process or a peer sharing the state dir) pick the same ordinal and interleave into one file, since
  // the file isn't written until the first record. `open(…, 'wx')` creates the file exclusively —
  // EEXIST means someone already took that ordinal, so we bump and retry. The scan seeds a good start;
  // the loop only spins under an actual collision.
  private async reserveOrdinalFile(dir: string, prefix: string): Promise<string> {
    let ordinal = await this.nextOrdinal(dir, prefix);
    for (;;) {
      const file = join(dir, `${prefix}-${ordinal}.jsonl`);
      try {
        const handle = await open(file, 'wx');
        await handle.close();
        return file;
      } catch (err) {
        if (!isEexist(err)) throw err;
        ordinal++;
      }
    }
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
  // `recordingFailed` is set when that transcript's recorder hit PERSISTENT_FAILURE_THRESHOLD
  // consecutive append failures — i.e. it stopped because writes were failing, not just because the
  // process crashed mid-run — so callers can decide whether resuming from it is trustworthy.
  async findResumable(
    group: string,
    stage: GroupStage,
  ): Promise<{ messages: ModelMessage[]; recordingFailed: boolean } | null> {
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
      let parsed: ReturnType<typeof reconstructTranscript>;
      try {
        parsed = reconstructTranscript(await readFile(join(dir, f), 'utf8'), this.onWarn);
      } catch {
        // Unreadable transcript → try the next; resume must never block the run.
        continue;
      }
      // An empty transcript (an ordinal reserved by begin whose agent died before its first step)
      // carries no state — skip it so it can't shadow an earlier one that does.
      if (parsed.messages.length === 0) continue;
      // The NEWEST non-empty transcript decides the whole answer: if it is interrupted, resume it;
      // if it is complete, the last run for this (group, stage) finished, so there is nothing to
      // resume. Falling through to an OLDER interrupted transcript would hand a later task a dead,
      // already-superseded conversation.
      if (parsed.complete) return null;
      return {
        messages: parsed.messages,
        recordingFailed: await this.hasFailureMarker(join(dir, f)),
      };
    }
    return null;
  }

  private async hasFailureMarker(transcriptFile: string): Promise<boolean> {
    try {
      await access(failureMarkerFile(transcriptFile));
      return true;
    } catch {
      return false;
    }
  }
}
