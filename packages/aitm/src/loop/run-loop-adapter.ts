// Production wiring for `aitm start`. Composes the WorkLoop's structural ports out of the
// real Planner, Orchestrator, WorktreePool, PlanGraph, MCP tools and GitHubClient.
//
// Symmetric counterpart to the merge-pr flow: `runStart` injects this as its `runLoop` seam
// (see src/cli/commands.ts `defaultRunLoop`). Every external dependency is reachable through
// a seam so the four WorkLoopResult branches are unit-testable without spawning subagents,
// git, or `gh` — the integration suite (test/integration/) covers the real stack.
//
// Flow:
//   1. Resume detection — if state already holds prGroups, reuse them; else run the Planner.
//   2. Persist the plan into RunState (status → working).
//   3. Build a *live* PlanGraph that re-reads the mirrored prGroups on every ready()/isComplete()
//      so status transitions written by the loop are visible (PlanGraph snapshots at construction).
//   4. Bridge the Orchestrator/subagents into the WorkLoopOrchestrator port and run the loop.

import { resolve as resolvePath } from 'node:path';
import {
  bashTool,
  composeSystemPrompt,
  editFileTool,
  FileStateTracker,
  globTool,
  grepTool,
  multiBashTool,
  multiEditTool,
  readFileTool,
  writeFileTool,
} from '@developerz.ai/ai-claude-compat';
import { type Tool, type ToolSet, tool } from 'ai';
import { z } from 'zod';
// Type-only import — no runtime cycle with commands.ts, which imports this module's value.
import type { RunLoopInput } from '../cli/commands.ts';
import { buildCompactionStep } from '../compaction/compaction-step.ts';
import { Compactor } from '../compaction/compactor.ts';
import type { GitHubClient } from '../github/github-client.ts';
import { McpClientManager } from '../mcp/mcp-client.ts';
import { OpenRouterClient } from '../openrouter/client.ts';
import { ModelLimitsRegistry } from '../openrouter/model-limits.ts';
import { Orchestrator } from '../orchestrator/orchestrator.ts';
import { PlanGraph } from '../plan/plan-graph.ts';
import type { PlanMarkdownGroup } from '../plan/plan-markdown.ts';
import type { Plan } from '../plan/schema.ts';
import { PrContextStore } from '../state/pr-context-store.ts';
import type { PrGroup, RunState } from '../state/schema.ts';
import {
  createPlannerAgent,
  PLANNER_SYSTEM_PREFIX,
  type PlannerTools,
  runPlanner,
} from '../subagents/planner.ts';
import {
  createReviewerAgent,
  type GithubToolInput,
  type GithubToolOutput,
  REVIEWER_SYSTEM_PREFIX,
  type ReviewerTools,
  runReviewer as runReviewerSubagent,
} from '../subagents/reviewer.ts';
import {
  createWorkerAgent,
  runWorker as runWorkerSubagent,
  WORKER_SYSTEM_PREFIX,
  type WorkerTools,
} from '../subagents/worker.ts';
import { runGit } from '../workspace/git-exec.ts';
import { WorktreePool } from '../workspace/worktree-pool.ts';
import { runFixSession } from './ci-fix.ts';
import { hasInterruptedGroup, normalizeResumeStatus } from './resume-normalize.ts';
import {
  type ReviewerInvocation,
  WorkLoop,
  type WorkLoopGithub,
  type WorkLoopGraph,
  type WorkLoopOrchestrator,
  type WorkLoopResult,
  type WorkLoopState,
} from './work-loop.ts';

// Worktree-scoped Claude-Code-style tools the Worker/Reviewer fall back to when no MCP server
// supplies them. aitm is MCP-first, but a bare `aitm start` (no `mcpServers` configured) must
// still be able to read, search, edit, commit and open a PR — so it uses the compat lib's
// tools, scoped to the active worktree.
export function localEditTools(cwd: string): WorkerTools {
  // One FileStateTracker per tool set (per subagent invocation) so read-before-edit enforcement is
  // scoped to a single run — the four file tools share it (issue #104).
  const fileState = new FileStateTracker();
  return {
    readFile: readFileTool({ cwd, fileState }),
    writeFile: writeFileTool({ cwd, fileState }),
    editFile: editFileTool({ cwd, fileState }),
    multiEdit: multiEditTool({ cwd, fileState }),
    grep: grepTool({ cwd }),
    glob: globTool({ cwd }),
    bash: bashTool({ cwd }),
    multiBash: multiBashTool({ cwd }),
  };
}

// Read-only subset for the Planner — survey the repo without write/edit/bash.
export function localReadTools(cwd: string): PlannerTools {
  const fileState = new FileStateTracker();
  return {
    readFile: readFileTool({ cwd, fileState }),
    grep: grepTool({ cwd }),
    glob: globTool({ cwd }),
  };
}

// Narrow state surface the adapter drives. StateStore satisfies it; tests pass an in-memory stub.
// readContext is optional — the rolling summary of prior PRs is threaded into subagent prompts
// when present, and the run still works (empty context) when the port omits it.
export type AdapterStatePort = {
  read(): Promise<RunState>;
  update(mutator: (s: RunState) => RunState): Promise<RunState>;
  readContext?(): Promise<string | null>;
  // Persist plan groups as the loop marks tasks done; StateStore renders them to plan.md.
  // Optional so in-memory test stubs can omit it; StateStore supplies it in production.
  writePlan?(groups: readonly PlanMarkdownGroup[]): Promise<void>;
};

export type PlanGroupsOutcome =
  | { kind: 'ok'; groups: PrGroup[] }
  | { kind: 'blocked'; reason: string }
  | { kind: 'error'; error: string };

export type OrchestratorBridgeCtx = {
  input: RunLoopInput;
  mcp: McpClientManager;
  rollingContext: string;
};

export type RunLoopAdapterSeams = {
  planGroups?: (input: RunLoopInput, mcp: McpClientManager) => Promise<PlanGroupsOutcome>;
  makeOrchestrator?: (
    ctx: OrchestratorBridgeCtx,
  ) => WorkLoopOrchestrator | Promise<WorkLoopOrchestrator>;
  makePool?: (input: RunLoopInput) => WorkLoopPool;
  makeGithub?: (input: RunLoopInput) => WorkLoopGithub;
  makeMcp?: (input: RunLoopInput) => McpClientManager;
  state?: AdapterStatePort;
};

// Re-exported for the seam type below without re-importing WorkLoopPool everywhere.
export type WorkLoopPool = import('./work-loop.ts').WorkLoopPool;

export async function runLoopAdapter(
  input: RunLoopInput,
  seams: RunLoopAdapterSeams = {},
): Promise<WorkLoopResult> {
  const state = seams.state ?? input.state;
  // MCP is only needed when a real Planner / Orchestrator default runs. When both are stubbed
  // (unit tests), we never connect, so no transport is spawned.
  const usesMcp = !seams.planGroups || !seams.makeOrchestrator;
  const mcp = seams.makeMcp
    ? seams.makeMcp(input)
    : new McpClientManager({ servers: input.resolved.mcpServers });

  let mcpConnected = false;
  try {
    if (usesMcp && !seams.makeMcp) {
      await mcp.connectAll();
      mcpConnected = true;
    }

    const current = await state.read();
    const rollingContext = (await state.readContext?.()) ?? '';

    // ---- Plan (fresh) or resume (prior prGroups present) -------------------
    let groups: PrGroup[];
    if (current.prGroups.length > 0) {
      // Resume: a run interrupted mid-lifecycle persisted its groups as 'in-progress'/'awaiting-pr',
      // which PlanGraph.ready() won't schedule. Normalize them back to 'pending' (preserving stage +
      // pr) so they re-enter the loop and resume at their persisted stage instead of being stranded.
      if (hasInterruptedGroup(current.prGroups)) {
        const next = await state.update((s) => ({
          ...s,
          prGroups: normalizeResumeStatus(s.prGroups),
        }));
        groups = next.prGroups;
      } else {
        groups = current.prGroups;
      }
    } else {
      const planFn = seams.planGroups ?? defaultPlanGroups;
      const outcome = await planFn(input, mcp);
      if (outcome.kind === 'blocked') {
        return { kind: 'blocked', reason: outcome.reason, outcomes: [] };
      }
      if (outcome.kind === 'error') {
        return { kind: 'blocked', reason: `planner error: ${outcome.error}`, outcomes: [] };
      }
      if (outcome.groups.length === 0) {
        return { kind: 'blocked', reason: 'planner produced no PR groups', outcomes: [] };
      }
      groups = outcome.groups;
      await state.update((s) => ({ ...s, status: 'working', prGroups: groups }));
    }

    // ---- Live graph + state proxy ------------------------------------------
    // PlanGraph captures its groups at construction, so rebuild it per call against the
    // mirror that workLoopState keeps in sync after every persisted update.
    let liveGroups: readonly PrGroup[] = groups;
    const graph: WorkLoopGraph = {
      ready: () => new PlanGraph([...liveGroups]).ready(),
      isComplete: () => new PlanGraph([...liveGroups]).isComplete(),
    };
    const workLoopState: WorkLoopState = {
      update: async (mutator) => {
        const next = await state.update(mutator);
        liveGroups = next.prGroups;
        return next;
      },
      writePlan: async (groups) => {
        await state.writePlan?.(groups);
      },
    };

    // ---- Remaining deps ----------------------------------------------------
    const pool =
      seams.makePool?.(input) ??
      new WorktreePool(
        input.cwd,
        resolvePath(input.cwd, '.ai-task-master'),
        input.resolved.concurrency,
      );
    const github = seams.makeGithub?.(input) ?? input.github;
    const orchestrator = await (seams.makeOrchestrator ?? defaultMakeOrchestrator)({
      input,
      mcp,
      rollingContext,
    });

    const loop = new WorkLoop({
      orchestrator,
      github,
      state: workLoopState,
      pool,
      graph,
      // Persist addressed review threads so the addressing-reviews loop dedups across re-polls.
      prContext: new PrContextStore(resolvePath(input.cwd, '.ai-task-master')),
      concurrency: input.resolved.concurrency,
      autoMerge: input.resolved.autoMerge,
      prPerTask: current.options.prPerTask ?? false,
      maxSessions: input.resolved.maxSessions,
      mergeMethod: input.resolved.mergeMethod,
      adminMerge: input.resolved.adminMerge ?? false,
      initialSessionCount: current.sessionCount,
    });
    return await loop.run();
  } finally {
    if (mcpConnected) {
      await mcp.close();
    }
  }
}

// ---- Plan ------------------------------------------------------------------

// Normalize a Planner-supplied group id into a safe git ref component. The id is only
// `z.string()` in the plan schema, so it can carry characters (leading '.', '.lock', spaces,
// ':' …) that would make `aitm/<id>` or `<branch>/<id>` an invalid ref and fail at worktree
// creation. Map unsafe chars to '-', strip the component-level footguns, never return empty.
export function sanitizeBranchComponent(id: string): string {
  let s = id.replace(/[^A-Za-z0-9._-]/g, '-');
  s = s.replace(/\.\.+/g, '.'); // collapse '..' (forbidden in refs)
  s = s.replace(/^[.-]+/, ''); // no leading '.' or '-'
  s = s.replace(/(?:\.lock)+$/i, ''); // no trailing '.lock'
  s = s.replace(/[.-]+$/, ''); // no trailing '.' or '-'
  return s.length > 0 ? s : 'group';
}

// Resolve a group's branch name, honoring a caller-specified `--branch`.
//   - no branch requested        → `aitm/<group-id>` (default)
//   - requested, single group    → the requested name verbatim (already validated by the CLI)
//   - requested, multiple groups → `<requested>/<group-id>` so concurrent worktrees
//     (and the PRs they open) don't collide on one branch name.
// The group-id segment is always sanitized so the composed ref is valid regardless of what the
// Planner emitted.
export function branchFor(
  groupId: string,
  requested: string | undefined,
  totalGroups: number,
): string {
  const safeId = sanitizeBranchComponent(groupId);
  if (requested === undefined) return `aitm/${safeId}`;
  return totalGroups <= 1 ? requested : `${requested}/${safeId}`;
}

export function planToPrGroups(plan: Plan, branch?: string): PrGroup[] {
  const total = plan.groups.length;
  return plan.groups.map((g) => ({
    id: g.id,
    title: g.title,
    tasks: g.tasks.map((t, i) => ({
      id: `${g.id}-${i + 1}`,
      text: t.description,
      complexity: t.complexity,
      done: false,
    })),
    dependsOn: g.dependsOn,
    branch: branchFor(g.id, branch, total),
    pr: null,
    status: 'pending' as const,
    stage: 'pending' as const,
  }));
}

async function defaultPlanGroups(
  input: RunLoopInput,
  mcp: McpClientManager,
): Promise<PlanGroupsOutcome> {
  const style = input.styleDigest ?? input.agentConfig.contents;
  const agent = createPlannerAgent({
    model: input.credentials.modelFor('planner'),
    tools: resolvePlannerTools(mcp.toolsForRole('planner'), input.cwd),
    systemPrompt: composeSystemPrompt(style, PLANNER_SYSTEM_PREFIX, input.cwd),
  });
  const result = await runPlanner(agent, {
    goal: input.goal,
    styleContents: style,
    maxPrs: input.resolved.maxPrs,
    ...(input.criteria !== undefined ? { criteria: input.criteria } : {}),
  });
  if (result.kind === 'ok')
    return { kind: 'ok', groups: planToPrGroups(result.plan, input.branch) };
  if (result.kind === 'blocked') return { kind: 'blocked', reason: result.reason };
  return { kind: 'error', error: result.error };
}

// ---- Orchestrator bridge ---------------------------------------------------

export function defaultMakeOrchestrator(ctx: OrchestratorBridgeCtx): WorkLoopOrchestrator {
  const { input, mcp, rollingContext } = ctx;
  const style = input.styleDigest ?? input.agentConfig.contents;

  // One Compactor per run: summarize-and-continue when a subagent's context window fills, instead
  // of dying on a provider overflow on the "really big PRs" runs aitm exists for (issue #102). The
  // summarizer is the fast tier; model-limits come from the OpenRouter catalog (lazy, cached; a
  // lookup miss or fetch failure just skips compaction — non-fatal). Threaded into both worker
  // paths (stage machine + CI-fix) and the reviewer.
  const compactor = new Compactor({
    summarizer: input.credentials.modelForCapability('fast'),
    limits: new ModelLimitsRegistry(
      new OpenRouterClient(input.resolved.openrouterApiKey, input.resolved.baseURL),
    ),
  });
  const orch = new Orchestrator({
    credentials: input.credentials,
    agentConfig: input.agentConfig,
    ...(input.styleDigest !== undefined ? { styleDigest: input.styleDigest } : {}),
    rollingContext,
    maxSessions: input.resolved.maxSessions,
    github: input.github,
    ...(input.resolved.prBodySections !== undefined
      ? { prBodySections: input.resolved.prBodySections }
      : {}),
  });

  // Build + run the Reviewer over a thread set in the given worktree. Shared by the prPerTask
  // autoMergeFlow (runReviewer) and the stage machine (addressReviews).
  const runReviewerThreads = ({ pr, threads, worktree }: ReviewerInvocation) => {
    const github = githubThreadTool(input.github);
    const tools = resolveReviewerTools(mcp.toolsForRole('reviewer'), worktree.path, github);
    const agent = createReviewerAgent({
      model: input.credentials.modelFor('reviewer'),
      tools,
      systemPrompt: composeSystemPrompt(style, REVIEWER_SYSTEM_PREFIX, worktree.path),
      prepareStep: buildCompactionStep<ReviewerTools>({
        compactor,
        modelId: input.credentials.modelIdFor('reviewer'),
      }),
    });
    return runReviewerSubagent(agent, {
      pr,
      threads,
      worktreePath: worktree.path,
      styleContents: style,
    });
  };

  return {
    runWorker: async ({ group, task, worktree, baseBranch }) => {
      // Prefer MCP-supplied tools; partial-fill any the server omits from the local set so a
      // bare `aitm start` (no mcpServers configured) can still edit, commit and open a PR.
      const tools = resolveWorkerTools(mcp.toolsForRole('worker'), worktree.path);
      const agent = createWorkerAgent({
        model: input.credentials.modelFor('worker'),
        tools,
        systemPrompt: composeSystemPrompt(style, WORKER_SYSTEM_PREFIX, worktree.path),
        prepareStep: buildCompactionStep<WorkerTools>({
          compactor,
          modelId: input.credentials.modelIdFor('worker'),
        }),
      });
      return runWorkerSubagent(agent, {
        group,
        ...(task ? { task } : {}),
        worktreePath: worktree.path,
        baseBranch,
        styleContents: style,
        rollingContext,
        ...(input.resolved.formatCommand ? { formatCommand: input.resolved.formatCommand } : {}),
        ...(input.resolved.verifyCommand ? { verifyCommand: input.resolved.verifyCommand } : {}),
      });
    },
    finalizeCommit: (group, delivery, worktreePath) =>
      orch.finalizeCommit(group, delivery, worktreePath),
    openPr: async (group, delivery, baseBranch) => {
      // The Worker's commits live on the group branch in a linked worktree (shared object
      // store). Push it to origin first — `gh pr create` won't open a PR for a branch that
      // isn't on the remote ("No commits between … / Head ref must be a branch").
      const head = group.branch ?? `aitm/${group.id}`;
      await runGit(['push', '-u', 'origin', head], { cwd: input.cwd });
      return orch.openPr(group, delivery, baseBranch);
    },
    runReviewer: runReviewerThreads,
    // ci-failed stage → shared fix session: download failed logs + comments to the state dir, run
    // the coding-capability Worker pointed at them, rebase onto origin/<base>, force-with-lease push.
    runCiFix: async ({ group, pr, worktree, baseBranch }) => {
      const result = await runFixSession({
        github: input.github,
        prContext: new PrContextStore(resolvePath(input.cwd, '.ai-task-master')),
        subagents: {
          credentials: input.credentials,
          workerTools: resolveWorkerTools(mcp.toolsForRole('worker'), worktree.path),
          styleContents: style,
          compactor,
          ...(input.resolved.formatCommand ? { formatCommand: input.resolved.formatCommand } : {}),
          ...(input.resolved.verifyCommand ? { verifyCommand: input.resolved.verifyCommand } : {}),
        },
        group,
        pr,
        baseBranch,
        worktreePath: worktree.path,
        allowForcePush: input.resolved.allowForcePush,
      });
      return result.kind === 'fixed' ? { kind: 'ok' } : { kind: 'blocked', reason: result.reason };
    },
    // addressing-reviews stage → run the Reviewer, then push its commits so the PR updates. The
    // Reviewer commits code fixes locally (worker pattern); a plain push suffices (additive commits,
    // no history rewrite). Replied/wontfix-only rounds make no commit, so there's nothing to push.
    addressReviews: async ({ pr, threads, worktree }) => {
      const result = await runReviewerThreads({ pr, threads, worktree });
      if (result.kind !== 'ok') {
        return {
          kind: 'blocked',
          reason: result.kind === 'blocked' ? result.reason : result.error,
        };
      }
      if (result.resolutions.some((r) => r.kind === 'fixed')) {
        await runGit(['push'], { cwd: worktree.path });
      }
      return { kind: 'ok' };
    },
  };
}

// MCP exposes a dynamically-typed ToolSet. The subagents need a statically-shaped tool record.
// Rather than fail closed when a server only exports the legacy readFile/writeFile/bash, we
// partial-fill: prefer the MCP tool for each name, falling back to the local worktree-scoped
// tool for any the server omits. The shape is asserted once at this boundary.
function resolveWorkerTools(set: ToolSet, cwd: string): WorkerTools {
  const local = localEditTools(cwd);
  return {
    readFile: set.readFile ?? local.readFile,
    writeFile: set.writeFile ?? local.writeFile,
    editFile: set.editFile ?? local.editFile,
    multiEdit: set.multiEdit ?? local.multiEdit,
    grep: set.grep ?? local.grep,
    glob: set.glob ?? local.glob,
    bash: set.bash ?? local.bash,
    multiBash: set.multiBash ?? local.multiBash,
  } as WorkerTools;
}

function resolveReviewerTools(
  set: ToolSet,
  cwd: string,
  github: Tool<GithubToolInput, GithubToolOutput>,
): ReviewerTools {
  return { ...resolveWorkerTools(set, cwd), github };
}

// The Planner gets only the read-only subset, partial-filled the same way. This is also the fix
// for the latent no-MCP bug: previously the Planner was handed the raw MCP ToolSet with no local
// fallback, so a bare `aitm start` left it with zero tools despite its prompt promising
// readFile/grep/glob.
function resolvePlannerTools(set: ToolSet, cwd: string): PlannerTools {
  const local = localReadTools(cwd);
  return {
    readFile: set.readFile ?? local.readFile,
    grep: set.grep ?? local.grep,
    glob: set.glob ?? local.glob,
  } as PlannerTools;
}

// The Reviewer's `github` tool is local glue over GitHubClient — not an MCP tool — so the
// adapter constructs it here rather than sourcing it from a server.
type ThreadGithub = Pick<GitHubClient, 'replyToThread' | 'resolveThread'>;

// Flat object, not a discriminatedUnion → no `oneOf` in the tool params (rejected by some
// OpenRouter-routed providers). `body` applies to replyToThread only.
const githubToolInputSchema = z.object({
  action: z.enum(['replyToThread', 'resolveThread']),
  threadId: z.string().min(1),
  body: z.string().optional(),
});

export function githubThreadTool(github: ThreadGithub): Tool<GithubToolInput, GithubToolOutput> {
  return tool<GithubToolInput, GithubToolOutput>({
    description: 'Reply to or resolve a PR review thread.',
    inputSchema: githubToolInputSchema,
    execute: async (input): Promise<GithubToolOutput> => {
      if (input.action === 'replyToThread') {
        await github.replyToThread(input.threadId, input.body ?? '');
        return { ok: true };
      }
      await github.resolveThread(input.threadId);
      return { ok: true };
    },
  });
}
