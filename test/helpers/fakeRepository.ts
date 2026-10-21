// FakeRepository: a scriptable IRepository for VS Code host tests (imports vscode at
// runtime: integration only, never from test/unit). Feed it to fakeModel() and drive a
// module through TestApi.hooks.overrideServices({model}).
//
// It mirrors the IRepository contract (src/model/types.ts):
// - run(kind, fn): push/pull/resolve are serialized FIFO; `operation` is set (and
//   onDidChangeOperation fires) while fn runs; after fn settles, success or failure, the
//   repository itself runs refresh({remote: true}). status/statusOffline/show pass through
//   unqueued and leave `operation` alone. The promise settles with fn's result or rejection
//   (after that refresh).
// - refresh(o) only logs (remote defaults to false) and runs the optional onRefresh hook;
//   it never throws: a CtxError from the hook lands in lastError.
import * as vscode from "vscode";
import { CtxError } from "../../src/cli/types";
import type { PageEntry, StatusDoc } from "../../src/contract/types";
import type { IRepository, OperationKind } from "../../src/model/types";
import { loadStatusDoc } from "./fixtures";

export interface FakeRepositoryOptions {
  /** The workspace folder (a Uri, or an fsPath). */
  root: vscode.Uri | string;
  /** Initial status: a StatusDoc, or a baseline scenario name (its online StatusDoc). */
  status?: StatusDoc | string;
}

export type StatusChange = { previous: StatusDoc | undefined; current: StatusDoc };

const MUTATING: ReadonlySet<OperationKind> = new Set<OperationKind>(["push", "pull", "resolve"]);
const CASE_INSENSITIVE_FS = process.platform === "win32" || process.platform === "darwin";

/** The '/'-separated path of `uri` below `dir` (both by Uri.path), or undefined when outside or equal. */
export function relativeUnder(dir: vscode.Uri, uri: vscode.Uri): string | undefined {
  const base = `${dir.path.replace(/\/+$/, "")}/`;
  const p = uri.path;
  const inside = CASE_INSENSITIVE_FS ? p.toLowerCase().startsWith(base.toLowerCase()) : p.startsWith(base);
  if (!inside) { return undefined; }
  const rel = p.slice(base.length);
  return rel === "" ? undefined : rel;
}

export class FakeRepository implements IRepository, vscode.Disposable {
  readonly root: vscode.Uri;
  readonly contexoDir: vscode.Uri;
  /** Every refresh, in order; run() appends {remote: true} after each push/pull/resolve. */
  readonly refreshCalls: { remote: boolean }[] = [];
  /** The kind of every run() call, in call order (including pass-through kinds). */
  readonly runCalls: OperationKind[] = [];
  lastError: CtxError | undefined;
  /** Optional: what refresh() does after logging (e.g. setStatus to simulate the next ctx status). */
  onRefresh: ((o: { remote: boolean }) => void | Promise<void>) | undefined;

  private _status: StatusDoc | undefined;
  private _operation: OperationKind | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly statusEmitter = new vscode.EventEmitter<StatusChange>();
  private readonly operationEmitter = new vscode.EventEmitter<OperationKind | undefined>();
  readonly onDidChangeStatus: vscode.Event<StatusChange> = this.statusEmitter.event;
  readonly onDidChangeOperation: vscode.Event<OperationKind | undefined> = this.operationEmitter.event;

  constructor(opts: FakeRepositoryOptions) {
    this.root = typeof opts.root === "string" ? vscode.Uri.file(opts.root) : opts.root;
    this.contexoDir = vscode.Uri.joinPath(this.root, ".contexo");
    if (opts.status !== undefined) {
      this._status = typeof opts.status === "string" ? loadStatusDoc(opts.status) : opts.status;
    }
  }

  get status(): StatusDoc | undefined { return this._status; }
  get operation(): OperationKind | undefined { return this._operation; }

  /** Replace the status and fire onDidChangeStatus({previous, current}). A string is a baseline scenario name. */
  setStatus(doc: StatusDoc | string, o: { offline?: boolean } = {}): void {
    const previous = this._status;
    const current = typeof doc === "string" ? loadStatusDoc(doc, o) : doc;
    this._status = current;
    this.statusEmitter.fire({ previous, current });
  }

  /** Set `operation` and fire onDidChangeOperation(kind). */
  setOperation(kind: OperationKind | undefined): void {
    this._operation = kind;
    this.operationEmitter.fire(kind);
  }

  async refresh(o?: { remote?: boolean }): Promise<void> {
    const call = { remote: o?.remote === true };
    this.refreshCalls.push(call);
    try {
      await this.onRefresh?.(call);
    } catch (err) {
      if (err instanceof CtxError) { this.lastError = err; return; }
      throw err;
    }
  }

  run<T>(kind: OperationKind, fn: () => Promise<T>): Promise<T> {
    this.runCalls.push(kind);
    if (!MUTATING.has(kind)) { return Promise.resolve().then(fn); }
    const result = this.queue.then(async () => {
      this.setOperation(kind);
      try {
        return await fn();
      } finally {
        this.setOperation(undefined);
        await this.refresh({ remote: true });
      }
    });
    this.queue = result.catch(() => undefined);
    return result;
  }

  pageAt(uri: vscode.Uri): PageEntry | undefined {
    const rel = this.relPathOf(uri);
    if (rel === undefined || !this._status) { return undefined; }
    const pages = this._status.pages;
    return pages.find((p) => p.path === rel)
      ?? (CASE_INSENSITIVE_FS ? pages.find((p) => p.path.toLowerCase() === rel.toLowerCase()) : undefined);
  }

  fileUri(relPath: string): vscode.Uri {
    return vscode.Uri.joinPath(this.contexoDir, ...relPath.split("/"));
  }

  /** file: and contexo: URIs (a contexo: URI keeps the working file's path). */
  relPathOf(uri: vscode.Uri): string | undefined {
    if (uri.scheme !== "file" && uri.scheme !== "contexo") { return undefined; }
    return relativeUnder(this.contexoDir, uri);
  }

  dispose(): void {
    this.statusEmitter.dispose();
    this.operationEmitter.dispose();
  }
}

export function fakeRepository(opts: FakeRepositoryOptions): FakeRepository {
  return new FakeRepository(opts);
}
