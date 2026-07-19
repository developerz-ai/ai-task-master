// Bounded promise pool: run a worker over items at most `min(limit, items.length)` at a time,
// returning results in input order. Fanning out one provider call per manifest file with an
// unbounded `Promise.all` can open dozens of concurrent LLM requests and trip rate limits, so the
// editor fanout needs a cap. Semantics mirror `Promise.all` at the edges: the first worker
// rejection (or an aborted signal) rejects the whole pool and stops pulling new work — in-flight
// workers are the caller's to cancel (pass a shared AbortSignal into the worker). No dependency on
// `Promise`-pool libraries; portable across Bun, Node ≥20, and Deno.

export type PoolWorker<T, R> = (item: T, index: number) => Promise<R>;

export type PoolOptions = {
  // Aborting this signal rejects the pool with the signal's reason and stops launching new workers.
  signal?: AbortSignal;
};

export async function runPool<T, R>(
  items: readonly T[],
  limit: number,
  worker: PoolWorker<T, R>,
  options: PoolOptions = {},
): Promise<R[]> {
  const results = new Array<R>(items.length);
  if (items.length === 0) return results;

  const { signal } = options;
  if (signal?.aborted) throw abortReason(signal);

  const width = Math.max(1, Math.min(Math.floor(limit) || 1, items.length));
  // One shared iterator across all lanes: each lane's synchronous `.next()` atomically claims the
  // next item, so `width` lanes yield exactly `width` concurrent workers with no shared counter.
  const entries = items.entries();
  let stopped = false;

  const runLane = async (): Promise<void> => {
    for (const [index, item] of entries) {
      if (stopped) return;
      try {
        results[index] = await worker(item, index);
      } catch (error) {
        stopped = true;
        throw error;
      }
    }
  };

  let onAbort: (() => void) | undefined;
  // A separate rejecting promise raced against the lanes so an abort mid-flight rejects promptly
  // instead of waiting on workers that may never settle. Without it, an abort would only be seen
  // after a lane's current worker resolves — or never, if that worker is blocked.
  const abortRace = signal
    ? new Promise<never>((_, reject) => {
        onAbort = (): void => {
          stopped = true;
          reject(abortReason(signal));
        };
        signal.addEventListener('abort', onAbort, { once: true });
      })
    : undefined;

  try {
    const lanes = Promise.all(Array.from({ length: width }, () => runLane()));
    await (abortRace ? Promise.race([lanes, abortRace]) : lanes);
    return results;
  } finally {
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
    // If the lanes settled first the abortRace stays pending forever; attach a no-op catch so a
    // late abort can't surface as an unhandled rejection.
    abortRace?.catch(() => {});
  }
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted', 'AbortError');
}
