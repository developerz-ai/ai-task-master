// Parallel repo survey for the planning phase.
//
// The Planner is a single agent that surveys the repo read-only in at most PLANNER_MAX_STEPS, then
// submits the plan. On a small repo that is fine. On a big one those steps are the bottleneck: the
// Planner spends its whole budget DISCOVERING the codebase (one grep/read at a time) and has little
// left to actually decide structure — the same asymmetry the Worker solved by fanning its editor
// leaves out instead of editing one file per step.
//
// This is the planning-side analogue. Before the Planner runs, a small pool of read-only scouts
// surveys the repo CONCURRENTLY, each through a distinct lens (a multi-modal sweep: architecture,
// domain, conventions, integration). Their findings are synthesized into one brief the Planner reads
// up front, so it starts with a map and spends its own steps on structure, not discovery.
//
// Gated on repo size: below SCOUT_REPO_FILE_FLOOR the single-planner survey is already fast and the
// scouts would add LLM calls without buying wall-clock, so the survey is skipped and the planning
// path stays byte-identical to before this module existed.
//
// SRP: this module runs the sweep and synthesizes the brief. It owns no agent construction of its own
// — a ScoutRunner seam is injected (the adapter wires the real read-only agent; tests wire a stub).

import { createSubagent, runPool, runWithSchemaRetry } from '@developerz.ai/ai-claude-compat';
import { tool } from 'ai';
import { z } from 'zod';
import { AGENT_STEP_BACKSTOP, forwardInit, type SubagentInit } from './factory.ts';
import type { PlannerTools } from './planner.ts';

// A scout's tool-loop cap is the shared runaway backstop, not a work budget — it surveys until it
// submits its finding, and the cap only guards a non-terminating loop (see AGENT_STEP_BACKSTOP).
export const SCOUT_MAX_STEPS = AGENT_STEP_BACKSTOP;

// At most this many scouts run at once. Four lenses fit in one wave; the cap matters only if the lens
// set grows, and mirrors the editor fanout's bounded pool so planning can't open an unbounded burst.
export const SCOUT_CONCURRENCY = 4;

// Below this many surveyable (git-tracked, non-vendored) files, skip the parallel survey: the
// single-planner path already reads such a repo quickly, so scouts would only add cost. The number is
// a floor on "big enough that discovery dominates planning", not a hard rule — tune with evidence.
export const SCOUT_REPO_FILE_FLOOR = 60;

// The distinct angles the scouts sweep. Each is blind to the others, so together they cover ground one
// sequential survey would reach only by spending most of its step budget. Keep them non-overlapping:
// redundant lenses waste a concurrent call without adding coverage.
export type ScoutLens = {
  key: string;
  // Interpolated into the scout prompt as "Survey the repo to answer: <focus>". Written as the one
  // question this lens exists to answer.
  focus: string;
};

export const SCOUT_LENSES: readonly ScoutLens[] = [
  {
    key: 'architecture',
    focus:
      'the repo layout and how it is built and run — top-level packages/apps, the module boundaries, the build/test/lint tooling and the commands that drive them',
  },
  {
    key: 'domain-and-data',
    focus:
      'the existing domain model and persistence — the entities, their types/schemas, how data is stored and accessed, and which of them the goal will touch or extend',
  },
  {
    key: 'conventions-and-tests',
    focus:
      'the house coding conventions and testing approach — how an existing feature of the same shape is structured and tested, so the plan matches established patterns rather than inventing new ones',
  },
  {
    key: 'integration-points',
    focus:
      'where the goal must hook into what already exists — the routes, services, auth, config and entry points it will extend or wire into, and the gaps it must fill',
  },
];

// The scout role frame (fed to reminderAgentSystemPrompt as roleGuidance). A scout is a read-only
// surveyor, not a planner: it answers one lens and submits a finding, and it never writes. The lens
// itself and the output contract come from buildScoutPrompt (the user message).
export const SCOUT_SYSTEM_PREFIX = [
  'You are a read-only repository scout on a parallel survey team feeding a Planner.',
  'Your whole job is to answer ONE assigned lens about this codebase and submit a tight finding.',
  'Survey with the read-only tools (glob/grep/readFile, and explore when present). You never write,',
  'edit, or run state-changing commands. Report only what the repo actually shows — files, patterns,',
  'commands — never a guess or a restatement of the goal. Then call submit with the ScoutFinding.',
].join('\n');

// What one scout returns. Small and concrete on purpose: the Planner reads several of these, so each
// must compress its lens to the facts that change a plan, not a prose report.
export const ScoutFindingSchema = z.object({
  // One to three sentences orienting the Planner to this lens.
  summary: z.string().min(1),
  // Concrete, actionable facts — "auth is handled in apps/api/src/middleware/session.ts", "tests use
  // @solidjs/testing-library with a bunfig preload". Not speculation, not restated goal.
  facts: z.array(z.string()).max(12).default([]),
  // Paths the Planner (or a Worker) will most want to open for this lens.
  relevantPaths: z.array(z.string()).max(20).default([]),
});
export type ScoutFinding = z.infer<typeof ScoutFindingSchema>;

// Everything a scout needs to know to survey its lens, minus the tools/model (those live in the
// injected runner). `goal` and `criteria` focus the survey on what the plan will need.
export type ScoutContext = {
  goal: string;
  criteria?: string;
};

// The prompt one scout receives. States the goal, then narrows the whole survey to this lens so the
// scout does not re-survey ground another lens owns. Exported for the wiring site and tests.
export function buildScoutPrompt(lens: ScoutLens, ctx: ScoutContext): string {
  const lines = [
    `Goal for the upcoming plan: ${ctx.goal}`,
    ...(ctx.criteria?.trim() ? [`Acceptance criteria: ${ctx.criteria}`] : []),
    '',
    `You are ONE scout on a parallel survey team. Survey the repo with the read-only tools to answer, for THIS lens only:`,
    `  ${lens.focus}`,
    '',
    'Stay on this lens — other scouts cover the rest. Report only what you actually found in the repo',
    '(files, patterns, commands), never guesses or a restatement of the goal. Then call submit with',
    'a tight ScoutFinding: a short summary, the concrete facts that will shape the plan, and the paths',
    'most worth opening.',
  ];
  return lines.join('\n');
}

// Runs one lens and returns its finding, or null when the scout produced nothing usable (a failed
// submission, a dead scout). Injected: the adapter builds a real read-only agent per lens; tests
// substitute a deterministic stub.
export type ScoutRunner = (lens: ScoutLens, ctx: ScoutContext) => Promise<ScoutFinding | null>;

// Everything the real ScoutRunner needs to build and drive a read-only scout agent. The read-only
// PlannerTools are shared across all lenses — they are stateless (readFile/grep/glob), so concurrent
// scouts reading at once is safe. `systemPrompt` is the scout role frame the adapter already builds.
// A scout is a Planner-shaped subagent with a narrower dial set, so the fields are PICKED from
// SubagentInit rather than restated — restating them let the two drift (and breaks assignability
// under exactOptionalPropertyTypes, since an indexed `T[k]` widens with `undefined`). `signal` is
// run-scoped cancellation: scouts run concurrently and outside the Planner's own generate, so
// without it an abort would leave a whole wave of in-flight surveys running.
export type ScoutAgentInit = Pick<
  SubagentInit<PlannerTools>,
  'model' | 'tools' | 'systemPrompt' | 'timeout' | 'onUsage' | 'signal'
>;

// A ScoutRunner backed by a real read-only agent: one fresh agent per lens (so concurrent lenses do
// not share a conversation), driven through the schema-retry kernel like the Planner itself. Returns
// null on an exhausted-retry failure so surveyRepoInParallel drops just that lens.
export function createScoutRunner(init: ScoutAgentInit): ScoutRunner {
  return async (lens, ctx) => {
    const agent = createSubagent<PlannerTools>(
      {
        model: init.model,
        tools: init.tools,
        systemPrompt: init.systemPrompt,
        submit: tool({
          description: 'Submit this scout lens finding (the ScoutFinding schema).',
          inputSchema: ScoutFindingSchema,
          execute: async (finding: ScoutFinding) => finding,
        }),
        ...forwardInit(init),
      },
      SCOUT_MAX_STEPS,
    );
    const submitted = await runWithSchemaRetry(
      agent,
      ScoutFindingSchema,
      buildScoutPrompt(lens, ctx),
      init.onUsage ? { onUsage: init.onUsage } : {},
    );
    return submitted.ok ? submitted.value : null;
  };
}

// A file count with the same skip-or-sweep verdict the adapter uses. Extracted so the decision is
// unit-testable without a repo, and so the reason is logged consistently. An explicit `override`
// (true/false) wins over the size heuristic — the escape hatch for "always"/"never".
export function shouldSurveyInParallel(fileCount: number, override?: boolean): boolean {
  if (override !== undefined) return override;
  return fileCount >= SCOUT_REPO_FILE_FLOOR;
}

// Run every lens concurrently and collect the findings that came back. A single scout failing (or
// its runner throwing) drops to null and is filtered out — one dead lens must not sink the survey,
// exactly as one failed editor leaf does not sink the fanout. Order follows SCOUT_LENSES.
export async function surveyRepoInParallel(
  lenses: readonly ScoutLens[],
  ctx: ScoutContext,
  runScout: ScoutRunner,
  concurrency: number = SCOUT_CONCURRENCY,
): Promise<Array<{ lens: ScoutLens; finding: ScoutFinding }>> {
  const results = await runPool([...lenses], concurrency, async (lens) => {
    const finding = await runScout(lens, ctx).catch(() => null);
    return finding === null ? null : { lens, finding };
  });
  return results.filter((r): r is { lens: ScoutLens; finding: ScoutFinding } => r !== null);
}

// Fold the scouts' findings into one brief the Planner reads before surveying itself. Empty (returns
// '') when no scout produced anything, so the caller can fall through to the plain single-planner
// prompt unchanged. Framed as leads, not gospel: the Planner still has its own read-only tools and
// must verify anything it leans on.
export function synthesizeSurveyBrief(
  results: ReadonlyArray<{ lens: ScoutLens; finding: ScoutFinding }>,
): string {
  const sections = results
    .map(({ lens, finding }) => renderScoutSection(lens, finding))
    .filter((s) => s !== '');
  if (sections.length === 0) return '';
  return [
    `Repo survey (gathered in parallel by ${sections.length} scout(s) — treat as leads; verify with`,
    'your own read-only tools before relying on anything load-bearing):',
    '',
    ...sections,
  ].join('\n');
}

function renderScoutSection(lens: ScoutLens, finding: ScoutFinding): string {
  const summary = finding.summary.trim();
  const facts = finding.facts.map((f) => f.trim()).filter((f) => f !== '');
  const paths = finding.relevantPaths.map((p) => p.trim()).filter((p) => p !== '');
  if (summary === '' && facts.length === 0 && paths.length === 0) return '';
  const lines = [`## ${lens.key}`];
  if (summary !== '') lines.push(summary);
  for (const fact of facts) lines.push(`- ${fact}`);
  if (paths.length > 0) lines.push(`relevant: ${paths.join(', ')}`);
  lines.push('');
  return lines.join('\n');
}
