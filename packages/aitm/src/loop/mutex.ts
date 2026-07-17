// A minimal async mutex: run() calls execute one at a time, in call order, never overlapping.
// Generalizes the tail-chain serialization the state stores already use (StateStore.update /
// appendProgress, PrContextStore.recordAddressedThreads): queue each critical section behind the
// previous so their bodies never interleave.
//
// The WorkLoop owns one to serialize the checkout→edit→commit critical section across
// concurrently-ready groups (PlanGraph.ready() can return several): the single in-place checkout
// holds one branch at a time, so the git-mutating section must run for one group at a time even when
// the driver dispatches a batch. Non-git phases (CI waits, PR polling) stay outside the lock and
// still overlap. See src/loop/work-loop.ts and docs/plans/.../02-parallel-team-shared-checkout.md.

export class Mutex {
  // Tail of the serialization chain. Each runExclusive appends its body after the current tail; the
  // chain swallows rejections so one failed section can't wedge every later caller.
  private tail: Promise<unknown> = Promise.resolve();

  // Run `fn` once the previously-queued sections have settled, returning its result (or rejection)
  // to THIS caller. A rejection propagates to the owner via the returned promise but is absorbed on
  // the internal chain, so the next runExclusive still proceeds.
  runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(() => fn());
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}
