// Per-step aggregate output budget. Each tool already caps its OWN output (bashTool 30k per stream,
// grep 200 results), but a single model step can fire many tool calls in parallel — five 30k bash
// results is 150k chars flooding the context even though every one stayed under its own cap. This
// decorator tracks the running total of model-visible tool output WITHIN a step and, once that total
// crosses a budget, spills each FURTHER result in the step to the ToolOutputStore in full, returning
// a short paging notice in its place. The model still sees the earliest results verbatim and pages
// the rest with readFile(offset/limit)/grep — nothing is lost.
//
// It is purely a model-visibility concern: the typed tool output is preserved bit-for-bit, so
// programmatic readers (submittedOutput, PostToolUse hooks) are unaffected — the same contract as
// withReminders. The budget only targets N×cap floods: a single oversized result is left to that
// tool's own cap and is always shown, never spilled from the first result.
//
// The counter is per STEP, not per run. The AI SDK renders a step's tool results sequentially (a
// `for` loop of awaited `createToolModelOutput` calls) and only then fires onStepFinish, so wire the
// returned `stepFinished` into each role's onStepFinish to reset between steps. Left unreset it
// degrades to a per-run budget — still safe, just more eager to spill.

import type { Tool, ToolSet } from 'ai';
import type { ToolOutputStore } from './tool-output-store.ts';

// The model-visible output union a tool's `toModelOutput` returns (text / json / content / error
// variants). `ai` doesn't re-export it, so derive it from the public Tool surface — as elsewhere.
type ModelOutput = Awaited<ReturnType<NonNullable<Tool['toModelOutput']>>>;
type ModelOutputCtx = { toolCallId: string; input: unknown; output: unknown };

// Default per-step budget: comfortably below a typical model context window yet well above any single
// tool's own cap, so ordinary single-result steps are never touched and only genuine floods spill.
export const DEFAULT_STEP_OUTPUT_BUDGET_CHARS = 120_000;

export type StepOutputBudgetInit = {
  // Where a withheld result is written in full. Required — the budget has nowhere to spill without it.
  store: ToolOutputStore;
  // Char ceiling for a step's combined model-visible tool output. Default
  // DEFAULT_STEP_OUTPUT_BUDGET_CHARS.
  budgetChars?: number;
};

export type StepBudgetedTools<T extends ToolSet> = {
  // The same tool set with every tool's `toModelOutput` decorated to honor the step budget.
  tools: T;
  // Reset the per-step accumulator; wire into each role's onStepFinish. Idempotent.
  stepFinished: () => void;
};

// Decorate a tool set with a per-step output budget (see the module header). Returns the decorated
// set plus the `stepFinished` reset the caller wires into onStepFinish.
export function withStepOutputBudget<T extends ToolSet>(
  tools: T,
  init: StepOutputBudgetInit,
): StepBudgetedTools<T> {
  const budget = init.budgetChars ?? DEFAULT_STEP_OUTPUT_BUDGET_CHARS;
  const { store } = init;
  // Running total of model-visible chars SHOWN this step; reset by stepFinished between steps.
  let spent = 0;

  const out: Record<string, Tool> = {};
  for (const [name, tool] of Object.entries(tools) as [string, Tool][]) {
    const decorated: NonNullable<Tool['toModelOutput']> = async (ctx) => {
      const base = await renderBase(tool, ctx);
      // Still within budget → show verbatim and count it. The result that first crosses the budget is
      // shown in full too (it is not "remaining"); only the results after the crossing spill.
      if (spent < budget) {
        spent += flattenOutput(base).length;
        return base;
      }
      const text = flattenOutput(base);
      if (text.length === 0) return base; // nothing to protect — never spill an empty result
      const spilled = await store.save(name, text).catch(() => null);
      // Spill write failed (rare): fail open — show the result (no data loss), the same spirit as
      // bashTool's degrade path. Count it so the budget keeps tracking what actually reached the model.
      if (spilled === null) {
        spent += text.length;
        return base;
      }
      return { type: 'text', value: spillNotice(budget, spilled.path) };
    };
    out[name] = { ...tool, toModelOutput: decorated };
  }

  const stepFinished = (): void => {
    spent = 0;
  };
  return { tools: out as T, stepFinished };
}

function spillNotice(budgetChars: number, path: string): string {
  return `[output withheld: this step's combined tool output exceeded the ${budgetChars}-char budget. Full output saved to ${path} — page with readFile(offset/limit) or grep]`;
}

// The base rendering the SDK would show — the tool's own toModelOutput, or the SDK default (text for
// a string result, json otherwise). Mirrors withReminders' baseModelOutput.
async function renderBase(tool: Tool, ctx: ModelOutputCtx): Promise<ModelOutput> {
  if (tool.toModelOutput) return await tool.toModelOutput(ctx);
  return typeof ctx.output === 'string'
    ? { type: 'text', value: ctx.output }
    : {
        type: 'json',
        value: (ctx.output ?? null) as Extract<ModelOutput, { type: 'json' }>['value'],
      };
}

// Flatten a rendered output to the plain text the model sees — used both as the size measure and as
// the content written to the spill file. Media/file parts of a content result carry no model-visible
// text and are skipped.
function flattenOutput(out: ModelOutput): string {
  switch (out.type) {
    case 'text':
    case 'error-text':
      return out.value;
    case 'json':
    case 'error-json':
      return JSON.stringify(out.value ?? null);
    case 'execution-denied':
      return out.reason ?? 'tool execution denied';
    case 'content':
      return out.value.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n');
    default:
      // Compile-time exhaustiveness: a new `ai` variant makes `out` non-`never` → a type error, not a
      // silent miscount. Runtime stays fail-safe (empty → treated as nothing to spill).
      out satisfies never;
      return '';
  }
}
