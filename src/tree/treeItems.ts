// TreeItems for the Knowledge tree nodes (WP-1.11). Items are plain vscode.TreeItem objects
// (no TreeItem/MarkdownString constructor), so unit tests load this module against the
// test:unit vscode stub. A page's tooltip is built on hover (resolveTreeItem) by pageTooltip.
import * as vscode from "vscode";
import type { GroupNode, PageNode, PendingNode, RepoNode, TreeNode } from "./treeModel";

export function pageItem(node: PageNode, fileUri: (relPath: string) => vscode.Uri): vscode.TreeItem {
  const uri = fileUri(node.path);
  return {
    id: node.id,
    label: node.label,
    ...(node.description !== undefined ? { description: node.description } : {}),
    // WP-1.10's FileDecorationProvider badges unverified/conflict/modified pages through it.
    resourceUri: uri,
    command: { command: "vscode.open", title: "Open", arguments: [uri] },
    contextValue: node.contextValue,
    iconPath: new vscode.ThemeIcon(node.icon),
    collapsibleState: vscode.TreeItemCollapsibleState.None,
  };
}

export function pendingItem(node: PendingNode): vscode.TreeItem {
  return {
    id: node.id,
    label: node.label,
    tooltip: node.tooltip,
    // No arguments: the shareViaAgent handler then copies its default prompt.
    command: { command: node.command.command, title: node.command.title },
    contextValue: node.contextValue,
    iconPath: new vscode.ThemeIcon(node.icon),
    collapsibleState: vscode.TreeItemCollapsibleState.None,
  };
}

export function groupItem(node: GroupNode): vscode.TreeItem {
  return {
    id: node.id,
    label: node.label,
    contextValue: "group",
    collapsibleState: vscode.TreeItemCollapsibleState.Expanded,
  };
}

export function repoItem(node: RepoNode): vscode.TreeItem {
  return {
    id: node.id,
    label: node.label,
    contextValue: node.contextValue,
    iconPath: new vscode.ThemeIcon("repo"),
    collapsibleState: vscode.TreeItemCollapsibleState.Expanded,
  };
}

export function treeItemFor(node: TreeNode, fileUri: (relPath: string) => vscode.Uri): vscode.TreeItem {
  switch (node.kind) {
    case "page": return pageItem(node, fileUri);
    case "pending": return pendingItem(node);
    case "group": return groupItem(node);
    case "repo": return repoItem(node);
  }
}

/**
 * The page tooltip. Titles, tags and summaries are teammate-authored, so the MarkdownString
 * is untrusted (isTrusted false, supportHtml false, no theme icons, no command links) and
 * every value goes through appendText, which escapes Markdown. Only the field names, our
 * own constants, are Markdown.
 */
export function pageTooltip(node: PageNode): vscode.MarkdownString {
  const md = new vscode.MarkdownString("", false);
  md.isTrusted = false;
  md.supportHtml = false;
  node.tooltip.forEach((f, i) => {
    if (i > 0) { md.appendMarkdown("  \n"); }
    md.appendMarkdown(`**${f.name}:** `);
    md.appendText(f.value);
  });
  return md;
}
