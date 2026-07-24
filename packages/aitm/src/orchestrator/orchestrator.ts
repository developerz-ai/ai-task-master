// docs/architecture.md §Flow, docs/subagents.md §Composition
// Top-level agent. Owns:
//   - prompt composition (style payload + role prefix + rolling context)
//   - routing between Planner / Worker / Reviewer (each exposed as a tool)
//   - **PR creation** — title, body, commit message: docs say Worker opens the PR,
//     but the Worker can be inconsistent on global-context narration. Orchestrator
//     re-composes the commit message and opens the PR via GitHubClient, taking the
//     Worker's draft as input. This is the reliability win: one place that knows
//     the whole plan writes the PR-level prose.
//
// SDK references:
//   docs/vendor/ai-sdk/chunk-04.md §"ToolLoopAgent"
//   docs/vendor/ai-sdk/chunk-09.md §"Subagents" §"Controlling What the Model Sees"
//   docs/vendor/ai-sdk/chunk-09.md §"Loop Control" — stopWhen: [stepCountIs(N), hasToolCall('done')]

import {
  callWithStepTimeout,
  correctiveMessage,
  formatSubmitIssues,
  SUBMIT_TOOL_NAME,
  type SubmittedOutput,
  submittedOutput,
} from '@developerz.ai/ai-claude-compat';
import {
  generateText,
  hasToolCall,
  type ModelMessage,
  stepCountIs,
  type TimeoutConfiguration,
  type Tool,
  ToolLoopAgent,
  tool,
} from 'ai';
import { ExecaError, execa } from 'execa';
import { z } from 'zod';
import type { AgentConfig } from '../agent-config/agent-config-detector.ts';
import type { CreatePrInput } from '../github/github-client.ts';
import type { PullRequest, ReviewThread } from '../github/schema.ts';
import type { PrGroup } from '../state/schema.ts';
import { type OnUsage, reportUsage } from '../subagents/factory.ts';
import type { PlannerTools } from '../subagents/planner.ts';
import { render } from '../subagents/prompts/templates.ts';
import type { ReviewerTools } from '../subagents/reviewer.ts';
import type { WorkerDelivery, WorkerTools } from '../subagents/worker.ts';
import { taskCommitTrailer } from '../workspace/task-commit-marker.ts';
import {
  type ModelProvider,
  makePlannerTool,
  makeReviewerTool,
  makeWorkerTool,
} from './subagent-tools.ts';

// Narrow surface — orchestrator only opens PRs, never shells `gh` itself.
// Structural so tests can drop in a literal stub without subclassing GitHubClient.
export type GhClient = {
  createPr(input: CreatePrInput): Promise<PullRequest>;
};

// `git commit --amend` injection seam — defaults to execa so tests can record argv
// without spawning git. Mirrors the GitHubClient.RunCmd shape on purpose.
export type RunCmdOptions = { cwd?: string };
export type RunCmdResult = { stdout: string; stderr: string; exitCode: number };
export type RunCmd = (
  file: string,
  args: readonly string[],
  options?: RunCmdOptions,
) => Promise<RunCmdResult>;

export const defaultRunCmd: RunCmd = async (file, args, options) => {
  try {
    const r = await execa(file, [...args], options?.cwd ? { cwd: options.cwd } : {});
    return {
      stdout: typeof r.stdout === 'string' ? r.stdout : '',
      stderr: typeof r.stderr === 'string' ? r.stderr : '',
      exitCode: r.exitCode ?? 0,
    };
  } catch (err) {
    if (err instanceof ExecaError) {
      return {
        stdout: typeof err.stdout === 'string' ? err.stdout : '',
        stderr: typeof err.stderr === 'string' ? err.stderr : '',
        exitCode: err.exitCode ?? 1,
      };
    }
    throw err;
  }
};

// The orchestrator's role guidance. buildSystemPrompt weaves it with the style digest and rolling
// context through render('orchestrator-system', …) — the one prompt-assembly seam, no call-site concat.
export const ORCHESTRATOR_ROLE_PREFIX = [
  '',
  '## Role: Orchestrator',
  '',
  'You coordinate Planner, Worker (Coordinator), and Reviewer, each exposed as a tool. You see the whole',
  'plan and the rolling context, so you own the per-PR prose: the final commit message and the PR title',
  '+ body.',
  '',
  'Flow:',
  '  1. planner → the PR-group DAG (once).',
  '  2. each ready group → worker; the harness commits + opens the PR.',
  '  3. each PR with unresolved threads → reviewer.',
  '  4. stop when every group is merged or blocked.',
  '',
  'Rules:',
  '  - Only you route between subagents; subagents are leaves and never spawn each other.',
  '  - Specific and terse. No marketing prose. Conventional commit subjects, ≤72 chars.',
].join('\n');

export type OrchestratorInit = {
  // Structural ModelProvider, not the concrete Credentials class, so tests can pass a literal
  // `{ modelFor }` stub. The real Credentials instance satisfies the shape unchanged.
  credentials: ModelProvider;
  agentConfig: AgentConfig;
  // Distilled coding-style digest. When present it replaces agentConfig.contents as the style
  // prefix for the orchestrator prompt and every subagent tool; absent → raw contents.
  styleDigest?: string;
  rollingContext: string;
  // LLM step budget for the orchestrator loop (separate from maxSessions, a PR/session count).
  // Null/0/negative → DEFAULT_MAX_STEPS. Caller responsibility to set a sensible value.
  maxSteps: number | null;
  github: GhClient;
  // Optional per-repo PR body section headings (each a `## ` heading). Undefined/empty/malformed
  // falls back to the default Summary/Changes/Testing/Evidence. See resolvePrBodySections.
  prBodySections?: readonly string[];
  // Defaults to execa-backed runner. Tests inject a recorder.
  runCmd?: RunCmd;
  // Per-step LLM request deadline for the two direct generateText sites (commit-message refine, PR
  // compose). Unset → no deadline. Threaded from resolved config as `{ stepMs }`. Issue #129.
  timeout?: TimeoutConfiguration;
  // Usage sink for the two direct generateText sites, recorded under the orchestrator role (#114).
  onUsage?: OnUsage;
  // Harness-level notice sink for the direct generateText sites — currently only composePr's
  // deterministic fallback (`PR composition fell back …`). Injected so the Orchestrator stays free of
  // the observability rendering details; the adapter wires it to harnessProgress. Mirrors `onUsage`.
  onProgress?: (message: string) => void;
};

// Per-group state needed to wire the subagent tools. Built fresh for each Orchestrator
// invocation since checkoutPath / group / pr / threads vary between groups.
export type OrchestratorBuildContext = {
  plannerTools: PlannerTools;
  workerTools: WorkerTools;
  reviewerTools: ReviewerTools;
  checkoutPath: string;
  baseBranch: string;
  group: PrGroup;
  pr: number;
  threads: ReviewThread[];
  // Run-scoped cancellation, handed to every subagent tool this build wires (see
  // SubagentInit.signal). Unset → subagent generations are not cancellable.
  signal?: AbortSignal;
};

export type OrchestratorTools = {
  planner: ReturnType<typeof makePlannerTool>;
  worker: ReturnType<typeof makeWorkerTool>;
  reviewer: ReturnType<typeof makeReviewerTool>;
  done: Tool<Record<string, never>, Record<string, never>>;
};

// The default PR body section headings, in order. Used when a repo does not configure its own
// via `prBodySections`. Single source of truth for both the model guidance and the assertion.
export const PR_BODY_SECTIONS = ['## Summary', '## Changes', '## Testing', '## Evidence'] as const;

// Resolve the effective section list from optional config. Every entry must be a real `## `
// heading; if the config is empty or any entry is malformed, fall back to the default so a bad
// config never blocks a run. Exported for unit testing.
export function resolvePrBodySections(raw: readonly string[] | undefined): readonly string[] {
  if (raw === undefined || raw.length === 0) return PR_BODY_SECTIONS;
  const cleaned = raw.map((s) => s.trim());
  return cleaned.every((s) => /^##\s+\S/.test(s)) ? cleaned : PR_BODY_SECTIONS;
}

// The comparable form of a heading: level markers, surrounding emphasis, trailing punctuation and
// case all dropped, so `### Changes:` and `## **changes**` both reduce to `changes`.
function headingKey(line: string): string {
  return line
    .replace(/^#+\s*/, '')
    .replace(/[*_`]/g, '')
    .replace(/[\s:;.\-–—]+$/, '')
    .trim()
    .toLowerCase();
}

// Per-line "is this inside a fenced code block" mask. Every scanner that looks for `## …` headings
// consults it, because a model body routinely QUOTES a heading inside a fence — a diff or file
// snippet containing `## Testing` (very plausible when a PR touches markdown, as this project's own
// docs do). Without fence-awareness that quoted line reads as a real section boundary, splitting a
// section short or routing a fragment into the wrong bucket, and repairPrBody would still pass
// assertPrBodySections by construction — so the corruption is silent, not loud. The fence marker
// line itself is masked as inside so it is never mistaken for content that matters. Both ``` and ~~~
// fences (3+ chars) are recognized.
function fenceMask(lines: readonly string[]): boolean[] {
  const mask: boolean[] = [];
  let inFence = false;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) {
      mask.push(true);
      inFence = !inFence;
    } else {
      mask.push(inFence);
    }
  }
  return mask;
}

// A heading line whose text is a canonical section name followed by MORE text on the same line —
// `## Summary Adds cookie auth` or `## Changes### Domain`, the shape a model produces when it forgets
// the newline between a heading and its content. Returns the canonical heading plus the trailing text
// as a separate content line, so splitBodyBlocks then slots that text under the right section instead
// of treating the whole run-on as an unrecognized heading (which repair used to dump as a duplicate
// tail — the doubled PR body bug). Undefined when the line is not a canonical-prefixed run-on. The
// boundary after the section name must be a non-letter so `## Changesets` never matches `## Changes`.
function splitRunOnHeading(
  line: string,
  canonicalByKey: ReadonlyMap<string, string>,
): string | undefined {
  const rest = line.replace(/^#+\s*/, '');
  const restLower = rest.toLowerCase();
  for (const [key, heading] of canonicalByKey) {
    if (!restLower.startsWith(key)) continue;
    const after = rest.charAt(key.length);
    if (after !== '' && /[a-z0-9]/i.test(after)) continue; // mid-word, not a real boundary
    const trailing = rest
      .slice(key.length)
      .replace(/^[\s:;.\-–—#]+/, '')
      .trim();
    return trailing === '' ? heading : `${heading}\n${trailing}`;
  }
  return undefined;
}

// Rewrite near-miss section headings to their canonical form before the contract is checked.
// Models reliably produce the right SECTIONS and the wrong markup — `### Changes` instead of
// `## Changes`, a trailing colon, bold around the word, or the section name with its content run onto
// the same line. Rejecting those threw away an otherwise good body and replaced it with a generated
// stub, a far worse outcome than fixing the `#`. Only lines that are already headings (and outside a
// code fence) are touched, and only when they name a required section. Exported for unit testing.
export function normalizePrBodyHeadings(body: string, sections: readonly string[]): string {
  const canonical = new Map(sections.map((s) => [headingKey(s), s]));
  const lines = body.split('\n');
  const fenced = fenceMask(lines);
  return lines
    .map((line, i) => {
      if (fenced[i]) return line;
      const trimmed = line.trim();
      if (!/^#{1,6}\s+\S/.test(trimmed)) return line;
      const exact = canonical.get(headingKey(trimmed));
      if (exact !== undefined) return exact;
      return splitRunOnHeading(trimmed, canonical) ?? line;
    })
    .join('\n');
}

// Enforce the PR body contract: every section must be present, as a real markdown heading line,
// and in order. Throws a descriptive error otherwise, so a malformed body is rejected before the
// PR is opened. Matches against actual `## …` heading lines (not arbitrary substrings) so a
// section name mentioned in prose can't satisfy the check. Exported for unit testing.
export function assertPrBodySections(
  body: string,
  sections: readonly string[] = PR_BODY_SECTIONS,
): void {
  const lines = body.split('\n');
  const fenced = fenceMask(lines);
  const headingLines = lines
    .map((line, i) => (fenced[i] ? '' : line.trim()))
    .filter((line) => line.startsWith('## '));
  let cursor = -1;
  for (const heading of sections) {
    const idx = headingLines.indexOf(heading, cursor + 1);
    if (idx === -1) {
      throw new Error(
        `PR body must contain heading lines ${sections.join(', ')} in order; ` +
          `missing or misordered: ${heading}`,
      );
    }
    cursor = idx;
  }
}

// Structured-output schema for PR composition. Title cap reinforces conventional-commit
// brevity; the body's section contract is enforced by assertPrBodySections after submission.
const PrCompositionSchema = z.object({
  title: z.string().min(1).max(72),
  body: z.string().min(1),
});
export type PrComposition = z.infer<typeof PrCompositionSchema>;

// Shape-only view of the fields read off a generateText result — mirrors the compat package's
// internal StepsResult so these helpers never restate the SDK's deep generic result type.
export type SubmitStepsResult = {
  steps: ReadonlyArray<{ toolCalls: ReadonlyArray<{ toolName: string; input: unknown }> }>;
};

// The raw input of the first `submit` call, exactly as the SDK recorded it. When the model's arguments
// fail the tool's inputSchema, ai@6's parseToolCall still records the call — with `invalid: true` and
// `input` set to whatever `JSON.parse` of the raw arguments yielded, which for a double-encoded payload
// is a STRING. That un-schema'd value is the evidence both the recovery and the failure notice need.
// Undefined when the model never submitted. Exported for unit testing.
export function submitToolInput(result: SubmitStepsResult): unknown {
  const call = result.steps
    .flatMap((step) => step.toolCalls)
    .find((toolCall) => toolCall.toolName === SUBMIT_TOOL_NAME);
  return call?.input;
}

// How many nested JSON-string layers to peel off a submit payload. A model that double-encodes usually
// does it once; three bounds the pathological case without ever looping on a self-referential string.
const MAX_JSON_PEELS = 3;

// Recover a composition from a submit payload that arrived as a JSON *string* where the schema expects
// an object — a well-formed answer in a badly-typed envelope. The compat package's submittedOutput
// already unwraps the two simplest shapes (exactly one JSON layer; a strictly ```-fenced block ending
// the string); this covers the residual ones that reach production and are indistinguishable in the
// error text: a second encoding layer, a fence with trailing prose, and a JSON object embedded in a
// prose turn. Nothing is trusted on shape alone — the peeled value must still satisfy
// PrCompositionSchema in full (and, at the call site, assertPrBodySections), so a model that wrote
// prose instead of a composition still fails and routes to the corrective retry. Exported for testing.
export function recoverComposition(input: unknown): PrComposition | undefined {
  if (typeof input !== 'string') return undefined;
  let candidate: unknown = input;
  for (let peel = 0; peel < MAX_JSON_PEELS && typeof candidate === 'string'; peel += 1) {
    const parsed = parseJsonEnvelope(candidate);
    if (!parsed.ok) break;
    candidate = parsed.value;
  }
  const validated = PrCompositionSchema.safeParse(candidate);
  return validated.success ? validated.data : undefined;
}

type ParsedJson = { ok: true; value: unknown } | { ok: false };

// One peel: drop a code fence, parse; failing that, parse the first balanced `{…}` region so a JSON
// object wrapped in narration ("Here is the PR: {…}") is still read.
function parseJsonEnvelope(raw: string): ParsedJson {
  const body = stripCodeFence(raw.trim());
  const direct = tryJsonParse(body);
  if (direct.ok) return direct;
  const embedded = firstJsonObject(body);
  return embedded === undefined ? { ok: false } : tryJsonParse(embedded);
}

function tryJsonParse(text: string): ParsedJson {
  if (text.length === 0) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

// Strip one ```-fenced wrapper (language tag optional). Deliberately more forgiving than the compat
// helper's anchored form: the closing fence may sit flush against the payload and anything after it is
// dropped — both shapes weak models emit, and both currently lose an otherwise-valid composition.
function stripCodeFence(text: string): string {
  const fenced = /^```[^\n]*\n?([\s\S]*?)```/.exec(text);
  return fenced === null ? text : (fenced[1] ?? '').trim();
}

// The first balanced `{…}` substring, tracking string literals and escapes so a brace inside a body
// string can't end the region early. Undefined when there is no balanced object.
function firstJsonObject(text: string): string | undefined {
  const start = text.indexOf('{');
  if (start === -1) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = inString;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return undefined;
}

// The composition the model submitted, with the string-envelope recovery applied. The one boundary
// where a badly-typed but well-formed answer is rescued: submittedOutput runs first (so an untouched
// object submission takes the exact same path it always did), and only its `invalid` verdict — never
// `no-submission`, never a valid one — is re-examined against the raw tool input. Exported for testing.
export function submittedComposition(result: SubmitStepsResult): SubmittedOutput<PrComposition> {
  const submitted = submittedOutput(result, PrCompositionSchema);
  if (submitted.ok || submitted.reason === 'no-submission') return submitted;
  const recovered = recoverComposition(submitToolInput(result));
  return recovered === undefined ? submitted : { ok: true, value: recovered };
}

// How much of a rejected submit payload the failure notice quotes — enough to tell a double-encoded
// envelope from prose, short enough that a whole PR body never lands in the log. The payload is the
// composer's own model-authored PR prose, so there is nothing here a run's own logs don't already hold.
export const SUBMIT_PAYLOAD_PREVIEW_CHARS = 180;

// One-line, truncated rendering of what the model actually submitted, appended to a schema-failure
// reason. Empty string when there is no payload, so a no-submission reason stays untouched. Exported
// for unit testing.
export function describeSubmitPayload(input: unknown): string {
  if (input === undefined) return '';
  const text = typeof input === 'string' ? input : safeStringify(input);
  const flat = text.replace(/\s+/g, ' ').trim();
  const preview =
    flat.length <= SUBMIT_PAYLOAD_PREVIEW_CHARS
      ? flat
      : `${flat.slice(0, SUBMIT_PAYLOAD_PREVIEW_CHARS)}…`;
  return `; submitted ${typeof input} (${text.length} chars): ${preview}`;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

// Corrective re-generations after the first composePr attempt. ≤2 → up to 3 total generations, the
// same bound as the subagents' in-conversation schema retry (#101). Exported for unit testing.
export const COMPOSE_PR_MAX_RETRIES = 2;

// One composePr attempt folded into a single outcome: the valid composition, or the reason it failed
// plus the corrective user message to resend. Two validation layers collapse here — PrCompositionSchema
// (via submittedOutput) and the section contract (assertPrBodySections) — so composePr's retry loop
// stays a flat drive over a message array. Exported for unit testing.
// `submitted` is carried on failure whenever the model DID produce a schema-valid composition that
// merely broke the section contract. That body is real work — prose about a real diff — and is what
// the repair path splices missing sections into instead of discarding it.
export type ComposeAttempt =
  | { ok: true; value: PrComposition }
  | { ok: false; reason: string; correction: string; submitted?: PrComposition };

// `submittedInput` is the raw `submit` payload (submitToolInput). It is quoted, truncated, in the
// schema-failure reason only — the corrective message the model sees already restates the issues, and a
// missing-section failure names the heading, so neither needs the payload echoed back.
export function compositionOutcome(
  submitted: SubmittedOutput<PrComposition>,
  sections: readonly string[],
  submittedInput?: unknown,
): ComposeAttempt {
  if (!submitted.ok) {
    const reason =
      submitted.reason === 'invalid'
        ? `orchestrator PR composition failed schema validation: ${formatSubmitIssues(submitted.issues)}${describeSubmitPayload(submittedInput)}`
        : 'orchestrator did not submit a PR composition';
    return { ok: false, reason, correction: correctiveMessage(submitted) };
  }
  // Normalize first, so a body that is right in substance and wrong only in markup passes as-is.
  const value: PrComposition = {
    ...submitted.value,
    body: normalizePrBodyHeadings(submitted.value.body, sections),
  };
  try {
    assertPrBodySections(value.body, sections);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      reason,
      correction: `${reason}\nCall \`submit\` again with a corrected body that includes every required section heading, verbatim and in order.`,
      submitted: value,
    };
  }
  return { ok: true, value };
}

// Truncate to `max` chars on a word boundary: hard-slice, then retreat to the last space so a word
// is never cut mid-token. A single word longer than `max` has no space to retreat to and is
// hard-sliced. Result is always ≤ max. Exported for unit testing.
export function truncateAtWord(text: string, max: number): string {
  if (text.length <= max) return text;
  const hard = text.slice(0, max);
  const lastSpace = hard.lastIndexOf(' ');
  return (lastSpace > 0 ? hard.slice(0, lastSpace) : hard).trimEnd();
}

// Collapse interior newlines so an interpolated (model-authored) field can neither span multiple
// body lines nor smuggle a `## …` line that assertPrBodySections would read as a section heading.
function oneLine(text: string): string {
  return text.replace(/\s*\n\s*/g, ' ').trim();
}

// Deterministic per-section body content for the fallback. Keyed off the heading's leading word so
// the default Summary/Changes/Testing set gets tailored prose; any other configured heading gets a
// generic non-empty line. Never emits a line starting with `## `, so it can't inject a heading.
function fallbackSectionContent(heading: string, group: PrGroup, delivery: WorkerDelivery): string {
  const name = heading.replace(/^#+\s*/, '').toLowerCase();
  if (name.startsWith('change')) {
    return fallbackChangeList(delivery.changes);
  }
  if (name.startsWith('test')) {
    return 'Automated verification output was not captured for this fallback; confirm via CI on this pull request.';
  }
  // The fallback runs when the model never produced a usable composition, so nothing here can be
  // attributed to a tool result — say exactly that rather than implying anything was demonstrated.
  if (name.startsWith('evidence')) {
    return fallbackEvidence(group);
  }
  if (name.startsWith('summar')) {
    return `Auto-generated composition for PR group ${oneLine(group.id)} — ${oneLine(group.title.trim() || group.id)}.`;
  }
  return `Auto-generated fallback content for PR group ${oneLine(group.id)}.`;
}

// The deterministic fallback's Evidence section: no run happened at this layer, so the only honest
// content is the group's acceptance check (when the plan carried one) plus an explicit statement
// that nothing here demonstrates it. Never claims a command ran.
function fallbackEvidence(group: PrGroup): string {
  const check = group.acceptance?.trim();
  const lines = ['- No verification output was captured for this pull request.'];
  if (check) {
    lines.push(
      `- Acceptance check for this group: ${oneLine(check)} — NOT demonstrated here; verify it before merging.`,
    );
  } else {
    lines.push('- This PR group carries no recorded acceptance check.');
  }
  return lines.join('\n');
}

// The deterministic fallback's Changes section. The per-file `summary` fields are raw editor output
// — often narration or self-talk ("owned by another leaf", "already contains the described changes")
// that reads as noise to a human reviewer. The only reliable signal in the fallback is the path +
// change-kind, so group by directory and list paths under each. Always clean, never leaks agent
// chatter, and scannable for multi-file PRs. Paths carry no newlines/`##`, so no section-heading
// injection is possible (the guard the old per-summary formatter needed).
function fallbackChangeList(changes: WorkerDelivery['changes']): string {
  if (changes.length === 0) return '- No file changes were recorded.';
  const groups = new Map<string, Map<string, string[]>>();
  for (const c of changes) {
    const slash = c.path.lastIndexOf('/');
    const dir = slash === -1 ? '.' : c.path.slice(0, slash);
    const file = slash === -1 ? c.path : c.path.slice(slash + 1);
    const byKind = groups.get(dir) ?? new Map<string, string[]>();
    const names = byKind.get(c.kind) ?? [];
    names.push(oneLine(file));
    byKind.set(c.kind, names);
    groups.set(dir, byKind);
  }
  const lines: string[] = [];
  for (const [dir, byKind] of groups) {
    const label = dir === '.' ? '(root)' : `${dir}/`;
    const parts = [...byKind.entries()].map(([kind, names]) => `${kind} ${names.join(', ')}`);
    lines.push(`- **${label}** — ${parts.join('; ')}`);
  }
  return lines.join('\n');
}

// Split a body at its `## …` heading lines. The first block carries no heading when the body opens
// with prose; every later block is one heading plus everything until the next heading. A `## …` line
// inside a code fence is content, not a boundary — otherwise a quoted heading would fragment the
// real section around it.
function splitBodyBlocks(body: string): Array<{ heading: string | undefined; content: string }> {
  const blocks: Array<{ heading: string | undefined; content: string[] }> = [
    { heading: undefined, content: [] },
  ];
  const lines = body.split('\n');
  const fenced = fenceMask(lines);
  for (const [i, line] of lines.entries()) {
    const trimmed = line.trim();
    if (!fenced[i] && /^##\s+\S/.test(trimmed)) blocks.push({ heading: trimmed, content: [] });
    else blocks[blocks.length - 1]?.content.push(line);
  }
  return blocks.map((b) => ({ heading: b.heading, content: b.content.join('\n').trim() }));
}

// Rebuild a body that broke the section contract, keeping the model's prose without ever doubling it.
//
// The pre-repair behavior threw the whole composition away for a generated stub — measured firing on
// 2 of 2 PRs, discarding accurate prose over one missing heading. The first repair kept the model's
// sections but appended content under any UNRECOGNIZED heading as a trailing block; when a model
// mashed its content onto the heading line (`## Summary Adds cookie auth`), every section read as
// unrecognized and the entire body was re-emitted after the deterministic fill — a doubled PR body.
//
// This version: normalize (which now also splits run-on headings) → slot each block under its section
// → any block that STILL isn't a required section is folded into the running text of the section
// before it (or the Summary when none has opened yet), never appended as a separate duplicate tail.
// Required sections the model omitted are filled from the same deterministic material the full
// fallback uses. The result carries every piece of the model's prose exactly once, in section order.
//
// Passes assertPrBodySections by construction, for any section set. Exported for unit testing.
export function repairPrBody(
  body: string,
  sections: readonly string[],
  group: PrGroup,
  delivery: WorkerDelivery,
): string {
  const blocks = splitBodyBlocks(normalizePrBodyHeadings(body, sections));
  const required = new Set(sections);
  const firstSection = sections[0];
  const owned = new Map<string, string[]>();
  // The section an unrecognized block folds into: the last required heading seen, or the first
  // section until one opens. This keeps stray content inline in a real section rather than dumping it
  // as a duplicate tail — the doubling bug — and never loses a word.
  let current = firstSection;
  for (const block of blocks) {
    const target =
      block.heading !== undefined && required.has(block.heading) ? block.heading : current;
    if (block.heading !== undefined && required.has(block.heading)) current = block.heading;
    const piece = [
      // An unrecognized heading's own text is prose the model wrote; keep it (demoted, so it can't
      // masquerade as a section) rather than dropping it.
      block.heading !== undefined && !required.has(block.heading)
        ? block.heading.replace(/^#+\s*/, '').trim()
        : '',
      block.content,
    ]
      .filter((s) => s !== '')
      .join('\n\n');
    if (piece === '' || target === undefined) continue;
    const bucket = owned.get(target) ?? [];
    bucket.push(piece);
    owned.set(target, bucket);
  }
  return sections
    .map((heading) => {
      const own = (owned.get(heading) ?? []).join('\n\n').trim();
      return `${heading}\n${own !== '' ? own : fallbackSectionContent(heading, group, delivery)}`;
    })
    .join('\n\n');
}

// Deterministic PR composition used when the model's composePr attempts are exhausted (invalid
// schema, a missing section, or no submission at all). Built purely from in-memory group + delivery
// data, so it is total (never throws) and does no I/O. The body emits every configured section
// heading verbatim and in order with non-heading content beneath each, so assertPrBodySections
// passes by construction for any section set. Exported for unit testing.
export function buildFallbackComposition(
  group: PrGroup,
  delivery: WorkerDelivery,
  sections: readonly string[],
): PrComposition {
  const subject = group.title.trim() || group.id;
  const title = truncateAtWord(`feat: ${oneLine(subject)}`, 72);
  const body = sections
    .map((heading) => `${heading}\n${fallbackSectionContent(heading, group, delivery)}`)
    .join('\n\n');
  return { title, body };
}

// Standard PR body every aitm-opened PR follows, so reviewers get a consistent shape. The
// Orchestrator model fills these sections from the worker delivery; exported so the format is
// unit-testable and documented in one place.
export const PR_BODY_GUIDE = [
  'body: GitHub-flavored markdown with exactly these four sections, in order, each with its',
  'heading verbatim. Put each `## ` heading on ITS OWN LINE with a blank line before the content —',
  'never run the content onto the heading line. Keep the whole body tight: a reviewer skims it, so',
  'no walls of text, no restating the diff line by line, no marketing.',
  `  ${PR_BODY_SECTIONS[0]}`,
  '    1-2 sentences on what changed and why.',
  `  ${PR_BODY_SECTIONS[1]}`,
  '    Scannable bulleted list of WHAT changed. Each entry a terse imperative one-liner naming the',
  '    change (e.g. `add fail-fast env loader with zod validation`), grouped by area when there are',
  '    several files. Treat the raw file notes as LEADS, not prose to copy — rewrite them for a human.',
  `  ${PR_BODY_SECTIONS[2]}`,
  '    How the change was verified (tests, lint). If not verified, say so explicitly.',
  `  ${PR_BODY_SECTIONS[3]}`,
  '    What was actually run and what it showed: the verify command and its outcome, the acceptance',
  '    check for this group and whether it was demonstrated, and anything that was checked and then',
  '    thrown away (an approach tried and reverted, a lead that went nowhere). Report ONLY what the',
  '    material below states was run — no command output here means `Nothing was run to verify this',
  '    change.`, and an acceptance check nothing demonstrates is reported as not demonstrated. A',
  '    plan, an intention, or "should work" is never evidence.',
].join('\n');

// Model guidance for the configured section set. The default set keeps its bespoke per-section
// descriptions (PR_BODY_GUIDE); a custom set gets a generic heading-by-heading instruction.
export function prBodyGuideFor(sections: readonly string[]): string {
  if (sameSections(sections, PR_BODY_SECTIONS)) return PR_BODY_GUIDE;
  return [
    `body: GitHub-flavored markdown with exactly these ${sections.length} sections, in order,`,
    'each as a verbatim heading line followed by the relevant content:',
    ...sections.map((s) => `  ${s}`),
  ].join('\n');
}

function sameSections(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((s, i) => s === b[i]);
}

// Fallback LLM step cap when caller passes null / 0 / negative `maxSteps`.
export const DEFAULT_MAX_STEPS = 50;

// Resolve the agent step cap from caller-provided `maxSteps`. Falls back to the
// default when the value is null, zero, or negative. Exported for unit testing.
export function resolveMaxSteps(maxSteps: number | null): number {
  return typeof maxSteps === 'number' && maxSteps > 0 ? maxSteps : DEFAULT_MAX_STEPS;
}

export class Orchestrator {
  constructor(private readonly init: OrchestratorInit) {}

  // Distilled digest when available, else the raw agent-config contents.
  private styleContents(): string {
    return this.init.styleDigest ?? this.init.agentConfig.contents;
  }

  // Effective PR body sections for this run (configured or default).
  private prBodySections(): readonly string[] {
    return resolvePrBodySections(this.init.prBodySections);
  }

  build(context: OrchestratorBuildContext): ToolLoopAgent<never, OrchestratorTools> {
    const commonDeps = {
      credentials: this.init.credentials,
      styleContents: this.styleContents(),
      rollingContext: this.init.rollingContext,
      checkoutPath: context.checkoutPath,
      ...(context.signal ? { signal: context.signal } : {}),
    };
    const tools: OrchestratorTools = {
      planner: makePlannerTool({ ...commonDeps, plannerTools: context.plannerTools }),
      worker: makeWorkerTool({
        ...commonDeps,
        workerTools: context.workerTools,
        baseBranch: context.baseBranch,
        group: context.group,
      }),
      reviewer: makeReviewerTool({
        ...commonDeps,
        reviewerTools: context.reviewerTools,
        pr: context.pr,
        threads: context.threads,
      }),
      done: tool<Record<string, never>, Record<string, never>>({
        description:
          'Signal that all PR groups have been processed and the orchestration is complete.',
        inputSchema: z.object({}),
        execute: async () => ({}),
      }),
    };
    return new ToolLoopAgent<never, OrchestratorTools>({
      model: this.init.credentials.modelFor('orchestrator'),
      instructions: this.buildSystemPrompt(),
      tools,
      stopWhen: [stepCountIs(resolveMaxSteps(this.init.maxSteps)), hasToolCall('done')],
    });
  }

  buildSystemPrompt(): string {
    return render('orchestrator-system', {
      style: this.styleContents(),
      roleGuidance: ORCHESTRATOR_ROLE_PREFIX,
      rollingContext: this.init.rollingContext,
    });
  }

  // Re-write the Worker's draft commit message via the orchestrator model, then
  // `git commit --amend` on the active checkout. Returns the new HEAD SHA.
  //
  // `taskId`, when given, is stamped onto the message as a trailer (see task-commit-marker.ts) so
  // CheckoutHome.hasTaskCommit can detect this exact commit on a resume — the crash window between
  // this amend and WorkLoop persisting the task as done, which would otherwise re-run the Worker and
  // double the commit. Optional so a caller finalizing a whole-group delivery with no single task in
  // scope (or an existing test stub) still compiles and behaves byte-identically (no trailer).
  async finalizeCommit(
    group: PrGroup,
    delivery: WorkerDelivery,
    checkoutPath: string,
    taskId?: string,
  ): Promise<string> {
    const refined = await this.refineCommitMessage(group, delivery);
    const message = taskId === undefined ? refined : `${refined}\n\n${taskCommitTrailer(taskId)}`;
    const runCmd = this.init.runCmd ?? defaultRunCmd;
    const amend = await runCmd('git', ['commit', '--amend', '-m', message], { cwd: checkoutPath });
    if (amend.exitCode !== 0) {
      throw new Error(`git commit --amend failed: ${amend.stderr.trim() || amend.stdout.trim()}`);
    }
    const sha = await runCmd('git', ['rev-parse', 'HEAD'], { cwd: checkoutPath });
    if (sha.exitCode !== 0) {
      throw new Error(`git rev-parse HEAD failed: ${sha.stderr.trim() || sha.stdout.trim()}`);
    }
    return sha.stdout.trim();
  }

  // Compose PR title + body via the orchestrator model, then open the PR through the github
  // client. Falls back to `aitm/<group.id>` when `group.branch` is unset.
  async openPr(group: PrGroup, delivery: WorkerDelivery, baseBranch: string): Promise<PullRequest> {
    const { title, body } = await this.composePr(group, delivery);
    const head = group.branch ?? `aitm/${group.id}`;
    return this.init.github.createPr({ title, body, base: baseBranch, head });
  }

  private async refineCommitMessage(group: PrGroup, delivery: WorkerDelivery): Promise<string> {
    const result = await callWithStepTimeout(
      () =>
        generateText({
          model: this.init.credentials.modelFor('orchestrator'),
          system: this.buildSystemPrompt(),
          prompt: this.buildCommitPrompt(group, delivery),
          ...(this.init.timeout !== undefined ? { timeout: this.init.timeout } : {}),
        }),
      this.init.timeout,
    );
    reportUsage(this.init.onUsage, result);
    return result.text.trim();
  }

  // Task-specific ask only — the shared system prompt (style/role/rolling-context) is sent once via
  // the `system` field (see refineCommitMessage), not re-concatenated here per call.
  private buildCommitPrompt(group: PrGroup, delivery: WorkerDelivery): string {
    return [
      'Rewrite the worker draft into a final commit message.',
      'Subject ≤72 chars, conventional-commit style. Body optional, one paragraph.',
      'Output ONLY the message — no labels, no quotes.',
      '',
      `PR group: ${group.id} — ${group.title}`,
      `Worker draft: ${delivery.draftCommitMessage}`,
      'Files changed:',
      ...delivery.changes.map((c) => `  - ${c.kind} ${c.path}: ${c.summary}`),
    ].join('\n');
  }

  private async composePr(group: PrGroup, delivery: WorkerDelivery): Promise<PrComposition> {
    // Structured output via a submit tool (tool-calling) rather than response_format json_schema,
    // which some OpenAI-compatible providers ignore. `toolChoice: 'auto'` — NOT a forced choice —
    // because thinking-enabled models reject a forced tool_choice outright: Kimi answers
    // "tool_choice 'specified'/'required' is incompatible with thinking enabled" and the group blocks
    // at pr-open. With `submit` the only tool and an explicit "call submit" instruction, every model
    // tested still emits exactly one submit call under 'auto' — the same pattern the Worker/Planner
    // subagents already rely on.
    //
    // Single-shot generateText, not an agent loop (the thinking-model constraint rules out a forced
    // submit), so schema/section recovery is driven inline here: on a botched submit —
    // PrCompositionSchema or assertPrBodySections — append the model's own bad turn plus one
    // corrective user message and re-generate over the growing message array, up to
    // COMPOSE_PR_MAX_RETRIES. Mirrors the subagents' in-conversation #101 retry. Exhausting the
    // retries (or a model that never submits) falls back to a deterministic composition rather than
    // throwing, so composePr is total over composition-quality failures and a whole PR group never
    // blocks at pr-open on prose alone. A genuine transport error (StepTimeoutError from
    // callWithStepTimeout, network) still propagates — the fallback is for bad compositions, not
    // stalled requests.
    //
    // Reading the submission goes through submittedComposition, not submittedOutput directly, so a
    // composition delivered as a JSON *string* is recovered rather than burned on a retry and thrown
    // away — the observed 100% pr-open fallback rate on glm-5.2.
    const model = this.init.credentials.modelFor('orchestrator');
    const sections = this.prBodySections();
    let messages: ModelMessage[] = [{ role: 'user', content: this.buildPrPrompt(group, delivery) }];
    let lastReason = 'orchestrator did not submit a PR composition';
    let lastSubmitted: PrComposition | undefined;
    for (let attempt = 0; attempt <= COMPOSE_PR_MAX_RETRIES; attempt++) {
      const result = await callWithStepTimeout(
        () =>
          generateText({
            model,
            system: this.buildSystemPrompt(),
            messages,
            tools: {
              submit: tool({
                description:
                  'Submit the composed pull-request title and body (the PrComposition schema).',
                inputSchema: PrCompositionSchema,
                execute: async (composition) => composition,
              }),
            },
            toolChoice: 'auto',
            ...(this.init.timeout !== undefined ? { timeout: this.init.timeout } : {}),
          }),
        this.init.timeout,
      );
      reportUsage(this.init.onUsage, result);
      const outcome = compositionOutcome(
        submittedComposition(result),
        sections,
        submitToolInput(result),
      );
      if (outcome.ok) return outcome.value;
      lastReason = outcome.reason;
      if (outcome.submitted !== undefined) lastSubmitted = outcome.submitted;
      if (attempt === COMPOSE_PR_MAX_RETRIES) break;
      messages = [
        ...messages,
        ...result.response.messages,
        { role: 'user', content: outcome.correction },
      ];
    }
    // Retries are exhausted, but a body that merely broke the section contract is still the model's
    // real description of this diff — repair it rather than discard it. Only a run where the model
    // never produced a schema-valid composition falls all the way through to the generated stub.
    if (lastSubmitted !== undefined) {
      const repaired = {
        title: lastSubmitted.title,
        body: repairPrBody(lastSubmitted.body, sections, group, delivery),
      };
      this.init.onProgress?.(
        `PR composition repaired: kept the model's title and body, filled the missing sections (${lastReason})`,
      );
      return repaired;
    }
    const fallback = buildFallbackComposition(group, delivery, sections);
    this.init.onProgress?.(
      `PR composition fell back to generated title/body: ${fallback.title} (${lastReason})`,
    );
    return fallback;
  }

  // Task-specific ask only — the shared system prompt is sent once via `system` (see composePr).
  private buildPrPrompt(group: PrGroup, delivery: WorkerDelivery): string {
    return [
      'Compose the pull-request title and body for this PR group, then call the submit tool with it.',
      '- title: conventional-commit style, ≤72 chars, summarizing the PR group goal below.',
      '  Do NOT copy a single commit message — the title describes the whole group, not one task.',
      prBodyGuideFor(this.prBodySections()),
      '- The `Files changed:` notes below are RAW editor output. They often contain narration,',
      '  repetition, or agent self-talk (e.g. "owned by another leaf", "already contains the described',
      '  changes", "type errors are pre-existing"). NEVER copy such phrases into the body. Rewrite each',
      '  into a clean, human one-liner describing WHAT changed — and group cohesive files so the list',
      '  stays scannable, not one noisy bullet per file.',
      '',
      `PR group goal (use this as the title's subject): ${group.id} — ${group.title}`,
      // The plan's acceptance check — what this group was supposed to prove. It belongs in the body
      // so a human reviewer sees what "done" meant; whether it HOLDS is only what the material below
      // shows, which is why the Evidence guidance forbids reporting it as demonstrated on faith.
      ...(group.acceptance?.trim()
        ? [`Acceptance check the plan set for this group: ${oneLine(group.acceptance)}`]
        : []),
      `Worker draft message (context for the body only — not the title): ${delivery.draftCommitMessage}`,
      'Files changed:',
      ...delivery.changes.map((c) => `  - ${c.kind} ${c.path}: ${c.summary}`),
    ].join('\n');
  }
}
