// Typed builders for the orchestrator bridge's inputs (issue #330).
//
// The bridge tests built these as `{...} as never`. `never` is assignable to everything, so the cast
// did not widen the literal — it switched the checker off for it entirely. #181 proved the cost: a
// new required field on the ctx left `typecheck:tests` green and killed 13 tests at runtime with
// `Cannot read properties of undefined`, which is the exact drift #132's gate exists to catch.
//
// This moves the construction into ONE place with a checked return type. A call site now states only
// what its assertion turns on, and a new required field breaks this file once — loudly, at compile
// time — instead of every literal silently at runtime.
//
// The doubles here are REAL instances with the outside-world methods overridden, not shapes that
// merely resemble them: a `Credentials` that answers with a silent model still carries every other
// method the bridge might reach, and a `GitHubClient` built on a no-op `RunCmd` still runs its own
// argument handling. A shape would drift from the class; an instance cannot.

import { backgroundProcessTools } from '@developerz.ai/ai-claude-compat';
import type { LanguageModel } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import type { RunLoopInput } from '../composition/run-input.ts';
import { Credentials } from '../credentials/credentials.ts';
import type { PrGroup } from '../domain/pr-group.ts';
import { GitHubClient } from '../github/github-client.ts';
import type { AdapterStatePort } from '../loop/adapter-support.ts';
import type { OrchestratorBridgeCtx } from '../loop/run-loop-adapter.ts';
import type { WorkerInvocation } from '../loop/work-loop.ts';
import { McpClientManager } from '../mcp/mcp-client.ts';
import { CURRENT_SCHEMA_VERSION, type RunState } from '../state/schema.ts';
import { StateStore } from '../state/state-store.ts';
import type { Checkout } from '../workspace/in-place-checkout.ts';
import { agentConfig, resolvedConfig } from './domain-fixtures.ts';

// A model handle that never answers: the bridge tests assert on what gets COMPOSED (prompts, tool
// sets, wiring), never on a completion. A test that needs a reply passes its own model.
function silentModel(): LanguageModel {
  return new MockLanguageModelV3();
}

export function bridgeCredentials(over: Partial<Credentials> = {}): Credentials {
  const real = new Credentials(resolvedConfig());
  return Object.assign(real, {
    modelFor: () => silentModel(),
    modelForCapability: () => silentModel(),
    modelIdFor: () => 'openai/gpt-5',
    modelIdForCapability: () => 'openai/gpt-5',
    ...over,
  });
}

// A `GitHubClient` on a `RunCmd` that answers every `gh` invocation with empty success. The bridge
// tests never reach GitHub; a call that did would return "no such PR" rather than shell out.
export function bridgeGithub(cwd = '/tmp/aitm-bridge'): GitHubClient {
  return new GitHubClient(cwd, async () => ({ stdout: '', stderr: '', exitCode: 0 }));
}

export function bridgeInput(over: Partial<RunLoopInput> = {}): RunLoopInput {
  const cwd = over.cwd ?? '/tmp/aitm-bridge';
  return {
    cwd,
    resolved: resolvedConfig(),
    credentials: bridgeCredentials(),
    agentConfig: agentConfig({ path: '/tmp/CLAUDE.md', contents: '' }),
    // Never written to: the bridge takes its state through the ctx's `state` port, not this one.
    state: new StateStore(cwd),
    github: bridgeGithub(cwd),
    goal: 'g',
    criteria: undefined,
    branch: undefined,
    ...over,
  };
}

export function bridgeCtx(over: Partial<OrchestratorBridgeCtx> = {}): OrchestratorBridgeCtx {
  const input = over.input ?? bridgeInput();
  return {
    input,
    mcp: new McpClientManager({ servers: {} }),
    rollingContext: '',
    fetchHtmlAvailable: false,
    state: bridgeState(),
    stepCounter: () => undefined,
    background: backgroundProcessTools({ cwd: input.cwd }),
    skills: [],
    ...over,
  };
}

// `read`/`update` are the only two the port requires; everything else on it is optional and a test
// that turns on one of them (a transcript store, a context writer) states just that one.
export function bridgeState(over: Partial<AdapterStatePort> = {}): AdapterStatePort {
  return { read: async () => baseRunState(), update: async (m) => m(baseRunState()), ...over };
}

export function bridgeCheckout(over: Partial<Checkout> = {}): Checkout {
  return { groupId: 'core', branch: 'aitm/core', path: '/tmp/wt', ...over };
}

// The group is the one field every runWorker assertion turns on (carry-over is keyed by it, the
// acceptance check rides on it), so it is stated rather than defaulted.
export function workerInvocation(
  group: PrGroup,
  over: Partial<WorkerInvocation> = {},
): WorkerInvocation {
  return { group, checkout: bridgeCheckout({ groupId: group.id }), baseBranch: 'main', ...over };
}

// The minimum a `read()`/`update()` port must return. Typed as `RunState` rather than inferred, so
// a schema change breaks here instead of producing a shape the port silently accepts. Kept local: a
// bridge test that cares about run state overrides `state` with its own port.
function baseRunState(): RunState {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    status: 'working',
    prGroups: [],
    currentGroupIndex: 0,
    currentTaskIndex: 0,
    sessionCount: 0,
    currentPr: null,
    runId: 'run-bridge',
    provider: 'openrouter',
    model: 'openai/gpt-5',
    agentConfigFile: 'CLAUDE.md',
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    options: {
      autoMerge: true,
      maxPrs: 5,
      maxSessions: null,
      mergeMethod: 'squash',
      stylePath: null,
      concurrency: 1,
      prPerTask: false,
    },
  };
}
