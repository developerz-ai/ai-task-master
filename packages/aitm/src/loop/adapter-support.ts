// Small cross-cutting helpers shared by run-loop-adapter.ts, planner-wiring.ts and
// tool-resolution.ts: error normalization, style-content resolution, transcript begin/resume,
// the state port contract, memory-index/rolling-context glue, and the run budget check. Kept as
// its own leaf module (no imports from the other loop/* wiring files) so those three can depend on
// it without forming an import cycle.

import process from 'node:process';
import {
  loadMemoryIndex,
  type MemoryIndexEntry,
  wrapReminder,
} from '@developerz.ai/ai-claude-compat';
import type { ModelMessage, Tool } from 'ai';
import type { RunLoopInput } from '../composition/run-input.ts';
import type { GroupStage } from '../domain/pr-group.ts';
import type { RunStep } from '../observability/step-progress.ts';
import type { UsageTracker } from '../observability/usage-tracker.ts';
import type { PlanMarkdownGroup } from '../plan/plan-markdown.ts';
import type { GroupDigestEntry } from '../state/rolling-context.ts';
import { appendGroupDigest } from '../state/rolling-context.ts';
import type { RunState } from '../state/schema.ts';
import type {
  RunEndOutcome,
  TranscriptRecorder,
  TranscriptStore,
  TranscriptTarget,
} from '../state/transcript-store.ts';
import { buildMemoryTool, type MemoryToolInput } from '../subagents/memory-tool.ts';
import type { BudgetStatus } from './work-loop.ts';

// Reduce a caught value to display text the way every catch site in this file already did
// (`err instanceof Error ? err.message : String(err)`), but without silently dropping the
// original value: wrapping a non-Error in a real Error keeps it reachable as `.cause` instead of
// discarding it once `String(err)` runs. A caught Error is returned as-is — same object, same
// `.message`, whatever `.cause` it already carried. Exported for the cause-preservation unit test.
export function describeError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err), { cause: err });
}

// The distiller bounds its digest to ~600 words (coding-style.ts INTRO), but the raw fallback — the
// target repo's verbatim CLAUDE.md/AGENTS.md, used when no digest was produced — is unbounded and
// would bloat every planner/worker/reviewer/self-review/CI-fix prompt (paid per subagent call). Cap
// it to a char budget matching that ceiling; keep the head, where house-style rules lead.
export const RAW_STYLE_MAX_CHARS = 4000;
const STYLE_TRUNCATION_MARKER = '\n\n[style truncated]';

// The style string injected into subagent prompts: the distilled digest when present (already
// bounded), else the raw style file capped to RAW_STYLE_MAX_CHARS. Single-sourced so the Planner and
// the Orchestrator bridge resolve style identically. Exported for the raw-fallback cap unit test.
export function resolveStyleContents(
  input: Pick<RunLoopInput, 'styleDigest' | 'agentConfig'>,
): string {
  return input.styleDigest ?? capRawStyle(input.agentConfig.contents);
}

function capRawStyle(contents: string): string {
  if (contents.length <= RAW_STYLE_MAX_CHARS) return contents;
  const budget = RAW_STYLE_MAX_CHARS - STYLE_TRUNCATION_MARKER.length;
  return contents.slice(0, budget) + STYLE_TRUNCATION_MARKER;
}

// The run's phase + N/M position as a standalone TRAILING `<system-reminder>`, appended to the END of a
// subagent's first user message (slice 04 §4) so the model still knows where it is in the run without
// the position sitting in — and re-invalidating every step — the cacheable prompt prefix. '' when the
// step reports no position (a bare `{}`), so appendReminderBlock leaves the prompt untouched.
export function runProgressReminder(step: RunStep): string {
  const line = runStepContextLine(step);
  return line ? wrapReminder(`# runProgress\n${line}`) : '';
}

// Render a RunStep as a progress line: `Step N of M — <phase>` when the counter is known, `Phase:
// <phase>` when only the phase is (planning, before groups exist), '' when nothing is. Mirrors the
// observability tag (step-progress.formatStepTag) but in prose for the model, not the log.
export function runStepContextLine(step: RunStep): string {
  const hasCounter = step.index !== undefined && step.total !== undefined && step.total > 0;
  if (hasCounter) {
    const base = `Step ${step.index} of ${step.total}`;
    return step.phase ? `${base} — ${step.phase}` : base;
  }
  return step.phase ? `Phase: ${step.phase}` : '';
}

// Narrow state surface the adapter drives. StateStore satisfies it; tests pass an in-memory stub.
// readContext is optional — the rolling summary of prior PRs is threaded into subagent prompts
// when present, and the run still works (empty context) when the port omits it.
export type AdapterStatePort = {
  read(): Promise<RunState>;
  update(mutator: (s: RunState) => RunState): Promise<RunState>;
  readContext?(): Promise<string | null>;
  // Persist the accumulated rolling context (context.md) after each PR opens (issue #123). Optional
  // like readContext; StateStore satisfies it verbatim (atomic write), test stubs may omit it.
  writeContext?(summary: string): Promise<void>;
  // Persist plan groups as the loop marks tasks done; StateStore renders them to plan.md.
  // Optional so in-memory test stubs can omit it; StateStore supplies it in production.
  writePlan?(groups: readonly PlanMarkdownGroup[]): Promise<void>;
  // Append one lifecycle line to progress.md (plan.md's sibling) as the loop narrates group/task
  // transitions. Optional like writePlan; StateStore supplies it in production.
  appendProgress?(entry: string): Promise<void>;
  // The per-repo memory dir (issue #118). Optional: a port that omits it turns memory off entirely
  // (no index block, no memory tool). StateStore supplies it in production.
  memoryDir?(): string;
  // Per-subagent transcript store (issue #108). Optional: a port that omits it records nothing and
  // resumes nothing, so test stubs are untouched. StateStore supplies it in production.
  transcripts?(): TranscriptStore;
};

// The Worker's `memory` tool (issue #118), rooted at the state port's memory dir. Undefined when the
// port hands out no dir (test stubs), so memory features stay entirely off with no scaffold.
export function memoryToolFor(
  state: Pick<AdapterStatePort, 'memoryDir'>,
): Tool<MemoryToolInput, string> | undefined {
  const dir = state.memoryDir?.();
  return dir ? buildMemoryTool(dir) : undefined;
}

// Load the current memory index for prompt injection (issue #118). Read fresh per prompt build so a
// memory a Worker wrote in an earlier group is visible to the next. Empty when no memory dir.
export async function memoryIndexFor(
  state: Pick<AdapterStatePort, 'memoryDir'>,
): Promise<MemoryIndexEntry[]> {
  const dir = state.memoryDir?.();
  return dir ? loadMemoryIndex(dir) : [];
}

// Resume messages for an interrupted (group, stage) transcript (issue #108) — looked up BEFORE a new
// recorder is begun for this run, so it can never self-resume from its own fresh (empty) file. Null
// when there is no store or nothing resumable. Reconstruction failures already return null in-store,
// so resume never blocks the run.
export async function resumeMessagesFor(
  store: TranscriptStore | undefined,
  group: string,
  stage: GroupStage,
): Promise<ModelMessage[] | null> {
  if (!store) return null;
  const found = await store.findResumable(group, stage);
  if (!found) return null;
  if (found.recordingFailed) {
    process.stderr.write(
      `warning: resuming ${group}/${stage} from a transcript whose recorder had persistent write failures — resume context may be incomplete\n`,
    );
  }
  return found.messages;
}

// Map a subagent result kind to the transcript run-end outcome (issue #108).
export function runEndOutcome(kind: string): RunEndOutcome {
  return kind === 'ok' ? 'submitted' : kind === 'error' ? 'error' : 'no-submission';
}

// Begin a transcript recorder, best-effort (issue #108 CR): a mkdir/readdir failure in begin() falls
// back to null instead of aborting the run — transcripts are optional observability, and the recorder
// itself already swallows write failures. Null store → null (no recording).
export async function beginTranscript(
  store: TranscriptStore | undefined,
  target: TranscriptTarget,
): Promise<TranscriptRecorder | null> {
  if (!store) return null;
  try {
    return await store.begin(target);
  } catch (err) {
    process.stderr.write(`warning: transcript begin failed: ${describeError(err).message}\n`);
    return null;
  }
}

// Append one group's digest to the live rolling context and persist it (issue #123). Failure-tolerant:
// a writeContext rejection is warned to stderr, never propagated — persisting context must never fail
// the PR-open path (the PR is already open; a lost digest only costs the next group some freshness).
export async function persistRollingContext(
  state: Pick<AdapterStatePort, 'writeContext'>,
  liveContext: string,
  entry: GroupDigestEntry,
): Promise<string> {
  const next = appendGroupDigest(liveContext, entry);
  try {
    await state.writeContext?.(next);
  } catch (err) {
    process.stderr.write(
      `warning: failed to persist rolling context: ${describeError(err).message}\n`,
    );
  }
  return next;
}

// Serialized rolling-context accumulator (issue #123). WorkLoop opens a whole batch of groups with
// `Promise.all`, so two openPr callbacks can run persistRollingContext concurrently. A plain
// read-modify-write of a shared string would lose an update — both appends start from the same
// snapshot and the later write clobbers the earlier group's digest. Queue every append onto a chain
// so each one reads the context left by the previous append; `current()` always returns the newest
// accumulated context for the worker + ci-fix live reads. Exported for unit testing.
export type RollingContextAccumulator = {
  current(): string;
  append(entry: GroupDigestEntry): Promise<string>;
};

export function createRollingContextAccumulator(
  state: Pick<AdapterStatePort, 'writeContext'>,
  initial: string,
): RollingContextAccumulator {
  let liveContext = initial;
  // Tail of the serialization chain. Its rejections are swallowed (persistRollingContext already
  // absorbs write failures) so one bad append can never wedge the queue for later groups.
  let tail: Promise<unknown> = Promise.resolve();
  return {
    current: () => liveContext,
    append: (entry) => {
      const step = tail.then(async () => {
        liveContext = await persistRollingContext(state, liveContext, entry);
        return liveContext;
      });
      tail = step.catch(() => undefined);
      return step;
    },
  };
}

// Run-level cost/token ceiling (issue #190). Builds the WorkLoop `budget` seam from the usage ledger
// and the resolved ceilings. Returns undefined when no ceiling is set OR there is no tracker, so the
// loop runs unbounded and byte-identical. Token enforcement needs no pricing; cost is priced at flush
// and skipped when the overall cost is unknown (an unpriced model) — the guardrail is honestly
// approximate. Exported for tests.
export function makeBudgetCheck(
  usage: UsageTracker | undefined,
  maxCostUsd: number | undefined,
  maxTotalTokens: number | undefined,
): (() => Promise<BudgetStatus>) | undefined {
  if ((maxCostUsd === undefined && maxTotalTokens === undefined) || !usage) return undefined;
  return async (): Promise<BudgetStatus> => {
    const { overall } = await usage.totals();
    if (maxTotalTokens !== undefined) {
      const total = overall.inputTokens + overall.outputTokens;
      if (total >= maxTotalTokens) {
        return {
          exceeded: true,
          reason: `token ceiling reached (${total} ≥ maxTotalTokens ${maxTotalTokens}); stopping before the next PR group`,
        };
      }
    }
    if (maxCostUsd !== undefined && overall.costUsd !== null && overall.costUsd >= maxCostUsd) {
      return {
        exceeded: true,
        reason: `cost ceiling reached ($${overall.costUsd.toFixed(4)} ≥ maxCostUsd $${maxCostUsd}); stopping before the next PR group`,
      };
    }
    return { exceeded: false };
  };
}
