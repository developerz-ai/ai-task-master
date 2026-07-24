// Tracks the OS process every stdio MCP server spawns and guarantees it dies with the run.
// SRP: process lifetime only — connecting, tool exposure, and role gating are McpClientManager's job.
//
// Why this exists on top of the SDK's own cleanup: @ai-sdk/mcp's stdio transport SIGTERMs its child
// through an AbortSignal in close(), then immediately forgets the handle. Nothing verifies the child
// actually exited, so a server that ignores SIGTERM (or wedges on shutdown) outlives the run; and the
// force-quit path (second SIGINT → process.exit, see cli.ts) never reaches close() at all. This
// registry keeps the pids, escalates SIGTERM → SIGKILL after a grace period, and installs a
// last-resort synchronous SIGKILL on process exit.

// The package's one sleep primitive lives beside the CI poller that needed it abortable; the grace
// poll below borrows it so there is a single timer implementation to keep leak-free — and, as a
// side effect, the grace poll costs no wall-clock under the test-runner fast path.
import process from 'node:process';
import { defaultSleep } from '../github/github-client.ts';
import type { LoggerLike } from '../logger/logger.ts';

// `process.kill(pid, 0)` is the liveness probe — signal 0 delivers nothing and throws ESRCH when the
// process is gone. Injected so tests never signal real processes.
export type KillFn = (pid: number, signal: NodeJS.Signals | 0) => void;

// The slice of `process` the exit guard needs. Injected for the same reason: a unit test must not
// attach listeners to the test runner.
export type ExitHooks = {
  on(event: 'exit', listener: () => void): unknown;
  off(event: 'exit', listener: () => void): unknown;
};

export type TrackedProcess = { name: string; pid: number };

// How long a child gets to exit on SIGTERM before it is SIGKILLed. An MCP server's shutdown is a
// stdin close plus process teardown — sub-second in practice; this is the wedged-server ceiling.
export const DEFAULT_KILL_GRACE_MS = 2000;
const POLL_INTERVAL_MS = 50;

export type StdioProcessRegistryInit = {
  kill?: KillFn;
  graceMs?: number;
  exitHooks?: ExitHooks;
  logger?: LoggerLike;
};

export class StdioProcessRegistry {
  private tracked: TrackedProcess[] = [];
  private readonly kill: KillFn;
  private readonly graceMs: number;
  private readonly exitHooks: ExitHooks;
  private exitGuard: (() => void) | null = null;

  constructor(private readonly init: StdioProcessRegistryInit = {}) {
    this.kill = init.kill ?? ((pid, signal) => process.kill(pid, signal));
    this.graceMs = init.graceMs ?? DEFAULT_KILL_GRACE_MS;
    this.exitHooks = init.exitHooks ?? process;
  }

  // Called once per connected stdio server. The first registration arms the exit guard, so a run that
  // dies without reaching terminate() still takes its children with it.
  register(name: string, pid: number): void {
    this.tracked.push({ name, pid });
    this.armExitGuard();
  }

  list(): readonly TrackedProcess[] {
    return this.tracked;
  }

  // SIGTERM every survivor, wait out the grace period, SIGKILL whatever is left. Never throws: a
  // process that already exited (ESRCH) is the expected case, and cleanup must not fail a run.
  async terminate(): Promise<void> {
    const targets = this.tracked;
    this.tracked = [];
    this.disarmExitGuard();
    const alive = targets.filter((t) => this.isAlive(t.pid));
    for (const t of alive) this.signal(t, 'SIGTERM');
    const survivors = await this.waitForExit(alive);
    for (const t of survivors) {
      this.init.logger?.warn('mcp server ignored SIGTERM — killing', { name: t.name, pid: t.pid });
      this.signal(t, 'SIGKILL');
    }
  }

  // Synchronous last resort for the `exit` event, where no promise can be awaited: SIGKILL outright,
  // no grace period. Idempotent — a later terminate() finds an empty list.
  killAllNow(): void {
    const targets = this.tracked;
    this.tracked = [];
    for (const t of targets) {
      if (this.isAlive(t.pid)) this.signal(t, 'SIGKILL');
    }
  }

  private async waitForExit(targets: readonly TrackedProcess[]): Promise<TrackedProcess[]> {
    let remaining = targets.filter((t) => this.isAlive(t.pid));
    let waited = 0;
    while (remaining.length > 0 && waited < this.graceMs) {
      await defaultSleep(POLL_INTERVAL_MS);
      waited += POLL_INTERVAL_MS;
      remaining = remaining.filter((t) => this.isAlive(t.pid));
    }
    return remaining;
  }

  private isAlive(pid: number): boolean {
    try {
      this.kill(pid, 0);
      return true;
    } catch (err) {
      // EPERM means the process exists but is not ours to signal — still alive, so report it as such
      // rather than silently leaving it running.
      return isPermissionError(err);
    }
  }

  private signal(target: TrackedProcess, signal: NodeJS.Signals): void {
    try {
      this.kill(target.pid, signal);
    } catch (err) {
      this.init.logger?.warn('mcp server kill failed', {
        name: target.name,
        pid: target.pid,
        signal,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private armExitGuard(): void {
    if (this.exitGuard) return;
    const guard = (): void => this.killAllNow();
    this.exitGuard = guard;
    this.exitHooks.on('exit', guard);
  }

  private disarmExitGuard(): void {
    if (!this.exitGuard) return;
    this.exitHooks.off('exit', this.exitGuard);
    this.exitGuard = null;
  }
}

function isPermissionError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: unknown }).code === 'EPERM'
  );
}
