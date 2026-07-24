// The CLI↔loop boundary contract: what a composition root assembles and hands to the run/merge
// adapters. Home of these types used to be `cli/commands.ts`, which made `loop/`'s own input
// contract live in the CLI and created a genuine cli↔loop type cycle (commands.ts value-imports the
// adapters; the adapters type-imported these back). Owning the contract here — a leaf both `cli/`
// and `loop/` depend on, importing neither — dissolves that cycle. The rest of the wiring halves of
// the two composition roots migrate into `src/composition/` in the following steps.

import type { AgentConfig } from '../agent-config/agent-config-detector.ts';
import type { ResolvedConfig } from '../config/schema.ts';
import type { Credentials } from '../credentials/credentials.ts';
import type { GitHubClient } from '../github/github-client.ts';
import type { LoggerLike } from '../logger/logger.ts';
import type { UsageTracker } from '../observability/usage-tracker.ts';
import type { ModelLimitsLookup } from '../openrouter/model-limits.ts';
import type { RunState } from '../state/schema.ts';
import type { StateStore } from '../state/state-store.ts';

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
  // Per-run token/cost accounting (issue #114). The adapter binds role-scoped onUsage sinks off it;
  // runStart flushes totals() to state + a summary line. Unset → no accounting.
  usage?: UsageTracker;
  // The single ModelLimitsRegistry for the run, shared by the tracker's pricing and the Compactor's
  // context lookup (#102) so the catalog is fetched at most once. Unset → the adapter builds its own.
  modelLimits?: ModelLimitsLookup;
  // Abort handle threaded from the CLI's SIGINT/SIGTERM handler (cli.ts). On abort the adapter closes
  // MCP so a force-exit can't orphan its stdio children; unset → no cancellation wiring.
  signal?: AbortSignal;
  // The run's structured logger, threaded into every loop consumer that accepts `logger?: LoggerLike`
  // (worker verify, MCP lifecycle, conflict resolution, compaction). Constructed in runStart; unset
  // in unit tests that stub the loop, where each `logger?.warn(...)` stays a no-op.
  logger?: LoggerLike;
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
  // Per-run token/cost accounting (issue #114/#190). The adapter binds role-scoped onUsage sinks off
  // it and threads them through the take-over subagents; runMergePr flushes totals() to state + a
  // summary line. Unset → no accounting (matching the merge flow's prior behavior).
  usage?: UsageTracker;
  // Abort handle so a SIGINT (or a test) cancels the take-over loop → exit code 2.
  signal?: AbortSignal;
  // The run's structured logger — same role as RunLoopInput.logger, threaded through the take-over
  // flow (its shared CI-fix session + conflict resolver). Constructed in runMergePr.
  logger?: LoggerLike;
};
