// A long silent model call (a slow `generate`, a stalled provider) leaves the run looking hung:
// nothing prints between one tool line and the next for minutes. The heartbeat fills that gap —
// a `still working… <elapsed>` ping once per interval OF SILENCE, suppressed the moment real
// progress resumes so it never doubles up on an already-live stream. It reads and writes through
// the same ProgressSink the progress lines use, so "was a line just emitted?" is a single
// timestamp compare (createHeartbeatSink records every write). Plain lines only — no cursor/ANSI
// rewrite — so it is safe on a piped non-TTY log exactly as on a terminal.

import {
  harnessProgress,
  labelText,
  type ProgressSink,
  type StreamLabel,
} from './step-progress.ts';

const DEFAULT_INTERVAL_MS = 60_000;

// Clock-style elapsed for the heartbeat line: `45s`, `1m0s`, `2m10s` — minutes+seconds, no decimal
// (distinct from step-progress `formatDuration`'s `7.2m`, which reads task/group totals). Negative
// or non-finite input (a clock rollback, a stubbed now) clamps to `0s`.
export function formatElapsed(ms: number): string {
  const safe = Number.isFinite(ms) && ms > 0 ? ms : 0;
  const totalSeconds = Math.floor(safe / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m${seconds}s` : `${seconds}s`;
}

// A ProgressSink that remembers when it was last written to. Every progress emitter
// (agentStepProgress, harnessProgress) and the heartbeat itself write through it, so `lastEmitMs`
// is the wall-clock of the most recent line of ANY kind — exactly the signal the heartbeat needs
// to tell silence from activity.
export type HeartbeatSink = ProgressSink & {
  lastEmitMs: () => number;
};

export function createHeartbeatSink(base: ProgressSink): HeartbeatSink {
  let lastEmitMs = base.now().getTime();
  return {
    write: (line) => {
      lastEmitMs = base.now().getTime();
      base.write(line);
    },
    color: base.color,
    now: base.now,
    lastEmitMs: () => lastEmitMs,
  };
}

// Injectable interval scheduler: run `onTick` every `intervalMs`, return a canceller. The default
// wraps the web-standard setInterval/clearInterval (portable across Bun/Node/Deno); tests pass a
// fake that captures the tick and fires it against a controlled clock.
export type ScheduleInterval = (onTick: () => void, intervalMs: number) => () => void;

const defaultSchedule: ScheduleInterval = (onTick, intervalMs) => {
  const handle = setInterval(onTick, intervalMs);
  return () => clearInterval(handle);
};

export type HeartbeatOptions = {
  intervalMs?: number;
  schedule?: ScheduleInterval;
};

// Start a liveliness heartbeat for a subagent call. Returns an idempotent stop function — the
// adapter calls it in the `finally` around each `generate`. Emits
// `[aitm …] <label>: still working… <elapsed>` only once a full interval has passed with no line
// written; otherwise stays quiet and lets the live stream speak for itself.
export function startHeartbeat(
  label: StreamLabel,
  sink: HeartbeatSink,
  options: HeartbeatOptions = {},
): () => void {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const schedule = options.schedule ?? defaultSchedule;
  const startMs = sink.now().getTime();

  const tick = (): void => {
    try {
      const nowMs = sink.now().getTime();
      if (nowMs - sink.lastEmitMs() < intervalMs) return;
      harnessProgress(
        `${labelText(label)}: still working… ${formatElapsed(nowMs - startMs)}`,
        undefined,
        sink,
      );
    } catch {
      // observability must never break the run
    }
  };

  const cancel = schedule(tick, intervalMs);
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    cancel();
  };
}
