// The Planner half of the run-loop adapter: turn a goal into PR groups, either by running the
// Planner subagent (with its optional parallel pre-planning scout survey) or by mapping an
// already-accepted Plan onto branch-assigned PrGroups. Split out of run-loop-adapter.ts so the
// orchestrator-bridge half of that file isn't tangled with planning concerns.

import type { RunLoopInput } from '../composition/run-input.ts';
import type { PrGroup } from '../domain/pr-group.ts';
import type { McpClientManager } from '../mcp/mcp-client.ts';
import { harnessProgress, shortModelName } from '../observability/step-progress.ts';
import { roleUsageSink } from '../observability/usage-tracker.ts';
import type { Plan } from '../plan/schema.ts';
import type { RunEndOutcome } from '../state/transcript-store.ts';
import type { OnUsage } from '../subagents/factory.ts';
import {
  createPlannerAgent,
  PLANNER_SYSTEM_PREFIX,
  type PlannerResult,
  type PlannerTools,
  runPlanner,
} from '../subagents/planner.ts';
import {
  createScoutRunner,
  SCOUT_LENSES,
  SCOUT_SYSTEM_PREFIX,
  shouldSurveyInParallel,
  surveyRepoInParallel,
  synthesizeSurveyBrief,
} from '../subagents/planner-scouts.ts';
import { harnessContextBlock, reminderAgentSystemPrompt } from '../subagents/role-prompt.ts';
import {
  dedupeBranchNames,
  sanitizeBranchComponent,
  slugifyTitle,
} from '../workspace/branch-name.ts';
import { runGit } from '../workspace/git-exec.ts';
import {
  beginTranscript,
  memoryIndexFor,
  resolveStyleContents,
  runEndOutcome,
  runProgressReminder,
} from './adapter-support.ts';
import { buildSubagentSession } from './subagent-session.ts';
import { applyHooks, buildExploreFor, resolvePlannerTools } from './tool-resolution.ts';

export type PlanGroupsOutcome =
  | { kind: 'ok'; groups: PrGroup[] }
  | { kind: 'blocked'; reason: string }
  | { kind: 'error'; error: string };

// Re-exported from workspace/branch-name.ts (its home now that WorkLoop also builds ref components).
// Kept on this module's surface so existing importers/tests are unaffected.
export { sanitizeBranchComponent };

// Resolve a group's branch name, honoring a caller-specified `--branch`.
//   - no branch requested        → `aitm/<group-id>-<title-slug>` (default)
//   - requested, single group    → the requested name verbatim (already validated by the CLI)
//   - requested, multiple groups → `<requested>/<group-id>-<title-slug>` so the groups' branches
//     (and the PRs they open) don't collide on one branch name.
// The title slug is what makes a branch list readable — `aitm/g1` says nothing next to
// `aitm/g1-add-todo-crud`, and on a repo where two people run aitm it is the difference between two
// runs sharing a branch name and not. Dropped when the title yields no usable characters.
// The group-id segment is always sanitized so the composed ref is valid regardless of what the
// Planner emitted.
export function branchFor(
  groupId: string,
  requested: string | undefined,
  totalGroups: number,
  title?: string,
): string {
  const safeId = sanitizeBranchComponent(groupId);
  const slug = title ? slugifyTitle(title) : '';
  // A title that just restates the id (`g1` / "G1") would give `aitm/g1-g1` — keep the bare id.
  const redundant = slug === '' || slug === safeId.toLowerCase();
  const segment = redundant ? safeId : `${safeId}-${slug}`;
  if (requested === undefined) return `aitm/${segment}`;
  return totalGroups <= 1 ? requested : `${requested}/${segment}`;
}

// Plan → the persisted PrGroups the loop drives. `takenBranches` is the set of branch names already
// published on the remote (see remoteBranchNames): every name aitm composes itself is resolved
// against it — and against this run's own groups — so two people running aitm on one repo can't end
// up sharing a branch and force-pushing over each other. Branches are assigned HERE, once, at plan
// acceptance; a resumed run reuses what state.json already holds and never re-dedupes.
// An explicit single-group `--branch` is the operator's own name: honored verbatim, never suffixed.
export function planToPrGroups(
  plan: Plan,
  branch?: string,
  takenBranches: ReadonlySet<string> = new Set(),
): PrGroup[] {
  const total = plan.groups.length;
  const desired = plan.groups.map((g) => branchFor(g.id, branch, total, g.title));
  const verbatim = branch !== undefined && total <= 1;
  const branches = verbatim ? desired : dedupeBranchNames(desired, takenBranches);
  return plan.groups.map((g, groupIndex) => ({
    id: g.id,
    title: g.title,
    acceptance: g.acceptance,
    tasks: g.tasks.map((t, i) => ({
      id: `${g.id}-${i + 1}`,
      text: t.description,
      complexity: t.complexity,
      done: false,
    })),
    dependsOn: g.dependsOn,
    branch: branches[groupIndex] ?? branchFor(g.id, branch, total, g.title),
    pr: null,
    status: 'pending' as const,
    stage: 'pending' as const,
    reviewGraceApplied: false,
  }));
}

// Branch names already published on `origin`, read in ONE `ls-remote` for the whole run rather than
// a probe per group. Best-effort by design: no origin, no network, or not a git repo all yield an
// empty set, so branch dedupe degrades to the plain names — a naming courtesy must never fail a run.
export async function remoteBranchNames(cwd: string, signal?: AbortSignal): Promise<Set<string>> {
  try {
    const result = await runGit(['ls-remote', '--heads', 'origin'], {
      cwd,
      ...(signal ? { signal } : {}),
    });
    return new Set(parseRemoteHeads(result.stdout));
  } catch {
    return new Set();
  }
}

// Count of git-tracked files — a cheap proxy for "how much codebase the Planner must survey", used to
// gate the parallel scout sweep (planner-scouts.ts). Tracked files exclude node_modules/dist by
// construction (gitignored), so no vendor filter is needed. A non-repo or a git failure returns 0,
// which reads as "small" and skips the sweep — the safe default, since scouts only ever ADD cost.
export async function countTrackedFiles(cwd: string): Promise<number> {
  try {
    const result = await runGit(['ls-files'], { cwd });
    return result.stdout.split('\n').filter((line) => line.trim() !== '').length;
  } catch {
    return 0;
  }
}

// `<sha>\trefs/heads/<branch>` lines → branch names, skipping blank lines and any non-heads ref git
// prints. Exported for unit testing — it is the half of remoteBranchNames that has no process in it.
export function parseRemoteHeads(stdout: string): string[] {
  const prefix = 'refs/heads/';
  const names: string[] = [];
  for (const line of stdout.split('\n')) {
    const ref = line.split('\t')[1]?.trim();
    if (ref?.startsWith(prefix) && ref.length > prefix.length) names.push(ref.slice(prefix.length));
  }
  return names;
}

// Run the parallel scout survey before planning, returning the synthesized brief — or undefined when
// the repo is below the size floor (scouts would be pure added cost) or the sweep produced nothing.
// Best-effort throughout: a git or scout failure degrades to no brief, never blocks the planner.
async function surveyRepoForPlanner(params: {
  input: RunLoopInput;
  style: string;
  plannerModelId: string;
  plannerUsage?: OnUsage;
  mcp: McpClientManager;
  fetchHtmlAvailable: boolean;
}): Promise<string | undefined> {
  const { input, style, plannerModelId, plannerUsage, mcp, fetchHtmlAvailable } = params;
  const fileCount = await countTrackedFiles(input.cwd);
  if (!shouldSurveyInParallel(fileCount)) return undefined;
  harnessProgress(
    `survey: ${SCOUT_LENSES.length} scouts sweeping ${fileCount} tracked files in parallel`,
    { phase: 'planning' },
  );
  const runScout = createScoutRunner({
    model: input.credentials.modelFor('planner'),
    tools: applyHooks(
      resolvePlannerTools(
        mcp.toolsForRole('planner'),
        input.cwd,
        fetchHtmlAvailable,
        buildExploreFor(input, input.cwd, plannerUsage),
      ),
      input,
      input.cwd,
    ),
    systemPrompt: reminderAgentSystemPrompt({
      style,
      roleGuidance: SCOUT_SYSTEM_PREFIX,
      cwd: input.cwd,
      modelId: plannerModelId,
    }),
    timeout: { stepMs: input.resolved.llmStepTimeoutMs },
    ...(plannerUsage ? { onUsage: plannerUsage } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
  });
  const ctx = {
    goal: input.goal,
    ...(input.criteria !== undefined ? { criteria: input.criteria } : {}),
  };
  const findings = await surveyRepoInParallel(SCOUT_LENSES, ctx, runScout).catch(() => []);
  harnessProgress(`survey: ${findings.length}/${SCOUT_LENSES.length} scouts reported`, {
    phase: 'planning',
  });
  const brief = synthesizeSurveyBrief(findings);
  return brief === '' ? undefined : brief;
}

export async function defaultPlanGroups(
  input: RunLoopInput,
  mcp: McpClientManager,
  fetchHtmlAvailable: boolean,
): Promise<PlanGroupsOutcome> {
  const style = resolveStyleContents(input);
  const plannerUsage = roleUsageSink(
    input.usage,
    'planner',
    input.credentials.modelIdFor('planner'),
  );
  // Planner gets the memory index (issue #118) but no memory tool: its read tools are rooted at the
  // repo cwd, so it reads memory files directly and stays read-only.
  const memoryIndex = await memoryIndexFor(input.state);
  // Transcript (issue #108): the planner run is recorded (never resumed — it always cold-starts).
  const plannerRecorder = await beginTranscript(input.state.transcripts?.(), { planner: true });
  const plannerModelId = input.credentials.modelIdFor('planner');
  harnessProgress(`planning with ${plannerModelId}: ${input.goal}`, { phase: 'planning' });
  // Shared sink (issue #01b liveliness): the heartbeat needs to see every progress write this call
  // makes (steps + retries) to tell silence from activity, so it must be the SAME sink instance
  // agentStepProgress/onRetry write through — buildSubagentSession bundles this for every call site.
  // Streaming (slice 07): when on, live text/tool lines print via session.onStream below, so the
  // step-finish renderer is told to skip them (textAndTools: false) — it still renders reasoning,
  // which has no live equivalent.
  const session = buildSubagentSession<PlannerTools>({
    role: 'planner',
    model: shortModelName(plannerModelId),
    phase: 'planning',
    streaming: input.resolved.streaming,
    recorder: plannerRecorder,
  });
  const agent = createPlannerAgent({
    model: input.credentials.modelFor('planner'),
    tools: applyHooks(
      resolvePlannerTools(
        mcp.toolsForRole('planner'),
        input.cwd,
        fetchHtmlAvailable,
        buildExploreFor(input, input.cwd, plannerUsage),
      ),
      input,
      input.cwd,
    ),
    systemPrompt: reminderAgentSystemPrompt({
      style,
      roleGuidance: PLANNER_SYSTEM_PREFIX,
      cwd: input.cwd,
      modelId: input.credentials.modelIdFor('planner'),
      memoryIndex,
    }),
    timeout: { stepMs: input.resolved.llmStepTimeoutMs },
    ...(plannerUsage ? { onUsage: plannerUsage } : {}),
    onStepFinish: session.onStepFinish,
    onRetry: session.onRetry,
    ...(session.onStream ? { onStream: session.onStream } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
  });
  // Parallel pre-planning survey (planner-scouts.ts): on a big enough repo, a pool of read-only
  // scouts sweeps distinct lenses concurrently and hands the Planner a map, so its own steps go to
  // structure instead of discovery. Gated on tracked-file count — below the floor the sequential
  // survey is already fast and scouts would be pure added cost, so this returns undefined and the
  // Planner prompt is byte-identical. Best-effort: a failed sweep degrades to no brief, never blocks.
  const surveyBrief = await surveyRepoForPlanner({
    input,
    style,
    plannerModelId,
    ...(plannerUsage ? { plannerUsage } : {}),
    mcp,
    fetchHtmlAvailable,
  });

  const stopPlannerHeartbeat = session.start();
  // The transcript is closed in the `finally` below, not after it: a planner that throws (provider
  // 5xx, step timeout) would otherwise leave an open 'working' record behind forever — the planner
  // stage is documented as never-resumed, so nothing would ever come back to end it.
  let plannerOutcome: RunEndOutcome = 'error';
  let result: PlannerResult;
  try {
    result = await runPlanner(agent, {
      goal: input.goal,
      styleContents: style,
      maxPrs: input.resolved.maxPrs,
      contextBlock: harnessContextBlock(),
      // No group counter yet — the Planner is what produces the groups — so the trailing progress
      // reminder carries the phase only (`Phase: planning`).
      progressBlock: runProgressReminder({ phase: 'planning' }),
      ...(input.criteria !== undefined ? { criteria: input.criteria } : {}),
      ...(surveyBrief !== undefined ? { surveyBrief } : {}),
    });
    plannerOutcome = runEndOutcome(result.kind);
  } finally {
    stopPlannerHeartbeat();
    await plannerRecorder?.end(plannerOutcome);
  }
  if (result.kind === 'ok') {
    // One remote read per run, here at first branch assignment — the only moment a branch name is
    // chosen. A resume never reaches this path, so a persisted branch is never renamed underneath a
    // half-finished PR.
    const groups = planToPrGroups(
      result.plan,
      input.branch,
      await remoteBranchNames(input.cwd, input.signal),
    );
    harnessProgress(
      `plan ready: ${groups.length} PR group(s) — ${groups.map((g) => g.id).join(', ')}`,
      { phase: 'planning' },
    );
    return { kind: 'ok', groups };
  }
  if (result.kind === 'blocked') return { kind: 'blocked', reason: result.reason };
  return { kind: 'error', error: result.error };
}
