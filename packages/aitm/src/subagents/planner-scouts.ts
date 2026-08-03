// The scouts: a wave of read-only agents that survey the repo in parallel for the planning phase.
//
// The Planner is a single agent that surveys the repo read-only, then submits the plan. On a small
// repo that is fine. On a big one discovery is the bottleneck: the Planner spends its budget learning
// the codebase one grep at a time and has little left to decide structure — the same asymmetry the
// Worker solved by fanning its editor leaves out instead of editing one file per step.
//
// This is the planning-side analogue, and it mirrors the work loop's shape: a lead decides HOW MANY
// scouts to send and WHERE (scout-lead.ts), exactly as planning decides how many workers and on what;
// the scouts here are the workers of that loop, except they read instead of write. Each owns one
// question and roams the repo freely to answer it. Their findings synthesize into one brief the
// Planner reads up front, so it starts from a map and spends its own steps on structure.
//
// SRP: this module owns the scout side — the assignment/finding shapes, one scout's prompt and agent,
// one concurrent wave, and the brief. The lead lives in scout-lead.ts, the round loop that connects
// them in scout-survey.ts. No agent construction of its own: a ScoutRunner seam is injected (the
// adapter wires the real read-only agent; tests wire a stub).

import { createSubagent, runPool, runWithSchemaRetry } from '@developerz.ai/ai-claude-compat';
import { tool } from 'ai';
import { z } from 'zod';
import { SUBAGENT_LIMIT_DEFAULT } from '../domain/subagent-limit.ts';
import { AGENT_STEP_BACKSTOP, forwardInit, type SubagentInit } from './factory.ts';
import type { PlannerTools } from './planner.ts';

// A scout's tool-loop cap is the shared runaway backstop, not a work budget — it surveys until it
// submits its finding, and the cap only guards a non-terminating loop (see AGENT_STEP_BACKSTOP).
export const SCOUT_MAX_STEPS = AGENT_STEP_BACKSTOP;

// Ceiling on one wave, enforced in the lead's schema. The lead picks the real number from the repo
// map — a focused goal may warrant one scout — and this only stops a runaway dispatch. Same number
// as the concurrency knob (1 main agent + up to 10 subagents), so a wave the lead judged necessary
// is never silently queued behind itself.
export const SCOUT_MAX_ASSIGNMENTS = SUBAGENT_LIMIT_DEFAULT;

// One scout's briefing, written by the lead (scout-lead.ts) off the repo map.
//
// A briefing, not a one-line question: the lead has seen the map and the scout has not, so the
// concrete leads it already holds — which files decide the answer, which symbols to grep for — are
// worth handing over rather than making the scout rediscover them. What stays the scout's own is the
// judgment: these are the starting points it must cover, not the limits of where it may go.
export const ScoutAssignmentSchema = z.object({
  // Short kebab-case label. Used as the section heading in the brief and in progress lines, so it
  // must read as an area of the codebase (`auth-middleware`), not as a sentence.
  key: z.string().min(1),
  // The ONE self-contained question this scout owns. Self-contained because the scout shares none of
  // the lead's context: whatever the question omits, the scout cannot recover.
  question: z.string().min(1),
  // The concrete sub-questions the answer decomposes into. What turns "how does auth work" into
  // something a scout can actually close out — and what makes its finding checkable.
  subQuestions: z.array(z.string()).max(8).default([]),
  // Territory to start in. Leads, not fences — the scout is free to follow the code out of them.
  startPaths: z.array(z.string()).max(8).default([]),
  // Files to open IN FULL. The lead names these when a file is decisive (an interface a new driver
  // must satisfy, a config schema) and a grep hit would show only a fragment of it.
  mustRead: z.array(z.string()).max(12).default([]),
  // Symbols/identifiers to grep for. Cheap to pass, expensive for a scout to guess: the lead knows
  // what the goal is called in this codebase, and the scout would otherwise search for synonyms.
  searchTerms: z.array(z.string()).max(12).default([]),
});
export type ScoutAssignment = z.infer<typeof ScoutAssignmentSchema>;

// The scout role frame (fed to reminderAgentSystemPrompt as roleGuidance). A scout is a read-only
// surveyor, not a planner: it answers its own assignment and submits a finding, and it never writes.
// The assignment and the output contract come from buildScoutPrompt (the user message).
export const SCOUT_SYSTEM_PREFIX = [
  'You are a read-only repository scout on a parallel survey team feeding a Planner.',
  'You own ONE assigned question about this codebase. Your briefing names the files and symbols your',
  'lead already knows matter — cover those, then keep going wherever the code leads. How you answer',
  'is yours to decide: `explore` handles broad sweeps, readFile opens what must be read whole.',
  'Survey with the read-only tools (glob/grep/readFile). You never write, edit, or run',
  'state-changing commands.',
  '',
  'Evidence, not impressions: every fact you report is anchored to a real path (file:line where you',
  'have it) that you actually opened. "X does not exist" is a finding — say it plainly rather than',
  'leaving it out. Never restate the goal back, never report what the code probably does.',
  'Then call submit with the ScoutFinding.',
].join('\n');

// What one scout returns. Small and concrete on purpose: the Planner reads several of these, so each
// must compress its assignment to the facts that change a plan, not a prose report.
export const ScoutFindingSchema = z.object({
  // One to three sentences orienting the Planner to this area.
  summary: z.string().min(1),
  // Concrete, actionable facts, each anchored to where it was seen — "session cookies are validated
  // in apps/api/src/middleware/session.ts:41", "tests use @solidjs/testing-library with a bunfig
  // preload". The anchor is what makes a fact checkable by the Planner instead of trusted blind.
  facts: z.array(z.string()).max(12).default([]),
  // Paths the Planner (or a Worker) will most want to open for this area.
  relevantPaths: z.array(z.string()).max(20).default([]),
  // What this scout could NOT settle. Feeds the lead's gap round (scout-survey.ts) — an unknown named
  // here is what buys a follow-up scout instead of the Planner discovering the hole mid-plan.
  openQuestions: z.array(z.string()).max(6).default([]),
});
export type ScoutFinding = z.infer<typeof ScoutFindingSchema>;

// Everything a scout needs beyond its own assignment, minus the tools/model (those live in the
// injected runner). `goal`/`criteria` focus the survey on what the plan will need; `repoMap` is the
// deterministic skeleton (workspace/repo-skeleton.ts) that spares every scout from re-discovering
// the repo's shape before it can start.
export type ScoutContext = {
  goal: string;
  criteria?: string;
  repoMap?: string;
};

// The prompt one scout receives: the map, its briefing, and what siblings own so two scouts don't
// survey the same ground — then it gets out of the way. The briefing's concrete parts render as a
// floor ("cover at least these"), never a ceiling, so a lead that guessed the wrong files costs the
// scout a few reads rather than the answer.
export function buildScoutPrompt(
  assignment: ScoutAssignment,
  ctx: ScoutContext,
  siblings: readonly ScoutAssignment[] = [],
): string {
  const others = siblings.filter((s) => s.key !== assignment.key);
  const lines = [
    `Goal for the upcoming plan: ${ctx.goal}`,
    ...(ctx.criteria?.trim() ? [`Acceptance criteria: ${ctx.criteria}`] : []),
    ...(ctx.repoMap?.trim() ? ['', ctx.repoMap] : []),
    '',
    'You are ONE scout on a parallel survey team. Your assignment:',
    `  ${assignment.question}`,
    ...(assignment.subQuestions.length > 0
      ? ['', 'Settle each of these:', ...assignment.subQuestions.map((q) => `  - ${q}`)]
      : []),
    ...(assignment.startPaths.length > 0
      ? ['', `Start in: ${assignment.startPaths.join(', ')}`]
      : []),
    ...(assignment.mustRead.length > 0 ? [`Read IN FULL: ${assignment.mustRead.join(', ')}`] : []),
    ...(assignment.searchTerms.length > 0
      ? [`Grep for: ${assignment.searchTerms.join(', ')}`]
      : []),
    ...(others.length > 0
      ? [
          `Other scouts are covering: ${others.map((o) => o.key).join(', ')} — leave their ground to them.`,
        ]
      : []),
    '',
    'Those are your starting points, not your limits: your lead picked them from a map, not from the',
    'code. Cover them, correct them where they are wrong, and follow the question wherever it',
    'actually leads — hand broad sweeps to `explore` so their raw text stays out of your context.',
    '',
    'Then call submit with a tight ScoutFinding: a short summary, the concrete facts that will shape',
    'the plan (each anchored to the file — file:line where you have it), the paths most worth',
    'opening, and anything you could not settle.',
  ];
  return lines.join('\n');
}

// Runs one assignment and returns its finding, or null when the scout produced nothing usable (a
// failed submission, a dead scout). Injected: the adapter builds a real read-only agent per
// assignment; tests substitute a deterministic stub.
export type ScoutRunner = (
  assignment: ScoutAssignment,
  ctx: ScoutContext,
  siblings: readonly ScoutAssignment[],
) => Promise<ScoutFinding | null>;

// Everything the real ScoutRunner needs to build and drive a read-only scout agent. The read-only
// PlannerTools are shared across all scouts — they are stateless (readFile/grep/glob), so concurrent
// scouts reading at once is safe. `systemPrompt` is the scout role frame the adapter already builds.
// A scout is a Planner-shaped subagent with a narrower dial set, so the fields are PICKED from
// SubagentInit rather than restated — restating them let the two drift (and breaks assignability
// under exactOptionalPropertyTypes, since an indexed `T[k]` widens with `undefined`). `signal` is
// run-scoped cancellation: scouts run concurrently and outside the Planner's own generate, so
// without it an abort would leave a whole wave of in-flight surveys running.
export type ScoutAgentInit = Pick<
  SubagentInit<PlannerTools>,
  'model' | 'systemPrompt' | 'timeout' | 'onUsage' | 'signal'
> & {
  // A FACTORY, not a record (issue #333). Every runner below builds a fresh agent per assignment so
  // concurrent members never share a conversation — but they all read one `tools` object, and the
  // tool record is where per-conversation state lives: the deferred MCP mount's activation set
  // (#119) and the nested-config announcement (#192) are both consumed by whichever member touched
  // first. Building the record per agent puts that state where the conversation is.
  tools: () => PlannerTools;
};

// A ScoutRunner backed by a real read-only agent: one fresh agent per assignment (so concurrent
// scouts do not share a conversation), driven through the schema-retry kernel like the Planner
// itself. Returns null on an exhausted-retry failure so surveyRepoInParallel drops just that scout.
export function createScoutRunner(init: ScoutAgentInit): ScoutRunner {
  return async (assignment, ctx, siblings) => {
    const agent = createSubagent<PlannerTools>(
      {
        model: init.model,
        tools: init.tools(),
        systemPrompt: init.systemPrompt,
        submit: tool({
          description: 'Submit this scout finding (the ScoutFinding schema).',
          inputSchema: ScoutFindingSchema,
          execute: async (finding: ScoutFinding) => finding,
        }),
        ...forwardInit<PlannerTools>(init),
      },
      SCOUT_MAX_STEPS,
    );
    const submitted = await runWithSchemaRetry(
      agent,
      ScoutFindingSchema,
      buildScoutPrompt(assignment, ctx, siblings),
      init.onUsage ? { onUsage: init.onUsage } : {},
    );
    return submitted.ok ? submitted.value : null;
  };
}

// One result of a wave: the assignment that was dispatched and what came back for it.
export type ScoutResult = { assignment: ScoutAssignment; finding: ScoutFinding };

// Run every assignment in the wave concurrently and collect the findings that came back. A single
// scout failing (or its runner throwing) drops to null and is filtered out — one dead scout must not
// sink the survey, exactly as one failed editor leaf does not sink the fanout. Order follows the
// assignment list, not completion order, so the brief is stable across runs.
export async function surveyRepoInParallel(
  assignments: readonly ScoutAssignment[],
  ctx: ScoutContext,
  runScout: ScoutRunner,
  concurrency: number = SUBAGENT_LIMIT_DEFAULT,
): Promise<ScoutResult[]> {
  const results = await runPool([...assignments], concurrency, async (assignment) => {
    const finding = await runScout(assignment, ctx, assignments).catch(() => null);
    return finding === null ? null : { assignment, finding };
  });
  return results.filter((r): r is ScoutResult => r !== null);
}

// Fold the scouts' findings into one brief the Planner reads before surveying itself. The repo map
// leads it: even when every scout dies the map is still worth handing over, which is why an empty
// findings list with a map is not an empty brief. Returns '' only when there is nothing at all to
// say, so the caller can fall through to the plain single-planner prompt unchanged. Framed as leads,
// not gospel: the Planner still has its own read-only tools and must verify anything load-bearing.
export function synthesizeSurveyBrief(
  results: ReadonlyArray<ScoutResult>,
  repoMap?: string,
): string {
  const sections = results
    .map(({ assignment, finding }) => renderScoutSection(assignment, finding))
    .filter((s) => s !== '');
  const map = repoMap?.trim() ?? '';
  if (sections.length === 0) return map === '' ? '' : `${map}\n`;
  return [
    ...(map === '' ? [] : [map, '']),
    `Repo survey (gathered in parallel by ${sections.length} scout(s) — treat as leads; verify with`,
    'your own read-only tools before relying on anything load-bearing):',
    '',
    ...sections,
  ].join('\n');
}

function renderScoutSection(assignment: ScoutAssignment, finding: ScoutFinding): string {
  const summary = finding.summary.trim();
  const facts = finding.facts.map((f) => f.trim()).filter((f) => f !== '');
  const paths = finding.relevantPaths.map((p) => p.trim()).filter((p) => p !== '');
  const open = finding.openQuestions.map((q) => q.trim()).filter((q) => q !== '');
  if (summary === '' && facts.length === 0 && paths.length === 0) return '';
  const lines = [`## ${assignment.key}`];
  if (summary !== '') lines.push(summary);
  for (const fact of facts) lines.push(`- ${fact}`);
  if (paths.length > 0) lines.push(`relevant: ${paths.join(', ')}`);
  // Carried into the brief, not just into the lead's gap round: a hole the team never closed is
  // something the Planner must know it has to settle itself.
  for (const question of open) lines.push(`open: ${question}`);
  lines.push('');
  return lines.join('\n');
}
