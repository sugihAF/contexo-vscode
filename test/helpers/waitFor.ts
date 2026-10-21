// Bounded deadline polling for tests: no fixed sleeps. No vscode import (unit and host tests).

export interface WaitForOptions {
  /** Give up after this many ms (default 5000). */
  timeoutMs?: number;
  /** Poll every this many ms (default 20). */
  intervalMs?: number;
  /** Appended to the timeout error. */
  message?: string;
}

/**
 * Poll `pred` until it returns (or resolves to) a truthy value, and return that value.
 * A predicate that throws counts as falsy; after `timeoutMs` the promise rejects with
 * 'waitFor timed out after <timeoutMs> ms[: message]', naming the last thrown error.
 */
export async function waitFor<T>(pred: () => T | Promise<T>, o: WaitForOptions = {}): Promise<NonNullable<T>> {
  const timeoutMs = o.timeoutMs ?? 5000;
  const intervalMs = o.intervalMs ?? 20;
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  for (;;) {
    try {
      const v = await pred();
      if (v) { return v as NonNullable<T>; }
      lastError = undefined;
    } catch (err) {
      lastError = err;
    }
    const left = deadline - Date.now();
    if (left <= 0) {
      const why = lastError === undefined ? "" : ` (last error: ${lastError instanceof Error ? lastError.message : String(lastError)})`;
      throw new Error(`waitFor timed out after ${timeoutMs} ms${o.message ? `: ${o.message}` : ""}${why}`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(intervalMs, left)));
  }
}
