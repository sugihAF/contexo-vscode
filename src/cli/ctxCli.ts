// createCtxCli (WP-1.7): the only module in the extension that starts a process (D1). It
// joins discovery + the handshake gate (discovery.ts, capabilities.ts; E35/E36), the E25 argv
// and the E26 env (spawn.ts), and document/envelope parsing (parse.ts) behind the frozen
// ICtxCli. The vscode adapters live here; the other src/cli modules stay vscode-free.
//
// Rules this file adds on top of those modules:
// - Discovery runs lazily (the first call), never while the workspace is untrusted, and is
//   memoized until rediscover() or a contexo.path change. Both re-run it and fire
//   onDidChangeBinary with the result (the first discovery is not a change). rediscover()
//   also drops the path+mtime+size handshake cache; a settings change reuses it, so typing a
//   path does not re-probe unchanged binaries.
// - Every method except version() and getBinary() rejects WITHOUT spawning while
//   BinaryState.kind !== 'ok', with CtxError.extension('spawn_failed', ...): there is no
//   dedicated code for an unusable binary, and it never reaches ctx. version() runs
//   `version --json` against any binary that has a path (ok, tooOld, extensionTooOld).
// - show('empty') answers zero bytes without spawning.
import * as os from "node:os";
import * as vscode from "vscode";
import { SUPPORTED_CONTRACT_VERSION, type PullDoc, type ResolveDoc, type ResolveStrategy, type StatusDoc, type VersionDoc } from "../contract/types";
import type { Handshake } from "./capabilities";
import { discover, nodeDiscoveryFs, type DiscoveryFs, type DiscoveryResult } from "./discovery";
import { docFromResult, errorFromExit, exitStatus, pushOutcomeFromResult } from "./parse";
import {
  createRunner, ctxArgv, terminalEnv,
  type Clock, type CommandClass, type CtxInvocation, type CtxRunner, type SpawnFn,
} from "./spawn";
import {
  CtxError, PUSH_PATHS_MAX,
  type BinaryState, type CtxCliDeps, type ICtxCli, type PushOutcome, type TerminalInvocation,
} from "./types";

/** Seams for tests (unit and e1); production passes none of them. */
export interface CtxCliOptions {
  /** The parent env for discovery (PATH, CONTEXO_TEST_CTX, ...) and every spawn; default process.env, read at each use. */
  env?: NodeJS.ProcessEnv;
  /** Default process.platform. */
  platform?: NodeJS.Platform;
  /** Default os.homedir (also the cwd of version runs). */
  homedir?: () => string;
  /** Default nodeDiscoveryFs. */
  fs?: DiscoveryFs;
  spawnFn?: SpawnFn;
  clock?: Clock;
  limits?: Partial<Record<CommandClass, number>>;
  killGraceMs?: number;
  maxConcurrentReads?: number;
  /** Default: context.extensionMode === vscode.ExtensionMode.Test (CONTEXO_TEST_CTX is honoured only then). */
  testMode?: boolean;
  /** Default: vscode.workspace.isTrusted. Nothing is spawned while it is false. */
  isTrusted?: () => boolean;
}

/** The frozen factory (WP-0.6 signature). */
export function createCtxCli(d: CtxCliDeps): ICtxCli {
  return createCtxCliWith(d, {});
}

/** createCtxCli with test seams. */
export function createCtxCliWith(d: CtxCliDeps, o: CtxCliOptions): ICtxCli {
  return new CtxCli(d, o);
}

const UNTRUSTED_MESSAGE = "Contexo never runs ctx in an untrusted workspace (Restricted Mode).";

class CtxCli implements ICtxCli {
  readonly onDidChangeBinary: vscode.Event<BinaryState>;
  private readonly emitter = new vscode.EventEmitter<BinaryState>();
  private readonly runner: CtxRunner;
  private readonly cache = new Map<string, Handshake>();
  private readonly extVersion: string;
  private readonly testMode: boolean;
  private readonly configSub: { dispose(): unknown };
  /** The memoized discovery (the latest one started). */
  private discovery: Promise<DiscoveryResult> | undefined;
  /** The latest discovery that finished (terminalInvocation is synchronous). */
  private settled: DiscoveryResult | undefined;
  private generation = 0;
  private configPath: string | undefined;
  private disposed = false;

  constructor(private readonly d: CtxCliDeps, private readonly o: CtxCliOptions) {
    this.onDidChangeBinary = this.emitter.event;
    this.extVersion = extensionVersion(d.context);
    this.testMode = o.testMode ?? d.context.extensionMode === vscode.ExtensionMode.Test;
    this.runner = createRunner({
      extVersion: this.extVersion,
      log: d.log,
      spawnFn: o.spawnFn,
      clock: o.clock,
      limits: o.limits,
      killGraceMs: o.killGraceMs,
      maxConcurrentReads: o.maxConcurrentReads,
      parentEnv: () => this.env(),
      platform: this.platform(),
    });
    this.configPath = d.config.path;
    this.configSub = d.config.onDidChange(() => {
      const next = d.config.path;
      if (next === this.configPath || this.disposed) { return; }
      this.configPath = next;
      d.log.info(`contexo.path changed to ${next === undefined ? "(empty)" : JSON.stringify(next)}; discovering ctx again`);
      void this.refresh(false);
    });
  }

  getBinary(): Promise<BinaryState> {
    if (this.disposed) { return Promise.resolve(this.settled?.state ?? { kind: "missing" }); }
    return this.current().then((r) => r.state);
  }

  rediscover(): Promise<BinaryState> {
    if (this.disposed) { return this.getBinary(); }
    return this.refresh(true);
  }

  async version(): Promise<VersionDoc> {
    this.assertLive();
    const r = await this.current();
    this.assertLive();
    if (r.invocation === undefined) { throw CtxError.extension("spawn_failed", this.trusted() ? refusal(r.state) : UNTRUSTED_MESSAGE); }
    const res = await this.runner.run(r.invocation, { cls: "version", args: ctxArgv.version(), cwd: this.homedir() });
    return docFromResult<VersionDoc>(res, "ctx.version.v1");
  }

  async status(root: string, o: { offline: boolean }, token?: vscode.CancellationToken): Promise<StatusDoc> {
    const inv = await this.ready();
    const res = await this.runner.run(inv, {
      cls: o.offline ? "statusOffline" : "status", args: ctxArgv.status(root, o.offline), cwd: root, token, coalesce: true,
    });
    return docFromResult<StatusDoc>(res, "ctx.status.v1");
  }

  async show(root: string, relPath: string, ref: "base" | "server" | (string & {}), token?: vscode.CancellationToken): Promise<Uint8Array> {
    // The empty left side of a diff for a page with no base: never a ctx call.
    if (ref === "empty") { return new Uint8Array(0); }
    const inv = await this.ready();
    const res = await this.runner.run(inv, { cls: "show", args: ctxArgv.show(root, relPath, ref), cwd: root, token });
    if (res.exitCode !== 0) { throw errorFromExit(res.stderr, exitStatus(res.exitCode, res.signal)); }
    // A copy: res.stdout may be a view into Node's shared Buffer pool.
    return new Uint8Array(res.stdout);
  }

  async push(root: string, o: { message?: string; paths?: string[] }): Promise<PushOutcome> {
    const inv = await this.ready();
    const paths = o.paths ?? [];
    if (paths.length > PUSH_PATHS_MAX) {
      this.d.log.info(`push: ${paths.length} paths is more than ${PUSH_PATHS_MAX}; the paths are omitted, so the push widens to every modified and new page`);
    }
    const res = await this.runner.run(inv, { cls: "push", args: ctxArgv.push(root, { message: o.message, paths }), cwd: root });
    return pushOutcomeFromResult(res);
  }

  async pull(root: string): Promise<PullDoc> {
    const inv = await this.ready();
    const res = await this.runner.run(inv, { cls: "pull", args: ctxArgv.pull(root), cwd: root });
    return docFromResult<PullDoc>(res, "ctx.pull.v1");
  }

  async resolve(root: string, relPath: string, strategy: ResolveStrategy, o: { ifServerSha?: string } = {}): Promise<ResolveDoc> {
    const inv = await this.ready();
    const res = await this.runner.run(inv, { cls: "resolve", args: ctxArgv.resolve(root, relPath, strategy, o), cwd: root });
    return docFromResult<ResolveDoc>(res, "ctx.resolve.v1");
  }

  terminalInvocation(args: string[]): TerminalInvocation {
    const inv = this.disposed ? undefined : this.settled?.invocation;
    if (inv === undefined) {
      throw CtxError.extension("spawn_failed", "ctx has not been found yet: await getBinary() first (install ctx or set contexo.path)");
    }
    return { shellPath: inv.command, shellArgs: [...inv.prefixArgs, ...args], env: terminalEnv(this.extVersion, inv.env) };
  }

  dispose(): void {
    if (this.disposed) { return; }
    this.disposed = true;
    this.generation++; // a discovery still running fires nothing
    this.configSub.dispose();
    this.runner.dispose();
    this.emitter.dispose();
  }

  // ---------- internals ----------

  private env(): NodeJS.ProcessEnv {
    return this.o.env ?? process.env;
  }

  private platform(): NodeJS.Platform {
    return this.o.platform ?? process.platform;
  }

  private homedir(): string {
    return this.o.homedir ? this.o.homedir() : os.homedir();
  }

  private trusted(): boolean {
    return this.o.isTrusted ? this.o.isTrusted() : vscode.workspace.isTrusted;
  }

  private assertLive(): void {
    if (this.disposed) { throw CtxError.extension("cancelled", "the ctx CLI was disposed"); }
  }

  /** The current discovery; an untrusted workspace answers missing without spawning (and without memoizing it). */
  private current(): Promise<DiscoveryResult> {
    if (!this.trusted()) { return Promise.resolve({ state: { kind: "missing" }, warnings: [UNTRUSTED_MESSAGE], tried: [] }); }
    return this.discovery ?? this.start().promise;
  }

  private start(): { generation: number; promise: Promise<DiscoveryResult> } {
    const generation = ++this.generation;
    const promise = this.runDiscovery();
    this.discovery = promise;
    void promise.then((r) => {
      if (generation === this.generation) { this.settled = r; }
    });
    return { generation, promise };
  }

  /** Re-run discovery and fire onDidChangeBinary; a superseded run resolves with the newest state. */
  private async refresh(clearCache: boolean): Promise<BinaryState> {
    if (clearCache) { this.cache.clear(); }
    if (!this.trusted()) { return (await this.current()).state; }
    const { generation, promise } = this.start();
    const r = await promise;
    if (generation !== this.generation) { return this.getBinary(); }
    this.emitter.fire(r.state);
    return r.state;
  }

  private async runDiscovery(): Promise<DiscoveryResult> {
    try {
      return await discover({
        platform: this.platform(),
        env: this.env(),
        homedir: this.homedir(),
        configPath: this.d.config.path,
        testMode: this.testMode,
        fs: this.o.fs ?? nodeDiscoveryFs,
        probe: (inv, args) => this.runner.run(inv, { cls: "version", args, cwd: this.homedir() }),
        log: this.d.log,
        cache: this.cache,
      });
    } catch (err) {
      this.d.log.error(`ctx discovery failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
      return { state: { kind: "missing" }, warnings: [], tried: [] };
    }
  }

  /** The gate (E36): the invocation of an ok binary, or a spawn_failed rejection that never reaches ctx. */
  private async ready(): Promise<CtxInvocation> {
    this.assertLive();
    if (!this.trusted()) { throw CtxError.extension("spawn_failed", UNTRUSTED_MESSAGE); }
    const r = await this.current();
    this.assertLive();
    if (r.state.kind !== "ok" || r.invocation === undefined) { throw CtxError.extension("spawn_failed", refusal(r.state)); }
    return r.invocation;
  }
}

/** package.json version for CONTEXO_CLIENT (D21). */
function extensionVersion(context: vscode.ExtensionContext): string {
  const v = (context.extension?.packageJSON as { version?: unknown } | undefined)?.version;
  return typeof v === "string" && v !== "" ? v : "0.0.0";
}

/** Why a call was refused before reaching ctx. */
function refusal(state: BinaryState): string {
  switch (state.kind) {
    case "missing":
      return "ctx was not found: install ctx, or set contexo.path to the absolute path of the ctx binary (see the Contexo log)";
    case "tooOld":
      return `ctx${state.versionText ? ` ${state.versionText}` : ""} at ${state.path} is too old for this extension`
        + `${state.missing.length > 0 ? ` (missing: ${state.missing.join(", ")})` : " (it does not speak contract 1)"}; run \`ctx update\``;
    case "extensionTooOld":
      return `ctx at ${state.path} speaks contract ${state.contractVersion}, but this extension supports contract ${SUPPORTED_CONTRACT_VERSION}: update the Contexo extension`;
    case "ok":
      return "ctx is ready";
  }
}
