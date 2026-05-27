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
import { type Tool, type ToolSet, tool } from 'ai';
import { execa } from 'execa';
import { z } from 'zod';
// Type-only import — no runtime cycle with commands.ts, which imports this module's value.
import type { RunLoopInput } from '../cli/commands.ts';
import type { GitHubClient } from '../github/github-client.ts';
import { McpClientManager } from '../mcp/mcp-client.ts';
import { Orchestrator } from '../orchestrator/orchestrator.ts';
import { PlanGraph } from '../plan/plan-graph.ts';
import type { Plan } from '../plan/schema.ts';
import type { PrGroup, RunState } from '../state/schema.ts';
import { createPlannerAgent, PLANNER_SYSTEM_PREFIX, runPlanner } from '../subagents/planner.ts';
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
import { bashTool, readFileTool, writeFileTool } from '../tools/fs-tools.ts';
import { WorktreePool } from '../workspace/worktree-pool.ts';
import {
  WorkLoop,
  type WorkLoopGithub,
  type WorkLoopGraph,
  type WorkLoopOrchestrator,
  type WorkLoopResult,
  type WorkLoopState,
} from './work-loop.ts';

// Worktree-scoped edit tools the Worker/Reviewer fall back to when no MCP server supplies
// readFile/writeFile/bash. aitm is MCP-first, but a bare `aitm start` (no `mcpServers`
// configured) must still be able to edit, commit and open a PR — so it uses aitm's own
// fs-tools (the same ones the merge-pr flow already wires), scoped to the active worktree.
export function localEditTools(cwd: string): WorkerTools {
  return {
    readFile: readFileTool({ cwd }),
    writeFile: writeFileTool({ cwd }),
    bash: bashTool({ cwd }),
  };
}

// Narrow state surface the adapter drives. StateStore satisfies it; tests pass an in-memory stub.
// readContext is optional — the rolling summary of prior PRs is threaded into subagent prompts
// when present, and the run still works (empty context) when the port omits it.
export type AdapterStatePort = {
  read(): Promise<RunState>;
  update(mutator: (s: RunState) => RunState): Promise<RunState>;
  readContext?(): Promise<string | null>;
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
      groups = current.prGroups;
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
      concurrency: input.resolved.concurrency,
      autoMerge: input.resolved.autoMerge,
      maxSessions: input.resolved.maxSessions,
      mergeMethod: input.resolved.mergeMethod,
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

export function planToPrGroups(plan: Plan): PrGroup[] {
  return plan.groups.map((g) => ({
    id: g.id,
    title: g.title,
    tasks: g.tasks.map((t) => t.description),
    dependsOn: g.dependsOn,
    branch: `aitm/${g.id}`,
    pr: null,
    status: 'pending' as const,
  }));
}

async function defaultPlanGroups(
  input: RunLoopInput,
  mcp: McpClientManager,
): Promise<PlanGroupsOutcome> {
  const style = input.agentConfig.contents;
  const agent = createPlannerAgent({
    model: input.credentials.modelFor('planner'),
    tools: mcp.toolsForRole('planner'),
    systemPrompt: style + PLANNER_SYSTEM_PREFIX,
  });
  const result = await runPlanner(agent, {
    goal: input.goal,
    styleContents: style,
    maxPrs: input.resolved.maxPrs,
    ...(input.criteria !== undefined ? { criteria: input.criteria } : {}),
  });
  if (result.kind === 'ok') return { kind: 'ok', groups: planToPrGroups(result.plan) };
  if (result.kind === 'blocked') return { kind: 'blocked', reason: result.reason };
  return { kind: 'error', error: result.error };
}

// ---- Orchestrator bridge ---------------------------------------------------

function defaultMakeOrchestrator(ctx: OrchestratorBridgeCtx): WorkLoopOrchestrator {
  const { input, mcp, rollingContext } = ctx;
  const style = input.agentConfig.contents;
  const orch = new Orchestrator({
    credentials: input.credentials,
    agentConfig: input.agentConfig,
    rollingContext,
    maxSessions: input.resolved.maxSessions,
    github: input.github,
  });

  return {
    runWorker: async ({ group, worktree, baseBranch }) => {
      // Prefer MCP-supplied edit tools; fall back to aitm's own worktree-scoped fs-tools so a
      // bare `aitm start` (no mcpServers configured) can still edit, commit and open a PR.
      const tools = extractWorkerTools(mcp.toolsForRole('worker')) ?? localEditTools(worktree.path);
      const agent = createWorkerAgent({
        model: input.credentials.modelFor('worker'),
        tools,
        systemPrompt: style + WORKER_SYSTEM_PREFIX,
      });
      return runWorkerSubagent(agent, {
        group,
        worktreePath: worktree.path,
        baseBranch,
        styleContents: style,
        rollingContext,
      });
    },
    finalizeCommit: (group, delivery, worktreePath) =>
      orch.finalizeCommit(group, delivery, worktreePath),
    openPr: async (group, delivery, baseBranch) => {
      // The Worker's commits live on the group branch in a linked worktree (shared object
      // store). Push it to origin first — `gh pr create` won't open a PR for a branch that
      // isn't on the remote ("No commits between … / Head ref must be a branch").
      const head = group.branch ?? `aitm/${group.id}`;
      await execa('git', ['push', '-u', 'origin', head], { cwd: input.cwd });
      return orch.openPr(group, delivery, baseBranch);
    },
    runReviewer: async ({ pr, threads, worktree }) => {
      const github = githubThreadTool(input.github);
      // Same fallback as the Worker: local fs-tools when no MCP server supplies them.
      const tools = extractReviewerTools(mcp.toolsForRole('reviewer'), github) ?? {
        ...localEditTools(worktree.path),
        github,
      };
      const agent = createReviewerAgent({
        model: input.credentials.modelFor('reviewer'),
        tools,
        systemPrompt: style + REVIEWER_SYSTEM_PREFIX,
      });
      return runReviewerSubagent(agent, {
        pr,
        threads,
        worktreePath: worktree.path,
        styleContents: style,
      });
    },
  };
}

// MCP exposes a dynamically-typed ToolSet. The Worker/Reviewer agents need a statically-shaped
// tool record; we validate the required names are present, then assert the shape at this single
// boundary. Returns null when any required tool is missing so the caller can block cleanly.
function extractWorkerTools(set: ToolSet): WorkerTools | null {
  const { readFile, writeFile, bash } = set;
  if (!readFile || !writeFile || !bash) return null;
  return { readFile, writeFile, bash } as WorkerTools;
}

function extractReviewerTools(
  set: ToolSet,
  github: Tool<GithubToolInput, GithubToolOutput>,
): ReviewerTools | null {
  const { readFile, writeFile, bash } = set;
  if (!readFile || !writeFile || !bash) return null;
  return { readFile, writeFile, bash, github } as ReviewerTools;
}

// The Reviewer's `github` tool is local glue over GitHubClient — not an MCP tool — so the
// adapter constructs it here rather than sourcing it from a server.
type ThreadGithub = Pick<GitHubClient, 'replyToThread' | 'resolveThread'>;

const githubToolInputSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('replyToThread'), threadId: z.string(), body: z.string() }),
  z.object({ action: z.literal('resolveThread'), threadId: z.string() }),
]);

export function githubThreadTool(github: ThreadGithub): Tool<GithubToolInput, GithubToolOutput> {
  return tool<GithubToolInput, GithubToolOutput>({
    description: 'Reply to or resolve a PR review thread.',
    inputSchema: githubToolInputSchema,
    execute: async (input): Promise<GithubToolOutput> => {
      if (input.action === 'replyToThread') {
        await github.replyToThread(input.threadId, input.body);
        return { ok: true };
      }
      await github.resolveThread(input.threadId);
      return { ok: true };
    },
  });
}
