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

const DETAIL_MAX = 250;

const CYAN_BOLD = '\x1b[36m\x1b[1m';
const ORANGE_BOLD = '\x1b[38;5;208m\x1b[1m';
const RESET = '\x1b[0m';

// Structural slice of the SDK's StepResult that progress rendering needs. Kept structural so the
// same handler satisfies both ToolLoopAgent's `onStepFinish` and generateText's.
export type StepProgressEvent = {
  text?: string;
  toolCalls?: ReadonlyArray<{ toolName: string; input: unknown }>;
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

// Compose a per-agent stream-line label: model, then the subagent's name — a routed domain
// specialist's name when one was picked, else the bare role — then optional context (the group id).
// Single source of truth for the specialist-else-role choice so the worker/reviewer/ci-fix call
// sites don't each hand-roll it. No specialist → `k3 worker g1` (today's label, unchanged).
export function agentLabel(input: {
  model: string;
  role: string;
  specialist?: string;
  ctx?: string;
}): string {
  const name = input.specialist ?? input.role;
  return input.ctx ? `${input.model} ${name} ${input.ctx}` : `${input.model} ${name}`;
}

// Output seam: where lines go, whether ANSI color is applied, and the clock. Injectable for tests;
// production call sites omit it and get stderr + TTY-gated color + wall clock.
export type ProgressSink = {
  write: (line: string) => void;
  color: boolean;
  now: () => Date;
};

function defaultSink(): ProgressSink {
  return {
    write: (line) => process.stderr.write(line),
    color: process.stderr.isTTY === true && process.env.NO_COLOR === undefined,
    now: () => new Date(),
  };
}

function prefix(label: string, sink: ProgressSink, colorCode: string, tag = ''): string {
  const t = sink.now();
  const hh = String(t.getHours()).padStart(2, '0');
  const mm = String(t.getMinutes()).padStart(2, '0');
  const ss = String(t.getSeconds()).padStart(2, '0');
  const body = tag ? `[${label} ${hh}:${mm}:${ss} ${tag}]` : `[${label} ${hh}:${mm}:${ss}]`;
  return sink.color ? `${colorCode}${body}${RESET}` : body;
}

function clip(s: string, max = DETAIL_MAX): string {
  const flat = s.replace(/\s*\n\s*/g, ' ⏎ ').trim();
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
    if (typeof value === 'string' && value.trim() !== '') parts.push(value);
  }
  if (parts.length > 0) return clip(parts.join(' '));
  try {
    return clip(JSON.stringify(record));
  } catch {
    return '[unserializable input]';
  }
}

// Render one finished agent step: its text response, then one `Using tool:` line per call.
export function renderStepLines(
  label: string,
  event: StepProgressEvent,
  sink: ProgressSink,
  step?: RunStep,
): string[] {
  const tag = step ? formatStepTag(step) : '';
  const lines: string[] = [];
  const text = event.text?.trim();
  if (text) lines.push(`${prefix(label, sink, ORANGE_BOLD, tag)} ${clip(text)}\n`);
  for (const call of event.toolCalls ?? []) {
    const detail = summarizeToolInput(call.toolName, call.input);
    lines.push(
      `${prefix(label, sink, ORANGE_BOLD, tag)} Using tool: ${call.toolName}${detail ? ` → ${detail}` : ''}\n`,
    );
  }
  return lines;
}

// An onStepFinish-compatible handler that streams an agent's activity under its own prefix.
// Never throws — progress must never break a run.
export function agentStepProgress(
  label: string,
  step?: RunStep,
  sink: ProgressSink = defaultSink(),
): (event: StepProgressEvent) => void {
  return (event) => {
    try {
      for (const line of renderStepLines(label, event, sink, step)) sink.write(line);
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
