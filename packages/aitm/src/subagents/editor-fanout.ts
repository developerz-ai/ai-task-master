// Layer A of the Worker's two-layer parallelism (see worker.ts's header): plan a file manifest,
// then fan editor sub-subagents out over it — one per cohesive directory-shaped group of files, run
// through a bounded pool with a shared abort controller. Also the mechanical "is this manifest too
// small to be worth fanning out" floor, and the on-disk phantom-edit verification every leaf's
// output is checked against before planAndEdit (worker.ts) trusts it as a real FileChange.

import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import type { BashInput, BashOutput } from '@developerz.ai/ai-claude-compat';
import { callWithStepTimeout, runPool } from '@developerz.ai/ai-claude-compat';
import { generateText, stepCountIs, type Tool } from 'ai';
import type { FileChange } from '../domain/worker-delivery.ts';
import { harnessProgress } from '../observability/step-progress.ts';
import { isAsyncIterable, requireExec, shQuote } from './bash-exec.ts';
import { AGENT_STEP_BACKSTOP, reportUsage, type WorkerSubagentInit } from './factory.ts';
import { capText, MANIFEST_FIELD_MAX, ROLLING_CONTEXT_MAX } from './prompt-caps.ts';
import { EDITOR_SYSTEM_PREFIX } from './prompts/role-guidance.ts';
import { buildEditorRolePrompt } from './role-prompt.ts';
import type { FileManifestEntry, WorkerInput, WorkerTools } from './worker.ts';

// Editor step cap. The shared runaway backstop, not a work budget — an editor leaf has no `submit`
// tool, so it ends on a plain-text response (runEditorPass); this only guards a non-terminating loop.
export const EDITOR_MAX_STEPS = AGENT_STEP_BACKSTOP;

// Editor fanout shape. The manifest is grouped by directory so one leaf owns a cohesive slice of
// files instead of the fanout opening one provider call per file, and the groups run through a
// bounded pool. MAX_FILES_PER_EDITOR caps how many files a leaf owns (a large directory still spreads
// across several leaves); EDITOR_CONCURRENCY_DEFAULT caps how many leaves run at once so a big
// manifest can't open dozens of concurrent LLM requests. Bigger than a typical "one file per leaf":
// modern coding models finish a single file in seconds, so a leaf should own a meaty, multi-file
// chunk that keeps an editor working for minutes — aitm is built for big work. The per-run config
// that overrides the concurrency is wired separately; unset falls back to this default.
export const MAX_FILES_PER_EDITOR = 6;
export const EDITOR_CONCURRENCY_DEFAULT = 4;

// Mechanical floor under the fanout decision. WORKER_SYSTEM_PREFIX already tells the Coordinator to
// fan out only at scale, but prose is not a constraint: an observed run spawned four editors for four
// one-line edits (`db.test.ts (1), package.json #1 (1), index.ts (1), package.json #2 (1)`) — four
// agent spin-ups, four repo surveys, four leaf prompts, for work one leaf finishes in a single step.
// A leaf's fixed cost dominates trivial work, so below this floor the whole manifest runs inline in
// ONE editor pass. Only manifest data available at the decision point feeds the predicate:
//   - FANOUT_FLOOR_FILES (4): at/below MAX_FILES_PER_EDITOR, so the collapsed leaf still respects the
//     per-leaf cap. 4 is the observed pathological width; a 5+ file slice keeps fanning out.
//   - FANOUT_FLOOR_PURPOSE_CHARS (240): the Coordinator's own prose across the WHOLE manifest. It
//     writes a clause for a one-line edit ("expand the exports field") and a paragraph for a real
//     module, so total purpose length is the cheapest honest proxy for how much work it planned.
//     240 over up-to-4 files is ~60 chars each — one short sentence apiece.
//   - a `create` entry is never trivial: writing a new file from nothing is real code, so any create
//     in the manifest keeps the fanout regardless of the other two signals.
export const FANOUT_FLOOR_FILES = 4;
export const FANOUT_FLOOR_PURPOSE_CHARS = 240;

// Editor leaves are the ones actually writing the code, so the budget has to fit the project style
// file that composeStyleGuide puts at the head of the guide (a typical CLAUDE.md runs 4-6k chars) —
// truncating it mid-rule is how a leaf ends up violating the house rules it was handed. The digest
// half tails it and is what gets cut when a repo ships an unusually long style file.
const EDITOR_STYLE_MAX = 6000;
// The Coordinator's hand-off digest is paid once per leaf, so it is capped far tighter than the style
// guide: ~800 chars is the "four sentences a colleague gives you before you start" the field asks for.
// A leaf buried in preamble writes worse code and costs ×N; anything longer, the leaf can go read.
const LEAF_CONTEXT_MAX = 800;

// The editor leaf's legitimate tools: the whole WorkerTools surface, and nothing else. Deriving the
// leaf set from an explicit allowlist — rather than destructuring named extras away — means anything
// the adapter mounts as a runtime EXTRA is excluded BY DEFAULT, so a future MCP-sourced or liveliness
// tool can't silently leak a capability into an editor. The extras dropped today are exactly the ones
// that don't belong at the leaf: editors never nest surveys (`explore`, issue #126), never touch
// durable memory (`memory`, issue #118), and never manage background processes (`bashOutput`/
// `killBash`, issue #103) — those live at the manifest/ci-fix level. Keep this in sync with the
// WorkerTools fields (`as const satisfies` fails the build on a stray key; a paired test asserts
// completeness).
export const EDITOR_TOOL_ALLOWLIST = [
  'readFile',
  'writeFile',
  'editFile',
  'multiEdit',
  'grep',
  'glob',
  'bash',
  'multiBash',
  'webFetch',
  'webSearch',
  'datetime',
] as const satisfies readonly (keyof WorkerTools)[];

// Compile-time completeness: the allowlist must name EVERY WorkerTools field so today's leaf tools
// all survive `editorToolSet`. `as const satisfies` above already rejects a stray/typo'd key; this
// catches the other direction — adding a field to WorkerTools without allowlisting it makes this type
// `never` and fails the build. Tuple-wrapped so the union check isn't distributed member-by-member.
const _allowlistCoversWorkerTools: [keyof WorkerTools] extends [
  (typeof EDITOR_TOOL_ALLOWLIST)[number],
]
  ? true
  : never = true;

// Byte-identical to the pre-#270 destructure for today's tool set (the same keys survive), but a
// newly-mounted runtime tool is now excluded rather than inherited.
export function editorToolSet(tools: WorkerTools): WorkerTools {
  const allowed = new Set<string>(EDITOR_TOOL_ALLOWLIST);
  return Object.fromEntries(
    Object.entries(tools).filter(([key]) => allowed.has(key)),
  ) as WorkerTools;
}

// Per-file editor result. `changed: false` marks a phantom edit — the model returned a summary but
// never wrote the file — so planAndEdit drops it and fails the pass instead of recording a FileChange
// the committed diff can't back.
export type EditorOutcome =
  | { changed: true; change: FileChange }
  | { changed: false; path: string };

// A manifest entry's grouping key: its immediate parent directory (POSIX manifest paths), or '.' for a
// repo-root file. Files under the same directory are cohesive, so they land on one leaf rather than
// fragmenting the fanout one-per-file.
function dirOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '.' : path.slice(0, slash);
}

// The base stream label naming one editor leaf: the lone file's basename for a single-file group
// (`login.ts`), or the shared parent directory for a multi-file leaf (`auth/`) — issue #131. Two
// leaves can still share a base (a chunked oversized directory, or same-basename files in sibling
// dirs); labelEditorGroups disambiguates those before the label reaches an operator.
function editorGroupLabel(group: readonly FileManifestEntry[]): string {
  const [first, ...rest] = group;
  if (!first) return '.';
  return rest.length === 0 ? basename(first.path) : `${dirOf(first.path)}/`;
}

// One editor leaf: the files it owns plus the distinct stream label naming it. Bundling the label with
// the files means the roster line, the per-editor completion line, and the onEditorStepFinish tag all
// read one already-disambiguated label instead of each re-deriving (and colliding on) it — issue #131.
type EditorLeaf = { label: string; files: FileManifestEntry[] };

// Turn directory groups into labeled leaves, disambiguating any shared base label (issue #131).
// editorGroupLabel is a pure function of a single group, so when groupManifestByDir chunks an oversized
// directory into several leaves they all resolve to the same `src/` — which makes the roster ambiguous
// (`src/ (3), src/ (2)`) and, worse, tags separate editors with an identical onEditorStepFinish stream
// line, defeating the per-editor labels. Any base shared by more than one leaf gets a ` #n` suffix in
// fanout order; a base owned by a single leaf stays bare, so the common one-leaf-per-directory case is
// byte-identical to before.
export function labelEditorGroups(groups: readonly FileManifestEntry[][]): EditorLeaf[] {
  const totals = new Map<string, number>();
  for (const group of groups) {
    const base = editorGroupLabel(group);
    totals.set(base, (totals.get(base) ?? 0) + 1);
  }
  const seen = new Map<string, number>();
  return groups.map((files) => {
    const base = editorGroupLabel(files);
    if ((totals.get(base) ?? 0) <= 1) return { label: base, files };
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return { label: `${base} #${n}`, files };
  });
}

// Is this manifest too small to be worth fanning out? See FANOUT_FLOOR_FILES for the constants and
// why these three signals. A one-file manifest is already a single leaf, so the floor has nothing to
// collapse there and returns false — that path stays byte-identical.
export function belowFanoutFloor(files: readonly FileManifestEntry[]): boolean {
  if (files.length <= 1 || files.length > FANOUT_FLOOR_FILES) return false;
  if (files.some((file) => file.kind === 'create')) return false;
  const purposeChars = files.reduce((total, file) => total + file.purpose.trim().length, 0);
  return purposeChars <= FANOUT_FLOOR_PURPOSE_CHARS;
}

// Stream label for the collapsed leaf. editorGroupLabel would name it after the FIRST entry's
// directory, which is a lie once the collapsed set spans directories — the whole point of the floor.
function collapsedLeafLabel(files: readonly FileManifestEntry[]): string {
  return `${files.length} small changes`;
}

// The fanout roster line (issue #131): `auth/ (2), login.ts (1)` — one entry per leaf, in fanout
// order, so an operator sees the team shape before any editor reports back.
function rosterSummary(leaves: readonly EditorLeaf[]): string {
  return leaves.map((leaf) => `${leaf.label} (${leaf.files.length})`).join(', ');
}

// One editor leaf's outcome, summarized for the roster's per-editor completion line (issue #131):
// how many of its files actually changed on disk vs. came back as a phantom (editorNoChangeReason in
// worker.ts reports the phantom paths separately once the whole fanout settles).
function outcomeSummary(outcomes: readonly EditorOutcome[]): string {
  const changed = outcomes.filter((o) => o.changed).length;
  const unchanged = outcomes.length - changed;
  return unchanged > 0 ? `${changed} changed, ${unchanged} unchanged` : `${changed} changed`;
}

// Group manifest entries into per-leaf assignments: entries sharing a parent directory go to the same
// leaf, and a directory with more than `maxPerGroup` entries is chunked to that size so no single leaf
// owns an unbounded brief while a large directory still spreads across the pool. Manifest order is
// preserved within and across groups so the fanout — and its tests — stay deterministic. A single-entry
// manifest yields one single-entry group, keeping that path byte-identical to the pre-team fanout.
export function groupManifestByDir(
  files: readonly FileManifestEntry[],
  maxPerGroup: number,
): FileManifestEntry[][] {
  const byDir = new Map<string, FileManifestEntry[]>();
  for (const file of files) {
    const dir = dirOf(file.path);
    const bucket = byDir.get(dir);
    if (bucket) bucket.push(file);
    else byDir.set(dir, [file]);
  }
  const size = Math.max(1, Math.floor(maxPerGroup) || 1);
  const groups: FileManifestEntry[][] = [];
  for (const bucket of byDir.values()) {
    for (let i = 0; i < bucket.length; i += size) {
      groups.push(bucket.slice(i, i + size));
    }
  }
  return groups;
}

// The shared "team brief" injected into every editor's system prompt when a manifest fans out to more
// than one leaf: the task in play, the whole file manifest (so each teammate sees what its siblings
// own, not just its own path), and the rolling cross-PR context. Built once per fanout. Values are
// slice-capped exactly as the manifest prompt caps them so a runaway plan can't blow the brief ×N. The
// caller injects it only for a real team (more than one group); a lone leaf sees no brief, keeping the
// single-leaf path byte-identical to the pre-team fanout.
export function buildTeamBrief(input: WorkerInput, files: readonly FileManifestEntry[]): string {
  const lines = [
    '<team-brief>',
    'You are one editor on a team realizing this change together; each leaf owns a different set of files.',
    '',
  ];
  if (input.task) {
    lines.push(`Task [${input.task.complexity}]: ${capText(input.task.text, MANIFEST_FIELD_MAX)}`);
  } else {
    lines.push(
      'Tasks in this change:',
      ...input.group.tasks.map((t) => `  - ${capText(t.text, MANIFEST_FIELD_MAX)}`),
    );
  }
  lines.push('', 'Full file manifest (each file is owned by exactly one leaf):');
  for (const file of files) {
    lines.push(`  - ${file.path} (${file.kind}) — ${capText(file.purpose, MANIFEST_FIELD_MAX)}`);
  }
  if (input.rollingContext.trim()) {
    lines.push(
      '',
      'Rolling context from prior PRs:',
      capText(input.rollingContext, ROLLING_CONTEXT_MAX),
    );
  }
  lines.push(
    '',
    'Edit only the file(s) named in your own brief below; treat the rest of the manifest as your',
    "teammates' contract, not files for you to touch.",
    '</team-brief>',
  );
  return lines.join('\n');
}

// Fan the manifest out over a bounded pool of editor leaves, sharing a single AbortController: any leaf
// rejecting (or the outer WorkerInput.signal aborting, e.g. SIGINT) aborts every sibling's in-flight
// `generateText` call so a doomed fanout stops burning tokens instead of running to completion (cleanup
// #2, plan 02-signal-cancellation-cleanup). The manifest is grouped by directory first so one leaf owns
// cohesive files, then at most `editorConcurrency` leaves run at once — a big manifest no longer opens
// one concurrent LLM request per file (slice 05). Each leaf yields one outcome per file it owns; the
// per-group results are flattened back to one outcome per manifest entry for planAndEdit.
export async function runEditorFanout(
  init: WorkerSubagentInit<WorkerTools>,
  manifest: { files: readonly FileManifestEntry[]; sharedContext?: string | undefined },
  input: WorkerInput,
): Promise<EditorOutcome[]> {
  const files = manifest.files;
  const controller = new AbortController();
  const outer = input.signal;
  const onOuterAbort = (): void => controller.abort(outer?.reason);
  if (outer) {
    if (outer.aborted) controller.abort(outer.reason);
    else outer.addEventListener('abort', onOuterAbort, { once: true });
  }
  const collapse = belowFanoutFloor(files);
  if (collapse) {
    harnessProgress(
      `group ${input.group.id}: manifest below the fanout floor (${files.length} small changes) — running them in one pass`,
    );
  }
  const leaves = collapse
    ? [{ label: collapsedLeafLabel(files), files: [...files] }]
    : labelEditorGroups(groupManifestByDir(files, MAX_FILES_PER_EDITOR));
  // A team brief only makes sense once the work is actually split across leaves; a lone leaf already
  // sees its whole assignment in its own prompt, and injecting nothing keeps that path byte-identical.
  // The roster/per-editor-outcome lines gate on the same condition (issue #131) — a lone leaf stays
  // byte-identical to the pre-team fanout, silence included.
  const isTeam = leaves.length > 1;
  const teamBrief = isTeam ? buildTeamBrief(input, files) : '';
  const concurrency = input.editorConcurrency ?? EDITOR_CONCURRENCY_DEFAULT;
  if (isTeam) {
    harnessProgress(
      `group ${input.group.id}: fanning out ${leaves.length} editors — ${rosterSummary(leaves)}`,
    );
  }
  try {
    const perLeaf = await runPool(leaves, concurrency, (leaf) =>
      runEditor(init, leaf, input, controller.signal, teamBrief, manifest.sharedContext)
        .then((outcomes) => {
          if (isTeam) {
            harnessProgress(
              `group ${input.group.id}: editor ${leaf.label} done — ${outcomeSummary(outcomes)}`,
            );
          }
          return outcomes;
        })
        .catch((err: unknown) => {
          controller.abort();
          throw err;
        }),
    );
    return perLeaf.flat();
  } finally {
    outer?.removeEventListener('abort', onOuterAbort);
  }
}

// One leaf, with exactly one retry for phantom edits. A leaf that narrates ("I updated the routes")
// without calling a write tool used to block the WHOLE task — an observed run shipped a PR with its
// services and none of its routes for that reason. Blocking is too blunt for a failure the model can
// usually fix once it is told plainly what happened, so the unwritten files get one corrective pass.
// Exactly one: a second narration after being told "you wrote nothing" is a real capability failure,
// and retrying it again would just burn a leaf's worth of tokens before blocking anyway.
async function runEditor(
  init: WorkerSubagentInit<WorkerTools>,
  leaf: EditorLeaf,
  input: WorkerInput,
  signal: AbortSignal,
  teamBrief: string,
  sharedContext: string | undefined,
): Promise<EditorOutcome[]> {
  const group = leaf.files;
  const summary = await runEditorPass(
    init,
    leaf,
    input,
    signal,
    teamBrief,
    buildEditorPrompt(group, input, sharedContext),
  );
  const outcomes = await verifyEditorOutcomes(init, input, group, summary);
  const phantoms = group.filter((file) => outcomes.some((o) => !o.changed && o.path === file.path));
  if (phantoms.length === 0) return outcomes;

  harnessProgress(
    `group ${input.group.id}: ${leaf.label} narrated ${phantoms.length === 1 ? 'an edit' : `${phantoms.length} edits`} without writing — retrying once`,
  );
  const retrySummary = await runEditorPass(
    init,
    leaf,
    input,
    signal,
    teamBrief,
    buildPhantomRetryPrompt(phantoms, input, sharedContext),
  );
  const retried = await verifyEditorOutcomes(init, input, phantoms, retrySummary || summary);
  const byPath = new Map(retried.map((o) => [o.changed ? o.change.path : o.path, o]));
  return outcomes.map((o) => (o.changed ? o : (byPath.get(o.path) ?? o)));
}

// One generateText call for a leaf, returning its one-line summary ('' when it said nothing).
async function runEditorPass(
  init: WorkerSubagentInit<WorkerTools>,
  leaf: EditorLeaf,
  input: WorkerInput,
  signal: AbortSignal,
  teamBrief: string,
  prompt: string,
): Promise<string> {
  // Per-editor label (issue #131): each leaf gets its own onStepFinish instance, tagged with the
  // already-disambiguated label naming what it owns, rather than every leaf sharing one anonymous
  // "editor" stream line — chunked-directory leaves no longer collide on that tag.
  const editorStepFinish = init.onEditorStepFinish?.(leaf.label);
  const started = Date.now();
  const result = await callWithStepTimeout(
    () =>
      generateText({
        model: init.model,
        tools: editorToolSet(init.tools),
        system: buildEditorRolePrompt({
          style: capText(input.styleContents, EDITOR_STYLE_MAX),
          roleGuidance: EDITOR_SYSTEM_PREFIX,
          cwd: input.checkoutPath,
          // Empty for a lone leaf → the slot is omitted and the system prompt is byte-identical to today.
          ...(teamBrief ? { teamBrief } : {}),
        }),
        prompt,
        stopWhen: stepCountIs(EDITOR_MAX_STEPS),
        abortSignal: signal,
        // web_search (issue #112) rides providerOptions.openrouter when the adapter enabled it for
        // this Worker. The old `{ openai: { parallelToolCalls: true } }` was dead — the OpenRouter
        // provider ignores the `openai` namespace, and parallelToolCalls is already an OpenRouter
        // chat-setting default (true), so dropping it changes no request bytes.
        ...(init.providerOptions !== undefined ? { providerOptions: init.providerOptions } : {}),
        ...(init.timeout !== undefined ? { timeout: init.timeout } : {}),
        // Editor-fanout progress (silent-run fix): per-step-field-only handlers, safe under the
        // parallel fanout — see WorkerSubagentInit.onEditorStepFinish.
        ...(editorStepFinish ? { onStepFinish: editorStepFinish } : {}),
      }),
    init.timeout,
  );
  reportUsage(init.onUsage, result, { latencyMs: Date.now() - started }); // per-leaf editor pass, recorded under the worker role (#114)
  const firstLine = result.text.trim().split('\n')[0];
  return firstLine && firstLine.length > 0 ? firstLine : '';
}

// Confirm EACH planned file diverged on disk before recording its change: a weak model can narrate an
// edit ("edited x") — or write two of its three files and narrate the third — without calling
// writeFile/editFile, and every unwritten path must surface as a phantom rather than a FileChange the
// committed diff can't back (audit 05).
async function verifyEditorOutcomes(
  init: WorkerSubagentInit<WorkerTools>,
  input: WorkerInput,
  group: readonly FileManifestEntry[],
  summary: string,
): Promise<EditorOutcome[]> {
  const outcomes: EditorOutcome[] = [];
  for (const file of group) {
    if (await editorTouchedPath(init.tools.bash, input.checkoutPath, file.path)) {
      outcomes.push({
        changed: true,
        change: {
          path: file.path,
          kind: file.kind,
          summary: summary || `${file.kind} ${file.path}`,
        },
      });
    } else {
      outcomes.push({ changed: false, path: file.path });
    }
  }
  return outcomes;
}

// Did the editor actually change this path on disk? `git status --porcelain` reports create (`??`),
// modify (` M`) and delete (` D`) as a non-empty line and stays empty when the tree is unchanged —
// exactly the no-diff-is-failure signal. `--no-optional-locks` keeps the parallel per-file checks off
// the shared index.lock so concurrent editors don't race on it. A non-zero exit is a real git fault,
// not a no-op edit, so it surfaces as an error rather than a silent phantom.
//
// Exported: worker.ts's inline-edit path (planAndEdit's `applied: true` handling) reuses the same
// on-disk check to phantom-guard a Coordinator's self-declared edits.
export async function editorTouchedPath(
  bash: Tool<BashInput, BashOutput>,
  checkoutPath: string,
  filePath: string,
): Promise<boolean> {
  const exec = requireExec(bash);
  const command = `git -C ${shQuote(checkoutPath)} --no-optional-locks status --porcelain -z -- ${shQuote(filePath)}`;
  const out = await exec(
    { command, description: 'verify the editor changed the file on disk' },
    { toolCallId: `worker-status-${randomUUID()}`, messages: [] },
  );
  if (isAsyncIterable(out)) {
    throw new Error('bash tool returned an async iterable; expected a single result');
  }
  if (out.exitCode !== 0) {
    throw new Error(`git status failed (${out.exitCode}) verifying ${filePath}\n${out.stderr}`);
  }
  return out.stdout.trim().length > 0;
}

// The head of a leaf's prompt: the ground the Coordinator already covered, plus the harness facts a
// leaf otherwise rediscovers or gets wrong. Everything here is data that already exists at this point
// — no extra model round-trip — and each line changes what the leaf types:
//   - `sharedContext`: the Coordinator's own hand-off digest (conventions, landmarks, contracts), so a
//     leaf does not re-survey the files the Coordinator just finished reading.
//   - the verify command: the bar the edit has to clear, which the leaf would otherwise only learn
//     about after the gate fails and a fix pass is spent on it.
//   - the format command: the harness runs it after the fanout, so hand-fixing import order or
//     whitespace is wasted work (an observed run spent four leaves doing exactly that).
// All three absent → empty, and the leaf prompt is byte-identical to the pre-hand-off shape.
function buildLeafContext(input: WorkerInput, sharedContext: string | undefined): string[] {
  const lines: string[] = [];
  if (sharedContext?.trim()) {
    lines.push(
      'What the coordinator already established:',
      capText(sharedContext, LEAF_CONTEXT_MAX),
    );
  }
  if (input.verifyCommand) {
    lines.push(`Your change must survive \`${capText(input.verifyCommand, MANIFEST_FIELD_MAX)}\`.`);
  }
  if (input.formatCommand) {
    lines.push(
      `\`${capText(input.formatCommand, MANIFEST_FIELD_MAX)}\` runs after you — do not hand-fix formatting or import order.`,
    );
  }
  return lines.length > 0 ? [...lines, ''] : lines;
}

function buildEditorPrompt(
  group: readonly FileManifestEntry[],
  input: WorkerInput,
  sharedContext?: string,
): string {
  const head = [`Checkout: ${input.checkoutPath}`, ...buildLeafContext(input, sharedContext)];
  const [first, ...rest] = group;
  // A single-file group is byte-identical to the pre-team per-file prompt (the common case).
  if (first && rest.length === 0) {
    return [
      ...head,
      `File: ${first.path}`,
      `Change kind: ${first.kind}`,
      `Purpose: ${capText(first.purpose, MANIFEST_FIELD_MAX)}`,
      '',
      'Make the change. Reply with a one-line summary.',
    ].join('\n');
  }
  const lines = [...head, `You own these ${group.length} files:`, ''];
  for (const file of group) {
    lines.push(
      `File: ${file.path}`,
      `Change kind: ${file.kind}`,
      `Purpose: ${capText(file.purpose, MANIFEST_FIELD_MAX)}`,
      '',
    );
  }
  lines.push('Make each change. Reply with a one-line summary.');
  return lines.join('\n');
}

// The single corrective retry for a leaf that narrated instead of writing. It names the failure
// explicitly rather than re-issuing the original brief: the model already believes it did the work, so
// repeating the request unchanged tends to produce the same narration. Scoped to the unwritten files
// only — whatever the leaf really did write stays committed as-is.
export function buildPhantomRetryPrompt(
  phantoms: readonly FileManifestEntry[],
  input: WorkerInput,
  sharedContext?: string,
): string {
  const lines = [
    `Checkout: ${input.checkoutPath}`,
    ...buildLeafContext(input, sharedContext),
    `You described ${phantoms.length === 1 ? 'this change' : 'these changes'} but wrote nothing — the file${
      phantoms.length === 1 ? ' is' : 's are'
    } unchanged on disk. Make the edit now with the write/edit tool; do not reply with a description of it.`,
    '',
  ];
  for (const file of phantoms) {
    lines.push(
      `File: ${file.path}`,
      `Change kind: ${file.kind}`,
      `Purpose: ${capText(file.purpose, MANIFEST_FIELD_MAX)}`,
      '',
    );
  }
  lines.push('Reply with a one-line summary only after the write tool has returned.');
  return lines.join('\n');
}
