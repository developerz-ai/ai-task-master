// docs/commands/start.md, docs/commands/merge-pr.md, docs/commands/config.md
// Dispatcher only. Each command does precondition checks → wires deps → kicks WorkLoop / writes config.
//
// The heavy WorkLoop+Orchestrator wiring is exposed via the `runLoop` / `runMergeFlow`
// injection seams so this module stays pure dispatch and is unit-testable without
// spinning up real subagents. Default seam implementations live below; integration
// tests (PR 12) cover the end-to-end stack.

import { homedir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';
import { type AgentConfig, AgentConfigDetector } from '../agent-config/agent-config-detector.ts';
import { StyleDistiller } from '../agent-config/coding-style.ts';
import { ConfigLoader } from '../config/config-loader.ts';
import { ConfigWriter } from '../config/config-writer.ts';
import { type AddProfileInput, ProfileManager } from '../config/profiles.ts';
import type { CliOverrides, ConfigFile, Profile, ResolvedConfig } from '../config/schema.ts';
import { Credentials } from '../credentials/credentials.ts';
import { DEFAULT_MODELS } from '../credentials/defaults.ts';
import { GitHubClient } from '../github/github-client.ts';
import { localEditTools, runLoopAdapter } from '../loop/run-loop-adapter.ts';
import type { WorkLoopResult } from '../loop/work-loop.ts';
import type { PrGroup, RunState } from '../state/schema.ts';
import { StateStore } from '../state/state-store.ts';
import type { ParsedArgs } from './args.ts';

export type CommandExit = { code: 0 | 1 | 2; message?: string };

export type AuthStatusFn = (cwd: string) => Promise<{ ok: boolean; scopes: string[] }>;

export type RunLoopInput = {
  cwd: string;
  resolved: ResolvedConfig;
  credentials: Credentials;
  agentConfig: AgentConfig;
  // Distilled coding-style digest; when absent, subagents fall back to agentConfig.contents.
  styleDigest?: string;
  state: StateStore;
  github: GitHubClient;
  goal: string;
  criteria: string | undefined;
  // Caller-specified PR branch (from `--branch`). Used verbatim for a single-group plan,
  // prefixed per group otherwise. Undefined falls back to `aitm/<group-id>`.
  branch: string | undefined;
};

export type RunMergeFlowInput = {
  cwd: string;
  pr: number;
  resume: boolean;
  resolved: ResolvedConfig;
  credentials: Credentials;
  agentConfig: AgentConfig;
  styleDigest?: string;
  state: StateStore;
  runState: RunState;
  github: GitHubClient;
  // Cap on CI-wait/fix iterations before giving up. From `--max-iterations`; the flow defaults to 30.
  maxIterations?: number;
  // Abort handle so a SIGINT (or a test) cancels the take-over loop → exit code 2.
  signal?: AbortSignal;
};

// Inputs for resolving the coding-style digest fed to subagent prompts. The digest is distilled
// once from AgentConfig + repo signals (StyleDistiller) and cached in the state dir; resume reuses
// the cache. Bundled so the `resolveStyle` seam is stubbable in unit tests without a real LLM call.
export type ResolveStyleInput = {
  cwd: string;
  credentials: Credentials;
  agentConfig: AgentConfig;
  state: StateStore;
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
  // Resolve the distilled coding-style digest threaded to subagents as `styleDigest`. Default:
  // reuse the cached `coding-style.md`, else distill once and cache it — never blocking the run
  // (degrades to raw AgentConfig.contents). Injected so unit tests skip the real LLM call.
  resolveStyle?: (input: ResolveStyleInput) => Promise<string>;
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
  // Abort handle, threaded into the take-over loop. When aborted, the flow returns `cancelled`
  // → exit code 2. The CLI can wire this to a SIGINT handler; tests drive it directly.
  signal?: AbortSignal;
};

export type ConfigCtx = {
  cwd?: string;
  homeDir?: string;
  stdout?: (chunk: string) => void;
};

export type ProfileCtx = {
  homeDir?: string;
  stdout?: (chunk: string) => void;
};

export async function runStart(
  args: Extract<ParsedArgs, { kind: 'start' }>,
  ctx: StartCtx = {},
): Promise<CommandExit> {
  const cwd = ctx.cwd ?? process.cwd();
  const homeDir = ctx.homeDir ?? homedir();
  const env = ctx.env ?? process.env;

  const loader = new ConfigLoader(cwd, homeDir, env);
  let resolved: ResolvedConfig;
  try {
    resolved = await loader.resolve(toCliOverrides(args));
  } catch (err) {
    return { code: 1, message: errMsg(err) };
  }

  try {
    Credentials.assertApiKeyPresent(resolved);
  } catch (err) {
    return { code: 1, message: errMsg(err) };
  }
  const credentials = new Credentials(resolved);

  const detector = new AgentConfigDetector(cwd);
  const detectOpts: { stylePath?: string | null } = {};
  if (args.stylePath !== undefined) detectOpts.stylePath = args.stylePath;
  else if (resolved.stylePath !== null) detectOpts.stylePath = resolved.stylePath;

  let agentConfig: AgentConfig | null;
  try {
    agentConfig = await detector.detect(detectOpts);
  } catch (err) {
    return { code: 1, message: errMsg(err) };
  }
  if (!agentConfig) {
    return {
      code: 1,
      message:
        'No CLAUDE.md or AGENTS.md found in the target repo (and no --style override). Add one or pass --style <path>.',
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
  const github = new GitHubClient(cwd);

  const stateDir = resolvePath(cwd, '.ai-task-master');
  const state = new StateStore(stateDir);

  // Resume detection: if a previous run left a valid state.json, skip re-init so
  // runId and prGroups are preserved. Only fall back on expected "missing/invalid
  // prior state" cases (ENOENT, JSON parse failure, schema mismatch); surface every
  // other error (permissions, IO) as a hard failure rather than silently re-initing.
  let resuming = false;
  let existingState: RunState | null = null;
  try {
    existingState = await state.read();
    resuming = true;
  } catch (err) {
    if (!isMissingOrInvalidState(err, stateDir)) {
      return { code: 1, message: `Could not read run state: ${errMsg(err)}` };
    }
    // No valid state.json — proceed with fresh init.
  }

  if (!resuming) {
    const initial = buildInitialRunState({ resolved, agentConfig });
    try {
      await state.init(initial);
      await state.writeGoal(args.goal, args.criteria);
      await loader.writeSnapshot(resolved, stateDir);
    } catch (err) {
      return { code: 1, message: errMsg(err) };
    }
  }

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

  // Coding-style digest (plan slice 01): distilled once from AgentConfig + repo signals and cached
  // in the state dir, reused on resume. Threaded into the loop so planner/worker/reviewer prompts
  // carry the digest. Never blocks — a thrown seam degrades to raw AgentConfig.contents.
  const resolveStyle = ctx.resolveStyle ?? defaultResolveStyle;
  let styleDigest: string;
  try {
    styleDigest = await resolveStyle({ cwd, credentials, agentConfig, state });
  } catch {
    styleDigest = agentConfig.contents;
  }

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
    });
  } catch (err) {
    return { code: 1, message: errMsg(err) };
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
}

export async function runMergePr(
  args: Extract<ParsedArgs, { kind: 'merge-pr' }>,
  ctx: MergePrCtx = {},
): Promise<CommandExit> {
  const cwd = ctx.cwd ?? process.cwd();
  const homeDir = ctx.homeDir ?? homedir();
  const env = ctx.env ?? process.env;

  const loader = new ConfigLoader(cwd, homeDir, env);
  let resolved: ResolvedConfig;
  try {
    resolved = await loader.resolve({});
  } catch (err) {
    return { code: 1, message: errMsg(err) };
  }
  try {
    Credentials.assertApiKeyPresent(resolved);
  } catch (err) {
    return { code: 1, message: errMsg(err) };
  }
  const credentials = new Credentials(resolved);

  const stateDir = resolvePath(cwd, '.ai-task-master');
  const state = new StateStore(stateDir);
  const github = ctx.github ?? new GitHubClient(cwd);

  // Take-over flow: `aitm merge-pr` (no args, no prior state) should work against any PR
  // the user built by hand — e.g. via Claude Code or `gh pr create`. We mirror the
  // claude-task-master `merge_pr` pattern: try to read existing state, and if absent,
  // synthesize a minimal one from --pr (or the current branch's PR) and persist it so
  // subsequent calls resume.
  let runState: RunState;
  try {
    runState = await state.read();
  } catch (err) {
    if (!isFileNotFound(err)) {
      return {
        code: 1,
        message: `Run state at ${join(stateDir, 'state.json')} is unreadable: ${errMsg(err)}. Fix or delete the file to start fresh.`,
      };
    }
    const synth = await synthesizeTakeoverState({ args, github, resolved });
    if (synth.kind === 'error') return synth.exit;
    runState = synth.state;
    try {
      await state.init(runState);
    } catch (initErr) {
      return { code: 1, message: errMsg(initErr) };
    }
  }

  const pr = args.pr ?? runState.currentPr ?? undefined;
  if (pr === undefined) {
    return {
      code: 1,
      message:
        'No PR to merge. Pass --pr <N>, switch to the PR branch, or run `aitm start` to populate state.',
    };
  }

  const detector = new AgentConfigDetector(cwd);
  const detectOpts: { stylePath?: string | null } = {};
  if (runState.options.stylePath !== null) detectOpts.stylePath = runState.options.stylePath;

  let agentConfig: AgentConfig | null;
  try {
    agentConfig = await detector.detect(detectOpts);
  } catch (err) {
    return { code: 1, message: errMsg(err) };
  }
  if (!agentConfig) {
    return {
      code: 1,
      message:
        'No CLAUDE.md or AGENTS.md found in the target repo (and no stylePath in state). Add one or pass --style on `aitm start`.',
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
    styleDigest = await resolveStyle({ cwd, credentials, agentConfig, state });
  } catch {
    styleDigest = agentConfig.contents;
  }

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
      ...(args.maxIterations !== undefined ? { maxIterations: args.maxIterations } : {}),
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
  } catch (err) {
    return { code: 1, message: errMsg(err) };
  }
  return mapResultToExit(result);
}

export async function runConfig(
  args: Extract<ParsedArgs, { kind: `config-${string}` }>,
  ctx: ConfigCtx = {},
): Promise<CommandExit> {
  const cwd = ctx.cwd ?? process.cwd();
  const homeDir = ctx.homeDir ?? homedir();
  const stdout = ctx.stdout ?? ((chunk: string) => process.stdout.write(chunk));
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

export async function runProfile(
  args: Extract<ParsedArgs, { kind: `profile-${string}` }>,
  ctx: ProfileCtx = {},
): Promise<CommandExit> {
  const homeDir = ctx.homeDir ?? homedir();
  const stdout = ctx.stdout ?? ((chunk: string) => process.stdout.write(chunk));
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
        if (args.apiKey !== undefined) input.apiKey = args.apiKey;
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

// ---- helpers ---------------------------------------------------------------

function toCliOverrides(args: Extract<ParsedArgs, { kind: 'start' }>): CliOverrides {
  const out: CliOverrides = {};
  if (args.maxPrs !== undefined) out.maxPrs = args.maxPrs;
  if (args.maxSessions !== undefined)
    out.maxSessions = args.maxSessions === 0 ? null : args.maxSessions;
  if (args.autoMerge !== undefined) out.autoMerge = args.autoMerge;
  if (args.prPerTask !== undefined) out.prPerTask = args.prPerTask;
  if (args.stylePath !== undefined) out.stylePath = args.stylePath;
  if (args.model !== undefined) out.model = args.model;
  if (args.concurrency !== undefined && args.concurrency > 0) out.concurrency = args.concurrency;
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
function isMissingOrInvalidState(err: unknown, stateDir: string): boolean {
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

// Mask a secret for display: keep the non-secret `sk-or-` prefix + last 4 chars so the user can
// confirm WHICH key is set without exposing it. Short values are fully hidden.
function maskSecret(value: string): string {
  return value.length <= 12 ? '***' : `${value.slice(0, 6)}…${value.slice(-4)}`;
}

function formatConfigValue(value: unknown): string {
  if (value === undefined) return '';
  if (typeof value === 'string') return value;
  return JSON.stringify(value, null, 2);
}

// One line per profile: an active marker, the name, its base URL, and a masked key hint.
function formatProfileList(active: string | undefined, profiles: Record<string, Profile>): string {
  const names = Object.keys(profiles).sort();
  if (names.length === 0) {
    return 'No profiles configured. Create one with `aitm profile add <name> --preset zai`.\n';
  }
  const lines = names.map((name) => {
    const p = profiles[name] ?? {};
    const marker = name === active ? '*' : ' ';
    const base = p.baseURL ?? '(provider default)';
    const key = p.openrouterApiKey ? maskSecret(p.openrouterApiKey) : '(no key)';
    return `${marker} ${name}\t${base}\t${key}`;
  });
  return `${lines.join('\n')}\n`;
}

// Mask the API key inside a single profile for display.
function redactProfile(profile: Profile): Profile {
  return profile.openrouterApiKey
    ? { ...profile, openrouterApiKey: maskSecret(profile.openrouterApiKey) }
    : profile;
}

// Redact a whole config file for `config list`: the top-level key and every profile's key.
function redactConfigKeys(file: ConfigFile): ConfigFile {
  const out: ConfigFile = file.openrouterApiKey
    ? { ...file, openrouterApiKey: maskSecret(file.openrouterApiKey) }
    : { ...file };
  if (out.profiles) {
    const profiles: Record<string, Profile> = {};
    for (const [name, profile] of Object.entries(out.profiles)) {
      profiles[name] = redactProfile(profile);
    }
    out.profiles = profiles;
  }
  return out;
}

const defaultAuthStatus: AuthStatusFn = (cwd) => new GitHubClient(cwd).authStatus();

// Resolve the coding-style digest fed to subagent prompts: reuse the cached digest when present,
// otherwise distill it once (smart-tier model) and cache it so resume reuses it. Never blocks the
// run — an unreadable cache, a distill failure, or a cache-write failure all degrade to the raw
// AgentConfig.contents. StyleDistiller.distill already degrades internally; the guards here cover
// the surrounding cache IO so a flaky style step can't halt planning or merging.
async function defaultResolveStyle(input: ResolveStyleInput): Promise<string> {
  const { cwd, credentials, agentConfig, state } = input;
  try {
    const cached = await state.readCodingStyle();
    if (cached !== null && cached.trim() !== '') return cached;
  } catch {
    // Unreadable cache (non-ENOENT) — distill fresh rather than block the run.
  }
  let digest: string;
  try {
    const distiller = new StyleDistiller({ model: credentials.modelFor('planner') });
    digest = await distiller.distill({ config: agentConfig, repoRoot: cwd });
  } catch {
    return agentConfig.contents;
  }
  try {
    await state.writeCodingStyle(digest);
  } catch {
    // Cache write failed — use the in-memory digest; a later resume re-distills.
  }
  return digest;
}

// Default loop seam — production wiring of Planner → PlanGraph → WorktreePool → WorkLoop with
// the Orchestrator/Worker/Reviewer subagents and MCP tools. Lives in run-loop-adapter.ts so this
// module stays pure dispatch; the adapter exposes its own seams for unit + integration tests.
async function defaultRunLoop(input: RunLoopInput): Promise<WorkLoopResult> {
  return runLoopAdapter(input);
}

// Real merge-pr adapter. Drives runTakeOverFlow against the cwd worktree: wait CI →
// Reviewer per unresolved thread → push → loop → merge. See src/loop/take-over-flow.ts
// for the iteration shape (mirrors claude-task-master `merge_pr`).
async function defaultRunMergeFlow(input: RunMergeFlowInput): Promise<WorkLoopResult> {
  const { runTakeOverFlow } = await import('../loop/take-over-flow.ts');
  const { githubThreadTool } = await import('../tools/github-thread-tool.ts');
  const { PrContextStore } = await import('../state/pr-context-store.ts');

  const worktreePath = input.cwd;
  const baseBranch = await input.github.defaultBranch();
  const styleContents = input.styleDigest ?? input.agentConfig.contents;
  // Downloads full failed-CI logs + review comments under .ai-task-master/debugging/pr/<pr>/ so
  // the CI-fix Worker reads them off disk instead of guessing (issue #48).
  const prContext = new PrContextStore(resolvePath(input.cwd, '.ai-task-master'));

  // Build the Claude-Code-style tool surface scoped to the cwd worktree. The Worker gets the
  // full read/write/edit/search/bash set; the Reviewer adds the `github` thread tool.
  const workerTools = localEditTools(worktreePath);
  const github = githubThreadTool({ github: input.github });

  const result = await runTakeOverFlow({
    pr: input.pr,
    worktreePath,
    baseBranch,
    github: input.github,
    prContext,
    mergeMethod: input.runState.options.mergeMethod,
    ...(input.maxIterations !== undefined ? { maxIterations: input.maxIterations } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
    // Pushes go through take-over-flow's shared rebaseAndForcePush helper (rebase onto
    // origin/<base> → `git push --force-with-lease`); `runCmd` defaults to real git via execa.
    subagents: {
      reviewerModel: input.credentials.modelFor('reviewer'),
      reviewerTools: { ...workerTools, github },
      workerModel: input.credentials.modelFor('worker'),
      workerTools,
      styleContents,
      ...(input.resolved.formatCommand ? { formatCommand: input.resolved.formatCommand } : {}),
    },
  });

  if (result.kind === 'merged') {
    return {
      kind: 'success',
      outcomes: [{ groupId: `takeover-${result.pr}`, status: 'merged', pr: result.pr }],
    };
  }
  if (result.kind === 'cancelled') {
    return { kind: 'cancelled', outcomes: [] };
  }
  return {
    kind: 'blocked',
    reason: result.reason,
    outcomes: [{ groupId: `takeover-${input.pr}`, status: 'blocked', reason: result.reason }],
  };
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
}): Promise<SynthesizeTakeoverResult> {
  const { args, github, resolved } = input;
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
  const state: RunState = {
    status: 'awaiting-pr',
    prGroups: [],
    currentGroupIndex: 0,
    currentTaskIndex: 0,
    sessionCount: 0,
    currentPr: pr,
    runId: `takeover-${Date.now().toString(36)}`,
    provider: 'openrouter',
    model: resolved.models.generic ?? DEFAULT_MODELS.generic,
    agentConfigFile: 'CLAUDE.md',
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

function isFileNotFound(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: unknown }).code === 'ENOENT'
  );
}
