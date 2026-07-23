// Tee the WorkLoop's harness narration into .ai-task-master/progress.md, plan.md's sibling: the
// same lifecycle lines the operator sees on stderr (group starts, stage transitions, task/merge
// timings), rendered as durable timestamped markdown bullets. SRP: rendering + teeing only —
// append serialization and the file itself are StateStore.appendProgress's job.

import { formatStepTag, harnessProgress, type RunStep } from '../observability/step-progress.ts';

// `- <ISO-8601 UTC> [<step tag>] <message>` — the tag matches the console bracket (`group 2/5
// working`), the full message is kept unclipped (files have no console width budget).
export function progressFileEntry(
  message: string,
  step?: RunStep,
  now: () => Date = () => new Date(),
): string {
  const stamp = now().toISOString();
  const tag = step ? formatStepTag(step) : '';
  return tag ? `- ${stamp} [${tag}] ${message}` : `- ${stamp} ${message}`;
}

export type ProgressOpts = { milestone?: boolean };
export type ProgressTee = (message: string, step?: RunStep, opts?: ProgressOpts) => void;

// Build the WorkLoop `progress` callback: every line goes to the console emitter, and — when the
// state port supplies appendProgress — to progress.md. Append failures (rejection or sync throw)
// are swallowed: observability must never break the run. `opts` (e.g. a milestone highlight) is
// passed to the console emitter only; the file entry stays plain markdown.
export function makeProgressTee(input: {
  append?: (entry: string) => Promise<void>;
  emit?: (message: string, step?: RunStep, opts?: ProgressOpts) => void;
  now?: () => Date;
}): ProgressTee {
  // Default emitter forwards to harnessProgress with the default sink, threading opts (the milestone
  // highlight) into its 4th param without leaking the sink type into this module.
  const emit =
    input.emit ?? ((message, step, opts) => harnessProgress(message, step, undefined, opts));
  const { append, now } = input;
  return (message, step, opts) => {
    emit(message, step, opts);
    if (!append) return;
    try {
      void append(progressFileEntry(message, step, now)).catch(() => undefined);
    } catch {
      // observability must never break the run
    }
  };
}
