// docs/subagents.md (Planner row), docs/task-groups.md, docs/agent-config-detection.md
// Goal + repo survey → ordered PR groups (DAG) with Zod-validated output.
// SDK reference: docs/vendor/ai-sdk/chunk-09.md §"Subagents" + chunk-05.md §"Generating Structured Data".

import type {
  GlobInput,
  GlobOutput,
  GrepInput,
  GrepOutput,
  ReadFileInput,
  ReadFileOutput,
} from '@developerz.ai/ai-claude-compat';
import {
  createSubagent,
  formatSubmitIssues,
  runWithSchemaRetry,
} from '@developerz.ai/ai-claude-compat';
import { type Tool, type ToolLoopAgent, tool } from 'ai';
import { type Plan, PlanSchema } from '../plan/schema.ts';
import type { DatetimeInput, DatetimeOutput } from '../tools/datetime.ts';
import type { WebFetchInput, WebFetchOutput } from '../tools/web-fetch.ts';
import type { WebSearchInput, WebSearchOutput } from '../tools/web-search.ts';
import {
  AGENT_STEP_BACKSTOP,
  appendReminderBlock,
  forwardInit,
  prependContextBlock,
  type SubagentInit,
} from './factory.ts';

export type PlannerAgent = ToolLoopAgent<never, PlannerTools>;

// The Planner only surveys the repo — it gets the read-only subset of the Claude-Code-style
// tool surface (no write/edit/bash), plus web + time tools (issue #112). The optional fetchHtml is a
// runtime extra (an optional tool field breaks the SDK's TypedToolCall) — see WorkerTools.
export type PlannerTools = {
  readFile: Tool<ReadFileInput, ReadFileOutput>;
  grep: Tool<GrepInput, GrepOutput>;
  glob: Tool<GlobInput, GlobOutput>;
  webFetch: Tool<WebFetchInput, WebFetchOutput>;
  // Provider-agnostic web search (DuckDuckGo, no key) — the Planner can research on ANY model, not
  // only OpenRouter-routed ones. A local function tool, so it is a core field like webFetch.
  webSearch: Tool<WebSearchInput, WebSearchOutput>;
  datetime: Tool<DatetimeInput, DatetimeOutput>;
};

export type PlannerInput = {
  goal: string;
  criteria?: string;
  styleContents: string;
  // null → unbounded (the default): the Planner sizes the plan to the goal and nothing is injected
  // into the prompt. A number is a PACKAGING cap the Planner must group everything to fit; a plan
  // that exceeds it is rejected outright rather than truncated, so no work is ever silently dropped.
  maxPrs: number | null;
  // Optional harness context block (a `<system-reminder>` envelope) prepended to the first user
  // message — target-repo instructions + current date, framed as advisory context (issue #106).
  contextBlock?: string;
  // Optional trailing `<system-reminder>` (the run's Step N/M position) appended to the END of the
  // first user message, kept out of the cacheable leading prefix (slice 04 §4). Unset → nothing added.
  progressBlock?: string;
  // Optional pre-planning repo survey gathered in parallel by scouts (planner-scouts.ts). Injected
  // before the "survey the repo yourself" instruction so the Planner starts from a map and spends its
  // own steps on structure, not discovery. Empty/absent → the plain single-planner prompt, unchanged.
  surveyBrief?: string;
};

export type PlannerResult =
  | { kind: 'ok'; plan: Plan }
  | { kind: 'blocked'; reason: string }
  | { kind: 'error'; error: string };

// The Planner's role prose lives behind the prompts seam (slice 08); re-exported for the wiring site
// (run-loop-adapter) that feeds it to buildRolePrompt.
export { PLANNER_SYSTEM_PREFIX } from './prompts/role-guidance.ts';

// Planner step budget — single-sourced so the step-budget reminder (issue #105) and the actual
// createSubagent cap can never drift apart.
export const PLANNER_MAX_STEPS = AGENT_STEP_BACKSTOP;

// Link a Planner agent back to its init so runPlanner can reach the optional onUsage sink (#114)
// without threading it through PlannerInput — mirrors the worker/reviewer WeakMap pattern.
const plannerInitRegistry = new WeakMap<PlannerAgent, SubagentInit<PlannerTools>>();

export function createPlannerAgent(init: SubagentInit<PlannerTools>): PlannerAgent {
  const agent = createSubagent<PlannerTools>(
    {
      model: init.model,
      tools: init.tools,
      systemPrompt: init.systemPrompt,
      submit: tool({
        description: 'Submit the finished plan as an ordered list of PR groups (the Plan schema).',
        inputSchema: PlanSchema,
        execute: async (plan) => plan,
      }),
      ...forwardInit(init),
    },
    PLANNER_MAX_STEPS,
  );
  plannerInitRegistry.set(agent, init);
  return agent;
}

export async function runPlanner(agent: PlannerAgent, input: PlannerInput): Promise<PlannerResult> {
  if (input.maxPrs !== null && (!Number.isInteger(input.maxPrs) || input.maxPrs < 1)) {
    return {
      kind: 'error',
      error: `maxPrs must be a positive integer or null, received ${input.maxPrs}`,
    };
  }
  const onUsage = plannerInitRegistry.get(agent)?.onUsage;
  try {
    const submitted = await runWithSchemaRetry(agent, PlanSchema, buildUserPrompt(input), {
      ...(onUsage ? { onUsage } : {}),
    });
    if (!submitted.ok) {
      // Only after the retry kernel exhausts. Distinguish the two failure modes in the message so
      // a weak model that never submits reads differently from one that keeps mangling the schema.
      if (submitted.reason === 'invalid') {
        return {
          kind: 'error',
          error: `planner plan failed schema validation after retries: ${formatSubmitIssues(submitted.issues)}`,
        };
      }
      return { kind: 'blocked', reason: 'planner did not submit a plan after retries' };
    }
    // Schema validation now enforces groups.min(1), so submitted.value.groups is never empty.
    const plan = submitted.value;
    // An over-cap plan is a REJECTED plan, never a truncated one. Dropping the tail (or folding it
    // into a "remainder" stub no Worker executes) would silently ship a fraction of the goal and
    // report success — the failure the cap exists to prevent, caused by the cap itself.
    if (input.maxPrs !== null && plan.groups.length > input.maxPrs) {
      return {
        kind: 'error',
        error: `planner emitted ${plan.groups.length} PR groups, exceeding maxPrs ${input.maxPrs}. Raise --max-prs (or pass 0 for unbounded) — the plan is not truncated, because dropping groups would silently drop work.`,
      };
    }
    return { kind: 'ok', plan };
  } catch (err) {
    return { kind: 'error', error: err instanceof Error ? err.message : String(err) };
  }
}

function buildUserPrompt(input: PlannerInput): string {
  const lines = [`Goal: ${input.goal}`];
  if (input.criteria?.trim()) {
    lines.push(`Acceptance criteria: ${input.criteria}`);
  }
  // Injected ONLY when the operator set a cap. With no cap the prompt says nothing about PR count,
  // so the Planner sizes the plan to the goal instead of to a budget it was handed.
  if (input.maxPrs !== null) lines.push(`maxPrs: ${input.maxPrs}`);
  const brief = input.surveyBrief?.trim();
  if (brief) {
    lines.push('', brief, '');
    lines.push(
      'Use the survey above as your starting map, then confirm and fill gaps with the read-only tools before you submit the Plan.',
    );
  } else {
    lines.push('Survey the repo with the read-only tools, then call submit with the Plan.');
  }
  return appendReminderBlock(
    prependContextBlock(input.contextBlock, lines.join('\n')),
    input.progressBlock,
  );
}
