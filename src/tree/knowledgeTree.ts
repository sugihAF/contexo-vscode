// The 'Contexo › Knowledge' TreeView (contexo.knowledge, WP-1.11). It renders StatusDoc data
// from the model only (D1): pages grouped by frontmatter type, broken files under 'Invalid'
// (E30), the pending agent-session item, a badge and a not-logged-in message.
//
// One TreeView and one provider live as long as the extension context. Every wire() binds a
// new KnowledgeTreeBinding to them: TestApi.hooks.overrideServices re-runs wire(), and
// disposing a TreeView is asynchronous in VS Code (it unregisters the view id after a
// microtask), so re-creating it under the same id in the same tick would orphan the new one.
import * as vscode from "vscode";
import type { IRepository } from "../model/types";
import type { Services } from "../services";
import { testHooks, type TreeNodeSnapshot, type TreeSnapshot } from "../testApi";
import { pageTooltip, treeItemFor } from "./treeItems";
import {
  buildRepo,
  layoutRoots,
  rendersPages,
  treeBadge,
  treeMessage,
  treeSignature,
  type RepoNode,
  type TreeNode,
} from "./treeModel";

export const KNOWLEDGE_VIEW_ID = "contexo.knowledge";

/** The TreeView properties a binding writes. */
export type TreeViewSink = Pick<vscode.TreeView<TreeNode>, "badge" | "message">;

/** The view's data provider; it delegates to the current binding (none: an empty tree). */
export class KnowledgeTreeProvider implements vscode.TreeDataProvider<TreeNode>, vscode.Disposable {
  private readonly changes = new vscode.EventEmitter<TreeNode | undefined>();
  readonly onDidChangeTreeData: vscode.Event<TreeNode | undefined> = this.changes.event;
  binding: KnowledgeTreeBinding | undefined;

  getTreeItem(node: TreeNode): vscode.TreeItem {
    return treeItemFor(node, (rel) => this.binding?.fileUri(node.root, rel)
      ?? vscode.Uri.joinPath(vscode.Uri.file(node.root), ".contexo", ...rel.split("/")));
  }

  getChildren(node?: TreeNode): TreeNode[] {
    return this.binding?.children(node) ?? [];
  }

  getParent(node: TreeNode): TreeNode | undefined {
    return this.binding?.parent(node);
  }

  /** Builds a page's untrusted Markdown tooltip on hover only. */
  resolveTreeItem(item: vscode.TreeItem, node: TreeNode, _token: vscode.CancellationToken): vscode.TreeItem {
    if (node.kind === "page" && item.tooltip === undefined) { item.tooltip = pageTooltip(node); }
    return item;
  }

  fire(node: TreeNode | undefined): void {
    this.changes.fire(node);
  }

  dispose(): void {
    this.changes.dispose();
  }
}

interface RepoEntry {
  readonly repo: IRepository;
  readonly root: string;
  readonly sub: vscode.Disposable;
  signature: string;
  /** Stable element: rebuilds replace its contents, so a refresh can target it. */
  readonly node: RepoNode;
}

/** One wire()'s view of s.model: a per-repository signature cache over the pure model. */
export class KnowledgeTreeBinding implements vscode.Disposable {
  private readonly entries = new Map<IRepository, RepoEntry>();
  private readonly byRoot = new Map<string, RepoEntry>();
  private readonly subs: vscode.Disposable[] = [];
  private showSessions: boolean;
  private rendering: boolean;
  private disposed = false;

  constructor(
    private readonly s: Services,
    private readonly provider: KnowledgeTreeProvider,
    private readonly view: TreeViewSink,
  ) {
    this.showSessions = s.config.treeShowSessions;
    this.rendering = rendersPages(s.model.state);
    // Subscriptions bind to the model of this wire(); handlers read s.model at call time.
    this.subs.push(
      s.model.onDidOpenRepository((r) => {
        if (this.add(r)) { this.layoutChanged("repository opened"); }
      }),
      s.model.onDidCloseRepository((r) => {
        if (this.remove(r)) { this.layoutChanged("repository closed"); }
      }),
      s.model.onDidChangeState(() => this.onState()),
      s.config.onDidChange(() => this.onConfig()),
    );
    for (const r of s.model.repositories) { this.add(r); }
    provider.binding = this;
    this.updateView();
    this.fire(undefined, "bound");
  }

  children(node?: TreeNode): TreeNode[] {
    if (!this.rendering) { return []; }
    if (node === undefined) { return layoutRoots([...this.entries.values()].map((e) => e.node)); }
    switch (node.kind) {
      case "repo": return [...node.children];
      case "group": return [...node.pages];
      default: return [];
    }
  }

  parent(node: TreeNode): TreeNode | undefined {
    const entry = this.byRoot.get(node.root);
    if (!entry || node.kind === "repo") { return undefined; }
    if (node.kind === "page") { return entry.node.children.find((c) => c.id === node.groupId); }
    return this.entries.size > 1 ? entry.node : undefined;
  }

  fileUri(root: string, relPath: string): vscode.Uri | undefined {
    return this.byRoot.get(root)?.repo.fileUri(relPath);
  }

  /** testHooks.treeSnapshot: the nodes as the provider serves them, plus badge and message. */
  snapshot(): TreeSnapshot {
    const badge = this.view.badge;
    const message = this.view.message;
    return {
      ...(message !== undefined ? { message } : {}),
      ...(badge ? { badge: { value: badge.value, tooltip: badge.tooltip } } : {}),
      roots: this.children(undefined).map((n) => this.snap(n)),
    };
  }

  dispose(): void {
    if (this.disposed) { return; }
    this.disposed = true;
    vscode.Disposable.from(...this.subs, ...[...this.entries.values()].map((e) => e.sub)).dispose();
    this.subs.length = 0;
    this.entries.clear();
    this.byRoot.clear();
    if (this.provider.binding === this) {
      this.provider.binding = undefined;
      this.view.badge = undefined;
      this.view.message = undefined;
      this.provider.fire(undefined);
    }
  }

  private snap(node: TreeNode): TreeNodeSnapshot {
    const item = this.provider.getTreeItem(node);
    const label = typeof item.label === "string" ? item.label : item.label?.label ?? "";
    return {
      label,
      ...(item.id !== undefined ? { id: item.id } : {}),
      ...(typeof item.description === "string" ? { description: item.description } : {}),
      ...(item.contextValue !== undefined ? { contextValue: item.contextValue } : {}),
      ...(item.resourceUri ? { resourceUri: item.resourceUri.toString() } : {}),
      children: this.children(node).map((c) => this.snap(c)),
    };
  }

  private add(r: IRepository): boolean {
    if (this.entries.has(r)) { return false; }
    const root = r.root.fsPath;
    const entry: RepoEntry = {
      repo: r,
      root,
      sub: r.onDidChangeStatus(() => this.onStatus(r)),
      signature: treeSignature(r.status),
      node: this.build(r, root),
    };
    this.entries.set(r, entry);
    this.byRoot.set(root, entry);
    return true;
  }

  private remove(r: IRepository): boolean {
    const entry = this.entries.get(r);
    if (!entry) { return false; }
    entry.sub.dispose();
    this.entries.delete(r);
    if (this.byRoot.get(entry.root) === entry) { this.byRoot.delete(entry.root); }
    return true;
  }

  private build(r: IRepository, root: string): RepoNode {
    const name = vscode.workspace.getWorkspaceFolder(r.root)?.name
      ?? r.root.path.split("/").filter((p) => p !== "").pop()
      ?? root;
    return buildRepo({ root, name, status: r.status }, { showSessions: this.showSessions });
  }

  private rebuild(entry: RepoEntry): void {
    entry.signature = treeSignature(entry.repo.status);
    Object.assign(entry.node, this.build(entry.repo, entry.root));
  }

  private onStatus(r: IRepository): void {
    const entry = this.entries.get(r);
    if (!entry || this.disposed) { return; }
    this.updateView();
    if (treeSignature(r.status) === entry.signature) { return; }
    this.rebuild(entry);
    if (this.rendering) {
      this.fire(this.entries.size > 1 ? entry.node : undefined, `status of ${entry.root}`);
    }
  }

  private onState(): void {
    const rendering = rendersPages(this.s.model.state);
    const flipped = rendering !== this.rendering;
    this.rendering = rendering;
    this.updateView();
    if (flipped) { this.fire(undefined, `state ${this.s.model.state}`); }
  }

  private onConfig(): void {
    const showSessions = this.s.config.treeShowSessions;
    if (showSessions === this.showSessions) { return; }
    this.showSessions = showSessions;
    for (const entry of this.entries.values()) { this.rebuild(entry); }
    if (this.rendering) { this.fire(undefined, "tree.showSessions"); }
  }

  private layoutChanged(why: string): void {
    this.updateView();
    if (this.rendering) { this.fire(undefined, why); }
  }

  private updateView(): void {
    const badge = this.rendering ? treeBadge([...this.entries.values()].map((e) => e.repo.status)) : undefined;
    const current = this.view.badge;
    if (current?.value !== badge?.value || current?.tooltip !== badge?.tooltip) { this.view.badge = badge; }
    const message = treeMessage(this.s.model.state);
    if (this.view.message !== message) { this.view.message = message; }
  }

  private fire(node: TreeNode | undefined, why: string): void {
    if (this.disposed) { return; }
    this.s.log.trace(`knowledge tree: onDidChangeTreeData (${why})`);
    this.provider.fire(node);
  }
}

const views = new WeakMap<vscode.ExtensionContext, { view: vscode.TreeView<TreeNode>; provider: KnowledgeTreeProvider }>();

export function registerKnowledgeTree(s: Services): vscode.Disposable {
  let held = views.get(s.context);
  if (!held) {
    const provider = new KnowledgeTreeProvider();
    const view = vscode.window.createTreeView(KNOWLEDGE_VIEW_ID, { treeDataProvider: provider, showCollapseAll: true });
    held = { view, provider };
    views.set(s.context, held);
    s.context.subscriptions.push(view, provider);
  }
  const binding = new KnowledgeTreeBinding(s, held.provider, held.view);
  const treeSnapshot = (): TreeSnapshot => binding.snapshot();
  testHooks.treeSnapshot = treeSnapshot;
  return new vscode.Disposable(() => {
    if (testHooks.treeSnapshot === treeSnapshot) { delete testHooks.treeSnapshot; }
    binding.dispose();
  });
}
