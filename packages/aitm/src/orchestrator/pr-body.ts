import {
  correctiveMessage,
  formatSubmitIssues,
  SUBMIT_TOOL_NAME,
  type SubmittedOutput,
  submittedOutput,
} from '@developerz.ai/ai-claude-compat';
import { z } from 'zod';
import type { PrGroup } from '../domain/pr-group.ts';
import type { WorkerDelivery } from '../domain/worker-delivery.ts';

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
export const PrCompositionSchema = z.object({
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
export function oneLine(text: string): string {
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

// The deterministic conventional-commit subject for a group when no model-authored message is usable:
// `feat: <group.title>` (or the group id when the title is blank), collapsed to one line and capped
// ≤72 chars on a word boundary. Shared by buildFallbackComposition (the PR title) and
// resolveCommitMessage's total fallback so the two never drift. Exported for unit testing.
export function fallbackCommitSubject(group: PrGroup): string {
  const subject = group.title.trim() || group.id;
  return truncateAtWord(`feat: ${oneLine(subject)}`, 72);
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
  const title = fallbackCommitSubject(group);
  const body = sections
    .map((heading) => `${heading}\n${fallbackSectionContent(heading, group, delivery)}`)
    .join('\n\n');
  return { title, body };
}

// The final commit message from the orchestrator's refine output, made total so an empty or
// code-fenced model response never produces `git commit --amend -m ''` and blocks the whole group at
// finalizeCommit. Mirrors composePr's fallback ladder: strip a wrapping code fence (weak models emit
// the message inside ```), and when nothing usable survives, fall back to the Worker's own draft, then
// to a deterministic feat: subject built from the group. Exported for unit testing.
export function resolveCommitMessage(
  text: string,
  group: PrGroup,
  delivery: WorkerDelivery,
): string {
  const refined = cleanCommitText(text);
  if (refined !== '') return refined;
  const draft = cleanCommitText(delivery.draftCommitMessage);
  if (draft !== '') return draft;
  return fallbackCommitSubject(group);
}

// Strip one wrapping code fence and trim — the normalization applied to both the model output and the
// Worker draft before either is accepted as a commit message.
function cleanCommitText(text: string): string {
  return stripCodeFence(text.trim()).trim();
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
