// docs/commands/start.md, docs/commands/merge-pr.md, docs/commands/config.md
// Dispatcher only. Each command does precondition checks → wires deps → kicks WorkLoop / writes config.
//
// The heavy WorkLoop+Orchestrator wiring is exposed via the `runLoop` / `runMergeFlow`
// injection seams so this module stays pure dispatch and is unit-testable without
// spinning up real subagents. Default seam implementations live below; integration
// tests (PR 12) cover the end-to-end stack.

import { homedir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline/promises';
import type { Readable } from 'node:stream';
import {
  type AgentConfig,
  AgentConfigDetector,
  type DetectOptions,
  defaultAgentConfig,
} from '../agent-config/agent-config-detector.ts';
import { composeStyleGuide, StyleDistiller } from '../agent-config/coding-style.ts';
import type { RunLoopInput, RunMergeFlowInput } from '../composition/run-input.ts';
import { ConfigLoader } from '../config/config-loader.ts';
import { ConfigWriter } from '../config/config-writer.ts';
import { type AddProfileInput, ProfileManager } from '../config/profiles.ts';
import type { CliOverrides, ResolvedConfig } from '../config/schema.ts';
import { Credentials } from '../credentials/credentials.ts';
import { createLlmFetch, type LlmFetch } from '../credentials/llm-fetch.ts';
import { DEFAULT_MODELS } from '../domain/model.ts';
import type { PrGroup } from '../domain/pr-group.ts';
import { defaultRunCmd, defaultSleep, GitHubClient } from '../github/github-client.ts';
import { Logger } from '../logger/logger.ts';
import { Disposer, disposeQuietly } from '../loop/disposer.ts';
import { mergeFlowAdapter } from '../loop/merge-flow-adapter.ts';
import { runLoopAdapter } from '../loop/run-loop-adapter.ts';
import type { WorkLoopResult } from '../loop/work-loop.ts';
import { harnessProgress } from '../observability/step-progress.ts';
import { roleUsageSink, UsageTracker } from '../observability/usage-tracker.ts';
import { OpenRouterClient } from '../openrouter/client.ts';
import { type ModelLimitsLookup, ModelLimitsRegistry } from '../openrouter/model-limits.ts';
import {
  OPENROUTER_REFERENCE_URL,
  OpenRouterReferenceCatalog,
} from '../openrouter/reference-catalog.ts';
import { UnsupportedSchemaVersion } from '../state/migrations.ts';
import type { RunLockHandle } from '../state/run-lock.ts';
import { CURRENT_SCHEMA_VERSION, type RunState } from '../state/schema.ts';
import { StateStore } from '../state/state-store.ts';
import type { CleanArgs, ParsedArgs } from './args.ts';
import { formatEffectiveConfig } from './effective-config.ts';
import {
  autoMergeNotice,
  formatConfigValue,
  formatProfileList,
  prLinksBlock,
  redactConfigKeys,
  redactProfile,
  usageSummaryLine,
} from './format.ts';
import { type BannerEntry, modelBanner } from './model-banner.ts';

export type CommandExit = { code: 0 | 1 | 2; message?: string };

export type AuthStatusFn = (cwd: string) => Promise<{ ok: boolean; scopes: string[] }>;

// Inputs for resolving the coding-style digest fed to subagent prompts. The digest is distilled
// once from AgentConfig + repo signals (StyleDistiller) and cached in the state dir; resume reuses
// the cache. Bundled so the `resolveStyle` seam is stubbable in unit tests without a real LLM call.
export type ResolveStyleInput = {
  cwd: string;
  credentials: Credentials;
  agentConfig: AgentConfig;
  state: StateStore;
  // Per-step LLM request deadline (ms) for the style-digest call (issue #129).
  llmStepTimeoutMs: number;
  // Usage sink for the style-digest call, recorded under the planner role (#114). Unset → none.
  usage?: UsageTracker;
};

// Inputs for the optional one-shot planning phase (issue #17). Mirrors the Planner's needs:
// goal + criteria + coding-style payload + a planner model handle (`credentials.modelFor('planner')`).
export type RunPlannerInput = {
  cwd: string;
  resolved: ResolvedConfig;
  credentials: Credentials;
  agentConfig: AgentConfig;
  goal: string;
  criteria: string | undefined;
};

// Planner already returns the plan-time `Plan` shape; the adapter maps it to persisted
// `PrGroup[]` (see `planToPrGroups` in src/loop/run-loop-adapter.ts). A `runPlanner` seam
// therefore hands `runStart` the already-mapped groups, or a block reason.
export type RunPlannerOutcome =
  | { kind: 'ok'; groups: PrGroup[] }
  | { kind: 'blocked'; reason: string };

export type StartCtx = {
  cwd?: string;
  homeDir?: string;
  env?: Record<string, string | undefined>;
  authStatus?: AuthStatusFn;
  // Optional one-shot planning hook (issue #17). When injected, `runStart` runs it once on a
  // fresh run — between `state.init` and `runLoop` — to populate `prGroups` and flip status
  // `planning → working`, and skips it on resume. When omitted, planning happens inside the
  // WorkLoop adapter (the merged default in src/loop/run-loop-adapter.ts), so production
  // behaviour is unchanged; this keeps the planning phase observable + injectable at the
  // dispatch layer, which is what the start-flow tests exercise.
  runPlanner?: (input: RunPlannerInput) => Promise<RunPlannerOutcome>;
  runLoop?: (input: RunLoopInput) => Promise<WorkLoopResult>;
  // Sink for the pre-run notice (e.g. the auto-merge banner). Defaults to process.stdout.
  stdout?: (chunk: string) => void;
  // Sink for non-fatal warnings (missing CLAUDE.md, config precedence, GitHub pagination, etc.).
  // Defaults to process.stderr. Injected so tests can assert on warnings without capturing the
  // real stream.
  stderr?: (chunk: string) => void;
  // Resolve the distilled coding-style digest threaded to subagents as `styleDigest`. Default:
  // reuse the cached `coding-style.md`, else distill once and cache it — never blocking the run
  // (degrades to raw AgentConfig.contents). Injected so unit tests skip the real LLM call.
  resolveStyle?: (input: ResolveStyleInput) => Promise<string>;
  // Abort handle threaded into the run loop (→ RunLoopInput.signal). The CLI wires it to
  // SIGINT/SIGTERM; the adapter closes MCP on abort. Tests drive it directly.
  signal?: AbortSignal;
  // The startup model banner (window + price per configured model). Defaults to resolving it through
  // the run's ModelLimitsRegistry, which fetches the provider catalog. Injected so tests that assert
  // on stdout don't depend on a network round-trip whose success changes what gets printed.
  modelBanner?: () => Promise<string>;
  // The run's keep-alive transport factory. Defaults to `createLlmFetch`; injected so tests can pin
  // that the handle is released on every exit path without opening a real socket pool.
  makeLlmFetch?: () => Promise<LlmFetch | undefined>;
};

// Minimal slice of GitHubClient used during the take-over precondition path (branch
// + PR auto-discovery). The full client is still injected into the merge flow itself;
// this narrower type lets tests stub the precondition path without spawning git.
export type MergePrGithub = Pick<GitHubClient, 'currentBranch' | 'getPrForBranch'>;

export type MergePrCtx = {
  cwd?: string;
  homeDir?: string;
  env?: Record<string, string | undefined>;
  authStatus?: AuthStatusFn;
  runMergeFlow?: (input: RunMergeFlowInput) => Promise<WorkLoopResult>;
  // Test seam: when omitted, a real GitHubClient(cwd) is constructed. Tests pass a
  // stub so the take-over flow does not actually shell out to git on a temp repo.
  github?: GitHubClient;
  // See StartCtx.resolveStyle — same read-or-distill-or-fallback contract for the merge flow.
  resolveStyle?: (input: ResolveStyleInput) => Promise<string>;
  // Sink for the end-of-run usage summary line (issue #114/#190). Defaults to process.stdout.
  stdout?: (chunk: string) => void;
  // See StartCtx.stderr — same non-fatal-warnings sink for the take-over flow.
  stderr?: (chunk: string) => void;
  // Abort handle, threaded into the take-over loop. When aborted, the flow returns `cancelled`
  // → exit code 2. The CLI can wire this to a SIGINT handler; tests drive it directly.
  signal?: AbortSignal;
  // See StartCtx.makeLlmFetch — same keep-alive transport seam for the take-over flow.
  makeLlmFetch?: () => Promise<LlmFetch | undefined>;
};

export type ConfigCtx = {
  cwd?: string;
  homeDir?: string;
  // Read by `config list --effective` to resolve the merged config (env is a credential source).
  env?: Record<string, string | undefined>;
  stdout?: (chunk: string) => void;
  // Where `config list --effective`'s resolution warnings go (stale baseURL, stripped project fields
  // — the very warnings that explain a surprising precedence outcome). Defaults to process.stderr.
  stderr?: (chunk: string) => void;
};

export type CleanCtx = {
  cwd?: string;
  stdout?: (chunk: string) => void;
  // Confirmation seam for the non---force path. Default: prompt on a TTY via readline; deny on a
  // non-TTY stdin so a script can never wipe state by accident (it must pass --force explicitly).
  confirm?: (question: string) => Promise<boolean>;
};

export type ProfileCtx = {
  homeDir?: string;
  stdout?: (chunk: string) => void;
  stderr?: (chunk: string) => void;
  // Reads the API key from stdin for `profile add --api-key-stdin`. Defaults to draining
  // process.stdin. Injectable so the stdin path is unit-testable.
  readStdin?: () => Promise<string>;
};

export type McpLoginCtx = {
  stdout?: (chunk: string) => void;
  stderr?: (chunk: string) => void;
  // OAuth flow injection seam for testing
  performOAuth?: (
    input: import('../mcp/oauth.ts').McpOAuthLoginInput,
  ) => Promise<import('../mcp/oauth.ts').OAuthConfig>;
};

// Exported for unit testing (drives the timeout/abort/size paths against an injected stream).
export async function drainStdin(options?: {
  timeoutMs?: number;
  maxBytes?: number;
  signal?: AbortSignal;
  stream?: Readable;
}): Promise<string> {
  const timeoutMs = options?.timeoutMs ?? 30_000; // 30 second default
  const maxBytes = options?.maxBytes ?? 1_000_000; // 1MB default
  const signal = options?.signal;

  if (signal?.aborted) throw signal.reason ?? new Error('Aborted');

  const stdin = options?.stream ?? process.stdin;
  stdin.setEncoding('utf8');

  // Event-driven, not `for await`: an open-but-idle stdin (no chunk ever arrives) blocks the async
  // iterator forever, so the timer and abort signal must *actively* settle the read rather than only
  // being checked when the next chunk lands. `finish` runs exactly once and always tears down the
  // timer, listeners, and the stream flow so no path leaks or holds the event loop open.
  return await new Promise<string>((resolve, reject) => {
    let data = '';
    let settled = false;

    const cleanup = () => {
      clearTimeout(timer);
      stdin.off('data', onData);
      stdin.off('end', onEnd);
      stdin.off('error', onError);
      if (onAbort) signal?.removeEventListener('abort', onAbort);
      stdin.pause();
    };
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };

    const timer = setTimeout(() => {
      finish(() =>
        reject(
          new Error(
            `Reading from stdin timed out after ${timeoutMs}ms. Pass the API key via --api-key or OPENROUTER_API_KEY env var instead.`,
          ),
        ),
      );
    }, timeoutMs);

    const onData = (chunk: string) => {
      data += chunk;
      if (data.length > maxBytes) {
        finish(() =>
          reject(
            new Error(
              `stdin data exceeded maximum size of ${maxBytes} bytes. API keys should be much smaller.`,
            ),
          ),
        );
      }
    };
    const onEnd = () => finish(() => resolve(data));
    const onError = (err: Error) => finish(() => reject(err));
    const onAbort = signal
      ? () => finish(() => reject(signal.reason ?? new Error('Aborted')))
      : undefined;

    stdin.on('data', onData);
    stdin.on('end', onEnd);
    stdin.on('error', onError);
    if (onAbort) signal?.addEventListener('abort', onAbort, { once: true });
    stdin.resume();
  });
}

// Resolve every configured capability model through the registry and format the startup banner.
// `forModel` throws ModelNotFound for a model the catalog omits entirely — that is itself worth
// showing (as "window unknown"), so it degrades to an undefined entry instead of propagating.
export async function startupModelBanner(
  limits: ModelLimitsLookup,
  resolved: Pick<ResolvedConfig, 'models' | 'activeProfile' | 'baseURL'>,
): Promise<string> {
  // One catalog load for the whole banner. Without this each forModel would retry the fetch (preload
  // clears its promise on failure by design), turning an unreachable catalog into one failed request
  // per capability.
  try {
    await limits.preload();
  } catch {
    return '';
  }
  const entries: BannerEntry[] = [];
  for (const [capability, modelId] of Object.entries(resolved.models)) {
    if (typeof modelId !== 'string' || modelId === '') continue;
    try {
      entries.push({ capability, modelId, limits: await limits.forModel(modelId) });
    } catch {
      entries.push({ capability, modelId, limits: undefined });
    }
  }
  // Nothing resolved at all means the catalog told us nothing, not that the models are limitless —
  // a table of "window unknown" would be noise, and worse, would read as a finding.
  if (!entries.some((e) => e.limits !== undefined)) return '';
  const where = [resolved.activeProfile, resolved.baseURL].filter(
    (s): s is string => s !== undefined && s !== '',
  );
  return modelBanner(entries, where.length > 0 ? where.join(' · ') : 'default provider');
}

// Non-fatal warnings go to the injected stderr sink (default process.stderr) so they never
// contaminate the plain-status stdout contract, and so tests can capture them without patching
// the real stream.
function warnToStderr(stderr: (chunk: string) => void): (message: string) => void {
  return (message) => stderr(`${message}\n`);
}

// AgentConfigDetector options from the CLI's stylePath sources + the homeDir seam (issue #117):
// the user-global CLAUDE.md lives in <homeDir>/.claude, and a nested-file budget overflow is logged
// via `warn`. `--style-path` (start) wins over resolved config; merge-pr passes only its persisted
// path (argStylePath undefined).
function buildDetectOpts(
  argStylePath: string | null | undefined,
  fallbackStylePath: string | null,
  homeDir: string,
  warn: (message: string) => void,
): DetectOptions {
  const opts: DetectOptions = {
    userConfigDir: join(homeDir, '.claude'),
    onWarn: warn,
  };
  if (argStylePath !== undefined) opts.stylePath = argStylePath;
  else if (fallbackStylePath !== null) opts.stylePath = fallbackStylePath;
  return opts;
}

export async function runStart(
  args: Extract<ParsedArgs, { kind: 'start' }>,
  ctx: StartCtx = {},
): Promise<CommandExit> {
  const cwd = ctx.cwd ?? process.cwd();
  const homeDir = ctx.homeDir ?? homedir();
  const env = ctx.env ?? process.env;
  const stderr = ctx.stderr ?? ((chunk: string) => process.stderr.write(chunk));
  const warn = warnToStderr(stderr);

  const loader = new ConfigLoader(cwd, homeDir, env, { warn });
  let resolved: ResolvedConfig;
  try {
    resolved = await loader.resolve(toCliOverrides(args));
  } catch (err) {
    return { code: 1, message: errMsg(err) };
  }

  // --pr-per-task needs auto-merge. Per-task PR isolation branches each task off the base the
  // PREVIOUS task's PR merged into (resetToBase off origin/<base>); with auto-merge off there is no
  // merged base mid-group, so every task piles onto one branch and only the first PR can open
  // (GitHub allows one open PR per head→base). Reject the combo up front instead of silently
  // degrading to a single group PR. Checked on the resolved config so a config `autoMerge: false`
  // is caught alongside `--no-automerge`; prPerTask only ever comes from the --pr-per-task flag.
  if (resolved.prPerTask && !resolved.autoMerge) {
    return {
      code: 1,
      message:
        'Cannot combine --pr-per-task with auto-merge disabled: per-task PRs each branch off the ' +
        'base the previous task merged into, so without auto-merge every task lands on one branch ' +
        'and only the first PR can open. Re-run with auto-merge on (drop --no-automerge or ' +
        '`aitm config set autoMerge true`), or drop --pr-per-task.',
    };
  }

  try {
    Credentials.assertApiKeyPresent(resolved);
  } catch (err) {
    return { code: 1, message: errMsg(err) };
  }
  const detector = new AgentConfigDetector(cwd);
  const detectOpts = buildDetectOpts(args.stylePath, resolved.stylePath, homeDir, warn);

  let agentConfig: AgentConfig | null;
  try {
    agentConfig = await detector.detect(detectOpts);
  } catch (err) {
    return { code: 1, message: errMsg(err) };
  }
  if (!agentConfig) {
    stderr(
      'No CLAUDE.md or AGENTS.md in the repo and no --style — using a generic default style, ' +
        "distilled with the repo's config files. Add a CLAUDE.md/AGENTS.md or pass --style for a sharper guide.\n",
    );
    agentConfig = defaultAgentConfig();
  }

  const authStatus = ctx.authStatus ?? defaultAuthStatus;
  let auth: { ok: boolean; scopes: string[] };
  try {
    auth = await authStatus(cwd);
  } catch (err) {
    return { code: 1, message: errMsg(err) };
  }
  if (!auth.ok) {
    return { code: 1, message: 'gh CLI is not authenticated. Run `gh auth login`.' };
  }
  // The run's abort handle is bound in here so a SIGINT kills an in-flight `gh` child, not just the
  // poll loops around it (see GitHubClient's constructor).
  const github = new GitHubClient(cwd, defaultRunCmd, defaultSleep, ctx.signal, undefined, warn);

  const stateDir = resolvePath(cwd, '.ai-task-master');
  const state = new StateStore(stateDir);
  // One run at a time per state dir. Taken before any state is read or written and released in the
  // finally below, so a second `aitm` invocation here fails fast instead of silently racing this
  // run's plan, group stages and PR numbers through StateStore's write-behind cache.
  let lock: RunLockHandle;
  try {
    lock = await state.acquireRunLock();
  } catch (err) {
    return { code: 1, message: errMsg(err) };
  }

  // Command-scoped release stack, drained in the finally below. Wider than the loop adapter's own
  // disposer: what is acquired here (the keep-alive transport) is built before the loop and used by
  // steps that run outside it, so it cannot hang off a disposer that dies with the loop.
  const disposer = new Disposer();

  try {
    // Resume detection: if a previous run left a valid state.json, skip re-init so
    // runId and prGroups are preserved. Only fall back on expected "missing/invalid
    // prior state" cases (ENOENT, JSON parse failure, schema mismatch); surface every
    // other error (permissions, IO) as a hard failure rather than silently re-initing.
    let resuming = false;
    let existingState: RunState | null = null;
    // Whether a state.json we are about to overwrite is on disk. StateStore.init refuses a clobber
    // unless told, so the two cases that legitimately discard prior state — a file too corrupt to
    // resume, and a finished run superseded below — have to say so; a missing file must not.
    let discardingPriorState = false;
    try {
      existingState = await state.read();
      resuming = true;
    } catch (err) {
      if (!isMissingOrInvalidState(err, stateDir)) {
        return { code: 1, message: `Could not read run state: ${errMsg(err)}` };
      }
      // No valid state.json — proceed with fresh init.
      discardingPriorState = !isFileNotFound(err);
    }

    // A FINISHED run in this directory must not swallow a new `aitm start`. Without this, re-running
    // `aitm start "<new goal>"` where a prior run already merged every group resumed that completed run
    // (nothing left to do → 0 calls, the new goal never even planned). Supersede it with a fresh run.
    // `aitm resume` short-circuits a completed run before reaching here, so this only affects `start`.
    if (existingState && isRunComplete(existingState)) {
      (ctx.stdout ?? ((chunk: string) => process.stdout.write(chunk)))(
        `Previous run here has finished — starting a new run for: ${args.goal}\n`,
      );
      existingState = null;
      resuming = false;
      discardingPriorState = true;
    } else if (existingState) {
      // An UNFINISHED run is resumed as before (idempotent `start`). If the operator typed a different
      // goal, say so plainly — `start` continues the in-progress run, it does not re-plan the new text —
      // so a surprised user knows `aitm clean` is how to start over.
      const persistedGoal = (await state.readGoal().catch(() => null))?.goal?.trim();
      if (
        persistedGoal !== undefined &&
        persistedGoal !== '' &&
        persistedGoal !== args.goal.trim()
      ) {
        (ctx.stdout ?? ((chunk: string) => process.stdout.write(chunk)))(
          `Resuming the unfinished run for "${persistedGoal}" — \`aitm start\` continues it, it does not re-plan. ` +
            `To start over for "${args.goal}", run \`aitm clean\` first.\n`,
        );
      }
    }

    let sessionId = existingState?.runId;
    if (!resuming) {
      const initial = buildInitialRunState({ resolved, agentConfig });
      sessionId = initial.runId;
      try {
        await state.init(initial, { force: discardingPriorState });
        await state.writeGoal(args.goal, args.criteria);
        await loader.writeSnapshot(resolved, stateDir);
      } catch (err) {
        return { code: 1, message: errMsg(err) };
      }
    }

    // Run-scoped session id → sticky routing + prompt-cache key (plan slice 04a). Sourced from the
    // persisted state.runId (fresh or resumed), so a resumed run reuses the same id and keeps warm.
    // Keep-alive transport (plan slice 04b): a tuned undici dispatcher on Node, undefined elsewhere
    // (Bun/Deno pool natively, or undici unavailable) → provider keeps its default fetch. Its pool
    // outlives the loop — the style digest and planner use it too — so its release belongs on this
    // command's disposer, not the adapter's.
    const llmFetch = await (ctx.makeLlmFetch ?? createLlmFetch)();
    if (llmFetch) disposer.add(() => llmFetch.close());
    const credentials = new Credentials(resolved, sessionId, llmFetch?.fetch);

    // The run's structured logger (finding 06/arch-1): every loop module accepts `logger?: LoggerLike`
    // but nothing ever constructed one, so every `logger?.warn(...)` was a silent no-op in shipped
    // runs. Build it here at the resolved level + run id, sinking structured records to stderr and to
    // .ai-task-master/logs/<runId>.log (docs/state.md), then thread it through the loop below. flush()
    // drains buffered file writes on the command's disposer, next to the transport + lock release.
    // sessionId is set on both the resume and fresh-init paths above; the `??` only satisfies its
    // optional type — buildInitialRunState always assigns a runId.
    const runId = sessionId ?? `run-${Date.now().toString(36)}`;
    const logger = new Logger(resolved.logLevel, runId, join(stateDir, 'logs', `${runId}.log`));
    disposer.add(() => logger.flush());

    // Planning phase (issue #17): a one-shot step that runs the Planner once, before the loop,
    // so `prGroups` is populated and the loop has something to iterate. Gated on whether a plan
    // is already persisted — not merely on `resuming` — because a prior run whose planning
    // blocked leaves a resumable state.json with empty `prGroups`; that case must re-plan rather
    // than hand the loop an empty plan. Only runs when a `runPlanner` seam is injected; otherwise
    // planning is handled inside the WorkLoop adapter (merged default), keeping production
    // behaviour unchanged and this module pure dispatch.
    const hasPersistedPlan = (existingState?.prGroups.length ?? 0) > 0;
    if (ctx.runPlanner && !hasPersistedPlan) {
      let plan: RunPlannerOutcome;
      try {
        plan = await ctx.runPlanner({
          cwd,
          resolved,
          credentials,
          agentConfig,
          goal: args.goal,
          criteria: args.criteria,
        });
      } catch (err) {
        return { code: 1, message: errMsg(err) };
      }
      if (plan.kind === 'blocked') {
        return { code: 1, message: plan.reason };
      }
      try {
        await state.update((s) => ({ ...s, status: 'working', prGroups: plan.groups }));
      } catch (err) {
        return { code: 1, message: `Failed to persist plan: ${errMsg(err)}` };
      }
    }

    // Per-run token/cost accounting (issue #114). One ModelLimitsRegistry for the run — shared by the
    // tracker's pricing and the Compactor's context lookup (#102) so the catalog is fetched at most
    // once. The tracker's onUsage sinks are bound in the adapter; totals flush after the loop.
    const modelLimits = new ModelLimitsRegistry(
      new OpenRouterClient(resolved.openrouterApiKey, resolved.baseURL, ctx.signal),
      new OpenRouterReferenceCatalog(OPENROUTER_REFERENCE_URL, ctx.signal),
    );
    const usage = new UsageTracker(modelLimits);

    // Print the resolved window + price per model before any tokens are spent. A provider that
    // publishes no context window disables autocompaction for the whole run, and one that publishes no
    // pricing reduces the end-of-run summary to `cost unknown` — both used to surface only after the
    // fact, if at all. Best-effort: a catalog that won't load must not stop the run.
    try {
      const banner = await (ctx.modelBanner ?? (() => startupModelBanner(modelLimits, resolved)))();
      if (banner !== '') (ctx.stdout ?? ((chunk: string) => process.stdout.write(chunk)))(banner);
    } catch {
      // diagnostics must never break the run
    }

    // Coding-style digest (plan slice 01): distilled once from AgentConfig + repo signals and cached
    // in the state dir, reused on resume. Threaded into the loop so planner/worker/reviewer prompts
    // carry the digest. Never blocks — a thrown seam degrades to raw AgentConfig.contents.
    const resolveStyle = ctx.resolveStyle ?? defaultResolveStyle;
    let styleDigest: string;
    try {
      styleDigest = await resolveStyle({
        cwd,
        credentials,
        agentConfig,
        state,
        llmStepTimeoutMs: resolved.llmStepTimeoutMs,
        usage,
      });
    } catch {
      styleDigest = agentConfig.contents;
    }

    const notice = autoMergeNotice(resolved.autoMerge);
    if (notice) (ctx.stdout ?? ((chunk: string) => process.stdout.write(chunk)))(notice);

    const runLoop = ctx.runLoop ?? defaultRunLoop;
    let result: WorkLoopResult;
    try {
      result = await runLoop({
        cwd,
        resolved,
        credentials,
        agentConfig,
        styleDigest,
        state,
        github,
        goal: args.goal,
        criteria: args.criteria,
        branch: args.branch,
        usage,
        modelLimits,
        logger,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
    } catch (err) {
      return { code: 1, message: errMsg(err) };
    }

    const stdout = ctx.stdout ?? ((chunk: string) => process.stdout.write(chunk));

    // Flush per-run usage/cost accounting (issue #114): persist totals + one summary line to the
    // stdout sink. Fire-and-forget — a tracker or state error must never change the run's outcome.
    try {
      const totals = await usage.totals();
      await state.update((s) => ({ ...s, usage: totals }));
      stdout(usageSummaryLine(totals));
    } catch {
      // observability must never break the run
    }

    // Every PR this run opened, with its URL — the first thing an operator wants when the run stops,
    // whatever the outcome. Read from persisted state (not the result) so it covers groups that opened
    // a PR before a later group blocked. Fire-and-forget, like the usage line.
    try {
      const block = prLinksBlock((await state.read()).prGroups);
      if (block !== '') stdout(block);
    } catch {
      // reporting must never break the run
    }

    // Persist the first awaiting-pr number into state so `aitm merge-pr` (with no --pr)
    // can pick it up. WorkLoop tracks per-group PR numbers but does not nominate one as
    // "current"; that's a CLI-level concern resolved here.
    if (result.kind === 'awaiting-pr' && result.prs.length > 0) {
      const firstPr = result.prs[0];
      if (firstPr !== undefined) {
        try {
          await state.update((s) => ({ ...s, currentPr: firstPr }));
        } catch (err) {
          return { code: 1, message: `Failed to persist currentPr: ${errMsg(err)}` };
        }
      }
    }

    return mapResultToExit(result);
  } finally {
    await disposeQuietly(disposer);
    await lock.release();
  }
}

// `aitm resume` — continue the run this directory already started. The goal is read from the state
// dir rather than retyped: a resumed run must never drift onto a subtly different goal than the one
// its plan was built for, and retyping it is exactly how that happens. Everything else is `start`,
// so this delegates rather than duplicating the precondition/loop wiring.
export async function runResume(
  args: Extract<ParsedArgs, { kind: 'resume' }>,
  ctx: StartCtx = {},
): Promise<CommandExit> {
  const cwd = ctx.cwd ?? process.cwd();
  const state = new StateStore(resolvePath(cwd, '.ai-task-master'));
  let persisted: Awaited<ReturnType<StateStore['readGoal']>>;
  try {
    persisted = await state.readGoal();
  } catch (err) {
    return { code: 1, message: `Failed to read the persisted goal: ${errMsg(err)}` };
  }
  if (persisted === null) {
    return {
      code: 1,
      message:
        'Nothing to resume here — no run has been started in this directory. Run `aitm start "<goal>"` first.',
    };
  }
  // A completed run has nothing to resume — re-planning its finished goal would redo merged work.
  // Say so (exit 0, not an error: the run succeeded) and point at `start` for new work. This also
  // keeps runStart's supersede-on-complete a `start`-only concern, since resume never reaches it.
  const resumeState = await state.read().catch(() => null);
  if (resumeState && isRunComplete(resumeState)) {
    return {
      code: 0,
      message:
        'This run is already complete — nothing to resume. Run `aitm start "<goal>"` to begin new work.',
    };
  }
  const { kind: _kind, ...flags } = args;
  return runStart(
    {
      kind: 'start',
      goal: persisted.goal,
      // A resumed run keeps the criteria it was planned against; an explicit --criteria still wins.
      ...(persisted.criteria !== undefined ? { criteria: persisted.criteria } : {}),
      ...flags,
    },
    ctx,
  );
}

export async function runMergePr(
  args: Extract<ParsedArgs, { kind: 'merge-pr' }>,
  ctx: MergePrCtx = {},
): Promise<CommandExit> {
  const cwd = ctx.cwd ?? process.cwd();
  const homeDir = ctx.homeDir ?? homedir();
  const env = ctx.env ?? process.env;
  const stderr = ctx.stderr ?? ((chunk: string) => process.stderr.write(chunk));
  const warn = warnToStderr(stderr);

  const loader = new ConfigLoader(cwd, homeDir, env, { warn });
  let resolved: ResolvedConfig;
  try {
    // `--admin` on merge-pr is a per-run override that forces the final merge past base-branch
    // policy, independent of any persisted run state.
    resolved = await loader.resolve(
      args.adminMerge !== undefined ? { adminMerge: args.adminMerge } : {},
    );
  } catch (err) {
    return { code: 1, message: errMsg(err) };
  }
  try {
    Credentials.assertApiKeyPresent(resolved);
  } catch (err) {
    return { code: 1, message: errMsg(err) };
  }
  const stateDir = resolvePath(cwd, '.ai-task-master');
  const state = new StateStore(stateDir);
  // One run at a time per state dir. Taken before any state is read or written and released in the
  // finally below, so a second `aitm` invocation here fails fast instead of silently racing this
  // run's plan, group stages and PR numbers through StateStore's write-behind cache.
  let lock: RunLockHandle;
  try {
    lock = await state.acquireRunLock();
  } catch (err) {
    return { code: 1, message: errMsg(err) };
  }

  // Command-scoped release stack, drained in the finally below. Wider than the loop adapter's own
  // disposer: what is acquired here (the keep-alive transport) is built before the loop and used by
  // steps that run outside it, so it cannot hang off a disposer that dies with the loop.
  const disposer = new Disposer();

  try {
    const github =
      ctx.github ?? new GitHubClient(cwd, defaultRunCmd, defaultSleep, ctx.signal, undefined, warn);

    // Detect agentConfig early so it can be passed to synthesizeTakeoverState, ensuring
    // the take-over state carries the actual detected config file rather than a hardcoded default.
    const detector = new AgentConfigDetector(cwd);
    const detectOpts = buildDetectOpts(undefined, resolved.stylePath, homeDir, warn);

    let agentConfig: AgentConfig | null;
    try {
      agentConfig = await detector.detect(detectOpts);
    } catch (err) {
      return { code: 1, message: errMsg(err) };
    }
    if (!agentConfig) {
      agentConfig = defaultAgentConfig();
    }

    // Take-over flow: `aitm merge-pr` (no args, no prior state) should work against any PR
    // the user built by hand — e.g. via Claude Code or `gh pr create`. We mirror the
    // claude-task-master `merge_pr` pattern: try to read existing state, and if absent,
    // synthesize a minimal one from --pr (or the current branch's PR) and persist it so
    // subsequent calls resume.
    let runState: RunState;
    // `--no-resume` means don't trust a persisted `currentPr` from a prior run — the PR is
    // re-resolved from --pr or the current branch instead. It does not mean the run behind that
    // number is junk, so the take-over PR is written in place: a mid-plan run keeps its plan,
    // group stages, options and runId rather than being replaced by a bare take-over state.
    if (args.resume === false) {
      const synth = await synthesizeTakeoverState({ args, github, resolved, agentConfig });
      if (synth.kind === 'error') return synth.exit;
      const takeover = synth.state;
      try {
        runState = await state.update((prior) => ({ ...prior, currentPr: takeover.currentPr }));
      } catch (err) {
        if (!isFileNotFound(err)) return unreadableStateExit(stateDir, err);
        runState = takeover;
        try {
          await state.init(runState);
        } catch (initErr) {
          return { code: 1, message: errMsg(initErr) };
        }
      }
    } else {
      try {
        runState = await state.read();
      } catch (err) {
        if (!isFileNotFound(err)) return unreadableStateExit(stateDir, err);
        const synth = await synthesizeTakeoverState({ args, github, resolved, agentConfig });
        if (synth.kind === 'error') return synth.exit;
        runState = synth.state;
        try {
          await state.init(runState);
        } catch (initErr) {
          return { code: 1, message: errMsg(initErr) };
        }
      }
    }

    // Run-scoped session id → sticky routing + prompt-cache key (plan slice 04a). Take-over reuses the
    // resolved (or freshly synthesized) state.runId so repeat merge-pr calls share one cache session.
    // Keep-alive transport (plan slice 04b) — see the start path; undefined off-Node keeps the default.
    const llmFetch = await (ctx.makeLlmFetch ?? createLlmFetch)();
    if (llmFetch) disposer.add(() => llmFetch.close());
    const credentials = new Credentials(resolved, runState.runId, llmFetch?.fetch);

    // The run's structured logger — see runStart. runState.runId is the take-over run's id (fresh or
    // resumed), so a resumed merge-pr keeps writing to the same .ai-task-master/logs/<runId>.log.
    const logger = new Logger(
      resolved.logLevel,
      runState.runId,
      join(stateDir, 'logs', `${runState.runId}.log`),
    );
    disposer.add(() => logger.flush());

    const pr = args.pr ?? runState.currentPr ?? undefined;
    if (pr === undefined) {
      return {
        code: 1,
        message:
          'No PR to merge. Pass --pr <N>, switch to the PR branch, or run `aitm start` to populate state.',
      };
    }

    const authStatus = ctx.authStatus ?? defaultAuthStatus;
    let auth: { ok: boolean; scopes: string[] };
    try {
      auth = await authStatus(cwd);
    } catch (err) {
      return { code: 1, message: errMsg(err) };
    }
    if (!auth.ok) {
      return { code: 1, message: 'gh CLI is not authenticated. Run `gh auth login`.' };
    }

    // Same read-or-distill-or-fallback as runStart; reuses the cached digest a prior `aitm start`
    // wrote, or distills once for a hand-built take-over PR. Never blocks the merge flow.
    const resolveStyle = ctx.resolveStyle ?? defaultResolveStyle;
    let styleDigest: string;
    try {
      styleDigest = await resolveStyle({
        cwd,
        credentials,
        agentConfig,
        state,
        llmStepTimeoutMs: resolved.llmStepTimeoutMs,
      });
    } catch {
      styleDigest = agentConfig.contents;
    }

    // Per-run token/cost accounting (issue #114/#190) — the parity gap that left `aitm merge-pr`
    // spend entirely unaccounted. One ModelLimitsRegistry for the tracker's pricing (a red-PR fix
    // session runs the same coding-tier Worker as `aitm start`); totals flush after the flow.
    const modelLimits = new ModelLimitsRegistry(
      new OpenRouterClient(resolved.openrouterApiKey, resolved.baseURL, ctx.signal),
      new OpenRouterReferenceCatalog(OPENROUTER_REFERENCE_URL, ctx.signal),
    );
    const usage = new UsageTracker(modelLimits);

    const runMergeFlow = ctx.runMergeFlow ?? defaultRunMergeFlow;
    let result: WorkLoopResult;
    try {
      result = await runMergeFlow({
        cwd,
        pr,
        resume: args.resume,
        resolved,
        credentials,
        agentConfig,
        styleDigest,
        state,
        runState,
        github,
        usage,
        logger,
        ...(args.maxIterations !== undefined ? { maxIterations: args.maxIterations } : {}),
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
    } catch (err) {
      return { code: 1, message: errMsg(err) };
    }

    // Flush per-run usage/cost accounting (issue #114/#190): persist totals + one summary line, the
    // same end-of-run reporting `aitm start` does. Fire-and-forget — a tracker or state error must
    // never change the run's outcome.
    try {
      const totals = await usage.totals();
      await state.update((s) => ({ ...s, usage: totals }));
      (ctx.stdout ?? ((chunk: string) => process.stdout.write(chunk)))(usageSummaryLine(totals));
    } catch {
      // observability must never break the run
    }

    return mapResultToExit(result);
  } finally {
    await disposeQuietly(disposer);
    await lock.release();
  }
}

export async function runConfig(
  args: Extract<ParsedArgs, { kind: `config-${string}` }>,
  ctx: ConfigCtx = {},
): Promise<CommandExit> {
  const cwd = ctx.cwd ?? process.cwd();
  const homeDir = ctx.homeDir ?? homedir();
  const env = ctx.env ?? process.env;
  const stdout = ctx.stdout ?? ((chunk: string) => process.stdout.write(chunk));
  const stderr = ctx.stderr ?? ((chunk: string) => process.stderr.write(chunk));
  const writer = new ConfigWriter(cwd, homeDir);

  try {
    switch (args.kind) {
      case 'config-set':
        await writer.set(args.scope, args.key, args.value);
        return { code: 0 };
      case 'config-unset':
        await writer.unset(args.scope, args.key);
        return { code: 0 };
      case 'config-get': {
        const value = await writer.get(args.scope, args.key);
        stdout(`${formatConfigValue(value)}\n`);
        return { code: 0 };
      }
      case 'config-list': {
        if (args.effective) {
          // `--scope` is meaningless for the merged view — it always resolves across every layer.
          // Resolution warnings (stale baseURL, stripped project fields) explain surprising
          // precedence, so route them to stderr rather than swallowing them.
          const loader = new ConfigLoader(cwd, homeDir, env, {
            warn: (m) => stderr(`${m}\n`),
          });
          const { resolved, sources } = await loader.resolveWithSources({});
          stdout(formatEffectiveConfig(resolved, sources));
          return { code: 0 };
        }
        const file = await writer.list(args.scope);
        // Never dump API keys in cleartext — `config list` output lands in terminals/logs.
        // Masks both the top-level key and any keys nested inside `profiles`.
        stdout(`${JSON.stringify(redactConfigKeys(file), null, 2)}\n`);
        return { code: 0 };
      }
      default:
        return {
          code: 1,
          message: `Unknown config subcommand: ${(args as { kind: string }).kind}`,
        };
    }
  } catch (err) {
    return { code: 1, message: errMsg(err) };
  }
}

// Mirror of claudetm's `clean`: delete the whole .ai-task-master/ state dir (logs and memory
// included — an explicit fresh start), confirming first unless --force.
export async function runClean(args: CleanArgs, ctx: CleanCtx = {}): Promise<CommandExit> {
  const cwd = ctx.cwd ?? process.cwd();
  const stdout = ctx.stdout ?? ((chunk: string) => process.stdout.write(chunk));
  const stateDir = resolvePath(cwd, '.ai-task-master');
  const state = new StateStore(stateDir);
  try {
    // Probe before confirming: with nothing to delete there is nothing to ask about — a non-TTY
    // `aitm clean` in a fresh repo must be the friendly exit-0 no-op, not a denied prompt.
    if (!(await state.exists())) {
      stdout('No task state found.\n');
      return { code: 0 };
    }
    if (!args.force) {
      const confirm = ctx.confirm ?? ttyConfirm;
      const approved = await confirm(`Delete ${stateDir} and all run state? [y/N] `);
      if (!approved) {
        return {
          code: 1,
          message: 'clean cancelled — state dir untouched (use --force to skip the prompt)',
        };
      }
    }
    await state.deleteAll();
    stdout('Task state cleaned.\n');
    return { code: 0 };
  } catch (err) {
    return { code: 1, message: errMsg(err) };
  }
}

// Interactive yes/no over stdin. Non-TTY stdin (CI, pipes) denies without prompting: an unattended
// `aitm clean` must opt into deletion with --force, never hang waiting for input. AbortSignal support
// allows testing/cancellation without patching globals.
async function ttyConfirm(question: string, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) {
    throw signal.reason ?? new Error('Aborted');
  }
  if (process.stdin.isTTY !== true) return false;
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const listener = () => rl.close();
  signal?.addEventListener('abort', listener);
  try {
    if (signal?.aborted) {
      throw signal.reason ?? new Error('Aborted');
    }
    const answer = await rl.question(question);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    signal?.removeEventListener('abort', listener);
    rl.close();
  }
}

export async function runProfile(
  args: Extract<ParsedArgs, { kind: `profile-${string}` }>,
  ctx: ProfileCtx = {},
): Promise<CommandExit> {
  const homeDir = ctx.homeDir ?? homedir();
  const stdout = ctx.stdout ?? ((chunk: string) => process.stdout.write(chunk));
  const stderr = ctx.stderr ?? ((chunk: string) => process.stderr.write(chunk));
  const manager = new ProfileManager(homeDir);

  try {
    switch (args.kind) {
      case 'profile-list': {
        const listing = await manager.list();
        stdout(formatProfileList(listing.activeProfile, listing.profiles));
        return { code: 0 };
      }
      case 'profile-use': {
        await manager.use(args.name);
        stdout(`Active profile is now "${args.name}".\n`);
        return { code: 0 };
      }
      case 'profile-add': {
        const input: AddProfileInput = {};
        if (args.preset !== undefined) input.preset = args.preset;
        if (args.baseURL !== undefined) input.baseURL = args.baseURL;
        if (args.apiKeyStdin) {
          const key = (await (ctx.readStdin ?? drainStdin)()).trim();
          if (key === '') return { code: 1, message: 'no API key received on stdin' };
          input.apiKey = key;
        } else if (args.apiKey !== undefined) {
          stderr(
            'warning: --api-key on the command line is visible in process listings and shell ' +
              'history; prefer --api-key-stdin (pipe the key) or the OPENROUTER_API_KEY env var.\n',
          );
          input.apiKey = args.apiKey;
        }
        await manager.add(args.name, input);
        // The first profile auto-activates; later ones don't — tailor the hint accordingly.
        const activated = (await manager.list()).activeProfile === args.name;
        stdout(
          activated
            ? `Created and activated profile "${args.name}".\n`
            : `Created profile "${args.name}". Run \`aitm profile use ${args.name}\` to activate it.\n`,
        );
        return { code: 0 };
      }
      case 'profile-set':
        await manager.set(args.name, args.key, args.value);
        return { code: 0 };
      case 'profile-get': {
        const value = await manager.get(args.name, args.key);
        stdout(`${formatConfigValue(value)}\n`);
        return { code: 0 };
      }
      case 'profile-remove':
        await manager.remove(args.name);
        stdout(`Removed profile "${args.name}".\n`);
        return { code: 0 };
      case 'profile-rename':
        await manager.rename(args.from, args.to);
        stdout(`Renamed profile "${args.from}" to "${args.to}".\n`);
        return { code: 0 };
      case 'profile-show': {
        const { name, profile } = await manager.show(args.name);
        stdout(`${name}\n${JSON.stringify(redactProfile(profile), null, 2)}\n`);
        return { code: 0 };
      }
      default:
        return {
          code: 1,
          message: `Unknown profile subcommand: ${(args as { kind: string }).kind}`,
        };
    }
  } catch (err) {
    return { code: 1, message: errMsg(err) };
  }
}

// OAuth login for MCP servers: perform authorization code flow and output config snippet.
export async function runMcpLogin(
  args: Extract<ParsedArgs, { kind: 'mcp-login' }>,
  ctx: McpLoginCtx = {},
): Promise<CommandExit> {
  const stdout = ctx.stdout ?? ((chunk: string) => process.stdout.write(chunk));
  const stderr = ctx.stderr ?? ((chunk: string) => process.stderr.write(chunk));

  try {
    // Endpoint discovery (RFC 8414 metadata + MCP WWW-Authenticate probe) and client-id resolution
    // live in mcp/oauth.ts; the CLI only forwards the server URL and user-supplied overrides.
    const login = ctx.performOAuth ?? (await import('../mcp/oauth.ts')).loginToMcpServer;

    const input: import('../mcp/oauth.ts').McpOAuthLoginInput = { serverUrl: args.serverUrl };
    if (args.callbackUrl) input.callbackUrl = args.callbackUrl;
    if (args.timeout) input.timeout = args.timeout;

    const config = await login(input);

    const configSnippet = JSON.stringify(
      {
        mcpServers: {
          [config.name]: {
            type: config.type,
            url: config.url,
            headers: config.headers,
          },
        },
      },
      null,
      2,
    );

    stdout('\n✅ OAuth authentication successful!\n\n');
    stdout('Add this to your .mcp.json or ~/.aitm.json:\n\n');
    stdout(`${configSnippet}\n\n`);

    return { code: 0 };
  } catch (err) {
    return { code: 1, message: errMsg(err) };
  }
}

// ---- helpers ---------------------------------------------------------------

function toCliOverrides(args: Extract<ParsedArgs, { kind: 'start' }>): CliOverrides {
  const out: CliOverrides = {};
  if (args.maxPrs !== undefined) out.maxPrs = args.maxPrs;
  if (args.maxSessions !== undefined)
    out.maxSessions = args.maxSessions === 0 ? null : args.maxSessions;
  if (args.autoMerge !== undefined) out.autoMerge = args.autoMerge;
  if (args.adminMerge !== undefined) out.adminMerge = args.adminMerge;
  if (args.allowDirty !== undefined) out.allowDirty = args.allowDirty;
  if (args.prPerTask !== undefined) out.prPerTask = args.prPerTask;
  if (args.stylePath !== undefined) out.stylePath = args.stylePath;
  if (args.model !== undefined) out.model = args.model;
  if (args.concurrency !== undefined && args.concurrency > 0) out.concurrency = args.concurrency;
  if (args.maxFixAttempts !== undefined) out.maxCiFixAttempts = args.maxFixAttempts;
  return out;
}

function mapResultToExit(result: WorkLoopResult): CommandExit {
  switch (result.kind) {
    case 'success':
      return { code: 0 };
    case 'blocked':
      return { code: 1, message: result.reason };
    case 'session-cap':
      return { code: 0, message: 'Session cap reached. Run `aitm start` again to resume.' };
    case 'awaiting-pr':
      return {
        code: 0,
        message: `PR(s) opened: ${result.prs.join(', ')}. Run \`aitm merge-pr\` to drive them to merge.`,
      };
    case 'cancelled':
      return { code: 2, message: 'Cancelled.' };
  }
}

function buildInitialRunState(input: {
  resolved: ResolvedConfig;
  agentConfig: AgentConfig;
}): RunState {
  const now = new Date().toISOString();
  const agentConfigFile: RunState['agentConfigFile'] =
    input.agentConfig.flavor === 'claude'
      ? 'CLAUDE.md'
      : input.agentConfig.flavor === 'agents'
        ? 'AGENTS.md'
        : 'custom';
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    status: 'planning',
    prGroups: [],
    currentGroupIndex: 0,
    currentTaskIndex: 0,
    sessionCount: 0,
    currentPr: null,
    runId: `run-${Date.now().toString(36)}`,
    provider: 'openrouter',
    model: input.resolved.models.generic ?? DEFAULT_MODELS.generic,
    agentConfigFile,
    createdAt: now,
    updatedAt: now,
    options: {
      autoMerge: input.resolved.autoMerge,
      prPerTask: input.resolved.prPerTask,
      maxPrs: input.resolved.maxPrs,
      maxSessions: input.resolved.maxSessions,
      mergeMethod: input.resolved.mergeMethod,
      stylePath: input.resolved.stylePath,
      concurrency: input.resolved.concurrency,
    },
  };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Recognises "no valid prior state" — the only conditions where we fall through to a
// fresh init. ENOENT means the file is absent. StateStore.read() prefixes any JSON
// parse or Zod schema error with the state-file path, so we match that prefix to
// distinguish corrupt state from genuine IO/permission errors.
// Whether a run has nothing left to do: the top-level status is 'success', or it planned at least one
// group and every one reached 'merged'. A plan-less or partly-done run is NOT complete (empty
// prGroups must not read as "all merged" via a vacuous every()), and a 'blocked'/'failed' run is
// resumable, not complete — so neither trips the supersede/short-circuit. Exported for unit testing.
export function isRunComplete(state: RunState): boolean {
  if (state.status === 'success') return true;
  return state.prGroups.length > 0 && state.prGroups.every((g) => g.status === 'merged');
}

function isMissingOrInvalidState(err: unknown, stateDir: string): boolean {
  // A run this build cannot read is not an invalid one. Discarding a state.json written by a newer
  // aitm would destroy a live run over a version gap, so it never routes to a forced fresh init.
  if (err instanceof UnsupportedSchemaVersion) return false;
  if (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: unknown }).code === 'ENOENT'
  ) {
    return true;
  }
  if (err instanceof Error) {
    const stateFile = join(stateDir, 'state.json');
    if (err.message.startsWith(`${stateFile}:`)) return true;
  }
  return false;
}

const defaultAuthStatus: AuthStatusFn = (cwd) => new GitHubClient(cwd).authStatus();

// Resolve the coding-style guide fed to subagent prompts: the project's CLAUDE.md/AGENTS.md verbatim
// plus a distilled digest of the repo's other signals (composeStyleGuide). Only the digest half is
// distilled and cached — the verbatim half is re-read from AgentConfig every run, so an edit to
// CLAUDE.md takes effect immediately instead of being pinned by a stale cache. Never blocks the run:
// an unreadable cache, a distill failure, or a cache-write failure all degrade to the verbatim file
// alone. StyleDistiller.distill already degrades internally; the guards here cover the cache IO.
async function defaultResolveStyle(input: ResolveStyleInput): Promise<string> {
  const { cwd, credentials, agentConfig, state } = input;
  try {
    const cached = await state.readCodingStyle();
    if (cached !== null && cached.trim() !== '') {
      harnessProgress('coding style: using cached digest');
      return composeStyleGuide(agentConfig, cached);
    }
  } catch {
    // Unreadable cache (non-ENOENT) — distill fresh rather than block the run.
  }
  let digest: string;
  try {
    // Style distillation runs on the planner's model, so its usage is recorded under `planner`.
    const onUsage = roleUsageSink(input.usage, 'planner', credentials.modelIdFor('planner'));
    const plannerModelId = credentials.modelIdFor('planner');
    const distiller = new StyleDistiller({
      model: credentials.modelFor('planner'),
      timeout: { stepMs: input.llmStepTimeoutMs },
      ...(onUsage ? { onUsage } : {}),
      // Single coarse announcement (no per-signal-file steps) so the pre-planning pause isn't a
      // silent gap — fired by StyleDistiller itself, once it knows what it actually gathered.
      onProgress: (message) => harnessProgress(`${message} with ${plannerModelId}`),
    });
    digest = await distiller.distill({ config: agentConfig, repoRoot: cwd });
  } catch {
    harnessProgress('coding style: distillation unavailable — using the raw style file');
    return composeStyleGuide(agentConfig, '');
  }
  harnessProgress('coding style: guide ready');
  try {
    await state.writeCodingStyle(digest);
  } catch {
    // Cache write failed — use the in-memory digest; a later resume re-distills.
  }
  return composeStyleGuide(agentConfig, digest);
}

// Default loop seam — production wiring of Planner → PlanGraph → InPlaceCheckout → WorkLoop with
// the Orchestrator/Worker/Reviewer subagents and MCP tools. Lives in run-loop-adapter.ts so this
// module stays pure dispatch; the adapter exposes its own seams for unit + integration tests.
async function defaultRunLoop(input: RunLoopInput): Promise<WorkLoopResult> {
  return runLoopAdapter(input);
}

// Default merge-flow seam — production wiring of the take-over flow (wait CI → Reviewer per
// unresolved thread → push → loop → merge) with the checkout-scoped tool surface and conflict
// resolver. Lives in merge-flow-adapter.ts so this module stays pure dispatch; the adapter
// exposes its own seams for unit + integration tests. See src/loop/take-over-flow.ts for the
// iteration shape (mirrors claude-task-master `merge_pr`).
async function defaultRunMergeFlow(input: RunMergeFlowInput): Promise<WorkLoopResult> {
  return mergeFlowAdapter(input);
}

type SynthesizeTakeoverResult =
  | { kind: 'ok'; state: RunState }
  | { kind: 'error'; exit: CommandExit };

// Build a minimal RunState that lets `merge-pr` take over a PR opened outside aitm. PR
// number comes from --pr or, failing that, from `gh pr view` against the current branch.
async function synthesizeTakeoverState(input: {
  args: Extract<ParsedArgs, { kind: 'merge-pr' }>;
  github: GitHubClient;
  resolved: ResolvedConfig;
  agentConfig: AgentConfig;
}): Promise<SynthesizeTakeoverResult> {
  const { args, github, resolved, agentConfig } = input;
  let pr = args.pr ?? null;
  if (pr === null) {
    let branch: string;
    try {
      branch = await github.currentBranch();
    } catch (err) {
      return {
        kind: 'error',
        exit: {
          code: 1,
          message: `Cannot detect a PR to take over: ${errMsg(err)}. Pass --pr <N> or switch to a branch with an open PR.`,
        },
      };
    }
    let found: { number: number } | null;
    try {
      found = await github.getPrForBranch(branch);
    } catch (err) {
      return { kind: 'error', exit: { code: 1, message: errMsg(err) } };
    }
    if (found === null) {
      return {
        kind: 'error',
        exit: {
          code: 1,
          message: `No open PR found for branch ${branch}. Pass --pr <N> to specify, or open a PR first.`,
        },
      };
    }
    pr = found.number;
  }

  const now = new Date().toISOString();
  const agentConfigFile: RunState['agentConfigFile'] =
    agentConfig.flavor === 'claude'
      ? 'CLAUDE.md'
      : agentConfig.flavor === 'agents'
        ? 'AGENTS.md'
        : 'custom';
  const state: RunState = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    status: 'awaiting-pr',
    prGroups: [],
    currentGroupIndex: 0,
    currentTaskIndex: 0,
    sessionCount: 0,
    currentPr: pr,
    runId: `takeover-${Date.now().toString(36)}`,
    provider: 'openrouter',
    model: resolved.models.generic ?? DEFAULT_MODELS.generic,
    agentConfigFile,
    createdAt: now,
    updatedAt: now,
    options: {
      autoMerge: resolved.autoMerge,
      prPerTask: resolved.prPerTask,
      maxPrs: resolved.maxPrs,
      maxSessions: resolved.maxSessions,
      mergeMethod: resolved.mergeMethod,
      stylePath: resolved.stylePath,
      concurrency: resolved.concurrency,
    },
  };
  return { kind: 'ok', state };
}

// A state.json that is present but unreadable is never rewritten from under the operator — not
// even by `--no-resume`, which distrusts one field, not the file. They fix or delete it.
function unreadableStateExit(stateDir: string, err: unknown): CommandExit {
  return {
    code: 1,
    message: `Run state at ${join(stateDir, 'state.json')} is unreadable: ${errMsg(err)}. Fix or delete the file to start fresh.`,
  };
}

function isFileNotFound(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: unknown }).code === 'ENOENT'
  );
}
