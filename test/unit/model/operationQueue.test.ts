// WP-1.8: src/model/operationQueue.ts, per-repository serialization of push/pull/resolve and
// the coalescing of status refreshes. A tiny harness wires the queue to a FakeCtxCli and the
// tests assert on its ordered method-call log.
import * as assert from "node:assert/strict";
import type { PushOutcome } from "../../../src/cli/types";
import type { PullDoc } from "../../../src/contract/types";
import { MUTATING_OPERATIONS, OperationQueue } from "../../../src/model/operationQueue";
import type { OperationKind } from "../../../src/model/types";
import { FakeCtxCli } from "../../helpers/fakeCtxCli";
import { loadStatusDoc } from "../../helpers/fixtures";

const ROOT = "/ws/repo";
const PUSH_OUTCOME = { doc: { schema: "ctx.push.v1" } } as unknown as PushOutcome;
const PULL_DOC = { schema: "ctx.pull.v1" } as unknown as PullDoc;

interface Deferred<T> {
  promise: Promise<T>;
  resolve(v: T): void;
  reject(e: unknown): void;
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** Let every queued microtask and promise chain run (no timers are faked here). */
async function flush(): Promise<void> {
  for (let i = 0; i < 3; i++) { await new Promise<void>((r) => setImmediate(r)); }
}

/** Tracks whether a promise has settled, without leaving a rejection unhandled. */
function track(p: Promise<unknown>): { settled: boolean } {
  const t = { settled: false };
  p.then(() => { t.settled = true; }, () => { t.settled = true; });
  return t;
}

/** The FakeCtxCli log as labels: 'status online', 'status offline', 'push', 'pull', ... */
function log(cli: FakeCtxCli): string[] {
  return cli.calls.map((c) => {
    if (c.method !== "status") { return c.method; }
    return (c.args[1] as { offline: boolean }).offline ? "status offline" : "status online";
  });
}

/** Makes cli.status wait for release() (one hold per call, released in call order). */
class StatusHold {
  private readonly waiting: Deferred<void>[] = [];

  constructor(cli: FakeCtxCli) {
    cli.setHandler("status", async (_root, o) => {
      const d = deferred();
      this.waiting.push(d);
      await d.promise;
      return loadStatusDoc("mixed", o);
    });
  }

  get count(): number { return this.waiting.length; }

  /** Let the oldest held status answer, then flush. */
  async release(): Promise<void> {
    const d = this.waiting.shift();
    assert.ok(d, "no status call is held");
    d.resolve();
    await flush();
  }
}

describe("model/operationQueue", () => {
  let cli: FakeCtxCli;
  let ops: (OperationKind | undefined)[];
  let queue: OperationQueue;

  beforeEach(() => {
    cli = new FakeCtxCli();
    ops = [];
    queue = new OperationQueue({
      runStatus: async (remote) => { await cli.status(ROOT, { offline: !remote }); },
      onDidChangeOperation: (k) => ops.push(k),
    });
  });

  afterEach(() => {
    queue.dispose();
  });

  it("push and pull requested together run sequentially", async () => {
    const pushGate = deferred();
    const pullGate = deferred();
    cli.setHandler("push", async () => { await pushGate.promise; return PUSH_OUTCOME; });
    cli.setHandler("pull", async () => { await pullGate.promise; return PULL_DOC; });
    const hold = new StatusHold(cli);

    const push = queue.run("push", () => cli.push(ROOT, {}));
    const pull = queue.run("pull", () => cli.pull(ROOT));
    const pushDone = track(push);
    await flush();
    assert.deepEqual(log(cli), ["push"], "pull waits for the running push");
    assert.equal(queue.operation, "push");
    assert.equal(queue.pendingOperations, 2);

    pushGate.resolve();
    await flush();
    assert.deepEqual(log(cli), ["push", "status online"], "push's follow-up refresh runs before pull");
    assert.equal(queue.operation, undefined);
    assert.equal(queue.pendingOperations, 1);
    assert.equal(pushDone.settled, false, "run() settles only after its follow-up refresh");

    await hold.release();
    assert.equal(pushDone.settled, true);
    assert.deepEqual(log(cli), ["push", "status online", "pull"], "pull starts once push's refresh completed");
    assert.equal(queue.operation, "pull");

    pullGate.resolve();
    await flush();
    assert.deepEqual(log(cli), ["push", "status online", "pull", "status online"]);
    await hold.release();
    assert.equal(await push, PUSH_OUTCOME);
    assert.equal(await pull, PULL_DOC);
    assert.deepEqual(log(cli), ["push", "status online", "pull", "status online"]);
    assert.deepEqual(ops, ["push", undefined, "pull", undefined]);
    assert.equal(queue.pendingOperations, 0);
  });

  it("three refreshes during a push give one online refresh after it", async () => {
    const pushGate = deferred();
    cli.setHandler("push", async () => { await pushGate.promise; return PUSH_OUTCOME; });
    const hold = new StatusHold(cli);

    const push = queue.run("push", () => cli.push(ROOT, {}));
    await flush();
    const refreshes = [queue.refresh(false), queue.refresh(true), queue.refresh(false)];
    const all = track(Promise.all(refreshes));
    await flush();
    assert.deepEqual(log(cli), ["push"], "no status runs while the push runs");

    pushGate.resolve();
    await flush();
    assert.deepEqual(log(cli), ["push", "status online"]);
    assert.equal(all.settled, false, "the waiters resolve when the follow-up refresh completes");

    await hold.release();
    await Promise.all(refreshes);
    await push;
    assert.deepEqual(log(cli), ["push", "status online"], "exactly one online refresh after the push");
  });

  it("a failed operation releases the queue and clears busy", async () => {
    cli.enqueue("push", new Error("push failed"));
    cli.setResult("pull", PULL_DOC);

    const failed = queue.run("push", () => cli.push(ROOT, {}));
    await assert.rejects(failed, /push failed/, "the rejection reaches the caller");
    assert.deepEqual(log(cli), ["push", "status online"], "the follow-up refresh ran before the rejection");
    assert.equal(queue.operation, undefined);
    assert.equal(queue.pendingOperations, 0);
    assert.deepEqual(ops, ["push", undefined]);

    assert.equal(await queue.run("pull", () => cli.pull(ROOT)), PULL_DOC);
    assert.deepEqual(log(cli), ["push", "status online", "pull", "status online"]);
    assert.deepEqual(ops, ["push", undefined, "pull", undefined]);
  });

  it("a failed operation queued behind another still lets the next one run", async () => {
    cli.setResult("pull", PULL_DOC);
    const first = queue.run("resolve", async () => { throw new Error("resolve failed"); });
    const second = queue.run("pull", () => cli.pull(ROOT));
    await assert.rejects(first, /resolve failed/);
    assert.equal(await second, PULL_DOC);
    assert.deepEqual(log(cli), ["status online", "pull", "status online"]);
    assert.deepEqual(ops, ["resolve", undefined, "pull", undefined]);
  });

  it("concurrent refreshes coalesce into one in flight plus one follow-up, online wins", async () => {
    const hold = new StatusHold(cli);
    const first = queue.refresh(false);
    assert.deepEqual(log(cli), ["status offline"], "the first refresh runs at once");
    const firstDone = track(first);

    const rest = [queue.refresh(false), queue.refresh(true), queue.refresh(false)];
    const restDone = track(Promise.all(rest));
    await flush();
    assert.deepEqual(log(cli), ["status offline"], "nothing else runs while a status is in flight");

    await hold.release();
    assert.equal(firstDone.settled, true);
    assert.equal(restDone.settled, false);
    assert.deepEqual(log(cli), ["status offline", "status online"], "one follow-up, online because one request was");

    await hold.release();
    await Promise.all(rest);
    assert.deepEqual(log(cli), ["status offline", "status online"]);

    const later = queue.refresh(false);
    assert.deepEqual(log(cli), ["status offline", "status online", "status offline"], "idle again: runs at once");
    await hold.release();
    await later;
  });

  it("an offline-only follow-up stays offline", async () => {
    const hold = new StatusHold(cli);
    const first = queue.refresh(true);
    const second = queue.refresh(false);
    const third = queue.refresh(false);
    await hold.release();
    await hold.release();
    await Promise.all([first, second, third]);
    assert.deepEqual(log(cli), ["status online", "status offline"]);
  });

  it("refresh never rejects when runStatus rejects", async () => {
    cli.setError("status", new Error("ctx crashed"));
    await queue.refresh(false);
    await queue.refresh(true);
    assert.deepEqual(log(cli), ["status offline", "status online"], "a failed status releases the coalescer");

    const throwing = new OperationQueue({
      runStatus: () => { throw new Error("sync throw"); },
      onDidChangeOperation: () => undefined,
    });
    await throwing.refresh(true);
    assert.equal(await throwing.run("push", async () => 7), 7, "a failed follow-up refresh still settles run()");
    throwing.dispose();
  });

  it("status, statusOffline and show pass through without changing operation", async () => {
    assert.deepEqual([...MUTATING_OPERATIONS].sort(), ["pull", "push", "resolve"]);
    const pushGate = deferred();
    cli.setHandler("push", async () => { await pushGate.promise; return PUSH_OUTCOME; });
    const push = queue.run("push", () => cli.push(ROOT, {}));
    await flush();

    for (const kind of ["status", "statusOffline", "show"] as const) {
      let called = false;
      const p = queue.run(kind, async () => { called = true; return kind; });
      assert.equal(called, false, `${kind}: fn runs on the next microtask, not synchronously`);
      assert.equal(await p, kind, `${kind} is not queued behind the running push`);
      assert.equal(called, true);
      assert.equal(queue.operation, "push", `${kind} leaves operation alone`);
      assert.equal(queue.pendingOperations, 1);
    }
    await assert.rejects(queue.run("show", async () => { throw new Error("show failed"); }), /show failed/);
    assert.deepEqual(ops, ["push"], "pass-through kinds fire no operation change");
    assert.deepEqual(log(cli), ["push"], "pass-through kinds run no follow-up refresh");

    pushGate.resolve();
    await push;
    assert.deepEqual(log(cli), ["push", "status online"]);
  });

  it("a refresh requested from the operation-cleared listener joins the follow-up refresh", async () => {
    const extra: Promise<void>[] = [];
    const q = new OperationQueue({
      runStatus: async (remote) => { await cli.status(ROOT, { offline: !remote }); },
      onDidChangeOperation: (k) => { ops.push(k); if (k === undefined) { extra.push(q.refresh(false)); } },
    });
    await q.run("push", async () => 1);
    await Promise.all(extra);
    assert.equal(extra.length, 1);
    assert.deepEqual(log(cli), ["status online"]);
    q.dispose();
  });

  it("a status already in flight when an operation settles is awaited and followed by an online one", async () => {
    const hold = new StatusHold(cli);
    const before = queue.refresh(false);
    const push = queue.run("push", async () => "ok");
    await flush();
    assert.deepEqual(log(cli), ["status offline"]);
    await hold.release();
    assert.deepEqual(log(cli), ["status offline", "status online"]);
    await hold.release();
    assert.equal(await push, "ok");
    await before;
    assert.deepEqual(log(cli), ["status offline", "status online"]);
  });

  describe("dispose", () => {
    it("refresh resolves at once and runs nothing; pending waiters resolve", async () => {
      const hold = new StatusHold(cli);
      const inFlight = queue.refresh(false);
      const followUp = queue.refresh(true);
      queue.dispose();
      await followUp;
      await queue.refresh(true);
      assert.equal(hold.count, 1);
      await hold.release();
      await inFlight;
      assert.deepEqual(log(cli), ["status offline"], "the queued follow-up never ran");
    });

    it("waiters of a running operation resolve; the operation runs no follow-up refresh", async () => {
      const pushGate = deferred();
      cli.setHandler("push", async () => { await pushGate.promise; return PUSH_OUTCOME; });
      const push = queue.run("push", () => cli.push(ROOT, {}));
      await flush();
      const waiter = queue.refresh(false);
      queue.dispose();
      await waiter;
      pushGate.resolve();
      assert.equal(await push, PUSH_OUTCOME);
      assert.equal(await queue.run("pull", async () => "after"), "after", "mutating run() still runs fn");
      assert.deepEqual(log(cli), ["push"], "no status after dispose");
      assert.equal(queue.operation, undefined);
      assert.equal(queue.pendingOperations, 0);
    });
  });
});
