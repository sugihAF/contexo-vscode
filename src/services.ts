// The one mutable service container every module receives (FROZEN after WP-0.I;
// additions only). Configuration lives here too: there is no src/config.ts or src/log.ts.
import * as vscode from "vscode";
import type { ICtxCli } from "./cli/types";
import type { IModel } from "./model/types";
import type { Prompts } from "./ui/prompts";

/**
 * ONE mutable object, created in extension.ts. TestApi.hooks.overrideServices replaces
 * `cli` and/or `model` in place and re-runs wire(); setPrompts replaces `prompts` in
 * place without re-wiring.
 *
 * RULE for every module: read s.cli, s.model and s.prompts at call time (inside event
 * handlers and command bodies). Never destructure them, or copy them into a closure or
 * field, at registration: the override and setPrompts would not reach that copy.
 * context, log and config never change.
 */
export interface Services {
  readonly context: vscode.ExtensionContext;
  readonly log: vscode.LogOutputChannel;
  readonly config: ContexoConfig;
  cli: ICtxCli;
  model: IModel;
  prompts: Prompts;
}

/** Live view of the contexo.* settings; every getter reads the current value. */
export interface ContexoConfig {
  /** contexo.path (machine scope), trimmed; undefined when empty. Discovery (WP-1.7) ignores non-absolute values. */
  readonly path: string | undefined;
  /** contexo.remoteRefresh.enabled (default true). */
  readonly remoteRefreshEnabled: boolean;
  /** contexo.remoteRefresh.intervalSeconds (default 180), clamped to [60, 86400] (clampRefreshInterval). */
  readonly remoteRefreshIntervalSeconds: number;
  /** contexo.scm.countIncoming (default false, E29). */
  readonly scmCountIncoming: boolean;
  /** contexo.decorations.enabled (default true). */
  readonly decorationsEnabled: boolean;
  /** contexo.tree.showSessions (default true). */
  readonly treeShowSessions: boolean;
  /** Fires after any contexo.* setting changes. */
  readonly onDidChange: vscode.Event<void>;
}

export const MIN_REMOTE_REFRESH_SECONDS = 60;
export const DEFAULT_REMOTE_REFRESH_SECONDS = 180;
/** One day: keeps seconds × 1000 far below setTimeout's 2^31-1 ms limit (larger values fire after 1 ms). */
export const MAX_REMOTE_REFRESH_SECONDS = 86_400;

/** contexo.remoteRefresh.intervalSeconds as used: default for a missing or non-numeric value, clamped to [60, 86400]. */
export function clampRefreshInterval(value: unknown): number {
  if (typeof value !== "number" || Number.isNaN(value)) { return DEFAULT_REMOTE_REFRESH_SECONDS; }
  return Math.min(MAX_REMOTE_REFRESH_SECONDS, Math.max(MIN_REMOTE_REFRESH_SECONDS, value));
}

/** ContexoConfig over vscode.workspace.getConfiguration('contexo'). */
export function createConfig(): ContexoConfig & vscode.Disposable {
  const emitter = new vscode.EventEmitter<void>();
  const sub = vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration("contexo")) { emitter.fire(); }
  });
  const get = <T>(key: string, fallback: T): T => vscode.workspace.getConfiguration("contexo").get<T>(key, fallback);
  return {
    get path() {
      const v = get<unknown>("path", "");
      return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
    },
    get remoteRefreshEnabled() { return get<boolean>("remoteRefresh.enabled", true) !== false; },
    get remoteRefreshIntervalSeconds() { return clampRefreshInterval(get<unknown>("remoteRefresh.intervalSeconds", DEFAULT_REMOTE_REFRESH_SECONDS)); },
    get scmCountIncoming() { return get<boolean>("scm.countIncoming", false) === true; },
    get decorationsEnabled() { return get<boolean>("decorations.enabled", true) !== false; },
    get treeShowSessions() { return get<boolean>("tree.showSessions", true) !== false; },
    onDidChange: emitter.event,
    dispose() { sub.dispose(); emitter.dispose(); },
  };
}
