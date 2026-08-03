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
  createGoalAssessorAgent,
  GOAL_ASSESSOR_SYSTEM_PREFIX,
  type GoalAssessment,
  runGoalAssessor,
} from '../subagents/goal-assessor.ts';
import {
  createPlannerAgent,
  PLANNER_SYSTEM_PREFIX,
  type PlannerResult,
  type PlannerTools,
  runPlanner,
} from '../subagents/planner.ts';
import {
  createScoutRunner,
  SCOUT_SYSTEM_PREFIX,
  type ScoutAgentInit,
  synthesizeSurveyBrief,
} from '../subagents/planner-scouts.ts';
import { harnessContextBlock, reminderAgentSystemPrompt } from '../subagents/role-prompt.ts';
import { createScoutLeadRunner, SCOUT_LEAD_SYSTEM_PREFIX } from '../subagents/scout-lead.ts';
import { runScoutSurvey, type ScoutSurveyEvent } from '../subagents/scout-survey.ts';
import {
  dedupeBranchNames,
  sanitizeBranchComponent,
  slugifyTitle,
} from '../workspace/branch-name.ts';
import { runGit } from '../workspace/git-exec.ts';
import { buildRepoSkeleton, renderRepoSkeleton } from '../workspace/repo-skeleton.ts';
import {
  beginTranscript,
  memoryIndexFor,
  resolveStyleContents,
  runEndOutcome,
  runProgressReminder,
} from './adapter-support.ts';
import { buildSubagentSession } from './subagent-session.ts';
import {
  appendIndexBlock,
  applyHooks,
  buildExploreFor,
  decorateTools,
  mountDeferredTools,
  resolvePlannerTools,
  type WithExplore,
  withActiveTools,
} from './tool-resolution.ts';

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

// Make a later wave's groups safe to append to the ones already in state. The Planner numbers every
// plan from `g1`, so wave 2 collides with wave 1 head-on: same ids, same branches, same task ids.
// Ids are rewritten `w<wave>-<id>` on collision, `dependsOn` follows the rename, task ids are rebuilt
// from the new group id, and a colliding branch takes a `-w<wave>` suffix. Cross-wave deps need no
// edge: earlier groups are already merged, so PlanGraph treats them as satisfied.
export function namespaceWaveGroups(
  fresh: readonly PrGroup[],
  taken: readonly PrGroup[],
  wave: number,
): PrGroup[] {
  const takenIds = new Set(taken.map((g) => g.id));
  const takenBranches = new Set(
    taken.map((g) => g.branch).filter((b): b is string => typeof b === 'string'),
  );
  const idMap = new Map<string, string>();
  for (const group of fresh) {
    let id = group.id;
    if (takenIds.has(id)) {
      id = `w${wave}-${group.id}`;
      for (let n = 2; takenIds.has(id); n++) id = `w${wave}-${group.id}-${n}`;
    }
    takenIds.add(id);
    idMap.set(group.id, id);
  }
  return fresh.map((group) => {
    const id = idMap.get(group.id) ?? group.id;
    let branch = group.branch;
    if (typeof branch === 'string' && takenBranches.has(branch)) {
      const base = branch;
      branch = `${base}-w${wave}`;
      for (let n = 2; takenBranches.has(branch); n++) branch = `${base}-w${wave}-${n}`;
    }
    if (typeof branch === 'string') takenBranches.add(branch);
    return {
      ...group,
      id,
      branch,
      dependsOn: group.dependsOn.map((dep) => idMap.get(dep) ?? dep),
      tasks: group.tasks.map((task, i) => ({ ...task, id: `${id}-${i + 1}` })),
    };
  });
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

// Every git-tracked path, the raw material for the repo map the survey runs on
// (workspace/repo-skeleton.ts). Tracked files exclude node_modules/dist by construction (gitignored),
// so no vendor filter is needed. A non-repo or a git failure returns [], which yields an empty map
// and a survey that simply starts without one — never a failed run.
export async function listTrackedFiles(cwd: string): Promise<string[]> {
  try {
    const result = await runGit(['ls-files'], { cwd });
    return result.stdout.split('\n').filter((line) => line.trim() !== '');
  } catch {
    return [];
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

// Run the scout survey before planning and return the synthesized brief — the repo map plus whatever
// the team found — or undefined when there is nothing at all to hand over. Best-effort throughout: a
// git, lead, or scout failure degrades the brief, never blocks the planner.
// Exported for unit testing — it is the only place that builds a real ScoutAgentInit (model, tools,
// system prompt, timeout, usage sink, signal) from a RunLoopInput; createScoutRunner itself is
// covered against a hand-built ScoutAgentInit in planner-scouts.test.ts, but that never exercises
// this wiring.
// Below this many tracked files, the Planner reads the repo end to end itself faster than a scout
// wave can survey it. Measured: an 11-file docs-only repo drew 2 rounds / 6 scouts over ~11 minutes,
// and the Planner then read the same files again anyway — the survey bought nothing but latency.
export const SURVEY_MIN_TRACKED_FILES = 25;

export async function surveyRepoForPlanner(params: {
  input: RunLoopInput;
  style: string;
  plannerModelId: string;
  plannerUsage?: OnUsage;
  mcp: McpClientManager;
  fetchHtmlAvailable: boolean;
}): Promise<string | undefined> {
  const { input, style, plannerModelId, plannerUsage, mcp, fetchHtmlAvailable } = params;
  const skeleton = buildRepoSkeleton(await listTrackedFiles(input.cwd));
  const repoMap = skeleton.totalFiles === 0 ? '' : renderRepoSkeleton(skeleton);
  // Small repo: hand over the map and skip the wave entirely. No lead call, no scouts, no rounds.
  // `totalFiles === 0` is NOT small — listTrackedFiles swallows a git failure into an empty list, so
  // zero means "size unknown" (no origin, not a repo) and must still survey.
  if (skeleton.totalFiles > 0 && skeleton.totalFiles < SURVEY_MIN_TRACKED_FILES) {
    harnessProgress(
      `survey: skipped — ${skeleton.totalFiles} tracked file(s), the planner reads the repo directly`,
      { phase: 'planning' },
    );
    const mapOnly = synthesizeSurveyBrief([], repoMap);
    return mapOnly === '' ? undefined : mapOnly;
  }
  // Lead and scouts differ only in role prose — same model, same read-only tools, same cancellation.
  // Hooks only, NOT decorateTools: one record is shared by the lead and every scout, so an on-touch
  // nested announcement (#192) would go to whichever member won the race rather than to each of
  // them. Scoping it per agent needs the runner to build its own record — tracked in #333.
  const base = {
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
    timeout: { stepMs: input.resolved.llmStepTimeoutMs },
    ...(plannerUsage ? { onUsage: plannerUsage } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
  };
  const scoutInit = (roleGuidance: string): ScoutAgentInit => ({
    ...base,
    systemPrompt: reminderAgentSystemPrompt({
      style,
      roleGuidance,
      cwd: input.cwd,
      modelId: plannerModelId,
    }),
  });
  const ctx = {
    goal: input.goal,
    ...(input.criteria !== undefined ? { criteria: input.criteria } : {}),
    ...(repoMap === '' ? {} : { repoMap }),
  };
  const findings = await runScoutSurvey({
    ctx,
    lead: createScoutLeadRunner(scoutInit(SCOUT_LEAD_SYSTEM_PREFIX)),
    runScout: createScoutRunner(scoutInit(SCOUT_SYSTEM_PREFIX)),
    // The one subagent knob, shared with the Worker's editor fanout: an operator throttling a
    // rate-limited endpoint means "fewer agents at once", not "fewer editors but the same scouts".
    concurrency: input.resolved.subagentLimit,
    onProgress: reportSurveyProgress,
  }).catch(() => []);
  const brief = synthesizeSurveyBrief(findings, repoMap);
  return brief === '' ? undefined : brief;
}

// Survey events → the operator's progress lines. Named rather than inlined so the wiring above reads
// as the survey it is. The dispatch line names the scouts' territories: it is the operator's only
// window into what the lead decided to look at, and a wave aimed at the wrong areas shows up here
// long before the plan does.
function reportSurveyProgress(event: ScoutSurveyEvent): void {
  const opts = { phase: 'planning' } as const;
  if (event.kind === 'dispatch') {
    const keys = event.assignments.map((a) => a.key).join(', ');
    harnessProgress(
      `survey: round ${event.round}, ${event.assignments.length} scouts on ${keys}`,
      opts,
    );
    return;
  }
  if (event.kind === 'reported') {
    harnessProgress(`survey: ${event.reported}/${event.dispatched} scouts reported`, opts);
    return;
  }
  harnessProgress(
    `survey: complete after ${event.rounds} round(s), ${event.findings} finding(s)`,
    opts,
  );
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
  const plannerModelId = input.credentials.modelIdFor('planner');
  harnessProgress(`planning with ${plannerModelId}: ${input.goal}`, { phase: 'planning' });
  // Pre-planning survey (scout-survey.ts): a lead sizes and aims a wave of read-only scouts at this
  // repo, they roam it concurrently, and the Planner is handed the resulting map so its own steps go
  // to structure instead of discovery. Best-effort: a failed survey degrades to no brief, never
  // blocks — and with no brief the Planner prompt is byte-identical to the un-surveyed path.
  // Runs BEFORE the transcript opens, not between it and the try/finally below: the survey is its own
  // team of agents and none of its records belong to the planner's transcript, and anything throwing
  // in that gap would leave an open 'working' record that nothing ever comes back to close.
  const surveyBrief = await surveyRepoForPlanner({
    input,
    style,
    plannerModelId,
    ...(plannerUsage ? { plannerUsage } : {}),
    mcp,
    fetchHtmlAvailable,
  });
  // Transcript (issue #108): the planner run is recorded (never resumed — it always cold-starts).
  const plannerRecorder = await beginTranscript(input.state.transcripts?.(), { planner: true });
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
  // Deferred loading reaches the Planner too (issue #193, extending #119). Planning is the
  // read-heavy recon pass — what a domain server knows about the system being changed belongs in the
  // plan, not discovered later by a Worker. Below the defer threshold the surplus mounts directly;
  // above it, name-only + `tool_search`. Nothing deferred → `activated` is null and this pass is
  // byte-identical to before, prompt included.
  const plannerMount = mountDeferredTools(mcp.toolSurfaceForRole('planner'));
  const plannerTools = decorateTools(
    {
      ...resolvePlannerTools(
        mcp.toolsForRole('planner'),
        input.cwd,
        fetchHtmlAvailable,
        buildExploreFor(input, input.cwd, plannerUsage),
      ),
      ...plannerMount.extraTools,
    } as WithExplore<PlannerTools>,
    input,
    input.cwd,
  );
  const agent = createPlannerAgent({
    model: input.credentials.modelFor('planner'),
    tools: plannerTools,
    systemPrompt: appendIndexBlock(
      reminderAgentSystemPrompt({
        style,
        roleGuidance: PLANNER_SYSTEM_PREFIX,
        cwd: input.cwd,
        modelId: input.credentials.modelIdFor('planner'),
        memoryIndex,
      }),
      plannerMount.indexBlock,
    ),
    // No compaction step on this role, so activation is the whole prepareStep when it applies.
    ...(plannerMount.activated === null
      ? {}
      : {
          prepareStep: withActiveTools<PlannerTools>(
            undefined,
            plannerTools,
            plannerMount.deferredNames,
            plannerMount.activated,
          ),
        }),
    timeout: { stepMs: input.resolved.llmStepTimeoutMs },
    ...(plannerUsage ? { onUsage: plannerUsage } : {}),
    onStepFinish: session.onStepFinish,
    onRetry: session.onRetry,
    ...(session.onStream ? { onStream: session.onStream } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
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

// The goal assessor's construction site, mirroring defaultPlanGroups' — same model, same read-only
// tools, same cancellation. It judges `input.goal` (the ORIGINAL goal), never the current wave's
// remaining-work goal, so a run cannot declare itself finished by shrinking what it is measured
// against. Never throws: runGoalAssessor resolves every failure to `complete: true`.
export async function defaultAssessGoal(
  input: RunLoopInput,
  mcp: McpClientManager,
  fetchHtmlAvailable: boolean,
  delivered: readonly string[],
): Promise<GoalAssessment> {
  const style = resolveStyleContents(input);
  const modelId = input.credentials.modelIdFor('planner');
  const usage = roleUsageSink(input.usage, 'planner', modelId);
  harnessProgress('checking the goal against the repo', { phase: 'planning' });
  const agent = createGoalAssessorAgent({
    model: input.credentials.modelFor('planner'),
    tools: decorateTools(
      resolvePlannerTools(
        mcp.toolsForRole('planner'),
        input.cwd,
        fetchHtmlAvailable,
        buildExploreFor(input, input.cwd, usage),
      ),
      input,
      input.cwd,
    ),
    systemPrompt: reminderAgentSystemPrompt({
      style,
      roleGuidance: GOAL_ASSESSOR_SYSTEM_PREFIX,
      cwd: input.cwd,
      modelId,
    }),
    timeout: { stepMs: input.resolved.llmStepTimeoutMs },
    ...(usage ? { onUsage: usage } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
  });
  return runGoalAssessor(agent, {
    goal: input.goal,
    delivered,
    contextBlock: harnessContextBlock(),
    ...(input.criteria !== undefined ? { criteria: input.criteria } : {}),
  });
}
