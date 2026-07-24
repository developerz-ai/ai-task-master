// A run-scoped stack of cleanup functions: every acquisition (MCP clients, undici agents, transcript
// writers, spawn registries) registers its release here so the run has exactly one guaranteed exit
// path, called from the adapter's `finally` AND from the abort reaper.
//
// Hand-rolled rather than `AsyncDisposableStack`/`await using`: Node 20 and Deno 1.40 are supported
// targets and neither ships the disposal built-ins reliably.

export type DisposeFn = () => void | Promise<void>;

export class Disposer {
  // LIFO: releases unwind in the reverse of acquisition, so a resource is never torn down before
  // something acquired on top of it.
  private readonly disposers: DisposeFn[] = [];
  private draining: Promise<void> | undefined;

  add(dispose: DisposeFn): void {
    this.disposers.push(dispose);
  }

  // Runs every registered disposer once, newest first, awaiting each. Idempotent: a second call has
  // nothing left to run, and a call made while a drain is in flight queues behind it — so a late
  // acquisition racing shutdown is still released instead of being dropped or disposed twice.
  disposeAll(): Promise<void> {
    const drained = (this.draining ?? Promise.resolve()).then(() => this.drain());
    this.draining = drained.then(
      () => undefined,
      () => undefined,
    );
    return drained;
  }

  // Every disposer runs even if an earlier one throws; failures surface together so one broken
  // release can't hide the rest.
  private async drain(): Promise<void> {
    const errors: unknown[] = [];
    for (let dispose = this.disposers.pop(); dispose; dispose = this.disposers.pop()) {
      try {
        await dispose();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, `Disposer: ${errors.length} disposer(s) failed`);
    }
  }
}

// Drain a run's releases without ever replacing the run's own outcome: a throw out of a `finally`
// would swap a real result (or a real error) for a cleanup failure, and an abort-time reaper has no
// caller left to catch anything at all. Report and move on.
export async function disposeQuietly(disposer: Disposer): Promise<void> {
  try {
    await disposer.disposeAll();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`warning: run cleanup failed: ${message}\n`);
  }
}
