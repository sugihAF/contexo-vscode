// FakeCtxCli: an in-process ICtxCli for tests that drive a module through
// TestApi.hooks.overrideServices({cli: new FakeCtxCli()}). Only `import type` from
// 'vscode', so plain mocha unit tests can load it too.
//
// Every ICtxCli method (terminalInvocation and dispose included) appends {method, args}
// to `calls` BEFORE it runs, so a handler or a test sees its own call in the log.
// Per method, the answer is, in order:
//   1. the next value queued with enqueue() (one-shot; an Error value rejects/throws);
//   2. the persistent behaviour last set with setResult(), setError() or setHandler()
//      (each call replaces the other two);
//   3. the default: getBinary/rediscover -> `binary` (ok with FAKE_VERSION_DOC), version ->
//      FAKE_VERSION_DOC, status -> loadStatusDoc(<scenario>, {offline}) (scenario 'mixed'
//      unless the constructor says otherwise), terminalInvocation -> node -e process.exit(0)
//      with ELECTRON_RUN_AS_NODE=1, dispose -> nothing; show/push/pull/resolve reject with
//      CtxError.extension('contract_mismatch', 'FakeCtxCli: no scripted result for <method>').
import type { CancellationToken, Disposable, Event } from "vscode";
import {
  CtxError,
  type BinaryState,
  type ICtxCli,
  type PushOutcome,
  type TerminalInvocation,
} from "../../src/cli/types";
import {
  CAPABILITIES,
  type PullDoc,
  type ResolveDoc,
  type ResolveStrategy,
  type StatusDoc,
  type VersionDoc,
} from "../../src/contract/types";
import { loadStatusDoc } from "./fixtures";

/**
 * The handshake document of a current ctx: contract 1, the 11 v1 capabilities followed by
 * 'repair' (E19). The fake ctx's built-in `version --json` answer is byte-for-byte this doc.
 */
export const FAKE_VERSION_DOC: VersionDoc = {
  schema: "ctx.version.v1",
  contract_version: 1,
  version: "0.7.0",
  commit: "5d3c1e0a9b8f7e6d5c4b3a29180716f5e4d3c2b1",
  date: "2026-10-14T12:00:00Z",
  dev_build: false,
  os: "darwin",
  arch: "arm64",
  capabilities: [...CAPABILITIES, "repair"],
};

/** The binary path the default `ok` BinaryState reports. */
export const FAKE_BINARY_PATH = "/fake/bin/ctx";

/** What each ICtxCli method resolves (or returns) with. */
export interface FakeCtxCliResults {
  getBinary: BinaryState;
  rediscover: BinaryState;
  version: VersionDoc;
  status: StatusDoc;
  show: Uint8Array;
  push: PushOutcome;
  pull: PullDoc;
  resolve: ResolveDoc;
  terminalInvocation: TerminalInvocation;
  dispose: void;
}
export type FakeCtxCliMethod = keyof FakeCtxCliResults;

/** The arguments each method was called with. */
export interface FakeCtxCliArgs {
  getBinary: [];
  rediscover: [];
  version: [];
  status: [root: string, o: { offline: boolean }, token?: CancellationToken];
  show: [root: string, relPath: string, ref: "base" | "server" | (string & {}), token?: CancellationToken];
  push: [root: string, o: { message?: string; paths?: string[] }];
  pull: [root: string];
  resolve: [root: string, relPath: string, strategy: ResolveStrategy, o?: { ifServerSha?: string }];
  terminalInvocation: [args: string[]];
  dispose: [];
}

/** A scripted implementation; async methods may return a value or a promise. */
export type FakeCtxCliHandler<M extends FakeCtxCliMethod> =
  (...args: FakeCtxCliArgs[M]) => FakeCtxCliResults[M] | Promise<FakeCtxCliResults[M]>;

export interface FakeCtxCliCall { method: FakeCtxCliMethod; args: unknown[]; }

export interface FakeCtxCliOptions {
  /** Initial binary state (default {kind:'ok', path: FAKE_BINARY_PATH, version: FAKE_VERSION_DOC}). */
  binary?: BinaryState;
  /** Baseline scenario whose StatusDoc the default status() returns (default 'mixed'). */
  scenario?: string;
}

type Behaviour =
  | { kind: "result"; value: unknown }
  | { kind: "error"; error: unknown }
  | { kind: "handler"; fn: (...args: unknown[]) => unknown };

const SYNC_METHODS: ReadonlySet<FakeCtxCliMethod> = new Set<FakeCtxCliMethod>(["terminalInvocation", "dispose"]);

export class FakeCtxCli implements ICtxCli {
  /** Every ICtxCli call, in call order, logged before it runs. */
  readonly calls: FakeCtxCliCall[] = [];
  /** What getBinary/rediscover answer by default; fireBinary() updates it. */
  binary: BinaryState;
  /** Scenario for the default status(). */
  scenario: string;
  disposed = false;

  private readonly queues = new Map<FakeCtxCliMethod, unknown[]>();
  private readonly behaviours = new Map<FakeCtxCliMethod, Behaviour>();
  private listeners: ((s: BinaryState) => unknown)[] = [];

  constructor(opts: FakeCtxCliOptions = {}) {
    this.binary = opts.binary ?? { kind: "ok", path: FAKE_BINARY_PATH, version: FAKE_VERSION_DOC };
    this.scenario = opts.scenario ?? "mixed";
  }

  /** vscode Event semantics: returns a Disposable that removes the listener. */
  readonly onDidChangeBinary: Event<BinaryState> = (listener, thisArgs?: unknown, disposables?: Disposable[]) => {
    const bound = (s: BinaryState): unknown => listener.call(thisArgs, s);
    this.listeners.push(bound);
    const d = { dispose: () => { this.listeners = this.listeners.filter((l) => l !== bound); } } as Disposable;
    disposables?.push(d);
    return d;
  };

  // ---------- scripting ----------

  /** Persistent result for method (replaces any error or handler). */
  setResult<M extends FakeCtxCliMethod>(method: M, value: FakeCtxCliResults[M]): this {
    this.behaviours.set(method, { kind: "result", value });
    return this;
  }

  /** Persistent failure: async methods reject with err, sync methods throw it (replaces result/handler). */
  setError(method: FakeCtxCliMethod, err: unknown): this {
    this.behaviours.set(method, { kind: "error", error: err });
    return this;
  }

  /** Persistent implementation (replaces result/error). */
  setHandler<M extends FakeCtxCliMethod>(method: M, fn: FakeCtxCliHandler<M>): this {
    this.behaviours.set(method, { kind: "handler", fn: fn as unknown as (...args: unknown[]) => unknown });
    return this;
  }

  /** One-shot answers, consumed FIFO before the persistent behaviour; an Error value rejects (or throws). */
  enqueue<M extends FakeCtxCliMethod>(method: M, ...values: (FakeCtxCliResults[M] | Error)[]): this {
    const q = this.queues.get(method) ?? [];
    q.push(...values);
    this.queues.set(method, q);
    return this;
  }

  /** Forget every queued value and persistent behaviour (the call log is kept). */
  reset(): this {
    this.queues.clear();
    this.behaviours.clear();
    return this;
  }

  /** Set `binary` and fire onDidChangeBinary(state). */
  fireBinary(state: BinaryState): void {
    this.binary = state;
    for (const l of [...this.listeners]) { l(state); }
  }

  /** The calls of one method, in order. */
  callsOf<M extends FakeCtxCliMethod>(method: M): FakeCtxCliArgs[M][] {
    return this.calls.filter((c) => c.method === method).map((c) => c.args as FakeCtxCliArgs[M]);
  }

  // ---------- ICtxCli ----------

  getBinary(): Promise<BinaryState> {
    return this.callAsync("getBinary", [], () => this.binary);
  }

  rediscover(): Promise<BinaryState> {
    return this.callAsync("rediscover", [], () => this.binary);
  }

  version(): Promise<VersionDoc> {
    return this.callAsync("version", [], () => (this.binary.kind === "ok" ? this.binary.version : FAKE_VERSION_DOC));
  }

  status(...args: FakeCtxCliArgs["status"]): Promise<StatusDoc> {
    return this.callAsync("status", args, () => loadStatusDoc(this.scenario, { offline: args[1].offline }));
  }

  show(...args: FakeCtxCliArgs["show"]): Promise<Uint8Array> {
    return this.callAsync("show", args, () => this.unscripted("show"));
  }

  push(...args: FakeCtxCliArgs["push"]): Promise<PushOutcome> {
    return this.callAsync("push", args, () => this.unscripted("push"));
  }

  pull(...args: FakeCtxCliArgs["pull"]): Promise<PullDoc> {
    return this.callAsync("pull", args, () => this.unscripted("pull"));
  }

  resolve(...args: FakeCtxCliArgs["resolve"]): Promise<ResolveDoc> {
    return this.callAsync("resolve", args, () => this.unscripted("resolve"));
  }

  terminalInvocation(...args: FakeCtxCliArgs["terminalInvocation"]): TerminalInvocation {
    return this.callSync("terminalInvocation", args, () => ({
      shellPath: process.execPath,
      shellArgs: ["-e", "process.exit(0)"],
      env: { ELECTRON_RUN_AS_NODE: "1" },
    }));
  }

  dispose(): void {
    this.callSync("dispose", [], () => {
      this.disposed = true;
      this.listeners = [];
    });
  }

  // ---------- plumbing ----------

  private unscripted(method: FakeCtxCliMethod): never {
    throw CtxError.extension("contract_mismatch", `FakeCtxCli: no scripted result for ${method}`);
  }

  /** Log the call, then answer: queued value, persistent behaviour, or the default. */
  private answer<M extends FakeCtxCliMethod>(method: M, args: unknown[], fallback: () => unknown): unknown {
    this.calls.push({ method, args });
    const q = this.queues.get(method);
    if (q && q.length > 0) {
      const v = q.shift();
      if (v instanceof Error) { throw v; }
      return v;
    }
    const b = this.behaviours.get(method);
    if (!b) { return fallback(); }
    switch (b.kind) {
      case "result": return b.value;
      case "error": throw b.error;
      case "handler": return b.fn(...args);
    }
  }

  private callAsync<M extends FakeCtxCliMethod>(method: M, args: unknown[], fallback: () => unknown): Promise<FakeCtxCliResults[M]> {
    try {
      return Promise.resolve(this.answer(method, args, fallback) as FakeCtxCliResults[M] | Promise<FakeCtxCliResults[M]>);
    } catch (err) {
      return Promise.reject(err);
    }
  }

  private callSync<M extends FakeCtxCliMethod>(method: M, args: unknown[], fallback: () => unknown): FakeCtxCliResults[M] {
    if (!SYNC_METHODS.has(method)) { throw new Error(`FakeCtxCli: ${method} is async`); }
    return this.answer(method, args, fallback) as FakeCtxCliResults[M];
  }
}
