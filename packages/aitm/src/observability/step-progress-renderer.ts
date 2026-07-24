// The live-stream rendering path (slice 07): consumes text-delta/tool-call events AS THEY ARRIVE,
// instead of waiting for onStepFinish, so a fast-moving stream shows up incrementally.

import {
  clip,
  formatStepTag,
  ORANGE_BOLD,
  prefix,
  type RunStep,
  SHORT_DETAIL_MAX,
  type StreamLabel,
  summarizeToolInput,
} from './step-progress-format.ts';
import { defaultProgressSink, type ProgressSink } from './step-progress-sink.ts';

// A live event forwarded from the compat streaming funnel (slice 07): incremental assistant text, or
// a tool call issued before its result resolves. Structurally identical to compat's
// SubagentStreamEvent — kept local (not imported) so this module has no hard dependency on
// ai-claude-compat's export surface; the caller's SubagentStreamSink satisfies this shape either way.
export type LiveStreamEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'tool-call'; toolName: string; input: unknown };

// Line-buffered live renderer (slice 07): consumes text-delta/tool-call events AS THEY ARRIVE and
// prints each complete line the moment it closes, instead of waiting for the whole step to finish.
// Assistant text is buffered until a `\n` closes a line (a trailing partial with no newline yet is
// held, flushed whole once more text closes it or a tool-call forces it out — a tool-call event fires
// BEFORE its result, matching the PR07 requirement that tool lines render pre-result). Honors the
// same leading-blank-line rule as renderStepLines (one blank before the run's first content, never a
// second) but only once per renderer instance — callers build a fresh renderer per subagent call, one
// continuous streamed generation. Never throws — a broken renderer must not abort the stream.
export function createLiveStreamRenderer(
  label: StreamLabel,
  step?: RunStep,
  sink: ProgressSink = defaultProgressSink(),
): (event: LiveStreamEvent) => void {
  const tag = step ? formatStepTag(step) : '';
  let buffer = '';
  let opened = false;

  const openSection = (): void => {
    if (opened) return;
    opened = true;
    sink.write('\n');
  };

  const writeLine = (text: string): void => {
    const clipped = clip(text);
    if (clipped.length === 0) return;
    sink.write(`${prefix(label, sink, ORANGE_BOLD, tag)} ${clipped}\n`);
  };

  const flushBuffer = (): void => {
    if (buffer.length === 0) return;
    writeLine(buffer);
    buffer = '';
  };

  return (event) => {
    try {
      if (event.type === 'text-delta') {
        if (event.text.length === 0) return;
        openSection();
        buffer += event.text;
        let newlineAt = buffer.indexOf('\n');
        while (newlineAt !== -1) {
          writeLine(buffer.slice(0, newlineAt));
          buffer = buffer.slice(newlineAt + 1);
          newlineAt = buffer.indexOf('\n');
        }
        return;
      }
      // tool-call: flush any held partial text line first so a tool line never swallows trailing
      // prose, then render the call itself immediately — before its result, not after the step.
      openSection();
      flushBuffer();
      const detail = summarizeToolInput(event.toolName, event.input);
      sink.write(
        `${prefix(label, sink, ORANGE_BOLD, tag)} Using tool: ${clip(event.toolName, SHORT_DETAIL_MAX)}${detail ? ` → ${detail}` : ''}\n`,
      );
    } catch {
      // observability must never break the run
    }
  };
}
