// Live run output, mirroring claude-task-master's console contract: a cyan `[aitm HH:MM:SS]`
// prefix for orchestrator/harness messages (stage transitions, PRs opened, fix passes) and an
// orange `[<agent> HH:MM:SS]` prefix for what each subagent is doing — its text and every tool
// call (`Using tool: bash → git status`). Streams to stderr so stdout stays reserved for plain
// status/results (Logger contract). Fixes the silent-run gap: `aitm start` printed nothing
// between the banner and the usage summary.
//
// The step handler reads ONLY the per-step fields of the AI SDK's StepResult (`text`,
// `toolCalls`) — never the cumulative `response.messages` — so one handler is safe to share
// across the Worker's parallel editor fanout, unlike the transcript recorder's delta slicing
// (issue #175).

import { basename, isAbsolute, relative } from 'node:path';

const DETAIL_MAX = 250;
const SHORT_DETAIL_MAX = 120;
const REASONING_MAX = 200;

const CYAN_BOLD = '\x1b[36m\x1b[1m';
const ORANGE_BOLD = '\x1b[38;5;208m\x1b[1m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

// Structural slice of the SDK's StepResult that progress rendering needs. Kept structural so the
// same handler satisfies both ToolLoopAgent's `onStepFinish` and generateText's.
export type StepProgressEvent = {
  text?: string;
  toolCalls?: ReadonlyArray<{ toolName: string; input: unknown }>;
  // The model's chain-of-thought for this step, when the provider surfaces one. Optional: most
  // steps and most models never set it.
  reasoningText?: string | undefined;
};

// The STATE + STEP a line is reported under (claudetm parity): a phase word (`working`, `pr-open`,
// `ci-fix`, …) and an `index/total` step counter, both optional. Composed into a compact tag that
// rides inside the timestamp bracket. All fields undefined → empty tag → today's format, byte-for-byte.
export type RunStep = {
  phase?: string;
  // Counter label — `group`/`task`. Prefixes the counter (`group 2/5`); omitted → bare `2/5`.
  unit?: string;
  index?: number;
  total?: number;
};

// Human-scale elapsed time for task/group timing lines (claudetm console parity): sub-minute spans
// read as seconds (`42.3s`), everything else as minutes (`7.2m`) — one significant decimal, no
// hour bucket (a run this long is already an outlier worth a raw number, not a new unit). Negative
// or non-finite input (a clock rollback, a stubbed `now()`) clamps to `0.0s` rather than printing
// garbage.
export function formatDuration(ms: number): string {
  const clamped = Number.isFinite(ms) && ms > 0 ? ms : 0;
  const totalSeconds = clamped / 1000;
  if (totalSeconds < 60) return `${totalSeconds.toFixed(1)}s`;
  return `${(totalSeconds / 60).toFixed(1)}m`;
}

// Render a RunStep as the in-bracket tag: `<unit N/M> <phase>`, e.g. `group 2/5 working`,
// `task 3/38 ci-fix`, or just `planning` when there is no counter yet. Empty string when nothing is
// known, so the prefix falls back to the plain `[label HH:MM:SS]` form.
export function formatStepTag(step: RunStep): string {
  const parts: string[] = [];
  if (step.index !== undefined && step.total !== undefined && step.total > 0) {
    const counter = `${step.index}/${step.total}`;
    parts.push(step.unit ? `${step.unit} ${counter}` : counter);
  }
  if (step.phase) parts.push(step.phase);
  return parts.join(' ');
}

// Every stream line repeats this label, so it stays short: the group/task context is capped
// rather than spelled out — callers print the full group slug once via `harnessProgress` on
// group start, then pass a short `g<N>`-style ctx (or whatever they have) for every line after.
const CTX_MAX = 24;

// Compose a per-agent stream-line label: model, then the subagent's name — a routed domain
// specialist's name when one was picked, else the bare role, else `role:<basename>` for a
// per-file editor fanout (05 spawns one editor per file and needs to tell them apart) — then
// optional context (the group id), capped so a long slug can't blow up every line. No specialist,
// no file → `k3 worker g1` (today's label, unchanged).
export function agentLabel(input: {
  model: string;
  role: string;
  specialist?: string;
  file?: string;
  ctx?: string;
}): string {
  const name = input.file
    ? `${input.role}:${basename(input.file)}`
    : (input.specialist ?? input.role);
  const ctx = input.ctx ? clip(input.ctx, CTX_MAX) : undefined;
  return ctx ? `${input.model} ${name} ${ctx}` : `${input.model} ${name}`;
}

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

function defaultSink(): ProgressSink {
  return defaultProgressSink();
}

function bracket(label: string, sink: ProgressSink, tag: string): string {
  const t = sink.now();
  const hh = String(t.getHours()).padStart(2, '0');
  const mm = String(t.getMinutes()).padStart(2, '0');
  const ss = String(t.getSeconds()).padStart(2, '0');
  return tag ? `[${label} ${hh}:${mm}:${ss} ${tag}]` : `[${label} ${hh}:${mm}:${ss}]`;
}

function prefix(label: string, sink: ProgressSink, colorCode: string, tag = ''): string {
  const body = bracket(label, sink, tag);
  return sink.color ? `${colorCode}${body}${RESET}` : body;
}

// The reasoning line rides the same bracket as tool/text lines but dims the WHOLE line — bracket
// included — so it reads as background chatter next to the orange work lines, not another one.
function dimLine(label: string, sink: ProgressSink, tag: string, message: string): string {
  const body = `${bracket(label, sink, tag)} ${message}`;
  return sink.color ? `${DIM}${body}${RESET}\n` : `${body}\n`;
}

// Model text and tool inputs are attacker-influenced strings, and every one of them reaches stderr
// under a colored `[aitm …]`/`[<agent> …]` prefix. Left raw they could carry ANSI escapes (recolor
// a forged line to impersonate the cyan harness prefix) or C0/C1 controls (CR/BS to overwrite what
// was printed, ESC/BEL to drive the operator's terminal). Strip both before any emit so untrusted
// text can neither spoof a harness line nor manipulate the terminal.
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control bytes is the intent.
const ANSI_ESCAPE = /\x1b[[\]()#;?]*(?:\d{1,4}(?:;\d{0,4})*)?[@-~]/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control bytes is the intent.
const CONTROL_CHARS = /[\x00-\x1f\x7f-\x9f]/g;

function stripControl(s: string): string {
  return s.replace(ANSI_ESCAPE, '').replace(CONTROL_CHARS, '');
}

function clip(s: string, max = DETAIL_MAX): string {
  const flat = stripControl(s.replace(/\s*\n\s*/g, ' ⏎ ')).trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

// Ordered probe keys for the one-line tool-input detail: every present string-valued key joins the
// detail, covering the compat/local tool shapes (bash.command, file tools' path, grep/glob
// pattern, webFetch url, explore prompt, github action…). Unknown shapes fall back to compact JSON.
const DETAIL_KEYS = [
  'command',
  'file_path',
  'path',
  'pattern',
  'query',
  'url',
  'action',
  'name',
  'prompt',
] as const;

// The agent prefix leads with the MODEL doing the work (claudetm shows `[claude]`; aitm routes via
// OpenRouter, so the model varies per role): strip the provider org and any `:variant` suffix from
// an OpenRouter id — `z-ai/glm-4.7:exacto` → `glm-4.7`. Unparseable ids pass through clipped.
export function shortModelName(modelId: string): string {
  const base = modelId.split('/').pop() ?? modelId;
  const noVariant = base.split(':')[0] ?? base;
  return clip(noVariant === '' ? modelId : noVariant, 40);
}

// Keys that hold a filesystem path: rewritten cwd-relative (claudetm `_relative_path`) so a line
// reads `src/a.ts`, not the checkout's full absolute path. `pattern` shares the short cap below
// but isn't a path (grep/glob patterns aren't relative-izable), so it's excluded here.
const PATH_KEYS = new Set(['file_path', 'path']);

// Keys short enough that a long value is more noise than signal on a one-line stream — capped
// tighter than `command`, which is the whole point of the line.
const SHORT_DETAIL_KEYS = new Set(['file_path', 'path', 'pattern']);

function relativizePath(value: string): string {
  if (!isAbsolute(value)) return value;
  const rel = relative(process.cwd(), value);
  return rel === '' ? '.' : rel;
}

// One-line, length-capped rendering of a tool call's input.
export function summarizeToolInput(toolName: string, input: unknown): string {
  if (typeof input === 'string') return clip(input);
  if (input === null || typeof input !== 'object') return clip(String(input ?? ''));
  const record = input as Record<string, unknown>;
  if (toolName === 'multiBash' && Array.isArray(record.commands)) {
    return clip(record.commands.map(String).join(' && '));
  }
  const parts: string[] = [];
  for (const key of DETAIL_KEYS) {
    const value = record[key];
    if (typeof value !== 'string' || value.trim() === '') continue;
    const resolved = PATH_KEYS.has(key) ? relativizePath(value) : value;
    parts.push(SHORT_DETAIL_KEYS.has(key) ? clip(resolved, SHORT_DETAIL_MAX) : resolved);
  }
  if (parts.length > 0) return clip(parts.join(' '));
  try {
    return clip(JSON.stringify(record));
  } catch {
    return '[unserializable input]';
  }
}

// Render one finished agent step: reasoning, then its text response, then one `Using tool:` line
// per call — each section (claudetm `agent_message.py:63-66` pattern) opens with a blank line so
// a fast-moving stream still reads as distinct chunks. `blank` is idempotent: back-to-back
// sections (e.g. reasoning immediately followed by text) never produce two blanks in a row.
export function renderStepLines(
  label: string,
  event: StepProgressEvent,
  sink: ProgressSink,
  step?: RunStep,
): string[] {
  const tag = step ? formatStepTag(step) : '';
  const lines: string[] = [];
  const blank = (): void => {
    if (lines[lines.length - 1] !== '\n') lines.push('\n');
  };

  const reasoning = event.reasoningText?.trim();
  if (reasoning) {
    blank();
    lines.push(dimLine(label, sink, tag, `thinking: ${clip(reasoning, REASONING_MAX)}`));
  }

  const text = event.text?.trim();
  if (text) {
    blank();
    lines.push(`${prefix(label, sink, ORANGE_BOLD, tag)} ${clip(text)}\n`);
  }

  const toolCalls = event.toolCalls ?? [];
  if (toolCalls.length > 0) blank();
  for (const call of toolCalls) {
    const detail = summarizeToolInput(call.toolName, call.input);
    lines.push(
      `${prefix(label, sink, ORANGE_BOLD, tag)} Using tool: ${call.toolName}${detail ? ` → ${detail}` : ''}\n`,
    );
  }
  return lines;
}

// An onStepFinish-compatible handler that streams an agent's activity under its own prefix.
// Never throws — progress must never break a run. `textAndTools: false` (slice 07) renders ONLY the
// reasoning line and drops text/toolCalls — for a streaming run, where createLiveStreamRenderer
// already printed that step's text and tool-call lines live as they arrived; rendering them again
// here at step-finish would duplicate every line. Reasoning has no live equivalent (the streamed
// funnel forwards text-delta/tool-call only), so it still renders at step-finish either way.
export function agentStepProgress(
  label: string,
  step?: RunStep,
  sink: ProgressSink = defaultSink(),
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
  label: string,
  step?: RunStep,
  sink: ProgressSink = defaultSink(),
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
        `${prefix(label, sink, ORANGE_BOLD, tag)} Using tool: ${event.toolName}${detail ? ` → ${detail}` : ''}\n`,
      );
    } catch {
      // observability must never break the run
    }
  };
}

// One cyan orchestrator line: what the harness is doing to drive/keep the agents in check
// (stage starts, PR numbers, fix passes, retries). The optional RunStep stamps the phase + N/M
// step into the bracket so every harness line names the state and position the run is on.
export function harnessProgress(
  message: string,
  step?: RunStep,
  sink: ProgressSink = defaultSink(),
): void {
  try {
    const tag = step ? formatStepTag(step) : '';
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
