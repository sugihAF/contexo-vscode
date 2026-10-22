// Model (WP-1.8): all extension state. It discovers trusted file-scheme workspace folders
// whose root holds .contexo/config.json, keeps one Repository per root, runs the ctx
// handshake before any status call, and derives ExtensionState from the handshake, the
// repositories and auth. VS Code is reached only through ModelHost, so unit tests inject
// trust, folders, the file system, watchers, focus and the clock.
import * as vscode from "vscode";
import type { BinaryState } from "../cli/types";
import type { StatusDoc } from "../contract/types";
import { pathKey, uriContains } from "./paths";
import { systemClock, type FileEventSource } from "./refreshScheduler";
import { Repository, type ModelLog, type RepositoryHost } from "./repository";
import type { ExtensionState, IModel, IRepository, ModelDeps } from "./types";

/** Watched in folders without a repository: its creation opens one (ctx init). */
export const CONFIG_GLOB = ".contexo/config.json";

export interface WorkspaceFolderLike {
  readonly uri: vscode.Uri;
  readonly name: string;
  readonly index: number;
}

export interface FoldersChange {
  readonly added: readonly WorkspaceFolderLike[];
  readonly removed: readonly WorkspaceFolderLike[];
}

/** Everything the model needs from VS Code. createVscodeHost() is the real one. */
export interface ModelHost extends RepositoryHost {
  isTrusted(): boolean;
  readonly onDidGrantWorkspaceTrust: vscode.Event<void>;
  workspaceFolders(): readonly WorkspaceFolderLike[];
  readonly onDidChangeWorkspaceFolders: vscode.Event<FoldersChange>;
  /** True when uri is an existing file (workspace.fs.stat). */
  isFile(uri: vscode.Uri): Promise<boolean>;
  activeEditorUri(): vscode.Uri | undefined;
  dispose(): void;
}

export function createModel(d: ModelDeps): IModel {
  return createModelWithHost(d, createVscodeHost());
}

/** createModel over an explicit host (unit tests). The model disposes the host. */
export function createModelWithHost(d: ModelDeps, host: ModelHost): IModel {
  return new Model(d, host);
}

/** The VS Code implementation of ModelHost. */
export function createVscodeHost(): ModelHost {
  const focus = new vscode.EventEmitter<boolean>();
  const windowState = vscode.window.onDidChangeWindowState((s) => focus.fire(s.focused));
  return {
    clock: systemClock,
    platform: process.platform,
    focus: {
      get focused() { return vscode.window.state.focused; },
      onDidChange: focus.event,
    },
    createWatcher: (folder, glob, o) =>
      vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, glob), false, o?.ignoreChangeEvents === true, false),
    isTrusted: () => vscode.workspace.isTrusted,
    onDidGrantWorkspaceTrust: vscode.workspace.onDidGrantWorkspaceTrust,
    workspaceFolders: () => vscode.workspace.workspaceFolders ?? [],
    onDidChangeWorkspaceFolders: vscode.workspace.onDidChangeWorkspaceFolders,
    isFile: async (uri) => {
      try {
        return ((await vscode.workspace.fs.stat(uri)).type & vscode.FileType.File) !== 0;
      } catch {
        return false;
      }
    },
    activeEditorUri: () => vscode.window.activeTextEditor?.document.uri,
    dispose: () => {
      windowState.dispose();
      focus.dispose();
    },
  };
}

function needsLogin(s: StatusDoc | undefined): boolean {
  if (!s) { return false; }
  return s.auth.state === "not_authenticated" || s.auth.state === "rejected" || s.remote.error?.code === "server_unresolved";
}

function isUri(v: unknown): v is vscode.Uri {
  if (v instanceof vscode.Uri) { return true; }
  const u = v as { scheme?: unknown; path?: unknown; with?: unknown } | null;
  return typeof u === "object" && u !== null && typeof u.scheme === "string" && typeof u.path === "string" && typeof u.with === "function";
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.stack ?? err.message : String(err);
}

class Model implements IModel {
  private _state: ExtensionState = "loading";
  private binary: BinaryState | undefined;
  private initCalled = false;
  private started = false;
  private discovered = false;
  private disposed = false;
  /** Open repositories, in open order (workspace-folder order at discovery). */
  private readonly repos: Repository[] = [];
  /** Folders without a repository, watched for .contexo/config.json (key: folderKey). */
  private readonly plain = new Map<string, FileEventSource>();
  private readonly subs: vscode.Disposable[] = [];
  private readonly log: ModelLog;

  private readonly stateEmitter = new vscode.EventEmitter<ExtensionState>();
  private readonly openEmitter = new vscode.EventEmitter<IRepository>();
  private readonly closeEmitter = new vscode.EventEmitter<IRepository>();
  readonly onDidChangeState: vscode.Event<ExtensionState> = this.stateEmitter.event;
  readonly onDidOpenRepository: vscode.Event<IRepository> = this.openEmitter.event;
  readonly onDidCloseRepository: vscode.Event<IRepository> = this.closeEmitter.event;

  constructor(private readonly d: ModelDeps, private readonly host: ModelHost) {
    this.log = d.log;
  }

  get state(): ExtensionState { return this._state; }
  get repositories(): readonly IRepository[] { return [...this.repos]; }

  /**
   * Untrusted (defense in depth, E38): no cli call at all; trust being granted starts it.
   * Trusted: subscribes, awaits the handshake (getBinary), then discovers the roots; every
   * repository opened with an ok binary runs its first, online, refresh.
   */
  async initialize(): Promise<void> {
    if (this.initCalled || this.disposed) { return; }
    this.initCalled = true;
    if (this.host.isTrusted()) {
      await this.start();
      return;
    }
    this.subs.push(this.host.onDidGrantWorkspaceTrust(() => {
      this.start().catch((err: unknown) => this.log.error(`model start failed: ${describeError(err)}`));
    }));
  }

  async refreshAll(o?: { remote?: boolean }): Promise<void> {
    if (this.disposed || !this.started) { return; }
    if (this.binary?.kind !== "ok") {
      // An explicit Refresh with a missing/too-old ctx re-runs discovery + handshake.
      let b: BinaryState;
      try {
        b = await this.d.cli.rediscover();
      } catch (err) {
        this.log.error(`ctx discovery failed: ${describeError(err)}`);
        b = { kind: "missing" };
      }
      if (this.disposed) { return; }
      this.binary = b;
      this.updateState();
      if (b.kind !== "ok") { return; }
    }
    const existing = [...this.repos];
    await this.syncFolders(); // re-discovers roots (ctx init); new ones refresh online on open
    await Promise.all(existing.filter((r) => !r.isDisposed).map((r) => r.refresh(o)));
  }

  getRepository(uri: vscode.Uri): IRepository | undefined {
    let best: Repository | undefined;
    for (const r of this.repos) {
      if (uriContains(r.root, uri, this.host.platform) && (!best || r.root.path.length > best.root.path.length)) { best = r; }
    }
    return best;
  }

  resolveTarget(arg: unknown): { repository: IRepository; relPath?: string } | undefined {
    if (arg === undefined) {
      if (this.repos.length === 1) { return { repository: this.repos[0] as Repository }; }
      const active = this.host.activeEditorUri();
      return active ? this.targetFor(active) : undefined;
    }
    if (arg instanceof Repository && this.repos.includes(arg)) { return { repository: arg }; }
    if (isUri(arg)) { return this.targetFor(arg); }
    if (typeof arg === "object" && arg !== null) {
      const o = arg as { resourceUri?: unknown; rootUri?: unknown };
      if (isUri(o.resourceUri)) { return this.targetFor(o.resourceUri); }
      if (isUri(o.rootUri)) {
        const repository = this.getRepository(o.rootUri);
        return repository ? { repository } : undefined;
      }
    }
    return undefined;
  }

  dispose(): void {
    if (this.disposed) { return; }
    this.disposed = true;
    for (const s of this.subs.splice(0)) { s.dispose(); }
    for (const w of this.plain.values()) { w.dispose(); }
    this.plain.clear();
    for (const r of this.repos.splice(0)) { r.dispose(); }
    this.host.dispose();
    this.stateEmitter.dispose();
    this.openEmitter.dispose();
    this.closeEmitter.dispose();
  }

  // ---------- lifecycle ----------

  private async start(): Promise<void> {
    if (this.started || this.disposed) { return; }
    this.started = true;
    this.subs.push(this.d.cli.onDidChangeBinary((b) => this.onBinaryChanged(b)));
    this.subs.push(this.host.onDidChangeWorkspaceFolders((e) => {
      this.onFoldersChanged(e).catch((err: unknown) => this.log.error(`workspace folder change failed: ${describeError(err)}`));
    }));
    let binary: BinaryState;
    try {
      binary = await this.d.cli.getBinary();
    } catch (err) {
      this.log.error(`ctx handshake failed: ${describeError(err)}`);
      binary = { kind: "missing" };
    }
    if (this.disposed) { return; }
    this.binary ??= binary; // an onDidChangeBinary that arrived meanwhile is newer
    this.updateState();
    await this.syncFolders();
    if (this.disposed) { return; }
    this.discovered = true;
    this.updateState();
  }

  private onBinaryChanged(b: BinaryState): void {
    if (this.disposed || !this.started) { return; }
    this.binary = b;
    this.updateState();
    if (b.kind === "ok") {
      void Promise.all(this.repos.map((r) => r.refresh({ remote: true })));
    }
  }

  /** The trust + handshake gate every ctx status goes through. */
  private canRunCtx(): boolean {
    return !this.disposed && this.started && this.host.isTrusted() && this.binary?.kind === "ok";
  }

  // ---------- roots ----------

  private folderKey(uri: vscode.Uri): string {
    return `${uri.scheme}://${uri.authority}${pathKey(uri.path.replace(/\/+$/, ""), this.host.platform)}`;
  }

  private repoFor(folder: vscode.Uri): Repository | undefined {
    const key = this.folderKey(folder);
    return this.repos.find((r) => this.folderKey(r.root) === key);
  }

  private inWorkspace(folder: vscode.Uri): boolean {
    const key = this.folderKey(folder);
    return this.host.workspaceFolders().some((f) => this.folderKey(f.uri) === key);
  }

  private configUri(folder: vscode.Uri): vscode.Uri {
    return vscode.Uri.joinPath(folder, ".contexo", "config.json");
  }

  /** Open every file-scheme folder root that has .contexo/config.json (in folder order); watch the rest. */
  private async syncFolders(): Promise<void> {
    const folders = this.host.workspaceFolders().filter((f) => f.uri.scheme === "file");
    const found = await Promise.all(folders.map((f) => this.repoFor(f.uri) ? Promise.resolve(true) : this.host.isFile(this.configUri(f.uri))));
    folders.forEach((f, i) => this.place(f.uri, found[i] === true));
  }

  /** Stat one folder's config.json and open or watch it (watcher events, added folders). */
  private async checkFolder(folder: vscode.Uri): Promise<void> {
    if (this.disposed || this.repoFor(folder)) { return; }
    const exists = await this.host.isFile(this.configUri(folder));
    this.place(folder, exists);
  }

  private place(folder: vscode.Uri, hasConfig: boolean): void {
    if (this.disposed || this.repoFor(folder) || !this.inWorkspace(folder)) { return; }
    if (hasConfig) {
      this.open(folder);
    } else {
      this.watchPlain(folder);
    }
  }

  private open(folder: vscode.Uri): void {
    this.unwatchPlain(folder);
    const repo = new Repository({
      root: folder,
      cli: this.d.cli,
      log: this.log,
      config: this.d.config,
      host: this.host,
      canRunCtx: () => this.canRunCtx(),
      onNotInitialized: (r) => this.close(r, { watch: true }),
      onDidSettle: () => this.updateState(),
    });
    this.repos.push(repo);
    this.log.info(`Contexo repository opened: ${folder.fsPath}`);
    this.openEmitter.fire(repo);
    repo.start();
    if (this.canRunCtx()) { void repo.refresh({ remote: true }); }
    this.updateState();
  }

  private close(repo: Repository, o: { watch: boolean }): void {
    const i = this.repos.indexOf(repo);
    if (i < 0) { return; }
    this.repos.splice(i, 1);
    repo.dispose();
    this.log.info(`Contexo repository closed: ${repo.root.fsPath}`);
    if (!this.disposed) { this.closeEmitter.fire(repo); }
    if (o.watch && !this.disposed && this.inWorkspace(repo.root)) { this.watchPlain(repo.root); }
    this.updateState();
  }

  private watchPlain(folder: vscode.Uri): void {
    const key = this.folderKey(folder);
    if (this.plain.has(key)) { return; }
    const w = this.host.createWatcher(folder, CONFIG_GLOB);
    const check = (): void => {
      this.checkFolder(folder).catch((err: unknown) => this.log.error(`config check failed: ${describeError(err)}`));
    };
    w.onDidCreate(check);
    w.onDidChange(check);
    this.plain.set(key, w);
  }

  private unwatchPlain(folder: vscode.Uri): void {
    const key = this.folderKey(folder);
    this.plain.get(key)?.dispose();
    this.plain.delete(key);
  }

  private async onFoldersChanged(e: FoldersChange): Promise<void> {
    if (this.disposed) { return; }
    for (const f of e.removed) {
      this.unwatchPlain(f.uri);
      const repo = this.repoFor(f.uri);
      if (repo) { this.close(repo, { watch: false }); }
    }
    await Promise.all(e.added.filter((f) => f.uri.scheme === "file").map((f) => this.checkFolder(f.uri)));
    this.updateState();
  }

  private targetFor(uri: vscode.Uri): { repository: IRepository; relPath?: string } | undefined {
    const repository = this.getRepository(uri);
    if (!repository) { return undefined; }
    const relPath = repository.pageAt(uri)?.path ?? repository.relPathOf(uri);
    return relPath === undefined ? { repository } : { repository, relPath };
  }

  // ---------- state ----------

  private computeState(): ExtensionState {
    const b = this.binary;
    if (!b) { return "loading"; } // also while untrusted: 'untrusted' is unreachable (E38)
    switch (b.kind) {
      case "ok": break;
      case "missing": return "ctxMissing";
      case "tooOld": return "ctxTooOld";
      case "extensionTooOld": return "extensionTooOld";
      default: return "ctxMissing";
    }
    if (!this.discovered) { return "loading"; }
    if (this.repos.length === 0) { return "noRepositories"; }
    if (!this.repos.some((r) => r.status !== undefined || r.lastError !== undefined)) { return "loading"; }
    if (this.repos.some((r) => r.lastError?.code === "not_implemented")) { return "ctxTooOld"; }
    if (this.repos.some((r) => needsLogin(r.status))) { return "notLoggedIn"; }
    return "ready";
  }

  private updateState(): void {
    if (this.disposed) { return; }
    const next = this.computeState();
    if (next === this._state) { return; }
    this._state = next;
    this.log.debug(`Contexo state: ${next}`);
    this.stateEmitter.fire(next);
  }
}
