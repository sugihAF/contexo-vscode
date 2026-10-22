// Maps every ctx failure (CtxError) to a message and the actions the user can take
// (WP-1.13). errorActions() is pure; presentError() shows it. Reusable by any module
// that calls ctx (WP-2.3). No action ever passes or offers --no-distill (D4).
import * as vscode from "vscode";
import { CtxError, type ExtensionErrorCode } from "../cli/types";
import type { ErrorCode } from "../contract/types";
import type { Services } from "../services";

/** busy (exit 12): retry the same operation once after this many ms, then offer [Retry]. */
export const BUSY_RETRY_MS = 1_000;

/** Command run by [Show Conflicts] and [Show Changes]. */
export const SHOW_SCM_COMMAND = "workbench.view.scm";

export type ErrorActionKind = "command" | "retry" | "showLog" | "openUrl";

export interface ErrorAction {
  /** Button label, e.g. 'Log in'. */
  label: string;
  kind: ErrorActionKind;
  /** kind 'command': the VS Code command id (contexo.login, contexo.updateCtx, contexo.init, workbench.view.scm). */
  command?: string;
  /** kind 'command': its arguments. */
  args?: unknown[];
  /** kind 'openUrl': an http: or https: URL, never anything else. */
  url?: string;
}

/** 'log' is a quiet log line only: no notification. */
export type ErrorSeverity = "error" | "warning" | "info" | "log";

export interface ErrorPresentation {
  /** The effective code (effectiveCode(err)). */
  code: ErrorCode | ExtensionErrorCode;
  message: string;
  actions: ErrorAction[];
  severity: ErrorSeverity;
  /**
   * The outcome calls for a remote status refresh (stale, not_resolvable, the not-found
   * codes). IRepository.run already refreshes after push, pull and resolve, so callers
   * inside run() pass {refreshed: true} to presentError.
   */
  refresh: boolean;
  /** busy only: auto-retry once after this many ms (BUSY_RETRY_MS) before showing the actions. */
  autoRetryMs?: number;
  /** distill_required only: callers show the D4 modal (Share via your agent) instead of a toast. */
  distillModal?: boolean;
}

/** Context that some messages name. */
export interface ErrorContext {
  /** StatusDoc.project.repo_id, named by forbidden. */
  repoId?: string;
}

/**
 * The code a CtxError is handled by: an ExtensionErrorCode as is, a known ErrorCode as
 * is, and an unknown (future) ctx code by its exit category through fallbackCode.
 */
export function effectiveCode(err: CtxError): ErrorCode | ExtensionErrorCode {
  void err;
  throw new Error("not implemented");
}

/**
 * The message and actions for err (WP-1.13 table, typed `satisfies Record<ErrorCode, ...>`):
 * - not_authenticated, auth_rejected, server_unresolved: [Log in] (contexo.login).
 * - forbidden: a toast naming ctx.repoId.
 * - not_initialized: [Initialize Contexo] (contexo.init).
 * - repo_not_configured: advice 'ctx remote set-repo <id>'.
 * - network, server_error, rate_limited: [Retry] [Show Log].
 * - busy: 'Another ctx operation (possibly your agent) is syncing', autoRetryMs 1000, then [Retry].
 * - conflict: [Show Conflicts] (workbench.view.scm).
 * - stale: refresh.
 * - server_unsupported: 'Server outdated'.
 * - not_implemented: like ctx too old (E17): [Update ctx] (contexo.updateCtx).
 * - quota_exceeded: [Upgrade] opening details.upgrade_url only when it is http or https.
 * - repo_not_found, page_not_found, sha_not_found, base_unavailable: refresh plus a toast.
 * - not_resolvable: refresh plus a toast naming details.state.
 * - internal: an error toast with [Show Log].
 * - invalid_path and usage: logged as an extension bug, with [Show Log].
 * - distill_required: distillModal (the D4 modal).
 * - extension-side codes (timeout, cancelled, spawn_failed, contract_mismatch): severity 'log'.
 * - unknown codes: by exit category (fallbackCode).
 */
export function errorActions(err: CtxError, ctx: ErrorContext = {}): ErrorPresentation {
  void err; void ctx;
  throw new Error("not implemented");
}

/** Every ErrorCode the table maps, in table order (the runtime half of the exhaustiveness check). */
export const MAPPED_ERROR_CODES: readonly ErrorCode[] = [];

/** True when err is a CtxError whose effective code is busy. */
export function isBusy(err: unknown): boolean {
  void err;
  throw new Error("not implemented");
}

/**
 * Run fn; when it fails with busy, wait `delayMs` (default BUSY_RETRY_MS) and run it
 * exactly once more. Any other failure, and the second attempt's, propagate unchanged.
 */
export async function withBusyRetry<T>(fn: () => Promise<T>, delayMs: number = BUSY_RETRY_MS, sleep: (ms: number) => Promise<void> = defaultSleep): Promise<T> {
  void fn; void delayMs; void sleep;
  throw new Error("not implemented");
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface PresentErrorOptions {
  /** Run by a [Retry] action; without it no Retry button is offered. */
  retry?: () => Promise<void>;
  /** Names the repo in forbidden. */
  repoId?: string;
  /** The repository to refresh when the presentation asks for it and it has not been refreshed. */
  repo?: { refresh(o?: { remote?: boolean }): Promise<void> };
  /** The caller's IRepository.run already refreshed (push, pull, resolve): never refresh again. */
  refreshed?: boolean;
}

/**
 * Log err, then show errorActions(err) without blocking: the notification promise is not
 * awaited, and the chosen action runs when the user picks it. severity 'log' only logs.
 * Actions: command -> vscode.commands.executeCommand(command, ...args); retry -> o.retry();
 * showLog -> s.log.show(); openUrl -> s.prompts.openExternal(Uri.parse(url)).
 */
export function presentError(s: Pick<Services, "prompts" | "log">, err: CtxError, o: PresentErrorOptions = {}): void {
  void s; void err; void o; void vscode; void CtxError;
  throw new Error("not implemented");
}
