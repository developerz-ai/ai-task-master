// PreToolUse / PostToolUse shell hooks on a tool registry (issue #121). `withHooks` decorates each
// tool's execute with matching hook commands: a PreToolUse hook can block (exit 2), rewrite the input
// (stdout JSON), or fail open; a PostToolUse hook surfaces stdout to the model as feedback. Hooks are
// the programmable governance escape hatch above the declarative command-rule engine (#113).
//
// A hook can never crash or hang the run: a non-2 non-zero exit, spawn failure, or timeout all
// fail open with a warning. Hook commands run with the operator's privileges — callers must source
// them only from operator-owned config, never from the worked-on repo (that would be arbitrary
// code execution by repo content).

import type { Tool, ToolSet } from 'ai';
import { execa } from 'execa';

// The subprocess seam a hook runs through. Narrower than execa's overloaded signature so a test can
// supply a plain fake without casting; the real execa satisfies it structurally.
export type HookExec = (
  command: string,
  options: { shell: true; input: string; timeout: number; cwd?: string; reject: false },
) => Promise<{ exitCode?: number; stdout?: unknown; stderr?: unknown; timedOut?: boolean }>;

const defaultExec: HookExec = (command, options) => execa(command, options);

export type HookSpec = {
  // Glob (`*` wildcard) on the registered tool name; omitted → matches every tool.
  matcher?: string;
  // Shell command run for the hook. Receives the event JSON on stdin.
  command: string;
  // Per-hook timeout (default DEFAULT_HOOK_TIMEOUT_MS). On timeout the hook fails open.
  timeoutMs?: number;
};

export type ToolHooks = {
  preToolUse?: HookSpec[];
  postToolUse?: HookSpec[];
};

export type WithHooksInit = {
  // cwd the hook commands run in and that is reported in the event payload.
  cwd?: string;
  // Warning sink for fail-open events (spawn failure, timeout, discarded rewrite). Defaults to stderr.
  onWarn?: (message: string) => void;
  // Test seam — swap out execa without spawning a real process.
  exec?: HookExec;
};

export const DEFAULT_HOOK_TIMEOUT_MS = 30_000;

// Cap on PostToolUse stdout surfaced to the model, so a noisy hook can't bloat every tool result and
// push the agent over its context window. Output past this is truncated with a marker.
export const MAX_HOOK_FEEDBACK_CHARS = 4_000;
const HOOK_FEEDBACK_TRUNCATION_MARKER = '\n[hook output truncated]';

// The bash-family tools whose blocked result must take the #113 BashOutput shape (exit 126). Every
// other tool gets the generic blocked-result object.
const BASH_TOOL_NAMES = new Set(['bash', 'multiBash']);

// The shape returned to the model when a non-bash tool call is blocked by a PreToolUse hook.
export type HookBlockedResult = { ok: false; blockedByHook: true; reason: string };

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Glob match with a single `*` wildcard on the tool name.
export function hookMatches(matcher: string | undefined, toolName: string): boolean {
  if (matcher === undefined || matcher === '*') return true;
  const pattern = matcher.split('*').map(escapeRegExp).join('.*');
  return new RegExp(`^${pattern}$`).test(toolName);
}

type HookOutcome =
  | { kind: 'proceed' }
  | { kind: 'block'; stderr: string }
  | { kind: 'rewrite'; input: unknown }
  | { kind: 'feedback'; stdout: string };

function bashBlocked(stderr: string): {
  stdout: string;
  stderr: string;
  exitCode: number;
  denied: true;
} {
  return { stdout: '', stderr, exitCode: 126, denied: true };
}

function blockFramed(stderr: string): string {
  const detail = stderr.trim();
  const suffix = detail ? ` ${detail}` : '';
  return `blocked by a PreToolUse hook.${suffix} Adjust your approach — do not retry the same call.`;
}

// Run one hook command, translating its exit code into an outcome. Any failure mode that isn't a
// clean block (exit 2) or a clean proceed (exit 0) is treated as proceed (fail-open) with a warning.
async function runHook(
  hook: HookSpec,
  payload: Record<string, unknown>,
  init: Required<Pick<WithHooksInit, 'onWarn'>> & { cwd?: string; exec: HookExec },
  isPost: boolean,
): Promise<HookOutcome> {
  try {
    const result = await init.exec(hook.command, {
      shell: true,
      input: JSON.stringify(payload),
      timeout: hook.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS,
      ...(init.cwd ? { cwd: init.cwd } : {}),
      reject: false,
    });
    const exitCode = result.exitCode ?? 1;
    const stdout = typeof result.stdout === 'string' ? result.stdout : '';
    const stderr = typeof result.stderr === 'string' ? result.stderr : '';
    if (result.timedOut) {
      init.onWarn(`hook \`${hook.command}\` timed out — proceeding (fail-open)`);
      return { kind: 'proceed' };
    }
    if (isPost) {
      // Fail open: a non-zero post-hook's (partial/error) output must not reach the model.
      if (exitCode !== 0) {
        init.onWarn(
          `PostToolUse hook \`${hook.command}\` exited ${exitCode} — ignoring its output`,
        );
        return { kind: 'proceed' };
      }
      const trimmed = stdout.trim();
      if (trimmed === '') return { kind: 'proceed' };
      if (trimmed.length > MAX_HOOK_FEEDBACK_CHARS) {
        init.onWarn(
          `PostToolUse hook \`${hook.command}\` emitted ${trimmed.length} chars — truncated to ${MAX_HOOK_FEEDBACK_CHARS}`,
        );
        return {
          kind: 'feedback',
          stdout: trimmed.slice(0, MAX_HOOK_FEEDBACK_CHARS) + HOOK_FEEDBACK_TRUNCATION_MARKER,
        };
      }
      return { kind: 'feedback', stdout: trimmed };
    }
    if (exitCode === 2) return { kind: 'block', stderr };
    if (exitCode === 0) {
      const rewrite = parseRewrite(stdout);
      return rewrite !== undefined ? { kind: 'rewrite', input: rewrite } : { kind: 'proceed' };
    }
    init.onWarn(`PreToolUse hook \`${hook.command}\` exited ${exitCode} — proceeding (fail-open)`);
    return { kind: 'proceed' };
  } catch (err) {
    init.onWarn(
      `hook \`${hook.command}\` failed to run (${err instanceof Error ? err.message : String(err)}) — proceeding (fail-open)`,
    );
    return { kind: 'proceed' };
  }
}

// A PreToolUse hook that exits 0 may emit `{ "input": <value> }` to rewrite the tool input. Anything
// that isn't such an object leaves the input unchanged.
function parseRewrite(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (trimmed === '') return undefined;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object' && 'input' in parsed) {
      return (parsed as { input: unknown }).input;
    }
  } catch {
    // non-JSON stdout on a proceed is ignored
  }
  return undefined;
}

// Validate a rewritten input against the tool's own schema when one is exposed; a rewrite that fails
// the schema is discarded (caller keeps the original). Tools built with the AI SDK carry a Zod
// schema whose safeParse we can reach; if none is present we accept the rewrite as-is.
function validateRewrite(tool: Tool, input: unknown): { ok: true; value: unknown } | { ok: false } {
  const schema = (
    tool as { inputSchema?: { safeParse?: (v: unknown) => { success: boolean; data?: unknown } } }
  ).inputSchema;
  if (!schema || typeof schema.safeParse !== 'function') return { ok: true, value: input };
  const parsed = schema.safeParse(input);
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false };
}

// Attach PostToolUse stdout to a tool result: appended for string results, an additive `hookFeedback`
// field for object results, left untouched for anything else.
function applyFeedback(result: unknown, feedback: string[]): unknown {
  const block = feedback.join('\n\n');
  if (typeof result === 'string') return `${result}\n\n<hook-feedback>\n${block}\n</hook-feedback>`;
  if (result && typeof result === 'object') return { ...result, hookFeedback: block };
  return result;
}

// The model-visible output union a tool's `toModelOutput` may return (text / json / error / content).
type ModelOutput = Awaited<ReturnType<NonNullable<Tool['toModelOutput']>>>;
type ModelOutputCtx = { toolCallId: string; input: unknown; output: unknown };

function isBlockedResult(out: unknown): out is HookBlockedResult {
  return (
    typeof out === 'object' &&
    out !== null &&
    (out as { blockedByHook?: unknown }).blockedByHook === true &&
    typeof (out as { reason?: unknown }).reason === 'string'
  );
}

// PostToolUse feedback that applyFeedback attached to an OBJECT result as an additive `hookFeedback`
// field (string results already carry it inline in the string). undefined when absent.
function objectHookFeedback(out: unknown): string | undefined {
  if (typeof out === 'object' && out !== null && 'hookFeedback' in out) {
    const feedback = (out as { hookFeedback?: unknown }).hookFeedback;
    if (typeof feedback === 'string') return feedback;
  }
  return undefined;
}

// The base rendering the SDK would show — the tool's own toModelOutput, or the SDK default (text for
// a string result, json otherwise). Mirrors withReminders' baseModelOutput; may be async.
async function baseModelOutput(
  base: NonNullable<Tool['toModelOutput']> | undefined,
  ctx: ModelOutputCtx,
): Promise<ModelOutput> {
  if (base) return await base(ctx);
  if (typeof ctx.output === 'string') return { type: 'text', value: ctx.output };
  // Strip the hook-injected `hookFeedback` field before the default json render, or a tool with no
  // custom toModelOutput would echo the feedback inside the json blob AND again in the appended
  // <hook-feedback> section — the model would see it twice (issue #180). The real tool output is
  // preserved; custom-renderer tools (which never read hookFeedback) are unaffected.
  const value = stripHookFeedback(ctx.output);
  return {
    type: 'json',
    value: (value ?? null) as Extract<ModelOutput, { type: 'json' }>['value'],
  };
}

function stripHookFeedback(output: unknown): unknown {
  if (typeof output === 'object' && output !== null && 'hookFeedback' in output) {
    return Object.fromEntries(
      Object.entries(output as Record<string, unknown>).filter(([key]) => key !== 'hookFeedback'),
    );
  }
  return output;
}

// Append a `<hook-feedback>` section after the base output (issue #180). A text base stays text; any
// other base becomes the `content` variant with the base as a text part followed by the section, so
// the base output always comes first. Parallels withReminders' appendReminders (a different envelope).
function appendHookFeedback(base: ModelOutput, feedback: string): ModelOutput {
  const section = `<hook-feedback>\n${feedback}\n</hook-feedback>`;
  if (base.type === 'text') return { type: 'text', value: `${base.value}\n\n${section}` };
  const baseParts =
    base.type === 'content'
      ? base.value
      : [{ type: 'text' as const, text: nonContentBaseAsText(base) }];
  return { type: 'content', value: [...baseParts, { type: 'text' as const, text: section }] };
}

function nonContentBaseAsText(base: Exclude<ModelOutput, { type: 'text' | 'content' }>): string {
  switch (base.type) {
    case 'json':
    case 'error-json':
      return JSON.stringify(base.value ?? null);
    case 'error-text':
      return base.value;
    case 'execution-denied':
      return base.reason ?? 'tool execution denied';
    default:
      // Compile-time exhaustiveness: a new `ai` variant makes `base` non-`never` → a type error, not
      // a silent drop. Runtime stays fail-open (empty string) if one ever slips through.
      base satisfies never;
      return '';
  }
}

function wrapTool<TOOL extends Tool>(
  name: string,
  tool: TOOL,
  preHooks: HookSpec[],
  postHooks: HookSpec[],
  init: Required<Pick<WithHooksInit, 'onWarn'>> & { cwd?: string; exec: HookExec },
): TOOL {
  const original = tool.execute;
  if (!original || (preHooks.length === 0 && postHooks.length === 0)) return tool;
  const blocked = (stderr: string): unknown =>
    BASH_TOOL_NAMES.has(name)
      ? bashBlocked(blockFramed(stderr))
      : ({
          ok: false,
          blockedByHook: true,
          reason: blockFramed(stderr),
        } satisfies HookBlockedResult);

  const execute: NonNullable<Tool['execute']> = async (input, options) => {
    let current = input;
    for (const hook of preHooks) {
      const outcome = await runHook(
        hook,
        { event: 'PreToolUse', toolName: name, input: current, cwd: init.cwd },
        init,
        false,
      );
      if (outcome.kind === 'block') return blocked(outcome.stderr);
      if (outcome.kind === 'rewrite') {
        const validated = validateRewrite(tool, outcome.input);
        if (validated.ok) current = validated.value;
        else
          init.onWarn(
            `PreToolUse rewrite for \`${name}\` failed the tool schema — using original input`,
          );
      }
    }
    const result = await original(current, options);
    const feedback: string[] = [];
    for (const hook of postHooks) {
      const outcome = await runHook(
        hook,
        { event: 'PostToolUse', toolName: name, input: current, result, cwd: init.cwd },
        init,
        true,
      );
      if (outcome.kind === 'feedback') feedback.push(outcome.stdout);
    }
    return feedback.length > 0 ? applyFeedback(result, feedback) : result;
  };

  // Decorate toModelOutput too (issue #180): hook artifacts live at the typed-output layer, but every
  // #127 tool renders from its own output shape and would drop them at the model-visible layer — a
  // blocked call renders undefined fields, and PostToolUse feedback never reaches the model. Surface
  // the block reason for a blocked call, and append feedback attached to an object result.
  const decoratedToModelOutput: NonNullable<Tool['toModelOutput']> = async (ctx) => {
    if (isBlockedResult(ctx.output)) return { type: 'text', value: ctx.output.reason };
    const base = await baseModelOutput(tool.toModelOutput, ctx);
    const feedback = objectHookFeedback(ctx.output);
    return feedback === undefined ? base : appendHookFeedback(base, feedback);
  };
  // The spread + execute/toModelOutput override is sound at runtime; the cast only sidesteps the SDK
  // Tool union's `execute?: never` output-tool variant under exactOptionalPropertyTypes (same need as
  // withReminders' toModelOutput override).
  return { ...tool, execute, toModelOutput: decoratedToModelOutput } as TOOL;
}

// Decorate a tool registry with PreToolUse/PostToolUse hooks. Same-shaped record out; a tool with no
// matching hook (or no hooks at all) is returned untouched, so behavior is unchanged everywhere hooks
// don't apply.
export function withHooks<T extends ToolSet>(
  tools: T,
  hooks: ToolHooks,
  init: WithHooksInit = {},
): T {
  const pre = hooks.preToolUse ?? [];
  const post = hooks.postToolUse ?? [];
  if (pre.length === 0 && post.length === 0) return tools;
  const resolved = {
    onWarn:
      init.onWarn ?? ((message: string) => void process.stderr.write(`warning: ${message}\n`)),
    ...(init.cwd ? { cwd: init.cwd } : {}),
    exec: init.exec ?? defaultExec,
  };
  const out: Record<string, Tool> = {};
  for (const [name, tool] of Object.entries(tools) as [string, Tool][]) {
    const preHooks = pre.filter((h) => hookMatches(h.matcher, name));
    const postHooks = post.filter((h) => hookMatches(h.matcher, name));
    out[name] = wrapTool(name, tool, preHooks, postHooks, resolved);
  }
  return out as T;
}
