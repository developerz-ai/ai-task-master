// Pure string-formatting for progress lines: durations, tags, labels, tool-input summaries, and
// the finished-step line renderer. No I/O — every function here takes data (and a ProgressSink
// only to read its clock/color, never to write) and returns a string. Output side (writing lines
// somewhere) lives in step-progress-sink.ts; the live-stream path lives in step-progress-renderer.ts.

import { basename, isAbsolute, relative } from 'node:path';
import { scrubSecrets } from '../logger/secret-scrubber.ts';
import type { ProgressSink } from './step-progress-sink.ts';

const DETAIL_MAX = 250;
export const SHORT_DETAIL_MAX = 120;
const REASONING_MAX = 200;

export const CYAN_BOLD = '\x1b[36m\x1b[1m';
export const ORANGE_BOLD = '\x1b[38;5;208m\x1b[1m';
const BLUE_BOLD = '\x1b[34m\x1b[1m';
export const GREEN_BOLD = '\x1b[32m\x1b[1m';
const MAGENTA = '\x1b[35m';
const DIM = '\x1b[2m';
export const RESET = '\x1b[0m';

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

// A stream-line label: either a plain string (harness lines, older callers — rendered as-is) or
// the structured per-agent form whose segments the bracket colors independently (subagent name
// blue, so parallel fan-out streams are tellable-apart at a glance). `text` is the exact string
// the un-structured label used to be, so anything that needs a flat form (heartbeat messages,
// tests, non-TTY sinks) reads identically to before.
export type AgentLabel = { model: string; name: string; ctx?: string; text: string };
export type StreamLabel = string | AgentLabel;

export function labelText(label: StreamLabel): string {
  return typeof label === 'string' ? label : label.text;
}

// Compose a per-agent stream-line label: model, then the subagent's name — a routed domain
// specialist's name when one was picked, else the bare role, else `role:<basename>` for a
// per-file editor fanout (05 spawns one editor per file and needs to tell them apart) — then
// optional context (the group id), capped so a long slug can't blow up every line. No specialist,
// no file → text `k3 worker g1` (today's label, unchanged).
export function agentLabel(input: {
  model: string;
  role: string;
  specialist?: string;
  file?: string;
  ctx?: string;
}): AgentLabel {
  const name = input.file
    ? `${input.role}:${basename(input.file)}`
    : (input.specialist ?? input.role);
  const ctx = input.ctx ? clip(input.ctx, CTX_MAX) : undefined;
  const text = ctx ? `${input.model} ${name} ${ctx}` : `${input.model} ${name}`;
  return ctx ? { model: input.model, name, ctx, text } : { model: input.model, name, text };
}

// The bracket, segment by segment: `[<model> <name> <ctx> <tag> <time>]` — the subagent name in
// blue, the state tag in magenta, the timestamp dim at the END so the leading columns are the
// stable who/where and the clock stays out of the way. `outer` is the resume color re-applied
// after each inner segment (a bare RESET would cancel the enclosing prefix color mid-bracket);
// null → no inner coloring (non-TTY sinks, dim reasoning lines that must stay uniformly dim).
function bracket(
  label: StreamLabel,
  sink: ProgressSink,
  tag: string,
  outer: string | null,
): string {
  const t = sink.now();
  const hh = String(t.getHours()).padStart(2, '0');
  const mm = String(t.getMinutes()).padStart(2, '0');
  const ss = String(t.getSeconds()).padStart(2, '0');
  const time = `${hh}:${mm}:${ss}`;
  const paint = (code: string, s: string): string =>
    outer === null ? s : `${code}${s}${RESET}${outer}`;
  const who =
    typeof label === 'string'
      ? label
      : `${label.model} ${paint(BLUE_BOLD, label.name)}${label.ctx ? ` ${label.ctx}` : ''}`;
  const parts = [who, ...(tag ? [paint(MAGENTA, tag)] : []), paint(DIM, time)];
  return `[${parts.join(' ')}]`;
}

export function prefix(
  label: StreamLabel,
  sink: ProgressSink,
  colorCode: string,
  tag = '',
): string {
  if (!sink.color) return bracket(label, sink, tag, null);
  return `${colorCode}${bracket(label, sink, tag, colorCode)}${RESET}`;
}

// The reasoning line rides the same bracket as tool/text lines but dims the WHOLE line — bracket
// included, inner segment colors suppressed — so it reads as background chatter next to the
// orange work lines, not another one.
function dimLine(label: StreamLabel, sink: ProgressSink, tag: string, message: string): string {
  const body = `${bracket(label, sink, tag, null)} ${message}`;
  return sink.color ? `${DIM}${body}${RESET}\n` : `${body}\n`;
}

// Model text and tool inputs are attacker-influenced strings, and every one of them reaches stderr
// under a colored `[aitm …]`/`[<agent> …]` prefix. Left raw they could carry ANSI escapes (recolor
// a forged line to impersonate the cyan harness prefix) or C0/C1 controls (CR/BS to overwrite what
// was printed, ESC/BEL to drive the operator's terminal). Strip both before any emit so untrusted
// text can neither spoof a harness line nor manipulate the terminal. They also carry CREDENTIALS —
// a `bash` step running `curl -H "Authorization: Bearer sk-…"` puts the key straight on the
// operator's terminal and into CI logs — so `clip` scrubs secret-shaped substrings too.
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control bytes is the intent.
const ANSI_ESCAPE = /\x1b[[\]()#;?]*(?:\d{1,4}(?:;\d{0,4})*)?[@-~]/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control bytes is the intent.
const CONTROL_CHARS = /[\x00-\x1f\x7f-\x9f]/g;

function stripControl(s: string): string {
  return s.replace(ANSI_ESCAPE, '').replace(CONTROL_CHARS, '');
}

// The single chokepoint every emitted fragment passes through — text, reasoning, tool detail,
// harness messages, labels — so scrubbing here covers the whole stream. Order is load-bearing:
// control bytes go first (a `\x00` planted mid-token would otherwise hide the secret from the
// scrubber, then vanish before printing), and truncation goes LAST (clipping first could cut a
// token below the scrubber's minimum length and leak the surviving prefix).
export function clip(s: string, max = DETAIL_MAX): string {
  const flat = scrubSecrets(stripControl(s.replace(/\s*\n\s*/g, ' ⏎ '))).trim();
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
  label: StreamLabel,
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
      `${prefix(label, sink, ORANGE_BOLD, tag)} Using tool: ${clip(call.toolName, SHORT_DETAIL_MAX)}${detail ? ` → ${detail}` : ''}\n`,
    );
  }
  return lines;
}
