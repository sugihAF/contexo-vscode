// The one place a ctx process starts (D1, E25, E26). Only `import type` from 'vscode', so
// plain node mocha (WP-3.1's conformance test) can load this module: the adapters live in
// ctxCli.ts.
//
// SEAM (pinned by the WP-1.7 lead before the lanes split; bodies are lane B's):
// - createRunner(d).run(inv, req) spawns `inv.command` with [...inv.prefixArgs, ...req.args]
//   and {cwd, env: spawnEnv(...), shell: false, windowsHide: true, stdio: ['ignore','pipe','pipe']}.
// - It RESOLVES with a ProcessResult for a process that exited by itself (any exit code) and
//   REJECTS with a CtxError for 'spawn_failed' (spawn 'error' event: ENOENT, EACCES, EINVAL;
//   a missing cwd; an argument with a NUL byte), 'timeout' (the class limit) and 'cancelled'
//   (the token, or dispose()). Kill path: SIGTERM, then SIGKILL `killGraceMs` later when the
//   process has not exited; the promise rejects when the process exits after the kill began,
//   or right after SIGKILL is sent, whichever comes first. Kill errors come from
//   parse.ts errorFromExit(stderr, status, {killedBy}).
// - Info log line per finished process (success, failure, kill), exactly:
//     ctx <JSON.stringify(args)> cwd=<JSON.stringify(cwd)> exit=<code|SIGNAL|timeout|cancelled|spawn_failed> <ms>ms
//   where args are the ctx args (req.args, not prefixArgs). Debug: `ctx stderr: <stderr>` when
//   stderr is non-empty. Never stdout (show bytes), never the env.
import * as childProcess from "node:child_process";
import type { CancellationToken } from "vscode";
import type { ResolveStrategy } from "../contract/types";
import { errorFromExit, exitStatus } from "./parse";
import { CTX_TIMEOUTS_MS, CtxError, KILL_GRACE_MS, PUSH_PATHS_MAX } from "./types";

/** Timeout classes (CTX_TIMEOUTS_MS keys). */
export type CommandClass = keyof typeof CTX_TIMEOUTS_MS;

/** version, status --offline, status and show count toward the read limit; push, pull and resolve do not. */
export const READ_CLASSES: ReadonlySet<CommandClass> = new Set<CommandClass>(["version", "statusOffline", "status", "show"]);

/** At most this many read processes run at once; further reads queue FIFO. */
export const MAX_CONCURRENT_READS = 4;

/** The logger the CLI writes to (structurally a vscode LogOutputChannel). */
export interface CliLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  debug(message: string): void;
}

/** Injectable timers (tests use a fake clock). */
export interface Clock {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  now(): number;
}

export const systemClock: Clock = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
};

/**
 * How to start "ctx": a resolved binary ({command: path, prefixArgs: []}) or, in Test mode,
 * the TestCtxSpec (node + fake-ctx.mjs), whose env is merged into the spawn env.
 */
export interface CtxInvocation {
  command: string;
  prefixArgs: readonly string[];
  env?: Readonly<Record<string, string>>;
}

/** child_process.spawn as the runner calls it. */
export type SpawnFn = (command: string, args: string[], options: childProcess.SpawnOptions) => childProcess.ChildProcess;

export const defaultSpawnFn: SpawnFn = (command, args, options) => childProcess.spawn(command, args, options);

/** A process that exited by itself. */
export interface ProcessResult {
  /** The ctx args (RunRequest.args; prefixArgs excluded). */
  args: readonly string[];
  /** stdout as raw bytes (binary-safe for `ctx show`). */
  stdout: Buffer;
  /** stderr decoded as UTF-8. */
  stderr: string;
  /** The exit code; null when the process ended by a signal. */
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  durationMs: number;
}

export interface RunRequest {
  cls: CommandClass;
  /** ctx args, e.g. ctxArgv.status(root, false). */
  args: readonly string[];
  /** The workspace-folder root, or os.homedir() for version. */
  cwd: string;
  token?: CancellationToken;
  /**
   * Share one process with an identical in-flight call (same command, prefixArgs, env, cwd
   * and args). ctxCli sets it for status only. Each caller's own token detaches only that
   * caller (it rejects 'cancelled'); the process is killed when every caller has cancelled.
   */
  coalesce?: boolean;
}

export interface RunnerDeps {
  /** package.json version: CONTEXO_CLIENT=contexo-vscode/<extVersion>. */
  extVersion: string;
  log: CliLogger;
  spawnFn?: SpawnFn;
  clock?: Clock;
  /** Per-class limits in ms; defaults CTX_TIMEOUTS_MS. */
  limits?: Partial<Record<CommandClass, number>>;
  /** Default KILL_GRACE_MS. */
  killGraceMs?: number;
  /** Default MAX_CONCURRENT_READS. */
  maxConcurrentReads?: number;
  /** The parent env, read at every spawn; default process.env. */
  parentEnv?: () => NodeJS.ProcessEnv;
  /** Default process.platform (case-insensitive env keys on win32). */
  platform?: NodeJS.Platform;
}

export interface CtxRunner {
  run(inv: CtxInvocation, req: RunRequest): Promise<ProcessResult>;
  /** Kill every running process (cancel path); queued and in-flight calls reject 'cancelled', and so does every later run(). */
  dispose(): void;
}

/** Why the runner killed a process. */
type KillReason = "timeout" | "cancelled";

/** One run() call; a coalesced process has several. */
interface Caller {
  resolve(r: ProcessResult): void;
  reject(err: CtxError): void;
  /** The caller's token subscription, disposed when the caller settles or detaches. */
  sub?: { dispose(): unknown };
}

/** One process (queued, running or done) and every caller waiting on it. */
interface Job {
  readonly inv: CtxInvocation;
  readonly cls: CommandClass;
  readonly args: readonly string[];
  readonly cwd: string;
  /** The coalescing key (coalesce: true calls only). */
  readonly key: string | undefined;
  readonly read: boolean;
  readonly callers: Set<Caller>;
  state: "queued" | "running" | "done";
  child?: childProcess.ChildProcess;
  killedBy?: KillReason;
  startedAt: number;
  limitTimer?: unknown;
  graceTimer?: unknown;
  readonly stdout: Buffer[];
  readonly stderr: Buffer[];
  exited: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

export function createRunner(d: RunnerDeps): CtxRunner {
  const spawnFn = d.spawnFn ?? defaultSpawnFn;
  const clock = d.clock ?? systemClock;
  const killGraceMs = d.killGraceMs ?? KILL_GRACE_MS;
  const maxReads = d.maxConcurrentReads ?? MAX_CONCURRENT_READS;
  const parentEnv = d.parentEnv ?? ((): NodeJS.ProcessEnv => process.env);
  const platform = d.platform ?? process.platform;
  const limitOf = (cls: CommandClass): number => d.limits?.[cls] ?? CTX_TIMEOUTS_MS[cls];

  /** Reads waiting for a slot, FIFO. */
  const queue: Job[] = [];
  const running = new Set<Job>();
  /** Coalescable jobs (queued or running, not yet being killed) by key. */
  const inflight = new Map<string, Job>();
  let activeReads = 0;
  let disposed = false;

  /** A closed or throwing log never keeps a call from settling. */
  const say = (level: keyof CliLogger, message: string): void => {
    try { d.log[level](message); } catch { /* ignored */ }
  };
  const cancelled = (): CtxError => errorFromExit("", -1, { killedBy: "cancelled" });

  function forget(job: Job): void {
    if (job.key !== undefined && inflight.get(job.key) === job) { inflight.delete(job.key); }
  }

  function attach(job: Job, caller: Caller, token: CancellationToken | undefined): void {
    job.callers.add(caller);
    if (token) { caller.sub = token.onCancellationRequested(() => onCancel(job, caller)); }
  }

  /** Reject one caller now; the process (if any) keeps running for the others. */
  function detach(job: Job, caller: Caller): void {
    if (!job.callers.delete(caller)) { return; }
    caller.sub?.dispose();
    caller.reject(cancelled());
  }

  function onCancel(job: Job, caller: Caller): void {
    if (job.state === "done" || !job.callers.has(caller)) { return; }
    if (job.state === "queued") {
      detach(job, caller);
      if (job.callers.size === 0) {
        // Never spawned: drop it from the queue.
        const i = queue.indexOf(job);
        if (i >= 0) { queue.splice(i, 1); }
        job.state = "done";
        forget(job);
      }
      return;
    }
    // Running: other callers (or a kill already under way) keep the process; the last caller kills it.
    if (job.callers.size > 1 || job.killedBy !== undefined) {
      detach(job, caller);
      return;
    }
    kill(job, "cancelled");
  }

  function pump(): void {
    while (!disposed && activeReads < maxReads) {
      const job = queue.shift();
      if (job === undefined) { return; }
      start(job);
    }
  }

  function start(job: Job): void {
    job.state = "running";
    running.add(job);
    if (job.read) { activeReads++; }
    job.startedAt = clock.now();
    let child: childProcess.ChildProcess;
    try {
      const options: childProcess.SpawnOptions = {
        cwd: job.cwd,
        env: spawnEnv(parentEnv(), d.extVersion, job.inv.env, platform),
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      };
      // Throws synchronously for EINVAL (.cmd/.bat on win32) and a NUL byte in an argument.
      child = spawnFn(job.inv.command, [...job.inv.prefixArgs, ...job.args], options);
    } catch (err) {
      spawnFailed(job, err);
      return;
    }
    job.child = child;
    child.stdout?.on("data", (b: Buffer | string) => job.stdout.push(toBuffer(b)));
    child.stderr?.on("data", (b: Buffer | string) => job.stderr.push(toBuffer(b)));
    // A pipe error must not become an uncaught exception; 'close' still follows.
    child.stdout?.on("error", (err: Error) => say("warn", `ctx stdout error: ${errorText(err)}`));
    child.stderr?.on("error", (err: Error) => say("warn", `ctx stderr error: ${errorText(err)}`));
    child.on("error", (err: Error) => {
      if (job.state !== "running") { return; }
      // pid is undefined only when the process never started (ENOENT, EACCES, a missing cwd).
      if (child.pid === undefined && !job.exited) {
        if (job.killedBy !== undefined) { finishKilled(job); } else { spawnFailed(job, err); }
        return;
      }
      say("warn", `ctx process error: ${errorText(err)}`);
    });
    child.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      job.exited = true;
      job.exitCode = code;
      job.signal = signal;
      if (job.killedBy !== undefined) { finishKilled(job); }
    });
    child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
      if (!job.exited) {
        job.exited = true;
        job.exitCode = code;
        job.signal = signal;
      }
      if (job.killedBy !== undefined) { finishKilled(job); } else { finishExited(job); }
    });
    job.limitTimer = clock.setTimeout(() => kill(job, "timeout"), limitOf(job.cls));
  }

  /** SIGTERM now, SIGKILL killGraceMs later; settles on the exit or right after SIGKILL. */
  function kill(job: Job, reason: KillReason): void {
    if (job.state !== "running" || job.killedBy !== undefined) { return; }
    job.killedBy = reason;
    clearTimer(job, "limitTimer");
    forget(job);
    if (job.exited) {
      // Exited but stdio not closed yet: nothing left to signal.
      finishKilled(job);
      return;
    }
    signal(job, "SIGTERM");
    job.graceTimer = clock.setTimeout(() => {
      job.graceTimer = undefined;
      if (job.state !== "running") { return; }
      signal(job, "SIGKILL");
      finishKilled(job);
    }, killGraceMs);
  }

  function signal(job: Job, sig: NodeJS.Signals): void {
    try {
      job.child?.kill(sig);
    } catch (err) {
      say("warn", `ctx ${sig} failed: ${errorText(err)}`);
    }
  }

  function clearTimer(job: Job, which: "limitTimer" | "graceTimer"): void {
    if (job[which] !== undefined) {
      clock.clearTimeout(job[which]);
      job[which] = undefined;
    }
  }

  function spawnFailed(job: Job, err: unknown): void {
    const error = CtxError.extension("spawn_failed", `could not start ctx (${job.inv.command} in ${job.cwd}): ${errorText(err)}`);
    settle(job, "spawn_failed", "", { error });
  }

  function finishKilled(job: Job): void {
    const reason = job.killedBy ?? "cancelled";
    const stderr = Buffer.concat(job.stderr).toString("utf8");
    const status = job.exited ? exitStatus(job.exitCode, job.signal) : -1;
    settle(job, reason, stderr, { error: errorFromExit(stderr, status, { killedBy: reason }) });
  }

  function finishExited(job: Job): void {
    // Decoded once, at the end, so a multibyte character split across chunks survives.
    const stderr = Buffer.concat(job.stderr).toString("utf8");
    const result: ProcessResult = {
      args: [...job.args],
      stdout: Buffer.concat(job.stdout),
      stderr,
      exitCode: job.exitCode,
      signal: job.signal,
      durationMs: clock.now() - job.startedAt,
    };
    settle(job, job.exitCode !== null ? String(job.exitCode) : job.signal ?? String(exitStatus(null, null)), stderr, { result });
  }

  /** The one place a running job ends: timers, bookkeeping, the log line, then every caller. */
  function settle(job: Job, label: string, stderr: string, outcome: { result: ProcessResult } | { error: CtxError }): void {
    if (job.state !== "running") { return; }
    job.state = "done";
    clearTimer(job, "limitTimer");
    clearTimer(job, "graceTimer");
    forget(job);
    running.delete(job);
    say("info", `ctx ${JSON.stringify(job.args)} cwd=${JSON.stringify(job.cwd)} exit=${label} ${clock.now() - job.startedAt}ms`);
    if (stderr.trim() !== "") { say("debug", `ctx stderr: ${stderr.trimEnd()}`); }
    const callers = [...job.callers];
    job.callers.clear();
    for (const c of callers) {
      c.sub?.dispose();
      if ("result" in outcome) { c.resolve(outcome.result); } else { c.reject(outcome.error); }
    }
    if (job.read) {
      activeReads--;
      pump();
    }
  }

  return {
    run(inv: CtxInvocation, req: RunRequest): Promise<ProcessResult> {
      if (disposed || req.token?.isCancellationRequested === true) { return Promise.reject(cancelled()); }
      return new Promise<ProcessResult>((resolve, reject) => {
        const caller: Caller = { resolve, reject };
        const key = req.coalesce === true ? coalesceKey(inv, req) : undefined;
        const shared = key === undefined ? undefined : inflight.get(key);
        if (shared !== undefined) {
          attach(shared, caller, req.token);
          return;
        }
        const job: Job = {
          inv, cls: req.cls, args: [...req.args], cwd: req.cwd, key, read: READ_CLASSES.has(req.cls), callers: new Set(),
          state: "queued", startedAt: clock.now(), stdout: [], stderr: [], exited: false, exitCode: null, signal: null,
        };
        if (key !== undefined) { inflight.set(key, job); }
        attach(job, caller, req.token);
        if (job.read && activeReads >= maxReads) { queue.push(job); } else { start(job); }
      });
    },
    dispose(): void {
      if (disposed) { return; }
      disposed = true;
      for (const job of queue.splice(0)) {
        job.state = "done";
        forget(job);
        for (const c of [...job.callers]) { detach(job, c); }
      }
      for (const job of [...running]) {
        if (job.killedBy === undefined) { kill(job, "cancelled"); } else { job.killedBy = "cancelled"; }
      }
      inflight.clear();
    },
  };
}

/** Same command, prefixArgs, env, cwd, class and args (env keys sorted). */
function coalesceKey(inv: CtxInvocation, req: RunRequest): string {
  const env = inv.env === undefined ? null : Object.entries(inv.env).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify([inv.command, inv.prefixArgs, env, req.cwd, req.cls, req.args]);
}

function toBuffer(b: Buffer | string): Buffer {
  return typeof b === "string" ? Buffer.from(b, "utf8") : b;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 'contexo-vscode/<extVersion>' (D21). */
export function clientName(extVersion: string): string {
  return `contexo-vscode/${extVersion}`;
}

/**
 * E26 spawn env: {...parent, ...extra, NO_COLOR:'1', CONTEXO_NO_UPDATE_CHECK:'1',
 * CONTEXO_CLIENT: clientName(extVersion)} with CONTEXO_DISTILL_DISABLE deleted. The E26 keys
 * always win over `extra`. On win32 (case-insensitive env) every case variant of the four keys
 * is removed first.
 */
export function spawnEnv(parent: NodeJS.ProcessEnv, extVersion: string, extra?: Readonly<Record<string, string>>, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...parent, ...extra };
  if (platform === "win32") {
    for (const k of Object.keys(env)) {
      if ((E26_KEYS as readonly string[]).includes(k.toUpperCase())) { delete env[k]; }
    }
  } else {
    delete env.CONTEXO_DISTILL_DISABLE;
  }
  return Object.assign(env, e26Env(extVersion));
}

/**
 * E26 for vscode.window.createTerminal (merged over the inherited env): {...extra, NO_COLOR:'1',
 * CONTEXO_NO_UPDATE_CHECK:'1', CONTEXO_CLIENT, CONTEXO_DISTILL_DISABLE: null} (null unsets).
 */
export function terminalEnv(extVersion: string, extra?: Readonly<Record<string, string>>): Record<string, string | null> {
  return { ...extra, ...e26Env(extVersion), CONTEXO_DISTILL_DISABLE: null };
}

/** The four env keys E26 controls (the first three set, the last one removed). */
const E26_KEYS = ["NO_COLOR", "CONTEXO_NO_UPDATE_CHECK", "CONTEXO_CLIENT", "CONTEXO_DISTILL_DISABLE"] as const;

function e26Env(extVersion: string): { NO_COLOR: string; CONTEXO_NO_UPDATE_CHECK: string; CONTEXO_CLIENT: string } {
  return { NO_COLOR: "1", CONTEXO_NO_UPDATE_CHECK: "1", CONTEXO_CLIENT: clientName(extVersion) };
}

/** A ctx show ref or an --if-server-sha value: 7 to 64 hex digits. */
const HEX_SHA = /^[0-9a-fA-F]{7,64}$/;

/** A builder-side argv error: a synthetic envelope with exit_code -1 (no process ran). */
function argvError(code: "usage" | "invalid_path", message: string): CtxError {
  return new CtxError({ schema: "ctx.error.v1", exit_code: -1, error: { code, message, advice: [], retryable: false } });
}

/** Any argument but a RelPath: only a NUL byte is refused (spawn would reject it anyway). */
function plainArg(value: string, what: string): string {
  if (value.includes("\x00")) { throw argvError("usage", `${what} contains a NUL byte`); }
  return value;
}

/** A contract RelPath: non-empty, no leading '-' (never read as a flag), no NUL. */
function relPathArg(p: string): string {
  if (p === "" || p.startsWith("-") || p.includes("\x00")) { throw argvError("invalid_path", `not a page path: ${JSON.stringify(p)}`); }
  return p;
}

function showRefArg(ref: string): string {
  if (ref === "base" || ref === "server" || HEX_SHA.test(ref)) { return ref; }
  throw argvError("usage", `not a ctx show ref (base, server or a 7-64 hex sha): ${JSON.stringify(ref)}`);
}

/**
 * E25 argv per command (R = absolute root, P = contract RelPath). Builders throw CtxError
 * (synthetic envelope, exit_code -1): 'invalid_path' for a P that is empty, starts with '-'
 * or contains NUL; 'usage' for a show ref that is not 'base' | 'server' | 7-64 hex (including
 * 'empty', which ctxCli answers without spawning), an ifServerSha that is not 7-64 hex, or a
 * NUL byte in any other argument.
 */
export const ctxArgv = {
  /** ['version','--json'] (no --root). */
  version(): string[] { return ["version", "--json"]; },
  /** ['version','--short'] (old-ctx probe after a failed handshake). */
  versionShort(): string[] { return ["version", "--short"]; },
  /** ['status','--json','--root',R] + ['--offline'] when offline. */
  status(root: string, offline: boolean): string[] {
    const args = ["status", "--json", "--root", plainArg(root, "the root")];
    if (offline) { args.push("--offline"); }
    return args;
  },
  /** ['show',P,'--at',ref,'--root',R] (no --json). */
  show(root: string, relPath: string, ref: string): string[] {
    return ["show", relPathArg(relPath), "--at", showRefArg(ref), "--root", plainArg(root, "the root")];
  },
  /** ['pull','--json','--root',R]. */
  pull(root: string): string[] { return ["pull", "--json", "--root", plainArg(root, "the root")]; },
  /**
   * ['push','--json','--yes','--root',R] + ['-m',M] when M is a non-empty string (one
   * element, verbatim) + ['--',...paths] when 1 <= paths.length <= PUSH_PATHS_MAX (omitted for
   * 0 or more: the push widens to every changed page; ctxCli logs it).
   */
  push(root: string, o: { message?: string; paths?: readonly string[] }): string[] {
    const args = ["push", "--json", "--yes", "--root", plainArg(root, "the root")];
    if (typeof o.message === "string" && o.message !== "") { args.push("-m", plainArg(o.message, "the push message")); }
    const paths = o.paths ?? [];
    for (const p of paths) { relPathArg(p); }
    if (paths.length >= 1 && paths.length <= PUSH_PATHS_MAX) { args.push("--", ...paths); }
    return args;
  },
  /** ['resolve',P,'--ours'|'--theirs','--json','--root',R] + ['--if-server-sha',S] when S is a non-empty string. */
  resolve(root: string, relPath: string, strategy: ResolveStrategy, o: { ifServerSha?: string } = {}): string[] {
    if (strategy !== "ours" && strategy !== "theirs") { throw argvError("usage", `not a resolve strategy: ${JSON.stringify(strategy)}`); }
    const args = ["resolve", relPathArg(relPath), strategy === "ours" ? "--ours" : "--theirs", "--json", "--root", plainArg(root, "the root")];
    const sha = o.ifServerSha;
    if (typeof sha === "string" && sha !== "") {
      if (!HEX_SHA.test(sha)) { throw argvError("usage", `not a 7-64 hex sha for --if-server-sha: ${JSON.stringify(sha)}`); }
      args.push("--if-server-sha", sha);
    }
    return args;
  },
};
