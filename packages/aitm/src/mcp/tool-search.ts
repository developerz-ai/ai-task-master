// Deferred MCP tool loading (issue #119). When a role's MCP surplus exceeds the threshold
// (McpClientManager.toolSurfaceForRole), those tools are mounted name-only: their JSON schemas stay
// out of every request until the model fetches them with the `tool_search` tool. This module owns
// that mechanism — the tool, the per-invocation activation set, the name-only prompt index, and the
// guard that turns a call to an un-activated tool into a typed "fetch first" result instead of a
// provider-level validation error.
//
// Activation is scoped to one subagent invocation: build a fresh surface per agent construction, and
// a new invocation starts fully deferred again. The adapter (run-loop-adapter.ts) composes the
// activation set into the single #102 `prepareStep`, adding activated names to `activeTools`.

import type { Tool, ToolCallOptions, ToolSet } from 'ai';
import { tool } from 'ai';
import { z } from 'zod';

export const TOOL_SEARCH_TOOL_NAME = 'tool_search';
const SELECT_PREFIX = 'select:';
const DEFAULT_MAX_RESULTS = 5;

type AnyTool = ToolSet[string];

const toolSearchInputSchema = z.object({
  query: z
    .string()
    .min(1)
    .describe(
      'Either `select:name1,name2` to fetch those exact tools by namespaced name, or free-text keywords ranked over tool names + descriptions.',
    ),
  max_results: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Cap on keyword matches (default 5). Ignored for `select:` queries.'),
});
export type ToolSearchInput = z.infer<typeof toolSearchInputSchema>;

export type ToolSearchMatch = { name: string; description: string; parameters: unknown };
export type ToolSearchOutput = { matches: ToolSearchMatch[]; notFound: string[] };

export type ToolSearchSurface = {
  // The `tool_search` tool. Mount under TOOL_SEARCH_TOOL_NAME exactly when `deferred` is non-empty.
  tool: Tool<ToolSearchInput, ToolSearchOutput>;
  // Names activated so far this invocation. The adapter reads this in prepareStep to grow activeTools.
  activated: ReadonlySet<string>;
  // The name-only system-prompt index for the deferred tools.
  indexBlock: string;
};

// Build the tool_search surface over a set of deferred (namespaced) tools. The returned `activated`
// set is mutated by the tool's execute as matches are fetched.
export function toolSearch(deferred: ToolSet): ToolSearchSurface {
  const activated = new Set<string>();
  const entries = Object.entries(deferred);
  const byName = new Map<string, AnyTool>(entries);

  const searchTool = tool({
    description:
      'Fetch the parameter schemas of deferred tools (listed name-only in your prompt) so you can call them. `select:name1,name2` fetches exact names; any other query is keyword-ranked over names and descriptions. Each returned tool becomes callable on your next step.',
    inputSchema: toolSearchInputSchema,
    execute: (input: ToolSearchInput): ToolSearchOutput => {
      const result = input.query.startsWith(SELECT_PREFIX)
        ? selectByName(input.query.slice(SELECT_PREFIX.length), byName)
        : keywordSearch(input.query, entries, input.max_results ?? DEFAULT_MAX_RESULTS);
      for (const match of result.matches) activated.add(match.name);
      return result;
    },
    toModelOutput: ({ output }) => ({ type: 'text', value: renderToolSearch(output) }),
  });

  return { tool: searchTool, activated, indexBlock: deferredToolIndexBlock(deferred) };
}

function selectByName(list: string, byName: Map<string, AnyTool>): ToolSearchOutput {
  const names = list
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  const matches: ToolSearchMatch[] = [];
  const notFound: string[] = [];
  for (const name of names) {
    const found = byName.get(name);
    if (found) matches.push(toMatch(name, found));
    else notFound.push(name);
  }
  return { matches, notFound };
}

function keywordSearch(query: string, entries: [string, AnyTool][], max: number): ToolSearchOutput {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t !== '');
  const scored = entries
    .map(([name, t]) => {
      const haystack = `${name} ${toolDescription(t)}`.toLowerCase();
      const score = terms.reduce((n, term) => (haystack.includes(term) ? n + 1 : n), 0);
      return { name, tool: t, score };
    })
    .filter((e) => e.score > 0)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, max);
  return { matches: scored.map((e) => toMatch(e.name, e.tool)), notFound: [] };
}

function toMatch(name: string, t: AnyTool): ToolSearchMatch {
  return { name, description: toolDescription(t), parameters: toolParameters(t) };
}

function toolDescription(t: AnyTool): string {
  return typeof t.description === 'string' ? t.description : '';
}

// MCP tools carry a JSON-schema `inputSchema`; render it verbatim so the model can construct a call.
function toolParameters(t: AnyTool): unknown {
  return t.inputSchema ?? {};
}

function renderToolSearch(output: ToolSearchOutput): string {
  const parts: string[] = [];
  if (output.matches.length === 0) {
    parts.push('No tools matched.');
  } else {
    parts.push(`Activated ${output.matches.length} tool(s) — callable on your next step:`);
    for (const m of output.matches) {
      parts.push(
        `\n${m.name}\n${m.description}\nParameters (JSON Schema): ${JSON.stringify(m.parameters)}`,
      );
    }
  }
  if (output.notFound.length > 0) {
    parts.push(`\nNot found (no such deferred tool): ${output.notFound.join(', ')}`);
  }
  return parts.join('\n');
}

// The always-visible name-only tier: contract preamble + one `<name>: <first sentence>` line per
// deferred tool. Empty string when nothing is deferred (the caller then mounts no index, no tool).
export const DEFERRED_TOOLS_CONTRACT =
  'The tools below are available but their parameter schemas are NOT loaded. Before calling one, fetch its schema with the `tool_search` tool (`select:<name>` for an exact name, or keywords to search), then call it on a later step. Calling a deferred tool before fetching its schema returns an error, not a result.';

export function deferredToolIndexBlock(deferred: ToolSet): string {
  const entries = Object.entries(deferred);
  if (entries.length === 0) return '';
  const lines = entries.map(([name, t]) => `${name}: ${firstSentence(toolDescription(t))}`);
  return [DEFERRED_TOOLS_CONTRACT, '<deferred-tools>', ...lines, '</deferred-tools>'].join('\n');
}

function firstSentence(text: string): string {
  const trimmed = text.replace(/\s+/g, ' ').trim();
  const match = /^(.*?[.!?])(\s|$)/.exec(trimmed);
  return match?.[1] ?? trimmed;
}

// --- guard: a deferred tool called before activation returns a typed result, never throws ---

const DEFERRED_GUARD_MARKER = '__aitmDeferredGuard';
type GuardResult = { [DEFERRED_GUARD_MARKER]: true; error: string };

function guardResult(name: string): GuardResult {
  return {
    [DEFERRED_GUARD_MARKER]: true,
    error: `${name} is a deferred tool whose schema is not loaded. Call \`${TOOL_SEARCH_TOOL_NAME}\` with \`select:${name}\` first, then call ${name} on a later step.`,
  };
}

function isGuardResult(v: unknown): v is GuardResult {
  return typeof v === 'object' && v !== null && DEFERRED_GUARD_MARKER in v;
}

// Wrap a deferred tool so a call before its name is activated short-circuits to the fetch-first
// result (with the same guidance rendered as the model-visible text), and a call after activation
// runs the real executor. Preserves the base tool's own toModelOutput for genuine results.
export function guardDeferred(
  name: string,
  base: AnyTool,
  activated: ReadonlySet<string>,
): AnyTool {
  const baseExecute = base.execute;
  const baseToModelOutput = base.toModelOutput;
  const inputSchema = base.inputSchema;
  return {
    ...base,
    execute: async (input: unknown, options: ToolCallOptions) => {
      if (!activated.has(name)) return guardResult(name);
      if (!baseExecute) return guardResult(name);
      // Narrow via the tool's own input schema if available, else pass through
      const narrowedInput =
        inputSchema && 'parseAsync' in inputSchema ? await inputSchema.parseAsync(input) : input;
      return baseExecute(narrowedInput, options);
    },
    toModelOutput: (options: { toolCallId: string; input: unknown; output: unknown }) => {
      if (isGuardResult(options.output)) return { type: 'text', value: options.output.error };
      if (baseToModelOutput) {
        return baseToModelOutput(options);
      }
      const out = options.output;
      return { type: 'text', value: typeof out === 'string' ? out : JSON.stringify(out) };
    },
  } as AnyTool;
}
