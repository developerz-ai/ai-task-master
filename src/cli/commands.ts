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
import { ConfigLoader } from '../config/config-loader.ts';
import { ConfigWriter } from '../config/config-writer.ts';
import type { CliOverrides, ResolvedConfig } from '../config/schema.ts';
import { Credentials } from '../credentials/credentials.ts';
import { DEFAULT_MODELS } from '../credentials/defaults.ts';
import { GitHubClient } from '../github/github-client.ts';
import type { WorkLoopResult } from '../loop/work-loop.ts';
import type { RunState } from '../state/schema.ts';
import { StateStore } from '../state/state-store.ts';
import type { ParsedArgs } from './args.ts';

export type CommandExit = { code: 0 | 1 | 2; message?: string };

export type AuthStatusFn = (cwd: string) => Promise<{ ok: boolean; scopes: string[] }>;

export type RunLoopInput = {
  cwd: string;
  resolved: ResolvedConfig;
  credentials: Credentials;
  agentConfig: AgentConfig;
  state: StateStore;
  github: GitHubClient;
  goal: string;
  criteria: string | undefined;
};

export type RunMergeFlowInput = {
  cwd: string;
  pr: number;
  resume: boolean;
  resolved: ResolvedConfig;
  credentials: Credentials;
  agentConfig: AgentConfig;
  state: StateStore;
  runState: RunState;
  github: GitHubClient;
};

export type StartCtx = {
  cwd?: string;
  homeDir?: string;
  env?: Record<string, string | undefined>;
  authStatus?: AuthStatusFn;
  runLoop?: (input: RunLoopInput) => Promise<WorkLoopResult>;
};

export type MergePrCtx = {
  cwd?: string;
  homeDir?: string;
  env?: Record<string, string | undefined>;
  authStatus?: AuthStatusFn;
  runMergeFlow?: (input: RunMergeFlowInput) => Promise<WorkLoopResult>;
};

export type ConfigCtx = {
  cwd?: string;
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
  // runId and prGroups are preserved. Fresh start on any read failure (ENOENT / schema mismatch).
  let resuming = false;
  try {
    await state.read();
    resuming = true;
  } catch {
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

  const runLoop = ctx.runLoop ?? defaultRunLoop;
  let result: WorkLoopResult;
  try {
    result = await runLoop({
      cwd,
      resolved,
      credentials,
      agentConfig,
      state,
      github,
      goal: args.goal,
      criteria: args.criteria,
    });
  } catch (err) {
    return { code: 1, message: errMsg(err) };
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
  let runState: RunState;
  try {
    runState = await state.read();
  } catch (err) {
    return {
      code: 1,
      message: `Could not read run state at ${join(stateDir, 'state.json')}. Did you run \`aitm start\`? (${errMsg(err)})`,
    };
  }

  const pr = args.pr ?? runState.currentPr ?? undefined;
  if (pr === undefined) {
    return {
      code: 1,
      message: 'No PR to merge. Pass --pr <N> or run `aitm start` first to populate state.',
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
  const github = new GitHubClient(cwd);

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
      state,
      runState,
      github,
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
        stdout(`${JSON.stringify(file, null, 2)}\n`);
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

// ---- helpers ---------------------------------------------------------------

function toCliOverrides(args: Extract<ParsedArgs, { kind: 'start' }>): CliOverrides {
  const out: CliOverrides = {};
  if (args.maxPrs !== undefined) out.maxPrs = args.maxPrs;
  if (args.maxSessions !== undefined)
    out.maxSessions = args.maxSessions === 0 ? null : args.maxSessions;
  if (args.autoMerge !== undefined) out.autoMerge = args.autoMerge;
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

function formatConfigValue(value: unknown): string {
  if (value === undefined) return '';
  if (typeof value === 'string') return value;
  return JSON.stringify(value, null, 2);
}

const defaultAuthStatus: AuthStatusFn = (cwd) => new GitHubClient(cwd).authStatus();

// Default loop seam — the production wiring of Orchestrator+Worker+Reviewer subagent
// tools, MCP servers, and worktree pool lands in the integration phase (plan PR 12).
// Until that adapter exists, surface a clear `blocked` outcome instead of throwing
// "not implemented", so the dispatch path itself stays observable.
async function defaultRunLoop(_input: RunLoopInput): Promise<WorkLoopResult> {
  return {
    kind: 'blocked',
    reason:
      'WorkLoop adapter not yet wired in this build. Inject `runLoop` via CLI options, or wait for the integration wiring task.',
    outcomes: [],
  };
}

async function defaultRunMergeFlow(_input: RunMergeFlowInput): Promise<WorkLoopResult> {
  return {
    kind: 'blocked',
    reason:
      'merge-pr flow adapter not yet wired in this build. Inject `runMergeFlow` via CLI options, or wait for the integration wiring task.',
    outcomes: [],
  };
}
