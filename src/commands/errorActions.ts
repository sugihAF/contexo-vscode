// Maps every ctx failure (CtxError) to a message and the actions the user can take
// (WP-1.13). errorActions() is pure; presentError() shows it. Reusable by any module
// that calls ctx (WP-2.3). No action ever passes or offers --no-distill (D4).
import * as vscode from "vscode";
import { CtxError, type ExtensionErrorCode } from "../cli/types";
import { ERROR_CODES, fallbackCode, type ErrorCode } from "../contract/types";
import type { Services } from "../services";
import { COMMAND_IDS } from "./ids";

/** busy (exit 12): retry the same operation once after this many ms, then offer [Retry]. */
export const BUSY_RETRY_MS = 1_000;

/** Command run by [Show Conflicts] and [Show Changes]. */
export const SHOW_SCM_COMMAND = "workbench.view.scm";

/** The busy (exit 12) message. */
export const BUSY_MESSAGE = "Another ctx operation (possibly your agent) is syncing";

/** Button labels of the error actions. */
export const ACTION_LABELS = {
  logIn: "Log in",
  init: "Initialize Contexo",
  retry: "Retry",
  showLog: "Show Log",
  showConflicts: "Show Conflicts",
  updateCtx: "Update ctx",
  upgrade: "Upgrade",
} as const;

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

// ---------- the table ----------

// Fresh objects per presentation, so a caller that edits its actions cannot corrupt the table.
const logIn = (): ErrorAction => ({ label: ACTION_LABELS.logIn, kind: "command", command: COMMAND_IDS.login });
const retry = (): ErrorAction => ({ label: ACTION_LABELS.retry, kind: "retry" });
const showLog = (): ErrorAction => ({ label: ACTION_LABELS.showLog, kind: "showLog" });

/** err.details as a record ({} when absent or not an object). */
function detailsOf(err: CtxError): Record<string, unknown> {
  return typeof err.details === "object" && err.details !== null ? (err.details as Record<string, unknown>) : {};
}

/** ctx's own message, never empty. */
function ctxMessage(err: CtxError): string {
  return err.message.trim() || `ctx exited ${err.exitCode}`;
}

/** v as a URL string when it parses with protocol http: or https:, else undefined (javascript:, data:, file:, ...). */
function httpUrl(v: unknown): string | undefined {
  if (typeof v !== "string") { return undefined; }
  try {
    const url = new URL(v);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

type Entry = (err: CtxError, ctx: ErrorContext) => Omit<ErrorPresentation, "code">;

/** A refresh plus a toast (the not-found family). */
const refreshToast = (message: string): Omit<ErrorPresentation, "code"> =>
  ({ message, actions: [], severity: "warning", refresh: true });

/** One entry per ErrorCode; the compiler enforces exhaustiveness through `satisfies`. */
const TABLE = {
  internal: (err) => ({
    message: `ctx failed: ${ctxMessage(err)}`, actions: [showLog()], severity: "error", refresh: false,
  }),
  usage: (err) => ({
    message: `Contexo extension bug: ctx rejected the command (${ctxMessage(err)}). Please report it with the log.`,
    actions: [showLog()], severity: "error", refresh: false,
  }),
  invalid_path: (err) => ({
    message: `Contexo extension bug: ctx rejected a page path (${ctxMessage(err)}). Please report it with the log.`,
    actions: [showLog()], severity: "error", refresh: false,
  }),
  not_authenticated: () => ({
    message: "You are not logged in to Contexo.", actions: [logIn()], severity: "warning", refresh: false,
  }),
  auth_rejected: () => ({
    message: "Your Contexo login was rejected or has expired. Log in again.", actions: [logIn()], severity: "warning", refresh: false,
  }),
  forbidden: (_err, ctx) => ({
    message: ctx.repoId
      ? `You do not have access to the Contexo repository ${ctx.repoId}. Ask its owner for access.`
      : "You do not have access to this Contexo repository. Ask its owner for access.",
    actions: [], severity: "error", refresh: false,
  }),
  not_initialized: () => ({
    message: "This folder is not a Contexo project yet.",
    actions: [{ label: ACTION_LABELS.init, kind: "command", command: COMMAND_IDS.init }], severity: "warning", refresh: false,
  }),
  repo_not_configured: () => ({
    message: "No Contexo repository is configured for this project. Run 'ctx remote set-repo <id>' in a terminal.",
    actions: [], severity: "warning", refresh: false,
  }),
  server_unresolved: () => ({
    message: "No Contexo server is known for this project. Log in to choose one.", actions: [logIn()], severity: "warning", refresh: false,
  }),
  conflict: () => ({
    message: "Some pages also changed on the server. Resolve the conflicts, then push again.",
    actions: [{ label: ACTION_LABELS.showConflicts, kind: "command", command: SHOW_SCM_COMMAND }], severity: "warning", refresh: false,
  }),
  stale: () => ({
    message: "The server version changed since you looked. Review the new diff, then try again.",
    actions: [], severity: "info", refresh: true,
  }),
  network: (err) => ({
    message: `Could not reach the Contexo server: ${ctxMessage(err)}`, actions: [retry(), showLog()], severity: "error", refresh: false,
  }),
  server_error: (err) => ({
    message: `The Contexo server failed: ${ctxMessage(err)}`, actions: [retry(), showLog()], severity: "error", refresh: false,
  }),
  rate_limited: (err) => ({
    message: `The Contexo server is rate limiting requests; wait a moment, then retry: ${ctxMessage(err)}`,
    actions: [retry(), showLog()], severity: "warning", refresh: false,
  }),
  repo_not_found: () => refreshToast("The Contexo repository was not found on the server."),
  page_not_found: () => refreshToast("That page was not found on the server; refreshing the status."),
  base_unavailable: () => refreshToast("The last synced version of that page is not available; refreshing the status."),
  sha_not_found: () => refreshToast("That page version was not found on the server; refreshing the status."),
  // D4: never ctx's own message or advice here, which may mention --no-distill.
  distill_required: () => ({
    message: "Agent sessions have not been distilled yet. Share these pages through your agent so the decision record is kept.",
    actions: [], severity: "warning", refresh: false, distillModal: true,
  }),
  not_resolvable: (err) => {
    const state = detailsOf(err).state;
    return {
      message: typeof state === "string" && state !== ""
        ? `This page cannot be resolved while it is ${state}; refreshing the status.`
        : "This page cannot be resolved in its current state; refreshing the status.",
      actions: [], severity: "info", refresh: true,
    };
  },
  server_unsupported: (err) => {
    const missing = detailsOf(err).missing;
    const names = Array.isArray(missing) ? missing.filter((m): m is string => typeof m === "string") : [];
    return {
      message: `Server outdated: the Contexo server does not support this operation yet${names.length > 0 ? ` (missing ${names.join(", ")})` : ""}.`,
      actions: [], severity: "warning", refresh: false,
    };
  },
  not_implemented: () => ({
    message: "Your ctx is too old for this operation. Update ctx.",
    actions: [{ label: ACTION_LABELS.updateCtx, kind: "command", command: COMMAND_IDS.updateCtx }], severity: "warning", refresh: false,
  }),
  quota_exceeded: (err) => {
    const url = httpUrl(detailsOf(err).upgrade_url);
    return {
      message: `Contexo quota exceeded: ${ctxMessage(err)}`,
      actions: url === undefined ? [] : [{ label: ACTION_LABELS.upgrade, kind: "openUrl", url }],
      severity: "warning", refresh: false,
    };
  },
  busy: () => ({
    message: BUSY_MESSAGE, actions: [retry()], severity: "warning", refresh: false, autoRetryMs: BUSY_RETRY_MS,
  }),
} satisfies Record<ErrorCode, Entry>;

/** The ErrorCodes the table maps (keyof the table; equal to ErrorCode, see errorActions.test.ts). */
export type MappedErrorCode = keyof typeof TABLE;

const EXTENSION_CODES = {
  timeout: true, cancelled: true, spawn_failed: true, contract_mismatch: true,
} satisfies Record<ExtensionErrorCode, true>;

/** The extension-side CtxError codes (a quiet log line each). */
export const EXTENSION_ERROR_CODES: readonly ExtensionErrorCode[] = Object.keys(EXTENSION_CODES) as ExtensionErrorCode[];

function isExtensionCode(code: string): code is ExtensionErrorCode {
  return Object.hasOwn(EXTENSION_CODES, code);
}

/**
 * The code a CtxError is handled by: an ExtensionErrorCode as is, a known ErrorCode as
 * is, and an unknown (future) ctx code by its exit category through fallbackCode.
 */
export function effectiveCode(err: CtxError): ErrorCode | ExtensionErrorCode {
  const code: string = err.code;
  if (isExtensionCode(code)) { return code; }
  if ((ERROR_CODES as readonly string[]).includes(code)) { return code as ErrorCode; }
  return fallbackCode(err.exitCode);
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
  const code = effectiveCode(err);
  if (isExtensionCode(code)) {
    return { code, message: `${ctxMessage(err)} (${code})`, actions: [], severity: "log", refresh: false };
  }
  const entry: Entry = TABLE[code];
  return { code, ...entry(err, ctx) };
}

/** Every ErrorCode the table maps, in table order (the runtime half of the exhaustiveness check). */
export const MAPPED_ERROR_CODES: readonly ErrorCode[] = Object.keys(TABLE) as ErrorCode[];

/** True when err is a CtxError whose effective code is busy. */
export function isBusy(err: unknown): boolean {
  return err instanceof CtxError && effectiveCode(err) === "busy";
}

/**
 * Run fn; when it fails with busy, wait `delayMs` (default BUSY_RETRY_MS) and run it
 * exactly once more. Any other failure, and the second attempt's, propagate unchanged.
 */
export async function withBusyRetry<T>(fn: () => Promise<T>, delayMs: number = BUSY_RETRY_MS, sleep: (ms: number) => Promise<void> = defaultSleep): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!isBusy(err)) { throw err; }
  }
  await sleep(delayMs);
  return fn();
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

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** The notification for a presentation; a prompt that throws becomes a rejection. */
async function notify(s: Pick<Services, "prompts">, p: ErrorPresentation, labels: string[]): Promise<string | undefined> {
  switch (p.severity) {
    case "error": return s.prompts.error(p.message, ...labels);
    case "warning": return s.prompts.warn(p.message, ...labels);
    case "info": return s.prompts.info(p.message, ...labels);
    case "log": return undefined;
  }
}

async function runAction(s: Pick<Services, "prompts" | "log">, a: ErrorAction, o: PresentErrorOptions): Promise<void> {
  switch (a.kind) {
    case "command":
      if (a.command !== undefined) { await vscode.commands.executeCommand(a.command, ...(a.args ?? [])); }
      return;
    case "retry":
      await o.retry?.();
      return;
    case "showLog":
      s.log.show();
      return;
    case "openUrl": {
      const url = httpUrl(a.url);
      if (url !== undefined) { await s.prompts.openExternal(vscode.Uri.parse(url)); }
      return;
    }
  }
}

/**
 * Log err, then show errorActions(err) without blocking: the notification promise is not
 * awaited, and the chosen action runs when the user picks it. severity 'log' only logs.
 * Actions: command -> vscode.commands.executeCommand(command, ...args); retry -> o.retry();
 * showLog -> s.log.show(); openUrl -> s.prompts.openExternal(Uri.parse(url)).
 * A refresh({remote: true}) of o.repo runs when the presentation asks for one and the
 * caller has not refreshed (o.refreshed). Nothing here throws: failures are logged.
 */
export function presentError(s: Pick<Services, "prompts" | "log">, err: CtxError, o: PresentErrorOptions = {}): void {
  const p = errorActions(err, o.repoId === undefined ? {} : { repoId: o.repoId });
  const line = `ctx failed (${p.code}, exit ${err.exitCode}): ${err.message}`;
  if (p.severity === "log") {
    if (p.code === "cancelled") { s.log.info(line); } else { s.log.warn(line); }
  } else {
    s.log.error(line);
  }

  const repo = o.repo;
  if (p.refresh && !o.refreshed && repo) {
    // An async wrapper, so even a refresh that throws synchronously is only logged.
    void (async () => {
      try {
        await repo.refresh({ remote: true });
      } catch (e) {
        s.log.error(`Contexo: refresh after ${p.code} failed: ${messageOf(e)}`);
      }
    })();
  }
  if (p.severity === "log") { return; }

  const actions = p.actions.filter((a) => a.kind !== "retry" || o.retry !== undefined);
  void notify(s, p, actions.map((a) => a.label))
    .then(async (choice) => {
      const action = actions.find((a) => a.label === choice);
      if (action === undefined) { return; }
      try {
        await runAction(s, action, o);
      } catch (e) {
        s.log.error(`Contexo: '${action.label}' failed: ${messageOf(e)}`);
      }
    })
    .catch((e: unknown) => { s.log.error(`Contexo: could not show the ${p.code} notification: ${messageOf(e)}`); });
}
