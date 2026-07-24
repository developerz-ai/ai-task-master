// The observability rigging every subagent call site in run-loop-adapter/planner-wiring builds
// before it can call `create*Agent` — a RunStep tag, an agentLabel, a heartbeat sink, a composed
// onStepFinish (transcript delta + progress line), a retry line, and (when streaming) a live
// stream renderer — was hand-assembled at five call sites (planner, worker, reviewer, self-review,
// ci-fix) with the same ~15-line shape each time. buildSubagentSession is that shape, extracted
// once all five callers needed it verbatim.

import type { RetryInfo } from '@developerz.ai/ai-claude-compat';
import type { ModelMessage, ToolLoopAgentSettings, ToolSet } from 'ai';
import {
  createHeartbeatSink,
  type HeartbeatSink,
  startHeartbeat,
} from '../observability/heartbeat.ts';
import type { StepCounter } from '../observability/run-step.ts';
import {
  agentLabel,
  agentStepProgress,
  composeStepFinish,
  createLiveStreamRenderer,
  defaultProgressSink,
  harnessProgress,
  type RunStep,
  type StreamLabel,
} from '../observability/step-progress.ts';
import type { TranscriptRecorder } from '../state/transcript-store.ts';

// The SDK step event a role's `onStepFinish` receives — spelled once so every buildSubagentSession
// caller shares one slot instead of restating the settings-indexed type.
export type StepEvent<TOOLS extends ToolSet> = Parameters<
  NonNullable<ToolLoopAgentSettings<never, TOOLS>['onStepFinish']>
>[0];

// An `onStepFinish` handler that records only the per-step message delta (issue #175). `ai@6` hands
// the callback the CUMULATIVE response-message list each step (per-step lengths [2, 4, 6] on a live
// run), not a delta — recording it verbatim grew transcript files O(N²) and made resume replay a
// duplicated conversation. Tracking the count already recorded and slicing keeps each record a true
// delta. One handler per recorder (fresh closure state); exported for tests.
export function recordStepDeltas(
  recorder: TranscriptRecorder,
): (event: {
  response: { messages: readonly ModelMessage[] };
  usage?: Parameters<TranscriptRecorder['step']>[1];
}) => void {
  let recorded = 0;
  return (event) => {
    const delta = event.response.messages.slice(recorded);
    recorded = event.response.messages.length;
    if (delta.length > 0) void recorder.step(delta, event.usage);
  };
}

// The console line for one LLM-call retry (slice 01b): RetryInfo.reason is always non-empty (compat's
// describeRetryReason), so this can never render an empty `Rate limited:` line. Exported for the unit
// test that pins the exact wording.
export function retryProgressMessage(info: RetryInfo): string {
  const seconds = Math.max(0, Math.round(info.delayMs / 1000));
  return `Rate limited (${info.reason}), retrying in ${seconds}s (${info.attempt}/${info.maxAttempts})`;
}

// Build an onRetry callback that reports a retry through harnessProgress under the given RunStep tag,
// via the SAME HeartbeatSink the caller's onStepFinish writes through — so a retry line counts as
// progress too and pushes back the heartbeat's next tick instead of racing it.
export function onRetryProgress(
  step: RunStep | undefined,
  sink: HeartbeatSink,
): (info: RetryInfo) => void {
  return (info) => harnessProgress(retryProgressMessage(info), step, sink);
}

export type SubagentSessionInit = {
  role: string;
  model: string;
  ctx?: string;
  specialist?: string;
  phase: string;
  counter?: StepCounter | undefined;
  streaming: boolean;
  // The transcript recorder for this call, when the run has one (issue #108). Its step deltas are
  // folded into `onStepFinish` alongside the progress line. Omitted or null → progress-only.
  recorder?: TranscriptRecorder | null;
};

export type SubagentSession<TOOLS extends ToolSet> = {
  tag: RunStep;
  label: StreamLabel;
  heartbeatSink: HeartbeatSink;
  onStepFinish: (event: StepEvent<TOOLS>) => void;
  onRetry: (info: RetryInfo) => void;
  onStream?: ReturnType<typeof createLiveStreamRenderer>;
  // Starts the liveliness heartbeat (issue #01b) and returns its idempotent stop function — call it
  // in the `finally` around the subagent's `generate`.
  start(): () => void;
};

export function buildSubagentSession<TOOLS extends ToolSet>(
  init: SubagentSessionInit,
): SubagentSession<TOOLS> {
  const tag: RunStep = { phase: init.phase, ...(init.counter ?? {}) };
  const label = agentLabel({
    model: init.model,
    role: init.role,
    ...(init.specialist ? { specialist: init.specialist } : {}),
    ...(init.ctx ? { ctx: init.ctx } : {}),
  });
  const heartbeatSink = createHeartbeatSink(defaultProgressSink());
  const onStepFinish =
    composeStepFinish<StepEvent<TOOLS>>(
      init.recorder ? recordStepDeltas(init.recorder) : undefined,
      agentStepProgress(label, tag, heartbeatSink, { textAndTools: !init.streaming }),
    ) ?? (() => {});
  return {
    tag,
    label,
    heartbeatSink,
    onStepFinish,
    onRetry: onRetryProgress(tag, heartbeatSink),
    ...(init.streaming ? { onStream: createLiveStreamRenderer(label, tag, heartbeatSink) } : {}),
    start: () => startHeartbeat(label, heartbeatSink),
  };
}
