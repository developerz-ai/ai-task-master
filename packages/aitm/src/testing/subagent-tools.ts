// Complete subagent tool sets for tests (issue #132).
//
// `PlannerTools` has 6 required slots and `WorkerTools` 11. A test whose model is mocked never
// reaches a tool, so the suite passed `tools: {}` and `{} as WorkerTools` — the largest single
// source of the errors the `typecheck:tests` gate now catches.
//
// These build the REAL tools from the same factories production uses, rooted at a caller-supplied
// cwd. A stub set would have been shorter, but every stub is a second definition of a tool's shape
// that drifts silently; the real factories cannot drift from themselves. Nothing here executes
// unless a test actually drives a tool call.

import type { SubagentHandle } from '@developerz.ai/ai-claude-compat';
import { localEditTools, localReadTools, type RoleTools } from '../loop/tool-resolution.ts';
import type { PlannerTools } from '../subagents/planner.ts';
import type { ReviewerTools } from '../subagents/reviewer.ts';
import type { WorkerTools } from '../subagents/worker.ts';
import { githubThreadTool } from '../tools/github-thread-tool.ts';

// `localReadTools` returns PlannerTools plus an optional `fetchHtml`; the extra key is harmless
// structurally but the tests want the exact type, so the slots are named explicitly.
export function plannerTools(over: Partial<PlannerTools> = {}): PlannerTools {
  const t = localReadTools(process.cwd());
  return {
    readFile: t.readFile,
    grep: t.grep,
    glob: t.glob,
    webFetch: t.webFetch,
    webSearch: t.webSearch,
    datetime: t.datetime,
    ...over,
  };
}

export function workerTools(over: Partial<WorkerTools> = {}): WorkerTools {
  const read = localReadTools(process.cwd());
  const edit = localEditTools(process.cwd());
  return {
    readFile: read.readFile,
    grep: read.grep,
    glob: read.glob,
    webFetch: read.webFetch,
    webSearch: read.webSearch,
    datetime: read.datetime,
    writeFile: edit.writeFile,
    editFile: edit.editFile,
    multiEdit: edit.multiEdit,
    bash: edit.bash,
    multiBash: edit.multiBash,
    ...over,
  };
}

// ReviewerTools is WorkerTools plus the PR-thread tool. Its client is a no-op: a test that cares
// about replies injects its own recorder through `over`.
export function reviewerTools(over: Partial<ReviewerTools> = {}): ReviewerTools {
  return {
    ...workerTools(),
    github: githubThreadTool({
      github: { replyToThread: async () => {}, resolveThread: async () => {} },
    }),
    ...over,
  };
}

// A `WorkerResult` of kind 'ok' carries the manifest-planning conversation so a later CI-fix pass
// can continue it (#107). Tests that only assert on the delivery still have to supply one; the
// agent is never touched on those paths, so it stands in as an opaque marker.
export function workerHandle(marker = 'worker-handle'): SubagentHandle<WorkerTools> {
  return { agent: {} as never, messages: [{ role: 'user', content: marker }] };
}

// What a `ScoutAgentInit.tools` factory returns (issue #333): the agent's own record plus the mount
// its activation step reads. `activated: null` is the nothing-deferred case, so a test that says
// nothing about MCP gets the same prepareStep it had before deferred loading existed.
export function roleTools(over: Partial<PlannerTools> = {}): RoleTools<PlannerTools> {
  return {
    tools: plannerTools(over),
    mount: { extraTools: {}, indexBlock: '', deferredNames: new Set(), activated: null },
  };
}
