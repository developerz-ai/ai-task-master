// Pre-PR self-review pass: BEFORE a PR opens, adversarially review the just-committed diff, run the
// project's verify command, and fix whatever either surfaces — a single coordinator-driven pass that
// runs on every group/task by default. aitm must never open a PR it hasn't reviewed and verified
// itself; external CI + CodeRabbit are backstops, not the only gate (many repos have neither).
//
// Shape mirrors ci-fix.ts, with two deliberate differences:
//   - Input is the LOCAL diff on the branch, not downloaded CI logs — the Worker inspects it with
//     `git diff <base>...HEAD` / its read tools.
//   - Output is a LOCAL commit only — no rebase / force-push, since the PR isn't open yet (that path
//     is owned by ci-fix and left untouched).
//
// One pass, no loop (by design): the coordinator runs the verify command once, folds any failures
// into a single adversarial review-and-fix Worker invocation, and the caller opens the PR regardless
// of the outcome. A still-unclean result is recorded, never blocked — the burn we guard against is a
// PR opened with a red typecheck the Worker hand-waved as "pre-existing", so we try to catch and fix
// it here, but we do not gate the PR on success.
//
// SRP: one self-review pass. The caller (WorkLoop.maybeSelfReview) owns whether it runs and what to
// do with the result. Verification (running the checks) is the coordinator's job here, not the
// Worker's — so the Worker runs with NO verifyCommand, and its review fixes are committed even when
// verify can't be made fully green in one pass.

import type { MemoryIndexEntry } from '@developerz.ai/ai-claude-compat';
import type { LanguageModel, TimeoutConfiguration } from 'ai';
import { buildCompactionStep, type CompactorLike } from '../compaction/compaction-step.ts';
import type { Capability } from '../config/schema.ts';
import { defaultRunCmd, type RunCmd, type RunCmdResult } from '../github/github-client.ts';
import type { LoggerLike } from '../logger/logger.ts';
import type { PrGroup, Task } from '../state/schema.ts';
import type { SubagentInit } from '../subagents/factory.ts';
import { buildRolePrompt } from '../subagents/role-prompt.ts';
import {
  createWorkerAgent,
  runWorker,
  WORKER_MAX_STEPS,
  type WorkerInput,
  type WorkerResult,
  type WorkerTools,
} from '../subagents/worker.ts';

// The self-review session's own role prefix (docs/prompt-design.md §2e). The review Worker is a
// Coordinator run adversarially over its own diff, so it gets this hostile-reviewer prompt instead of
// the plain WORKER_SYSTEM_PREFIX — it owns the pre-PR gate: read the diff as a hostile reviewer, fix
// what it finds, and submit only when the diff is clean and the verify command is green.
export const SELF_REVIEW_SYSTEM_PREFIX = [
  '',
  'You are the pre-PR self-reviewer. Read the diff about to become a PR as a hostile reviewer would,',
  'then fix what you find — you own this gate.',
  '',
  'Adversarial pass, in order:',
  '1. Correctness: bugs, wrong edge cases, off-by-one, unhandled errors the change introduced.',
  '2. Scope: every changed line must trace to the task — revert drive-by edits and reformatting.',
  "3. Contract: does it meet the task's acceptance check? Run tests and lint (the verify command).",
  "4. Style: matches the repo's conventions and the coding-style digest.",
  '',
  "Fix real problems with the edit tools; leave a pre-existing issue you did not cause as a note, don't",
  'bundle it. Do NOT claim green unless a tool result in this run shows it. When the diff is clean and',
  'verify passes, submit — a partial-but-honest report beats an unearned "looks good".',
].join('\n');

// Model selector — Credentials satisfies it structurally. The pass owns the tier decision: always
// 'coding', so the self-review lands on the strongest code model regardless of role mapping. The id
// method feeds the Compactor's context-window lookup for the same tier.
export type SelfReviewModelSelector = {
  modelForCapability(capability: Capability): LanguageModel;
  modelIdForCapability(capability: Capability): string;
};

// Subagent wiring for the review Worker. Mirrors the CI-fix session's FixSessionSubagents so the
// adapter builds both the same way; `runWorkerOverride` is the unit-test seam (no real LLM/git).
export type SelfReviewSubagents = {
  credentials: SelfReviewModelSelector;
  workerTools: WorkerTools;
  // Style payload (CLAUDE.md / AGENTS.md digest). Prepended to the Worker system prompt.
  styleContents: string;
  // Optional formatter run before staging so the committed fix matches the project's formatter.
  formatCommand?: string;
  // Optional Compactor: the review Worker gets a summarize-and-continue prepareStep when its context
  // window fills, using the 'coding'-tier model id.
  compactor?: CompactorLike;
  // Per-step LLM request deadline forwarded to the review Worker agent. Unset → none.
  timeout?: TimeoutConfiguration;
  // Provider options forwarded to the review Worker agent (e.g. OpenRouter web_search). Unset → none.
  providerOptions?: SubagentInit<WorkerTools>['providerOptions'];
  // Usage sink forwarded to the review Worker agent, recorded under the worker role. Unset → none.
  onUsage?: SubagentInit<WorkerTools>['onUsage'];
  // Live rolling context threaded into the review Worker's manifest prompt. Unset → ''.
  rollingContext?: string;
  // Optional harness context block (a `<system-reminder>` envelope: repo instructions + date)
  // prepended to the review Worker's first user message. Unset → no block.
  contextBlock?: string;
  // Optional trailing `<system-reminder>` (the run's Step N/M position) appended to the END of the
  // review Worker's first user message, kept out of the cacheable leading prefix (slice 04 §4).
  progressBlock?: string;
  // Per-repo memory index injected into the review Worker's prompt. Unset → no memory block.
  memoryIndex?: readonly MemoryIndexEntry[];
  // Per-step transcript recorder callback forwarded to the review Worker agent. Unset → nothing.
  onStepFinish?: SubagentInit<WorkerTools>['onStepFinish'];
  // Progress-only per-step callback for the review Worker's parallel editor fanout. Unset → silent.
  onEditorStepFinish?: SubagentInit<WorkerTools>['onEditorStepFinish'];
  // Retry-visibility sink forwarded to the review Worker agent (slice 01b). Unset → no sink.
  onRetry?: SubagentInit<WorkerTools>['onRetry'];
  // Live-streaming sink + watchdog overrides forwarded to the review Worker agent (slice 07). Set
  // only when config `streaming` is true. Unset → non-streaming path, byte-identical to today.
  onStream?: SubagentInit<WorkerTools>['onStream'];
  streamWatchdog?: SubagentInit<WorkerTools>['streamWatchdog'];
  // Injection seam — bypass the real Worker agent in tests.
  runWorkerOverride?: (input: WorkerInput) => Promise<WorkerResult>;
};

export type SelfReviewInput = {
  subagents: SelfReviewSubagents;
  group: PrGroup;
  baseBranch: string;
  // Where the group's branch is checked out — the Worker edits here, and verify runs with this cwd.
  checkoutPath: string;
  // The effective verify command the coordinator runs ONCE before the review Worker (config
  // verifyCommand, else a detected fallback). Undefined → no shell verify (adversarial review only).
  verifyCommand?: string;
  // git/shell shim — defaults to execa. Stubbed in unit tests to script the verify outcome without
  // spawning a process.
  runCmd?: RunCmd;
  logger?: LoggerLike;
};

export type SelfReviewResult =
  // Nothing to fix — the diff reviewed clean and verify (if run) was green. Open the PR as-is.
  | { kind: 'clean' }
  // The review Worker committed fixes onto the branch. Open the PR with the improved diff.
  | { kind: 'reviewed' }
  // Verify failed and the review Worker could not deliver a fix — a red PR may ship. Open it anyway
  // (external CI is the backstop) with the reason recorded.
  | { kind: 'unclean'; reason: string };

// Last N chars of combined stdout+stderr — the failure tail is what a fixer needs. Matches worker.ts.
const VERIFY_TAIL_MAX = 4000;

export async function runSelfReviewSession(input: SelfReviewInput): Promise<SelfReviewResult> {
  const { subagents, group, checkoutPath } = input;
  const runCmd = input.runCmd ?? defaultRunCmd;
  const log = input.logger;

  // 1. Coordinator-owned verify: run the effective command ONCE so its failures feed the review. A
  //    command-not-found (exit 127) is inconclusive, not a real failure — a missing fallback tool
  //    must not spawn a bogus fix pass — so it is treated as "no verify ran".
  let verifyFailure: RunCmdResult | null = null;
  if (input.verifyCommand) {
    const out = await runShell(runCmd, checkoutPath, input.verifyCommand);
    log?.info('self-review: verify', { command: input.verifyCommand, exitCode: out.exitCode });
    if (out.exitCode !== 0 && out.exitCode !== 127) verifyFailure = out;
  }

  // 2. One adversarial review-and-fix Worker pass over the local diff (+ any verify failures). The
  //    Worker runs with NO verifyCommand — it just commits the fixes; the coordinator already
  //    verified above. An empty manifest (nothing to fix) surfaces as `blocked`, which for a review
  //    is the CLEAN case, not a failure.
  const worker = await runReviewWorker(
    input,
    buildSelfReviewTask(group, input.baseBranch, input.verifyCommand, verifyFailure),
  );

  if (worker.kind === 'ok') {
    log?.info('self-review: fixes committed', {
      group: group.id,
      files: worker.delivery.changes.length,
      verifyFailed: verifyFailure !== null,
    });
    return { kind: 'reviewed' };
  }

  // The Worker produced no fix (empty manifest / blocked / error). With verify green or unrun, that
  // means the diff is already clean. With verify red, the failure it reported still ships — record
  // why so the run summary shows it, and let the caller open the PR (external CI catches it).
  if (verifyFailure === null) {
    log?.info('self-review: nothing to fix', { group: group.id });
    return { kind: 'clean' };
  }
  const detail = worker.kind === 'error' ? worker.error : worker.reason;
  log?.warn('self-review: verify still failing, opening PR anyway', { group: group.id, detail });
  return { kind: 'unclean', reason: uncleanReason(input.verifyCommand ?? '', verifyFailure) };
}

// Build + run the review Worker on the coding tier. Honors the test override; otherwise mirrors the
// CI-fix session's worker build (compaction, timeout, provider options, usage, transcript hooks). No
// verifyCommand is threaded — verification is the coordinator's job here (see module header).
async function runReviewWorker(input: SelfReviewInput, task: Task): Promise<WorkerResult> {
  const { subagents, group, baseBranch, checkoutPath } = input;
  const baseInput: WorkerInput = {
    group,
    task,
    checkoutPath,
    baseBranch,
    styleContents: subagents.styleContents,
    rollingContext: subagents.rollingContext ?? '',
    ...(subagents.contextBlock ? { contextBlock: subagents.contextBlock } : {}),
    ...(subagents.progressBlock ? { progressBlock: subagents.progressBlock } : {}),
    ...(subagents.formatCommand ? { formatCommand: subagents.formatCommand } : {}),
    ...(input.logger ? { logger: input.logger } : {}),
  };
  if (subagents.runWorkerOverride) return subagents.runWorkerOverride(baseInput);

  const prepareStep = subagents.compactor
    ? buildCompactionStep<WorkerTools>({
        compactor: subagents.compactor,
        modelId: subagents.credentials.modelIdForCapability('coding'),
        ...(input.logger ? { logger: input.logger } : {}),
      })
    : undefined;
  const agent = createWorkerAgent({
    model: subagents.credentials.modelForCapability('coding'),
    tools: subagents.workerTools,
    systemPrompt: buildRolePrompt({
      style: subagents.styleContents,
      roleGuidance: SELF_REVIEW_SYSTEM_PREFIX,
      cwd: checkoutPath,
      maxSteps: WORKER_MAX_STEPS,
      modelId: subagents.credentials.modelIdForCapability('coding'),
      ...(subagents.memoryIndex ? { memoryIndex: subagents.memoryIndex } : {}),
    }),
    ...(prepareStep ? { prepareStep } : {}),
    ...(subagents.timeout !== undefined ? { timeout: subagents.timeout } : {}),
    ...(subagents.providerOptions !== undefined
      ? { providerOptions: subagents.providerOptions }
      : {}),
    ...(subagents.onUsage !== undefined ? { onUsage: subagents.onUsage } : {}),
    ...(subagents.onStepFinish ? { onStepFinish: subagents.onStepFinish } : {}),
    ...(subagents.onEditorStepFinish ? { onEditorStepFinish: subagents.onEditorStepFinish } : {}),
    ...(subagents.onRetry ? { onRetry: subagents.onRetry } : {}),
    ...(subagents.onStream ? { onStream: subagents.onStream } : {}),
    ...(subagents.streamWatchdog ? { streamWatchdog: subagents.streamWatchdog } : {}),
  });
  return runWorker(agent, baseInput);
}

// The self-review task: adversarially review the branch's committed diff and fix real problems. When
// verify failed, its output is folded in so the SAME pass fixes those errors too. Scoped as one
// `task` so the Worker's manifest prompt targets the review instead of re-planning the group's work;
// mirrors the CI-fix session's buildFixTask shape.
function buildSelfReviewTask(
  group: PrGroup,
  baseBranch: string,
  verifyCommand: string | undefined,
  verifyFailure: RunCmdResult | null,
): Task {
  const branch = group.branch ?? `aitm/${group.id}`;
  const lines = [
    `Before this PR opens, adversarially self-review the changes just committed on branch \`${branch}\`.`,
    `Inspect the diff against the base — run \`git diff ${baseBranch}...HEAD\` (or read the changed`,
    'files) — and scrutinize it like a hostile external reviewer whose job is to find what is wrong.',
    '',
    'Find and FIX every real problem:',
    '- correctness bugs and obvious regressions;',
    '- leftover TODO/FIXME markers, debug prints, or commented-out code;',
    '- missed edge cases and unhandled errors;',
    '- code that will not typecheck or lint.',
  ];
  if (verifyFailure) {
    lines.push(
      '',
      `The project verify command (\`${verifyCommand}\`) FAILS on these changes. Fix every error it`,
      'reports so the code is green. Do NOT dismiss failures as "pre-existing" or "unrelated to my',
      'change" and ship anyway — fix them.',
      '',
      'Verify output (tail):',
      verifyTail(verifyFailure),
    );
  }
  lines.push(
    '',
    'Change ONLY what these issues require — do not expand scope or refactor unrelated code. If the',
    'diff is already correct and clean, make no changes at all.',
  );
  return {
    id: `${group.id}-self-review`,
    text: lines.join('\n'),
    complexity: 'complex',
    done: false,
  };
}

function uncleanReason(verifyCommand: string, out: RunCmdResult): string {
  return [
    `The verify command (\`${verifyCommand}\`) still failed (exit ${out.exitCode}) after the pre-PR`,
    'self-review — the PR was opened anyway so external CI can weigh in. Review the failure:',
    '',
    'Verify output (tail):',
    verifyTail(out),
  ].join('\n');
}

function verifyTail(out: RunCmdResult): string {
  const combined = [out.stdout, out.stderr]
    .map((s) => s.trimEnd())
    .filter((s) => s.length > 0)
    .join('\n');
  return combined.length > VERIFY_TAIL_MAX ? combined.slice(-VERIFY_TAIL_MAX) : combined;
}

// Run a shell command string in the checkout via the runCmd shim (`sh -c`), so a configured
// verify command like `bun test` works verbatim. Never throws on a non-zero exit — a failing verify
// is a handled outcome the pass reacts to.
async function runShell(
  runCmd: RunCmd,
  checkoutPath: string,
  command: string,
): Promise<RunCmdResult> {
  return runCmd('sh', ['-c', command], { cwd: checkoutPath });
}
