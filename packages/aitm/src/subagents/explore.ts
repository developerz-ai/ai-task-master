// The built-in `explore` tool (issue #126): a read-only survey fan-out mounted into the Planner and
// the Worker's manifest pass. Each call spawns a fresh, bounded, fast-tier child that surveys the
// repo with the read-only trio (readFile/grep/glob) and returns a self-contained conclusion — the
// child ingests the raw file text, the parent's context keeps only the answer. That delegation is
// what stops the survey phase from re-sending file dumps on every step of a long-lived conversation.
//
// This is adapter-local glue (same precedent as the Reviewer's `github` slot): the child model is a
// concrete injected handle and the read tools are worktree-confined — never sourced from MCP.

import {
  AgentToolConstructionError,
  type AgentToolInput,
  makeAgentTool,
} from '@developerz.ai/ai-claude-compat';
import type { LanguageModel, Tool, ToolSet } from 'ai';

// The tool name the model invokes and the ToolSet key it mounts under.
export const EXPLORE_TOOL_NAME = 'explore';

// Read-only allowlist enforced by makeAgentTool — the child may hold only these three tools.
export const EXPLORE_ALLOWED_TOOLS = ['readFile', 'grep', 'glob'] as const;

const EXPLORE_DESCRIPTION =
  'Delegate a read-only repo survey to a fresh sub-agent that reads files, greps, and globs, then ' +
  'returns a self-contained conclusion (with file:line references). The child shares NONE of your ' +
  'context, so the prompt must be a complete, standalone question. Use it for broad or multi-file ' +
  'questions so the raw file text stays out of your own context; issue independent explore calls in ' +
  'the same turn to run them in parallel.';

const EXPLORE_SYSTEM_PROMPT = [
  'You are a read-only survey agent. You answer ONE self-contained question about a code repository.',
  '',
  'Ground every claim in the real code: use readFile (with offset/limit for large files), grep, and',
  'glob to locate and confirm. You cannot edit, write, or run commands — only read.',
  '',
  'Your final message IS the return value handed back to the agent that called you. Make it a',
  'self-contained answer: state the conclusion directly, cite concrete file:line references, and',
  'include only what the caller needs to act — not a narration of your search. If the answer is that',
  'something does not exist, say so plainly.',
].join('\n');

// The child toolset must be exactly the read-only trio (keys matching EXPLORE_ALLOWED_TOOLS); a
// wider set trips makeAgentTool's allowlist. Callers pass the worktree-confined trio from
// localReadTools so the child is rooted at the invoking agent's cwd.
export type ExploreToolInit = {
  model: LanguageModel;
  readTools: ToolSet;
};

export function buildExploreTool(init: ExploreToolInit): Tool<AgentToolInput, string> {
  // The allowlist in makeAgentTool rejects EXTRA tools but does not require the trio to be present;
  // an explore child missing readFile/grep/glob would construct yet be unable to survey. Require all
  // three up front so a mis-wired caller fails loudly at construction, not silently at survey time.
  const missing = EXPLORE_ALLOWED_TOOLS.filter((name) => !(name in init.readTools));
  if (missing.length > 0) {
    throw new AgentToolConstructionError(
      `explore tool requires the read-only trio; missing: ${missing.join(', ')}`,
    );
  }
  return makeAgentTool(
    {
      name: EXPLORE_TOOL_NAME,
      description: EXPLORE_DESCRIPTION,
      systemPrompt: EXPLORE_SYSTEM_PROMPT,
    },
    { model: init.model, tools: init.readTools, allowedTools: [...EXPLORE_ALLOWED_TOOLS] },
  );
}
