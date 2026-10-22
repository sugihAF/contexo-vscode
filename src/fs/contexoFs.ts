// The read-only contexo: file system (WP-1.10): page versions served by `ctx show` through
// the pure ContentCache. It never writes, never parses page YAML and never decodes bytes.
import * as vscode from "vscode";
import { CtxError } from "../cli/types";
import type { PageEntry, StatusDoc } from "../contract/types";
import type { IRepository } from "../model/types";
import type { Services } from "../services";
import { ContentCache, isContractRelPath, refKind } from "./contentCache";
import { CONTEXO_SCHEME, fromContexoUri } from "./contexoUri";

/** ctx codes that mean "this version does not exist" (invalid_path: same as our own path rejection). */
const NOT_FOUND_CODES: ReadonlySet<string> = new Set([
  "base_unavailable", "page_not_found", "sha_not_found", "repo_not_found", "invalid_path",
]);

const CASE_INSENSITIVE_FS = process.platform === "darwin" || process.platform === "win32";

function samePath(a: string, b: string): boolean {
  return a === b || (CASE_INSENSITIVE_FS && a.toLowerCase() === b.toLowerCase());
}

/** A contexo: URI that passed every check: a known repository's canonical root, a contract path, a valid ref. */
interface Target { repo: IRepository; root: string; relPath: string; ref: string; }

/**
 * contexo:<working file path>?{ref, root, path}. readFile is the only method that rejects;
 * everything that writes throws NoPermissions. onDidChangeFile reports exactly the URIs the
 * cache served whose version a status change moved.
 */
export class ContexoFileSystemProvider implements vscode.FileSystemProvider, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile: vscode.Event<vscode.FileChangeEvent[]> = this.emitter.event;
  private readonly cache: ContentCache<vscode.Uri>;
  private readonly tracked = new Map<IRepository, vscode.Disposable>();
  private readonly subscriptions: vscode.Disposable[] = [];

  constructor(private readonly s: Services) {
    // s.cli and s.model are read at call time (Services rule).
    this.cache = new ContentCache<vscode.Uri>({
      fetch: (root, relPath, ref) => this.s.cli.show(root, relPath, ref),
      page: (root, relPath) => this.pageOf(root, relPath),
      uriKey: (uri) => uri.toString(),
    });
    for (const repo of s.model.repositories) { this.track(repo); }
    this.subscriptions.push(
      s.model.onDidOpenRepository((repo) => this.track(repo)),
      s.model.onDidCloseRepository((repo) => this.untrack(repo)),
    );
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const t = this.target(uri);
    if (!t) { throw vscode.FileSystemError.FileNotFound(uri); }
    if (t.ref === "empty") { return new Uint8Array(0); }
    try {
      return await this.cache.read(t.root, t.relPath, t.ref, uri);
    } catch (err) {
      throw this.mapError(uri, t.ref, err);
    }
  }

  /** Never throws. mtime moves whenever a cached version this URI was served is evicted. */
  stat(uri: vscode.Uri): vscode.FileStat {
    let size = 0;
    try {
      const t = this.target(uri);
      if (t && t.ref !== "empty") { size = this.cache.sizeOf(t.root, t.relPath, t.ref); }
    } catch {
      size = 0;
    }
    return { type: vscode.FileType.File, ctime: 0, mtime: this.cache.version(uri), size };
  }

  readDirectory(_uri: vscode.Uri): [string, vscode.FileType][] {
    return [];
  }

  watch(_uri: vscode.Uri, _o: { readonly recursive: boolean; readonly excludes: readonly string[] }): vscode.Disposable {
    return new vscode.Disposable(() => undefined);
  }

  createDirectory(uri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions(uri);
  }

  writeFile(uri: vscode.Uri, _content: Uint8Array, _o: { readonly create: boolean; readonly overwrite: boolean }): void {
    throw vscode.FileSystemError.NoPermissions(uri);
  }

  delete(uri: vscode.Uri, _o: { readonly recursive: boolean }): void {
    throw vscode.FileSystemError.NoPermissions(uri);
  }

  rename(oldUri: vscode.Uri, _newUri: vscode.Uri, _o: { readonly overwrite: boolean }): void {
    throw vscode.FileSystemError.NoPermissions(oldUri);
  }

  dispose(): void {
    for (const d of this.subscriptions.splice(0)) { d.dispose(); }
    for (const d of this.tracked.values()) { d.dispose(); }
    this.tracked.clear();
    this.emitter.dispose();
  }

  /**
   * The checked target of uri, or undefined (-> FileNotFound, no ctx call): a parseable
   * query, a valid ref, a contract path, and a root that IS a known repository's root
   * (getRepository also matches sub-folders, so a crafted root must equal it).
   */
  private target(uri: vscode.Uri): Target | undefined {
    let q: ReturnType<typeof fromContexoUri>;
    try {
      q = fromContexoUri(uri);
    } catch {
      return undefined;
    }
    if (q.ref !== "empty" && refKind(q.ref) === undefined) { return undefined; }
    if (!isContractRelPath(q.relPath)) { return undefined; }
    const repo = this.repositoryAt(q.root);
    return repo ? { repo, root: repo.root.fsPath, relPath: q.relPath, ref: q.ref } : undefined;
  }

  /** The repository whose root equals root (exactly, or ignoring case on darwin/win32). */
  private repositoryAt(root: string): IRepository | undefined {
    if (root === "") { return undefined; }
    let repo: IRepository | undefined;
    try {
      repo = this.s.model.getRepository(vscode.Uri.file(root));
    } catch {
      return undefined;
    }
    return repo && samePath(repo.root.fsPath, root) ? repo : undefined;
  }

  /** The current status entry of relPath under the repository at root (canonical root). */
  private pageOf(root: string, relPath: string): PageEntry | undefined {
    const repo = this.repositoryAt(root);
    if (!repo) { return undefined; }
    return repo.status?.pages.find((p) => p.path === relPath) ?? repo.pageAt(repo.fileUri(relPath));
  }

  private track(repo: IRepository): void {
    if (this.tracked.has(repo)) { return; }
    this.tracked.set(repo, repo.onDidChangeStatus((e) => this.statusChanged(repo, e.current)));
  }

  private untrack(repo: IRepository): void {
    this.tracked.get(repo)?.dispose();
    this.tracked.delete(repo);
    this.cache.dropRoot(repo.root.fsPath);
  }

  private statusChanged(repo: IRepository, current: StatusDoc): void {
    const lookup = (relPath: string): PageEntry | undefined =>
      current.pages.find((p) => p.path === relPath) ?? repo.pageAt(repo.fileUri(relPath));
    const uris = this.cache.invalidate(repo.root.fsPath, lookup);
    if (uris.length > 0) {
      this.emitter.fire(uris.map((uri) => ({ type: vscode.FileChangeType.Changed, uri })));
    }
  }

  /** Not-found ctx codes -> FileNotFound; everything else is logged and becomes Unavailable. Never cached. */
  private mapError(uri: vscode.Uri, ref: string, err: unknown): Error {
    if (err instanceof CtxError && NOT_FOUND_CODES.has(err.code)) {
      return vscode.FileSystemError.FileNotFound(uri);
    }
    const code = err instanceof CtxError ? err.code : "error";
    const message = err instanceof Error ? err.message : String(err);
    this.s.log.warn(`contexo: fs readFile ${uri.toString()} (ref ${ref}) failed: ${code}: ${message}`);
    return vscode.FileSystemError.Unavailable(`ctx show failed (${code}): ${message}`);
  }
}

/** Registers the contexo: provider (read-only, case-sensitive); the Disposable unregisters and disposes it. */
export function registerContexoFs(s: Services): vscode.Disposable {
  const provider = new ContexoFileSystemProvider(s);
  try {
    const registration = vscode.workspace.registerFileSystemProvider(CONTEXO_SCHEME, provider, { isReadonly: true, isCaseSensitive: true });
    return vscode.Disposable.from(registration, provider);
  } catch (err) {
    provider.dispose();
    throw err;
  }
}
