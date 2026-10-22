// OperationQueue (WP-1.8): per-repository serialization of push/pull/resolve and the
// coalescing of status refreshes. Pure: no vscode import; the Repository adapter feeds it.
import type { OperationKind } from "./types";

/** The kinds run() serializes (IRepository.run). status, statusOffline and show pass through. */
export const MUTATING_OPERATIONS: ReadonlySet<OperationKind> = new Set<OperationKind>(["push", "pull", "resolve"]);

export interface OperationQueueDeps {
  /**
   * Run exactly ONE `ctx status` (online when remote is true) and record its outcome.
   * It should never reject; a rejection is swallowed by the queue.
   */
  runStatus(remote: boolean): Promise<void>;
  /** Called with the kind when a mutating fn starts, and with undefined when it settles. */
  onDidChangeOperation(kind: OperationKind | undefined): void;
}

/**
 * One per repository.
 *
 * Refresh coalescing, refresh(remote):
 * - While any mutating operation is queued or its fn is running (pendingOperations > 0): no
 *   status runs now. The request joins the waiters of the ONE online refresh that follows the
 *   running operation (any number of offline or online requests coalesce into it); its promise
 *   resolves when that follow-up refresh completes.
 * - Otherwise, with no status in flight: run one now (online iff remote).
 * - Otherwise (a status in flight): coalesce into ONE follow-up status that runs after the
 *   in-flight one, online if any coalesced request was online; resolves when it completes.
 * - Never rejects. After dispose(): resolves at once and runs nothing; pending waiters resolve.
 *
 * Operations, run(kind, fn) (the frozen IRepository.run contract, src/model/types.ts):
 * - push, pull and resolve are serialized FIFO: fn starts only after the previous mutating
 *   operation AND its follow-up refresh have settled.
 * - While fn runs, `operation` is kind; onDidChangeOperation(kind) fires on entry and
 *   onDidChangeOperation(undefined) when fn settles (success or failure).
 * - When fn settles, pendingOperations drops by one and the queue runs ONE online refresh
 *   (through the same coalescer, so a status already in flight is awaited and followed by an
 *   online one). The waiters collected while the operation was queued or running resolve
 *   when it completes.
 * - The returned promise settles with fn's result or rejection, only AFTER that follow-up
 *   refresh has completed. A failed fn still releases the queue: the next operation runs.
 * - status, statusOffline and show are not queued: run() calls fn on the next microtask,
 *   leaves `operation` alone and runs no follow-up refresh.
 * - After dispose(): mutating run() calls still run fn (callers await them) but no follow-up
 *   refresh runs.
 */
export class OperationQueue {
  private _operation: OperationKind | undefined;
  private _pending = 0;
  /** True while onDidChangeOperation(undefined) runs: a refresh asked for there joins the follow-up. */
  private settling = false;
  private disposed = false;
  /** Settles when the last queued mutating operation and its follow-up refresh have settled. */
  private tail: Promise<unknown> = Promise.resolve();
  /** The status running now. */
  private inFlight: Batch | undefined;
  /** The ONE status queued behind inFlight. */
  private next: Batch | undefined;
  /** Requests made while an operation was queued or running: resolved by its follow-up refresh. */
  private opWaiters: Batch | undefined;

  constructor(private readonly deps: OperationQueueDeps) {}

  /** The mutating operation whose fn is running, else undefined. */
  get operation(): OperationKind | undefined {
    return this._operation;
  }

  /** Mutating operations queued or running (fn not yet settled). */
  get pendingOperations(): number {
    return this._pending;
  }

  refresh(remote: boolean): Promise<void> {
    if (this.disposed) { return Promise.resolve(); }
    if (this._pending > 0 || this.settling) {
      this.opWaiters ??= newBatch(true);
      return this.opWaiters.promise;
    }
    return this.coalesce(remote);
  }

  run<T>(kind: OperationKind, fn: () => Promise<T>): Promise<T> {
    if (!MUTATING_OPERATIONS.has(kind)) { return Promise.resolve().then(fn); }
    this._pending++;
    const result = this.tail.then(async () => {
      this.setOperation(kind);
      let outcome: { ok: true; value: T } | { ok: false; error: unknown };
      try {
        outcome = { ok: true, value: await fn() };
      } catch (error) {
        outcome = { ok: false, error };
      }
      this._pending--;
      this.settling = true;
      try {
        this.setOperation(undefined);
      } finally {
        this.settling = false;
      }
      const waiters = this.opWaiters;
      this.opWaiters = undefined;
      await this.coalesce(true);
      waiters?.resolve();
      if (!outcome.ok) { throw outcome.error; }
      return outcome.value;
    });
    this.tail = result.then(noop, noop);
    return result;
  }

  dispose(): void {
    if (this.disposed) { return; }
    this.disposed = true;
    for (const b of [this.inFlight, this.next, this.opWaiters]) { b?.resolve(); }
    this.next = undefined;
    this.opWaiters = undefined;
  }

  private setOperation(kind: OperationKind | undefined): void {
    this._operation = kind;
    try {
      this.deps.onDidChangeOperation(kind);
    } catch {
      // A throwing listener must not wedge the queue (operation, pendingOperations, FIFO).
    }
  }

  /** At most one status in flight plus ONE follow-up (online if any request was). Never rejects. */
  private coalesce(remote: boolean): Promise<void> {
    if (this.disposed) { return Promise.resolve(); }
    if (this.inFlight === undefined) {
      const b = newBatch(remote);
      this.start(b);
      return b.promise;
    }
    if (this.next !== undefined) {
      this.next.remote ||= remote;
      return this.next.promise;
    }
    this.next = newBatch(remote);
    return this.next.promise;
  }

  private start(b: Batch): void {
    this.inFlight = b;
    let run: Promise<void>;
    try {
      run = Promise.resolve(this.deps.runStatus(b.remote));
    } catch (error) {
      run = Promise.reject(error);
    }
    void run.catch(noop).then(() => {
      this.inFlight = undefined;
      const n = this.next;
      this.next = undefined;
      if (n !== undefined && !this.disposed) { this.start(n); }
      b.resolve();
    });
  }
}

/** Requests that share one status run (or one follow-up refresh). */
interface Batch {
  remote: boolean;
  readonly promise: Promise<void>;
  readonly resolve: () => void;
}

function newBatch(remote: boolean): Batch {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { remote, promise, resolve };
}

function noop(): void {
  // Intentionally empty.
}
