// The ctx process boundary (FROZEN after WP-0.I; additions only).
// Only `import type` from 'vscode' here, so unit tests and test/helpers/fakeCtxCli.ts
// can load this module without VS Code.
import type { CancellationToken, Event, ExtensionContext, LogOutputChannel } from "vscode";
import {
  parseEnvelope,
  type ErrorCode,
  type ErrorEnvelope,
  type PullDoc,
  type PushDoc,
  type ResolveDoc,
  type ResolveStrategy,
  type StatusDoc,
  type VersionDoc,
} from "../contract/types";
import type { ContexoConfig } from "../services";

export type { ShowRef } from "../contract/types";

/**
 * Result of discovery + `ctx version --json` handshake (E36):
 * - ENOENT, no candidate, or output that is not ctx -> missing (ExtensionState 'ctxMissing').
 * - contract_version > SUPPORTED_CONTRACT_VERSION -> extensionTooOld ('extensionTooOld').
 * - contract_version < 1, a REQUIRED_CAPABILITIES entry missing, or an old ctx
 *   ('unknown flag: --json'; versionText from `ctx version --short`) -> tooOld ('ctxTooOld').
 * - otherwise ok, whatever the version string ('dev', '0.7.0-rc.1').
 */
export type BinaryState =
  | { kind: "ok"; path: string; version: VersionDoc }
  | { kind: "missing" }
  | { kind: "tooOld"; path: string; versionText?: string; missing: string[] }
  | { kind: "extensionTooOld"; path: string; contractVersion: number };

/** `ctx push --json` result: exit 0, or exit 6 (conflicts) with BOTH the PushDoc and the conflict envelope. */
export interface PushOutcome { doc: PushDoc; conflict?: ErrorEnvelope; }

/** A process-free invocation for vscode.window.createTerminal({shellPath, shellArgs, env}). */
export interface TerminalInvocation {
  shellPath: string;
  shellArgs: string[];
  /** Extra terminal env; a null value unsets the variable (used to drop CONTEXO_DISTILL_DISABLE, E26). */
  env?: { [key: string]: string | null };
}

/**
 * The only component that spawns ctx (D1; ESLint allows child_process only in src/cli/).
 * Implemented by createCtxCli in src/cli/ctxCli.ts (WP-1.7). Normative rules for it:
 *
 * Discovery (E35), first hit wins, cached by path + mtime + size:
 *   1. contexo.path (machine scope; absolute paths only, relative values are ignored)
 *   2. PATH (on win32 scan PATH x PATHEXT; never call `which`)
 *   3. ~/.local/bin/ctx                      (scripts/install.sh:14)
 *   4. %LOCALAPPDATA%\Programs\contexo\ctx.exe (scripts/install.ps1:14)
 *   5. ~/go/bin/ctx[.exe]
 *   6. /opt/homebrew/bin/ctx, then /usr/local/bin/ctx
 *   Candidates ending in .cmd, .bat or .ps1 are rejected with 'point contexo.path at ctx.exe'
 *   (Node refuses to spawn them with shell:false, CVE-2024-27980; shell:true is banned).
 *
 * argv per command (E25; R = absolute workspace-folder fsPath, P = contract RelPath):
 *   version: ['version','--json']                                   (no --root)
 *   status:  ['status','--json','--root',R] + ['--offline'] when offline
 *   show:    ['show',P,'--at','base'|'server'|<sha>,'--root',R]     (no --json; ref 'empty' is never sent)
 *   pull:    ['pull','--json','--root',R]
 *   push:    ['push','--json','--yes','--root',R] + ['-m',M] when M is non-empty
 *            + ['--',...paths] when paths has 1..PUSH_PATHS_MAX entries (omitted above that)
 *   resolve: ['resolve',P,'--ours'|'--theirs','--json','--root',R] + ['--if-server-sha',S] when set
 *   old-ctx probe after a failed handshake: ['version','--short']
 *
 * Spawn (E26): child_process.spawn(path, args, {shell:false, windowsHide:true,
 *   stdio:['ignore','pipe','pipe'], env}) with env = {...process.env, NO_COLOR:'1',
 *   CONTEXO_NO_UPDATE_CHECK:'1', CONTEXO_CLIENT:'contexo-vscode/<extension version>'} and
 *   CONTEXO_DISTILL_DISABLE deleted from the copy. Never pass --no-distill.
 *
 * Timeouts (CTX_TIMEOUTS_MS): SIGTERM at the limit, SIGKILL KILL_GRACE_MS later.
 *
 * Errors: exit != 0 -> CtxError.fromProcess(stderr, exit) (the last non-empty stderr
 *   line is the envelope; parseEnvelope falls back by exit code). push exit 6 resolves
 *   with {doc, conflict}. Process-level failures use CtxError.extension(...).
 *
 * Test mode: when context.extensionMode === ExtensionMode.Test and env CONTEXO_TEST_CTX
 *   is set, it is JSON TestCtxSpec {command, prefixArgs[, env]}: spawn `command` with
 *   [...prefixArgs, ...args] and merge `env` into the spawn env. Never honoured otherwise.
 *
 * The extension never spawns ctx while vscode.workspace.isTrusted is false, and never
 * calls `ctx repair`.
 */
export interface ICtxCli {
  readonly onDidChangeBinary: Event<BinaryState>;
  getBinary(): Promise<BinaryState>;
  /** Drop the discovery/handshake cache (contexo.path changed, ctx installed/updated) and run it again. */
  rediscover(): Promise<BinaryState>;
  version(): Promise<VersionDoc>;
  status(root: string, o: { offline: boolean }, token?: CancellationToken): Promise<StatusDoc>;
  /** Raw page bytes (`ctx show`). ref is 'base', 'server' or a commit sha, never 'empty'. */
  show(root: string, relPath: string, ref: "base" | "server" | (string & {}), token?: CancellationToken): Promise<Uint8Array>;
  push(root: string, o: { message?: string; paths?: string[] }): Promise<PushOutcome>;
  pull(root: string): Promise<PullDoc>;
  resolve(root: string, relPath: string, strategy: ResolveStrategy, o?: { ifServerSha?: string }): Promise<ResolveDoc>;
  /** A no-shell terminal invocation of the resolved ctx with `args` (login, init, update) and the E26 env rules. */
  terminalInvocation(args: string[]): TerminalInvocation;
  dispose(): void;
}

export interface CtxCliDeps {
  context: ExtensionContext;
  log: LogOutputChannel;
  config: ContexoConfig;
}

/** Per-command timeouts in ms (contract §2). */
export const CTX_TIMEOUTS_MS = {
  version: 5_000,
  statusOffline: 10_000,
  status: 30_000,
  show: 30_000,
  push: 120_000,
  pull: 120_000,
  resolve: 120_000,
} as const;
/** SIGKILL follows SIGTERM after this many ms. */
export const KILL_GRACE_MS = 2_000;
/** push passes explicit paths after '--' only up to this many (E25). */
export const PUSH_PATHS_MAX = 150;

/** Env var holding the Test-mode ctx override (JSON TestCtxSpec). */
export const TEST_CTX_ENV = "CONTEXO_TEST_CTX";
export interface TestCtxSpec { command: string; prefixArgs: string[]; env?: Record<string, string>; }

/** Failures produced by the extension itself, never by ctx. */
export type ExtensionErrorCode = "timeout" | "cancelled" | "spawn_failed" | "contract_mismatch";

const CTX_ERROR_BRAND = Symbol.for("contexo.CtxError");

/**
 * A failed ctx invocation. `code` is the envelope's ErrorCode (authoritative over the
 * exit code), an ExtensionErrorCode, or an unknown future ctx code (handle by exitCode).
 *
 * `instanceof CtxError` is brand-based (Symbol.for), so it also holds for errors built by
 * another copy of this module: integration tests load out/src/cli/types.js while the
 * extension runs the esbuild bundle.
 */
export class CtxError extends Error {
  readonly code: ErrorCode | ExtensionErrorCode | (string & {});
  readonly exitCode: number;
  readonly advice: string[];
  readonly retryable: boolean;
  readonly httpStatus?: number;
  readonly details?: unknown;
  readonly stderr: string;
  readonly envelope: ErrorEnvelope;

  constructor(envelope: ErrorEnvelope, stderr = "", code?: ExtensionErrorCode) {
    super(envelope.error.message);
    this.name = "CtxError";
    this.envelope = envelope;
    this.code = code ?? envelope.error.code;
    this.exitCode = envelope.exit_code;
    this.advice = Array.isArray(envelope.error.advice) ? envelope.error.advice : [];
    this.retryable = envelope.error.retryable;
    if (envelope.error.http_status !== undefined) { this.httpStatus = envelope.error.http_status; }
    if (envelope.error.details !== undefined) { this.details = envelope.error.details; }
    this.stderr = stderr;
    Object.defineProperty(this, CTX_ERROR_BRAND, { value: true });
  }

  static override [Symbol.hasInstance](v: unknown): boolean {
    return typeof v === "object" && v !== null && (v as Record<symbol, unknown>)[CTX_ERROR_BRAND] === true;
  }

  /** From a finished ctx process: parses the last non-empty stderr line (parseEnvelope). */
  static fromProcess(stderr: string, exitCode: number): CtxError {
    return new CtxError(parseEnvelope(stderr, exitCode), stderr);
  }

  /**
   * An extension-side failure (timeout, cancellation, spawn error, unparseable stdout).
   * The synthetic envelope carries code 'internal'; `code` carries the extension code.
   * exitCode defaults to -1 (no process exit status).
   */
  static extension(code: ExtensionErrorCode, message: string, o: { exitCode?: number; stderr?: string; retryable?: boolean } = {}): CtxError {
    const exitCode = o.exitCode ?? -1;
    const envelope: ErrorEnvelope = {
      schema: "ctx.error.v1",
      exit_code: exitCode,
      error: { code: "internal", message, advice: [], retryable: o.retryable ?? false },
    };
    return new CtxError(envelope, o.stderr ?? "", code);
  }
}
