// Model and Repository interfaces (FROZEN after WP-0.I; additions only).
// Implemented by createModel in src/model/model.ts (WP-1.8).
import type { Disposable, Event, ExtensionContext, LogOutputChannel, Uri } from "vscode";
import type { CtxError, ICtxCli } from "../cli/types";
import type { PageEntry, StatusDoc } from "../contract/types";
import type { ContexoConfig } from "../services";
import type { Prompts } from "../ui/prompts";

/**
 * Drives the `contexo.state` context key and the viewsWelcome entries.
 * 'untrusted' is kept for completeness but is unreachable: with
 * capabilities.untrustedWorkspaces.supported=false VS Code disables the extension in
 * Restricted Mode (E38). No viewsWelcome entry or test may target it.
 */
export type ExtensionState =
  | "loading"
  | "ctxMissing"
  | "ctxTooOld"
  | "extensionTooOld"
  | "untrusted"
  | "noRepositories"
  | "notLoggedIn"
  | "ready";

export type OperationKind = "status" | "statusOffline" | "push" | "pull" | "resolve" | "show";

/** One workspace folder that contains .contexo/config.json. */
export interface IRepository {
  /** The workspace folder (passed to ctx as --root <root.fsPath>). */
  readonly root: Uri;
  /** <root>/.contexo */
  readonly contexoDir: Uri;
  /** The last StatusDoc (after the WP-1.8 stateMerge), or undefined before the first status. */
  readonly status: StatusDoc | undefined;
  /** The last failed ctx call for this repository, cleared by the next success. */
  readonly lastError: CtxError | undefined;
  /** The mutating operation in flight (push, pull or resolve), if any. */
  readonly operation: OperationKind | undefined;
  readonly onDidChangeStatus: Event<{ previous: StatusDoc | undefined; current: StatusDoc }>;
  readonly onDidChangeOperation: Event<OperationKind | undefined>;
  /**
   * Run `ctx status`: offline (`--offline`) unless o.remote is true. Concurrent calls
   * coalesce; never throws (failures land in lastError).
   */
  refresh(o?: { remote?: boolean }): Promise<void>;
  /**
   * Run fn through this repository's operation queue.
   * - push, pull and resolve are serialized (one at a time per repository, FIFO);
   *   `operation` is set while fn runs and onDidChangeOperation fires on entry and exit.
   * - After a push, pull or resolve settles (success or failure) the repository runs
   *   an online refresh (refresh({remote: true})) itself. Callers never refresh after run().
   * - status, statusOffline and show are not queued and do not change `operation`.
   * The promise settles with fn's result or rejection, and for push, pull and resolve only
   * AFTER that follow-up refresh has completed, so a caller that awaits run() reads the
   * post-operation status.
   */
  run<T>(kind: OperationKind, fn: () => Promise<T>): Promise<T>;
  /** The status entry for a working-file Uri under contexoDir (case-insensitive file systems handled here). */
  pageAt(uri: Uri): PageEntry | undefined;
  /** <root>/.contexo/<relPath> as a file Uri. */
  fileUri(relPath: string): Uri;
  /** The '/'-separated path of uri relative to contexoDir, or undefined when uri is outside it. */
  relPathOf(uri: Uri): string | undefined;
}

export interface IModel extends Disposable {
  readonly state: ExtensionState;
  readonly onDidChangeState: Event<ExtensionState>;
  readonly repositories: readonly IRepository[];
  readonly onDidOpenRepository: Event<IRepository>;
  readonly onDidCloseRepository: Event<IRepository>;
  /** The repository whose root folder contains (or equals) uri. */
  getRepository(uri: Uri): IRepository | undefined;
  /**
   * Map a command argument to a repository (and page): undefined (the only
   * repository, else the active editor's), a Uri, a SourceControl (rootUri), a
   * SourceControlResourceState or tree item (resourceUri), or a repository itself.
   * Returns undefined when nothing matches.
   */
  resolveTarget(arg: unknown): { repository: IRepository; relPath?: string } | undefined;
  /** refresh(o) on every repository. */
  refreshAll(o?: { remote?: boolean }): Promise<void>;
  /** Discover repositories and run the handshake. wire() calls it at most once per model instance. */
  initialize(): Promise<void>;
}

export interface ModelDeps {
  context: ExtensionContext;
  log: LogOutputChannel;
  config: ContexoConfig;
  cli: ICtxCli;
  /** Delegates to services.prompts at call time, so TestApi.hooks.setPrompts reaches the model. */
  prompts: Prompts;
}
