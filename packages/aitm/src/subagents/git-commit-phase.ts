// The commit phase: create/reuse the group branch, run the operator's format command, stage, and
// commit — plus, when a verifyCommand is configured, gate that commit on it (format → verify → one
// bounded model fix pass → re-verify → commit) via `commitWithVerify`. The fix pass itself
// (planAndEdit) is the ONE caller-supplied hook, since it lives in worker.ts and calling back into
// it here would cycle the module graph — `commitWithVerify` takes it as a parameter instead.

import { randomUUID } from 'node:crypto';
import type { BashInput, BashOutput } from '@developerz.ai/ai-claude-compat';
import type { Tool } from 'ai';
import type { FileChange } from '../domain/worker-delivery.ts';
import { harnessProgress } from '../observability/step-progress.ts';
import { isAsyncIterable, requireExec, runBash, shQuote } from './bash-exec.ts';
import {
  buildVerifyFixTask,
  logVerify,
  renderVerifyFailure,
  runVerify,
  verifyBlockedReason,
} from './verify-gate.ts';
import type { WorkerInput } from './worker.ts';

// aitm's own state dir, relative to the checkout root. stageAndCommit names it so `git add -A` never
// sweeps the run's own bookkeeping into a target-repo commit.
const STATE_DIR = '.ai-task-master';

export async function commitOnBranch(
  bash: Tool<BashInput, BashOutput>,
  input: WorkerInput,
  message: string,
): Promise<void> {
  const exec = requireExec(bash);
  // Branch already created by planAndEdit (branch-before-edit); only format + stage + commit remain.
  await runFormat(exec, input);
  await stageAndCommit(exec, input, message);
}

// Create/switch the group branch. Invoked from planAndEdit BEFORE the editor fanout so edits land on
// the group branch from the start (audit 02). `-B` with no start-point sets the branch to the current
// HEAD — a no-op when the branch is already checked out (e.g. the reused verify fix pass), and it
// never discards committed work. The driver acquires its checkout mutex around the whole
// checkout→edit→commit span so a concurrent group can't switch the shared tree mid-pass.
export async function checkoutBranch(
  exec: NonNullable<Tool<BashInput, BashOutput>['execute']>,
  input: WorkerInput,
  branch: string,
): Promise<void> {
  await runBash(exec, `git -C ${shQuote(input.checkoutPath)} checkout -B ${shQuote(branch)}`);
}

// Stage (excluding aitm's own state dir) + commit — the post-verify steps shared by both paths.
// Excluding `.ai-task-master/` keeps our state.json/goal out of the target-repo commit even when
// the target repo does not gitignore it; the `:!` pathspec leaves its tracked files untouched.
async function stageAndCommit(
  exec: NonNullable<Tool<BashInput, BashOutput>['execute']>,
  input: WorkerInput,
  message: string,
): Promise<void> {
  const wt = shQuote(input.checkoutPath);
  // Stage everything, then UNSTAGE aitm's own state dir. `git add -A -- ':!.ai-task-master'` throws
  // "paths are ignored" when .ai-task-master is gitignored (the in-place case: the state dir sits at
  // the repo root and most repos ignore it) — naming an ignored path in a pathspec trips git. Plain
  // `add -A` skips ignored files silently; the `reset` then also drops the dir if it ISN'T ignored,
  // so aitm never commits its own state either way. No-op (exit 0) when nothing was staged for it.
  await runBash(exec, `git -C ${wt} add -A`);
  await runBash(exec, `git -C ${wt} reset -q -- ${STATE_DIR}`);
  await runBash(exec, `git -C ${wt} commit -m ${shQuote(message)}`);
}

// Format BEFORE staging (and before verify) so the committed diff matches the project's formatter
// — LLM output is rarely byte-identical to biome/prettier/gofmt, and a format-gated CI would
// otherwise reject an otherwise-correct PR (issue #48). A non-zero exit (e.g. unfixable lint
// errors) surfaces as a worker error rather than a silent CI failure later.
async function runFormat(
  exec: NonNullable<Tool<BashInput, BashOutput>['execute']>,
  input: WorkerInput,
): Promise<void> {
  if (!input.formatCommand) return;
  await runBash(exec, `cd ${shQuote(input.checkoutPath)} && ${input.formatCommand}`);
}

// One committed file from the verify-gate commit's tree diff: its path and the change kind git
// recorded (authoritative over any manifest's declared kind).
type CommittedFile = { path: string; kind: FileChange['kind'] };

// The files in the just-created verify-gate commit (HEAD vs its parent). stageAndCommit adds the whole
// tree, so this — not the fix manifest — is the record of what actually shipped. Rename detection is
// off (no -M), so a moved file reads as a delete plus a create, both kept.
async function committedFileChanges(
  exec: NonNullable<Tool<BashInput, BashOutput>['execute']>,
  checkoutPath: string,
): Promise<CommittedFile[]> {
  const out = await exec(
    {
      command: `git -C ${shQuote(checkoutPath)} --no-optional-locks diff-tree --no-commit-id --name-status -r HEAD`,
      description: 'list the files in the verify-gate commit',
    },
    { toolCallId: `worker-difftree-${randomUUID()}`, messages: [] },
  );
  if (isAsyncIterable(out)) {
    throw new Error('bash tool returned an async iterable; expected a single result');
  }
  if (out.exitCode !== 0) {
    throw new Error(`git diff-tree failed (${out.exitCode})\n${out.stderr}`);
  }
  const committed: CommittedFile[] = [];
  for (const line of out.stdout.split('\n')) {
    const tab = line.indexOf('\t');
    if (tab === -1) continue;
    const path = line.slice(tab + 1).trim();
    if (path === '') continue;
    committed.push({ path, kind: statusToKind(line.slice(0, tab)) });
  }
  return committed;
}

// git diff-tree --name-status status letter → FileChange kind. `A` is a create and `D` a delete;
// `M`/`R`/`C`/`T` and anything else are a modification of existing content for the delivery's purposes.
function statusToKind(status: string): FileChange['kind'] {
  const letter = status.trim().charAt(0);
  if (letter === 'A') return 'create';
  if (letter === 'D') return 'delete';
  return 'modify';
}

// The summary attached to a committed file the fix manifest never named — the formatter's or a
// phantom-adjacent write's doing. Files the fix manifest did name carry its own per-file summary.
const VERIFY_FIX_SUMMARY = 'Changed by the verify fix pass';

// Reconcile the committed tree diff against what the first pass already recorded: every committed file
// the first pass did not name becomes an "extra" the delivery must carry. Prefer the fix manifest's
// own summary for it, falling back to a generic note; the committed kind wins, since it is what git
// recorded. Paths already in planned.changes are dropped — the first pass carries those.
function deriveExtraChanges(
  committed: readonly CommittedFile[],
  plannedChanges: readonly FileChange[],
  fixChanges: readonly FileChange[],
): FileChange[] {
  const plannedPaths = new Set(plannedChanges.map((c) => c.path));
  const fixSummaries = new Map(fixChanges.map((c) => [c.path, c.summary]));
  const extra: FileChange[] = [];
  for (const file of committed) {
    if (plannedPaths.has(file.path)) continue;
    extra.push({
      path: file.path,
      kind: file.kind,
      summary: fixSummaries.get(file.path) ?? VERIFY_FIX_SUMMARY,
    });
  }
  return extra;
}

// A completed plan+edit pass, as far as the commit phase needs to know: its recorded changes and
// draft message — mirrors the `ok` case of worker.ts's PlanEditResult without importing it (a
// type-only re-shape keeps this module import-free of worker.ts's value exports).
type VerifyCommitInput = {
  changes: readonly FileChange[];
  draftCommitMessage: string;
};

// One bounded fix pass: re-plan+re-edit scoped to the verify failure. Supplied by the caller
// (worker.ts's planAndEdit) so this module never imports worker.ts's value exports.
type RunFixPass = (
  fixInput: WorkerInput,
  branch: string,
) => Promise<{ kind: 'ok'; changes: FileChange[] } | { kind: 'blocked' | 'error' | 'no-changes' }>;

// Gate committing on `verifyCommand`. Branch checkout + format run first (verify must see the
// formatted files); then verify in the checkout. On a non-zero exit: exactly ONE bounded fix pass
// (a task-scoped manifest+editor re-run fed the verify output) + re-format + re-verify. Still red →
// `blocked` carrying the verify tail; nothing is staged or committed. Green → stage + commit,
// returning any files the fix pass touched so runWorker can fold them into the delivery.
export async function commitWithVerify(
  bash: Tool<BashInput, BashOutput>,
  input: WorkerInput,
  branch: string,
  planned: VerifyCommitInput,
  runFixPass: RunFixPass,
): Promise<{ kind: 'ok'; extraChanges: FileChange[] } | { kind: 'blocked'; reason: string }> {
  const exec = requireExec(bash);
  // The group branch was already created by the first planAndEdit pass (branch-before-edit); verify
  // must see the formatted files, so format the checked-out branch before running verify.
  await runFormat(exec, input);

  let started = Date.now();
  let out = await runVerify(exec, input);

  // Formatter-first repair. A failed verify used to go straight to the model, which meant formatting
  // diagnostics — import order, a `"exports"` field wanting expansion — were handed to an LLM that
  // spawned a leaf per file to hand-edit them. `biome check --write` (or whatever formatCommand is)
  // fixes that whole class in milliseconds, deterministically. So re-run the formatter first and
  // re-verify; only what survives is worth a model fix pass. The formatter already ran before this
  // verify, but the fanout's edits are exactly what it needs to see — and it is idempotent, so on a
  // genuinely non-formatting failure this costs one no-op format plus one re-verify.
  const formatRepair = out.exitCode !== 0 && input.formatCommand !== undefined;
  logVerify(input, out, Date.now() - started, {
    formatRetryFollowed: formatRepair,
    fixPassFollowed: out.exitCode !== 0 && !formatRepair,
  });
  if (formatRepair) {
    await runFormat(exec, input);
    started = Date.now();
    out = await runVerify(exec, input);
    harnessProgress(
      `group ${input.group.id}: verify failed → formatted → re-verified (exit ${out.exitCode})`,
    );
    logVerify(input, out, Date.now() - started, {
      formatRetryFollowed: false,
      fixPassFollowed: out.exitCode !== 0,
    });
  }

  let fixChanges: FileChange[] = [];
  if (out.exitCode !== 0) {
    // One bounded fix pass. planAndEdit never verifies, so this cannot recurse. Its edits are
    // captured for the delivery; an empty/blocked fix manifest simply makes zero edits, and the
    // re-verify below is still authoritative (per the spec, a still-red gate blocks on the tail).
    // Continue THIS pass's conversation (planned.handle, threaded via runFixPass's closure), not
    // input.priorHandle — that is an earlier CI-fix pass's handle (or unset), so replaying it would
    // re-plan the fix from a conversation two passes stale instead of building on the manifest the
    // first pass just produced (issue #107).
    const fixed = await runFixPass(
      {
        ...input,
        task: buildVerifyFixTask(input.group.id),
        verifyFailureBlock: renderVerifyFailure(out),
      },
      branch,
    );
    if (fixed.kind === 'ok') fixChanges = fixed.changes;
    await runFormat(exec, input);
    started = Date.now();
    out = await runVerify(exec, input);
    logVerify(input, out, Date.now() - started, {
      formatRetryFollowed: false,
      fixPassFollowed: false,
    });
    if (out.exitCode !== 0) {
      return { kind: 'blocked', reason: verifyBlockedReason(input.verifyCommand ?? '', out) };
    }
  }

  await stageAndCommit(exec, input, planned.draftCommitMessage);
  // stageAndCommit commits the WHOLE tree, so the fix manifest is not the authoritative list of what
  // shipped: a fix-pass editor's write, the formatter, or a phantom-adjacent edit all land in the
  // commit even when no manifest named them, and a blocked/no-changes fix pass reports no changes yet
  // may still have left committed edits. Derive the extras from the commit's own tree diff so
  // delivery.changes names every committed file the first pass didn't already record (audit).
  const committed = await committedFileChanges(exec, input.checkoutPath);
  return { kind: 'ok', extraChanges: deriveExtraChanges(committed, planned.changes, fixChanges) };
}
