// The Contexo FileDecorationProvider (WP-1.10): badges pages under <root>/.contexo/ by sync
// state through their file: URIs, so one provider serves the Explorer, the Source Control
// view and the Knowledge tree. What each state looks like lives in decorationModel.ts.
import * as vscode from "vscode";
import type { RelPath, StatusDoc } from "../contract/types";
import type { IRepository } from "../model/types";
import type { Services } from "../services";
import { testHooks, type DecorationSnapshot } from "../testApi";
import { decorationForState, decorationsOf, diff, isExcludedRelPath, type PageDecoration } from "./decorationModel";

interface TrackedRepository {
  readonly subscription: vscode.Disposable;
  /** The last status this provider saw (what a close has to clear). */
  last: StatusDoc | undefined;
}

/**
 * Reads s.model and s.config at call time. Subscribes to the model's repository events at
 * construction: a model swap disposes this provider and wire() builds a new one.
 * onDidChangeFileDecorations always fires a non-empty array of file URIs, never undefined.
 */
export class ContexoDecorationProvider implements vscode.FileDecorationProvider, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<vscode.Uri[]>();
  readonly onDidChangeFileDecorations: vscode.Event<vscode.Uri[]> = this.emitter.event;

  private readonly s: Services;
  private readonly tracked = new Map<IRepository, TrackedRepository>();
  private readonly subscriptions: vscode.Disposable[] = [];
  /** contexo.decorations.enabled as last seen, to fire only on an actual toggle. */
  private enabled: boolean;
  private disposed = false;

  constructor(s: Services) {
    this.s = s;
    this.enabled = s.config.decorationsEnabled;
    try {
      this.subscriptions.push(
        s.config.onDidChange(() => this.onConfigChanged()),
        s.model.onDidOpenRepository((repo) => this.onOpen(repo)),
        s.model.onDidCloseRepository((repo) => this.onClose(repo)),
      );
      for (const repo of s.model.repositories) { this.track(repo); }
    } catch (err) {
      this.dispose();
      throw err;
    }
  }

  /** The decoration of a page's working file, or undefined (also what testHooks.decorationFor reports). */
  decorationAt(uri: vscode.Uri): PageDecoration | undefined {
    if (!this.s.config.decorationsEnabled || uri.scheme !== "file") { return undefined; }
    const repo = this.s.model.getRepository(uri);
    if (!repo) { return undefined; }
    const rel = repo.relPathOf(uri);
    if (rel === undefined || isExcludedRelPath(rel)) { return undefined; }
    const page = repo.pageAt(uri);
    return page ? decorationForState(page.state) : undefined;
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    const d = this.decorationAt(uri);
    if (!d) { return undefined; }
    const fd = new vscode.FileDecoration(d.badge, d.tooltip, d.color === undefined ? undefined : new vscode.ThemeColor(d.color));
    fd.propagate = d.propagate;
    return fd;
  }

  /** decorationAt(uri) as a DecorationSnapshot (color omitted when there is none). */
  snapshotFor(uri: vscode.Uri): DecorationSnapshot | undefined {
    const d = this.decorationAt(uri);
    if (!d) { return undefined; }
    const snapshot: DecorationSnapshot = { badge: d.badge, tooltip: d.tooltip, propagate: d.propagate };
    if (d.color !== undefined) { snapshot.color = d.color; }
    return snapshot;
  }

  dispose(): void {
    if (this.disposed) { return; }
    this.disposed = true;
    for (const d of this.subscriptions.splice(0)) { d.dispose(); }
    for (const t of this.tracked.values()) { t.subscription.dispose(); }
    this.tracked.clear();
    this.emitter.dispose();
  }

  private track(repo: IRepository): void {
    this.tracked.get(repo)?.subscription.dispose();
    const t: TrackedRepository = {
      last: repo.status,
      subscription: repo.onDidChangeStatus(({ previous, current }) => {
        t.last = current;
        if (this.s.config.decorationsEnabled) { this.fire(this.urisOf(repo, diff(previous, current))); }
      }),
    };
    this.tracked.set(repo, t);
  }

  private onOpen(repo: IRepository): void {
    this.track(repo);
    if (this.s.config.decorationsEnabled) { this.fire(this.decoratedUris(repo, repo.status)); }
  }

  private onClose(repo: IRepository): void {
    const t = this.tracked.get(repo);
    const last = t ? t.last : repo.status;
    t?.subscription.dispose();
    this.tracked.delete(repo);
    if (this.s.config.decorationsEnabled) { this.fire(this.decoratedUris(repo, last)); }
  }

  /** contexo.* changed: only an actual decorations.enabled toggle refreshes every known page. */
  private onConfigChanged(): void {
    const now = this.s.config.decorationsEnabled;
    if (now === this.enabled) { return; }
    this.enabled = now;
    const uris: vscode.Uri[] = [];
    for (const repo of this.tracked.keys()) { uris.push(...this.decoratedUris(repo, repo.status)); }
    this.fire(uris);
  }

  private decoratedUris(repo: IRepository, status: StatusDoc | undefined): vscode.Uri[] {
    return this.urisOf(repo, [...decorationsOf(status).keys()]);
  }

  /** Excluded paths never carry a decoration, so they never need a refresh. */
  private urisOf(repo: IRepository, relPaths: readonly RelPath[]): vscode.Uri[] {
    return relPaths.filter((p) => !isExcludedRelPath(p)).map((p) => repo.fileUri(p));
  }

  private fire(uris: vscode.Uri[]): void {
    if (uris.length > 0 && !this.disposed) { this.emitter.fire(uris); }
  }
}

/** Registers the provider and testHooks.decorationFor; disposing removes both. */
export function registerDecorations(s: Services): vscode.Disposable {
  const provider = new ContexoDecorationProvider(s);
  let registration: vscode.Disposable;
  try {
    registration = vscode.window.registerFileDecorationProvider(provider);
  } catch (err) {
    provider.dispose();
    throw err;
  }
  const hook = (uri: vscode.Uri): DecorationSnapshot | undefined => provider.snapshotFor(uri);
  testHooks.decorationFor = hook;
  return new vscode.Disposable(() => {
    if (testHooks.decorationFor === hook) { delete testHooks.decorationFor; }
    registration.dispose();
    provider.dispose();
  });
}
