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
  constructor(private readonly deps: OperationQueueDeps) {
    void this.deps;
  }

  /** The mutating operation whose fn is running, else undefined. */
  get operation(): OperationKind | undefined {
    throw new Error("OperationQueue: not implemented (WP-1.8 lane B)");
  }

  /** Mutating operations queued or running (fn not yet settled). */
  get pendingOperations(): number {
    throw new Error("OperationQueue: not implemented (WP-1.8 lane B)");
  }

  refresh(remote: boolean): Promise<void> {
    void remote;
    throw new Error("OperationQueue: not implemented (WP-1.8 lane B)");
  }

  run<T>(kind: OperationKind, fn: () => Promise<T>): Promise<T> {
    void kind;
    void fn;
    throw new Error("OperationQueue: not implemented (WP-1.8 lane B)");
  }

  dispose(): void {
    throw new Error("OperationQueue: not implemented (WP-1.8 lane B)");
  }
}
