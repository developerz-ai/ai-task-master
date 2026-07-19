import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createHeartbeatSink,
  formatElapsed,
  type ScheduleInterval,
  startHeartbeat,
} from './heartbeat.ts';
import type { ProgressSink } from './step-progress.ts';

// Fake wall clock: getTime() advances by whole seconds from a fixed local base, so both the elapsed
// math (getTime diffs) and the rendered bracket HH:MM:SS stay deterministic across timezones.
const BASE_MS = new Date(2026, 0, 2, 3, 4, 5).getTime();

function fakeClock(): { now: () => Date; set: (offsetMs: number) => void } {
  let offset = 0;
  return {
    now: () => new Date(BASE_MS + offset),
    set: (offsetMs) => {
      offset = offsetMs;
    },
  };
}

// One test rig: a controllable clock, a captured tick, a cancel counter, and a HeartbeatSink whose
// writes land in `lines` (so we can read both real progress lines and heartbeat lines back).
function harness(opts: { color?: boolean; write?: (line: string) => void } = {}): {
  lines: string[];
  clock: ReturnType<typeof fakeClock>;
  sink: ReturnType<typeof createHeartbeatSink>;
  schedule: ScheduleInterval;
  tick: () => void;
  cancelled: () => number;
} {
  const lines: string[] = [];
  const clock = fakeClock();
  const base: ProgressSink = {
    write: opts.write ?? ((line) => lines.push(line)),
    color: opts.color ?? false,
    now: clock.now,
  };
  const sink = createHeartbeatSink(base);
  let tickFn: (() => void) | undefined;
  let cancelled = 0;
  const schedule: ScheduleInterval = (fn) => {
    tickFn = fn;
    return () => {
      cancelled += 1;
    };
  };
  return { lines, clock, sink, schedule, tick: () => tickFn?.(), cancelled: () => cancelled };
}

test('heartbeat: formatElapsed renders clock-style m/s, clamping bad input', () => {
  assert.equal(formatElapsed(45_000), '45s');
  assert.equal(formatElapsed(60_000), '1m0s');
  assert.equal(formatElapsed(130_000), '2m10s');
  assert.equal(formatElapsed(0), '0s');
  assert.equal(formatElapsed(-500), '0s');
  assert.equal(formatElapsed(Number.NaN), '0s');
});

test('heartbeat: createHeartbeatSink forwards writes and records the emit time', () => {
  const written: string[] = [];
  const clock = fakeClock();
  const sink = createHeartbeatSink({ write: (l) => written.push(l), color: false, now: clock.now });
  assert.equal(sink.lastEmitMs(), BASE_MS);
  clock.set(5_000);
  sink.write('hello\n');
  assert.deepEqual(written, ['hello\n']);
  assert.equal(sink.lastEmitMs(), BASE_MS + 5_000);
});

test('heartbeat: fires a still-working line each interval of silence', () => {
  const h = harness();
  const stop = startHeartbeat('worker g1', h.sink, { intervalMs: 60_000, schedule: h.schedule });

  h.clock.set(60_000);
  h.tick();
  h.clock.set(120_000);
  h.tick();

  assert.equal(h.lines.length, 2);
  assert.ok(h.lines[0]?.startsWith('[aitm '));
  assert.ok(h.lines[0]?.endsWith('worker g1: still working… 1m0s\n'));
  assert.ok(h.lines[1]?.endsWith('worker g1: still working… 2m0s\n'));
  stop();
});

test('heartbeat: stays silent while progress keeps the stream alive, then resumes', () => {
  const h = harness();
  const stop = startHeartbeat('worker g1', h.sink, { intervalMs: 60_000, schedule: h.schedule });

  // A real progress line lands 30s in — the stream is alive.
  h.clock.set(30_000);
  h.sink.write('[worker g1 03:04:35] Using tool: bash → git status\n');

  // Tick at 60s: only 30s since the last line → no heartbeat.
  h.clock.set(60_000);
  h.tick();
  assert.equal(h.lines.filter((l) => l.includes('still working')).length, 0);

  // Then silence: tick at 120s (90s since that line) → heartbeat resumes.
  h.clock.set(120_000);
  h.tick();
  const beats = h.lines.filter((l) => l.includes('still working'));
  assert.equal(beats.length, 1);
  assert.ok(beats[0]?.endsWith('worker g1: still working… 2m0s\n'));
  stop();
});

test('heartbeat: stop cancels the timer and is idempotent', () => {
  const h = harness();
  const stop = startHeartbeat('worker g1', h.sink, { intervalMs: 60_000, schedule: h.schedule });
  stop();
  stop();
  assert.equal(h.cancelled(), 1);
});

test('heartbeat: writes a plain line on a non-TTY sink, cyan-prefixed on a TTY', () => {
  const plain = harness({ color: false });
  startHeartbeat('worker g1', plain.sink, { intervalMs: 60_000, schedule: plain.schedule });
  plain.clock.set(60_000);
  plain.tick();
  assert.ok(!plain.lines[0]?.includes('\x1b'));
  assert.ok(plain.lines[0]?.startsWith('[aitm '));

  const tty = harness({ color: true });
  startHeartbeat('worker g1', tty.sink, { intervalMs: 60_000, schedule: tty.schedule });
  tty.clock.set(60_000);
  tty.tick();
  assert.ok(tty.lines[0]?.startsWith('\x1b[36m\x1b[1m[aitm '));
  assert.ok(tty.lines[0]?.includes('still working… 1m0s'));
});

test('heartbeat: a throwing sink never breaks the tick', () => {
  const h = harness({
    write: () => {
      throw new Error('sink died');
    },
  });
  startHeartbeat('worker g1', h.sink, { intervalMs: 60_000, schedule: h.schedule });
  h.clock.set(60_000);
  assert.doesNotThrow(() => h.tick());
});
