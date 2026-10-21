// FakeModel: a scriptable IModel for VS Code host tests (imports vscode at runtime:
// integration only, never from test/unit). Drive a module with
//   await api.hooks.overrideServices({model: fakeModel({repositories: [fakeRepository({root, status: 'mixed'})]})})
// then script it: setState, addRepository/removeRepository (fire open/close), and each
// repository's setStatus/setOperation. Calls are logged in refreshAllCalls,
// initializeCalls and resolveTargetCalls.
import * as vscode from "vscode";
import type { ExtensionState, IModel, IRepository } from "../../src/model/types";
import { relativeUnder, type FakeRepository } from "./fakeRepository";

export interface FakeModelOptions {
  /** Initial state (default 'ready'). */
  state?: ExtensionState;
  /** Initial repositories (no open events fire for them). */
  repositories?: (FakeRepository | IRepository)[];
}

const CASE_INSENSITIVE_FS = process.platform === "win32" || process.platform === "darwin";

function isUri(v: unknown): v is vscode.Uri {
  if (v instanceof vscode.Uri) { return true; }
  const u = v as { scheme?: unknown; path?: unknown; with?: unknown } | null;
  return typeof u === "object" && u !== null && typeof u.scheme === "string" && typeof u.path === "string" && typeof u.with === "function";
}

function samePath(a: vscode.Uri, b: vscode.Uri): boolean {
  const pa = a.path.replace(/\/+$/, "");
  const pb = b.path.replace(/\/+$/, "");
  return CASE_INSENSITIVE_FS ? pa.toLowerCase() === pb.toLowerCase() : pa === pb;
}

export class FakeModel implements IModel {
  /** Every refreshAll call (remote defaults to false). */
  readonly refreshAllCalls: { remote: boolean }[] = [];
  /** Every resolveTarget argument, in order. */
  readonly resolveTargetCalls: unknown[] = [];
  /** How many times initialize() ran (wire() calls it at most once per model). */
  initializeCalls = 0;
  disposed = false;

  private _state: ExtensionState;
  private readonly repos: IRepository[];
  private readonly stateEmitter = new vscode.EventEmitter<ExtensionState>();
  private readonly openEmitter = new vscode.EventEmitter<IRepository>();
  private readonly closeEmitter = new vscode.EventEmitter<IRepository>();
  readonly onDidChangeState: vscode.Event<ExtensionState> = this.stateEmitter.event;
  readonly onDidOpenRepository: vscode.Event<IRepository> = this.openEmitter.event;
  readonly onDidCloseRepository: vscode.Event<IRepository> = this.closeEmitter.event;

  constructor(opts: FakeModelOptions = {}) {
    this._state = opts.state ?? "ready";
    this.repos = [...(opts.repositories ?? [])];
  }

  get state(): ExtensionState { return this._state; }
  /** A snapshot copy, in open order. */
  get repositories(): readonly IRepository[] { return [...this.repos]; }

  /** Change the state; onDidChangeState fires only when it differs. */
  setState(s: ExtensionState): void {
    if (s === this._state) { return; }
    this._state = s;
    this.stateEmitter.fire(s);
  }

  /** Append a repository and fire onDidOpenRepository. */
  addRepository(r: FakeRepository | IRepository): void {
    this.repos.push(r);
    this.openEmitter.fire(r);
  }

  /** Remove a repository (if present) and fire onDidCloseRepository. */
  removeRepository(r: FakeRepository | IRepository): void {
    const i = this.repos.indexOf(r);
    if (i < 0) { return; }
    this.repos.splice(i, 1);
    this.closeEmitter.fire(r);
  }

  /** The repository whose root equals or contains uri (the deepest root wins). */
  getRepository(uri: vscode.Uri): IRepository | undefined {
    let best: IRepository | undefined;
    for (const r of this.repos) {
      if (samePath(r.root, uri) || relativeUnder(r.root, uri) !== undefined) {
        if (!best || r.root.path.length > best.root.path.length) { best = r; }
      }
    }
    return best;
  }

  /**
   * undefined -> the only repository, else the active editor's; a repository -> itself;
   * a Uri, or an object with resourceUri (SourceControlResourceState, tree item) -> its
   * repository plus relPath when under .contexo/; an object with rootUri (SourceControl)
   * -> its repository. Anything else -> undefined.
   */
  resolveTarget(arg: unknown): { repository: IRepository; relPath?: string } | undefined {
    this.resolveTargetCalls.push(arg);
    if (arg === undefined) {
      if (this.repos.length === 1) { return { repository: this.repos[0] as IRepository }; }
      const active = vscode.window.activeTextEditor?.document.uri;
      return active ? this.targetFor(active) : undefined;
    }
    if (this.repos.includes(arg as IRepository)) { return { repository: arg as IRepository }; }
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

  /** Logs the call, then refresh(o) on every repository. */
  async refreshAll(o?: { remote?: boolean }): Promise<void> {
    this.refreshAllCalls.push({ remote: o?.remote === true });
    await Promise.all(this.repos.map((r) => r.refresh(o)));
  }

  initialize(): Promise<void> {
    this.initializeCalls++;
    return Promise.resolve();
  }

  dispose(): void {
    this.disposed = true;
    this.stateEmitter.dispose();
    this.openEmitter.dispose();
    this.closeEmitter.dispose();
  }

  private targetFor(uri: vscode.Uri): { repository: IRepository; relPath?: string } | undefined {
    const repository = this.getRepository(uri);
    if (!repository) { return undefined; }
    const relPath = repository.relPathOf(uri);
    return relPath === undefined ? { repository } : { repository, relPath };
  }
}

export function fakeModel(opts?: FakeModelOptions): FakeModel {
  return new FakeModel(opts);
}
