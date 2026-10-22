// Repository (WP-1.8): one per workspace folder whose root holds .contexo/config.json. It
// keeps the latest StatusDoc (after stateMerge), serializes push/pull/resolve through its
// OperationQueue and refreshes on its RefreshScheduler's triggers. Runtime vscode use is
// limited to EventEmitter and Uri (both in the unit-test stub); watchers, focus and the clock
// come from the injected host.
import * as vscode from "vscode";
import { CtxError, type ICtxCli } from "../cli/types";
import type { PageEntry, StatusDoc } from "../contract/types";
import type { ContexoConfig } from "../services";
import { OperationQueue } from "./operationQueue";
import { fileUriOf, pathKey, relPathOfUri } from "./paths";
import { RefreshScheduler, WATCH_GLOBS, type Clock, type FileEventSource, type FocusSource } from "./refreshScheduler";
import { mergeOffline } from "./stateMerge";
import type { IRepository, OperationKind } from "./types";

/** The LogOutputChannel methods the model uses. */
export type ModelLog = Pick<vscode.LogOutputChannel, "trace" | "debug" | "info" | "warn" | "error">;

/** What a repository needs from VS Code (vscode adapters in model.ts; fakes in unit tests). */
export interface RepositoryHost {
  readonly clock: Clock;
  readonly focus: FocusSource;
  readonly platform: NodeJS.Platform;
  /** workspace.createFileSystemWatcher(new RelativePattern(folder, glob), …). */
  createWatcher(folder: vscode.Uri, glob: string, o?: { ignoreChangeEvents?: boolean }): FileEventSource;
}

export interface RepositoryDeps {
  /** The workspace folder (ctx --root <root.fsPath>). */
  root: vscode.Uri;
  cli: ICtxCli;
  log: ModelLog;
  config: Pick<ContexoConfig, "remoteRefreshEnabled" | "remoteRefreshIntervalSeconds" | "onDidChange">;
  host: RepositoryHost;
  /** The model's gate (trusted, handshake ok): when false no ctx status runs at all. */
  canRunCtx(): boolean;
  /** ctx status said not_initialized: the model closes this repository. */
  onNotInitialized(repo: Repository): void;
  /** After every status attempt (a result or an error), before onDidChangeStatus fires. */
  onDidSettle(repo: Repository): void;
}

/**
 * onDidChangeStatus fires only when this signature changes. It covers the fields WP-1.8's
 * plan lists (per page: path, state, conflict_kind, base.sha, base.hash, base.stale,
 * remote.sha, invalid.message; counts; auth.state; captures pending/fresh/blocks_push;
 * remote source and error.code) plus what the sibling views render (WP-1.8 ruling): per page
 * invalid.stage, type, slug, title, tags, author, agent, updated, reasoning_summary and
 * notes; auth user name/email; server.url; project repo_id and dashboard URLs. It never
 * includes generated_at or fetched_at, so an identical refresh fires nothing.
 */
export function statusSignature(doc: StatusDoc): string {
  const c = doc.counts;
  return JSON.stringify([
    doc.pages.map((p) => [
      p.path, p.state, p.conflict_kind ?? null,
      p.base?.sha ?? null, p.base?.hash ?? null, p.base?.stale ?? null,
      p.remote?.sha ?? null,
      p.invalid?.stage ?? null, p.invalid?.message ?? null,
      p.type ?? null, p.slug ?? null, p.title ?? null, p.tags,
      p.author ?? null, p.agent ?? null, p.updated ?? null, p.reasoning_summary ?? null,
      p.notes,
    ]),
    [c.unchanged, c.modified, c.new, c.incoming, c.incoming_new, c.conflict, c.deleted_local, c.invalid, c.unverified, c.ahead, c.behind],
    [doc.auth.state, doc.auth.user_name ?? null, doc.auth.user_email ?? null],
    [doc.captures.pending, doc.captures.fresh, doc.captures.blocks_push],
    [doc.remote.source, doc.remote.error?.code ?? null],
    [doc.server.url ?? null, doc.project.repo_id ?? null, doc.project.dashboard_url, doc.project.dashboard_page_url_template ?? null],
  ]);
}

function toCtxError(err: unknown): CtxError {
  if (err instanceof CtxError) { return err; }
  return CtxError.extension("spawn_failed", err instanceof Error ? err.message : String(err));
}

type StatusChange = { previous: StatusDoc | undefined; current: StatusDoc };

export class Repository implements IRepository, vscode.Disposable {
  readonly root: vscode.Uri;
  readonly contexoDir: vscode.Uri;

  private _status: StatusDoc | undefined;
  private _signature: string | undefined;
  private _lastError: CtxError | undefined;
  /** The last merged result of an ONLINE refresh: stateMerge's overlay source. */
  private onlineBase: StatusDoc | undefined;
  private disposed = false;
  private index: { doc: StatusDoc; exact: Map<string, PageEntry>; folded: Map<string, PageEntry> } | undefined;

  private readonly statusEmitter = new vscode.EventEmitter<StatusChange>();
  private readonly operationEmitter = new vscode.EventEmitter<OperationKind | undefined>();
  readonly onDidChangeStatus: vscode.Event<StatusChange> = this.statusEmitter.event;
  readonly onDidChangeOperation: vscode.Event<OperationKind | undefined> = this.operationEmitter.event;

  private readonly queue: OperationQueue;
  private readonly scheduler: RefreshScheduler;
  private readonly watchers: FileEventSource[];

  constructor(private readonly deps: RepositoryDeps) {
    this.root = deps.root;
    this.contexoDir = vscode.Uri.joinPath(deps.root, ".contexo");
    this.queue = new OperationQueue({
      runStatus: (remote) => this.runStatus(remote),
      onDidChangeOperation: (kind) => { if (!this.disposed) { this.operationEmitter.fire(kind); } },
    });
    const { host } = deps;
    const watchers = {
      md: host.createWatcher(deps.root, WATCH_GLOBS.md),
      json: host.createWatcher(deps.root, WATCH_GLOBS.json),
      pending: host.createWatcher(deps.root, WATCH_GLOBS.pending, { ignoreChangeEvents: true }),
    };
    this.watchers = [watchers.md, watchers.json, watchers.pending];
    this.scheduler = new RefreshScheduler({
      clock: host.clock,
      focus: host.focus,
      config: deps.config,
      watchers,
      relPathOf: (uri) => this.relPathOf(uri),
      refresh: (o) => this.refresh(o),
      authState: () => this._status?.auth.state,
      platform: host.platform,
    });
  }

  get status(): StatusDoc | undefined { return this._status; }
  get lastError(): CtxError | undefined { return this._lastError; }
  get operation(): OperationKind | undefined { return this.queue.operation; }
  get isDisposed(): boolean { return this.disposed; }

  /** Start the watchers' and the poll's policy (the model runs the first online refresh). */
  start(): void {
    if (!this.disposed) { this.scheduler.start(); }
  }

  refresh(o?: { remote?: boolean }): Promise<void> {
    return this.queue.refresh(o?.remote === true);
  }

  run<T>(kind: OperationKind, fn: () => Promise<T>): Promise<T> {
    return this.queue.run(kind, fn);
  }

  pageAt(uri: vscode.Uri): PageEntry | undefined {
    const rel = this.relPathOf(uri);
    const doc = this._status;
    if (rel === undefined || !doc) { return undefined; }
    if (this.index?.doc !== doc) {
      const exact = new Map<string, PageEntry>();
      const folded = new Map<string, PageEntry>();
      for (const p of doc.pages) {
        exact.set(p.path, p);
        const key = pathKey(p.path, this.deps.host.platform);
        if (!folded.has(key)) { folded.set(key, p); }
      }
      this.index = { doc, exact, folded };
    }
    return this.index.exact.get(rel) ?? this.index.folded.get(pathKey(rel, this.deps.host.platform));
  }

  fileUri(relPath: string): vscode.Uri {
    return fileUriOf(this.contexoDir, relPath);
  }

  relPathOf(uri: vscode.Uri): string | undefined {
    return relPathOfUri(this.contexoDir, uri, this.deps.host.platform);
  }

  dispose(): void {
    if (this.disposed) { return; }
    this.disposed = true;
    this.scheduler.dispose();
    for (const w of this.watchers) { w.dispose(); }
    this.queue.dispose();
    this.statusEmitter.dispose();
    this.operationEmitter.dispose();
  }

  /** ONE ctx status (the queue coalesces and serializes calls). Never rejects. */
  private async runStatus(remote: boolean): Promise<void> {
    if (this.disposed || !this.deps.canRunCtx()) { return; }
    let doc: StatusDoc;
    try {
      doc = await this.deps.cli.status(this.root.fsPath, { offline: !remote });
    } catch (err) {
      if (this.disposed) { return; }
      const e = toCtxError(err);
      this._lastError = e;
      this.deps.log.warn(`ctx status${remote ? "" : " --offline"} failed for ${this.root.fsPath}: ${e.code}: ${e.message}`);
      if (remote) { this.scheduler.noteOnline(undefined); }
      if (e.code === "not_initialized") {
        this.deps.onNotInitialized(this);
        return;
      }
      this.deps.onDidSettle(this);
      return;
    }
    if (this.disposed) { return; }
    // A result without a live listing (--offline, or an online call whose remote was
    // unusable, E22) gets the overlay of the last online result (stateMerge, E8).
    const next = doc.remote.source === "live" ? doc : mergeOffline(this.onlineBase, doc);
    if (remote) { this.onlineBase = next; }
    const previous = this._status;
    const signature = statusSignature(next);
    const changed = signature !== this._signature;
    this._status = next;
    this._signature = signature;
    this._lastError = undefined;
    if (remote) { this.scheduler.noteOnline(doc); }
    this.deps.onDidSettle(this);
    if (changed && !this.disposed) { this.statusEmitter.fire({ previous, current: next }); }
  }
}
