// Output seam and the two emitters that write through it: per-agent step lines and the harness's
// own cyan status line. Formatting itself lives in step-progress-format.ts; this module is the
// stateful/output side — where lines go, and the onStepFinish-shaped handlers that drive it.

import {
  CYAN_BOLD,
  clip,
  formatStepTag,
  GREEN_BOLD,
  prefix,
  RESET,
  type RunStep,
  renderStepLines,
  type StepProgressEvent,
  type StreamLabel,
} from './step-progress-format.ts';

// Output seam: where lines go, whether ANSI color is applied, and the clock. Injectable for tests;
// production call sites omit it and get stderr + TTY-gated color + wall clock.
export type ProgressSink = {
  write: (line: string) => void;
  color: boolean;
  now: () => Date;
};

// Exported so callers that need to share ONE sink instance across several emitters (the heartbeat,
// slice 01b — it must see every write those emitters make to tell silence from activity) can build
// one with the exact same stderr/TTY/clock behavior as the module-internal default.
export function defaultProgressSink(): ProgressSink {
  return {
    write: (line) => process.stderr.write(line),
    color: process.stderr.isTTY === true && process.env.NO_COLOR === undefined,
    now: () => new Date(),
  };
}

// Prepended to a milestone line (a group merging) so the one event the operator is waiting for is
// scannable in a wall of cyan stage lines. A star, per request; single-width so it never misaligns.
const MILESTONE_STAR = '★';

// An onStepFinish-compatible handler that streams an agent's activity under its own prefix.
// Never throws — progress must never break a run. `textAndTools: false` (slice 07) renders ONLY the
// reasoning line and drops text/toolCalls — for a streaming run, where createLiveStreamRenderer
// already printed that step's text and tool-call lines live as they arrived; rendering them again
// here at step-finish would duplicate every line. Reasoning has no live equivalent (the streamed
// funnel forwards text-delta/tool-call only), so it still renders at step-finish either way.
export function agentStepProgress(
  label: StreamLabel,
  step?: RunStep,
  sink: ProgressSink = defaultProgressSink(),
  options?: { textAndTools?: boolean },
): (event: StepProgressEvent) => void {
  const textAndTools = options?.textAndTools ?? true;
  return (event) => {
    try {
      const rendered: StepProgressEvent = textAndTools
        ? event
        : { reasoningText: event.reasoningText };
      for (const line of renderStepLines(label, rendered, sink, step)) sink.write(line);
    } catch {
      // observability must never break the run
    }
  };
}

// One cyan orchestrator line: what the harness is doing to drive/keep the agents in check
// (stage starts, PR numbers, fix passes, retries). The optional RunStep stamps the phase + N/M
// step into the bracket so every harness line names the state and position the run is on.
// `milestone` marks a success worth spotting at a glance (a group merged): the [aitm] prefix goes
// green, a ★ leads the line, and the message itself is green too. Everything else stays the cyan
// default. Non-TTY sinks (files, NO_COLOR) still get the ★ but no ANSI.
export function harnessProgress(
  message: string,
  step?: RunStep,
  sink: ProgressSink = defaultProgressSink(),
  opts?: { milestone?: boolean },
): void {
  try {
    const tag = step ? formatStepTag(step) : '';
    if (opts?.milestone) {
      const body = clip(`${MILESTONE_STAR} ${message}`);
      const text = sink.color ? `${GREEN_BOLD}${body}${RESET}` : body;
      sink.write(`${prefix('aitm', sink, GREEN_BOLD, tag)} ${text}\n`);
      return;
    }
    sink.write(`${prefix('aitm', sink, CYAN_BOLD, tag)} ${clip(message)}\n`);
  } catch {
    // observability must never break the run
  }
}

// Compose several per-step observers (e.g. the transcript recorder + the progress stream) into
// the single `onStepFinish` slot a subagent init exposes. Each observer is isolated: one throwing
// cannot starve the others. All-undefined → undefined, so callers keep the conditional-spread idiom.
export function composeStepFinish<E>(
  ...handlers: Array<((event: E) => unknown) | undefined>
): ((event: E) => void) | undefined {
  const present = handlers.filter((h): h is (event: E) => unknown => h !== undefined);
  if (present.length === 0) return undefined;
  return (event) => {
    for (const handler of present) {
      try {
        handler(event);
      } catch {
        // one observer's failure must not starve the others
      }
    }
  };
}
