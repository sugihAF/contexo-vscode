// UriSpec / ClickSpec / ResourceDescriptor -> vscode objects (WP-1.9). Type-only vscode
// import: every contexo: URI is built with toContexoUri (never by hand), so it matches
// the URIs WP-1.10's FileSystemProvider serves and invalidates.
import type { Command, SourceControlResourceState, Uri } from "vscode";
import { toContexoUri } from "../fs/contexoUri";
import type { IRepository } from "../model/types";
import type { ClickSpec, ResourceDescriptor, UriSpec } from "./resourceModel";

/** The repository members the converters need. */
export type ScmRepository = Pick<IRepository, "root" | "fileUri">;

/** A resource state that remembers its page path (VS Code passes this object back to commands). */
export interface ContexoResourceState extends SourceControlResourceState {
  readonly relPath: string;
}

/**
 * file -> repo.fileUri(relPath);
 * contexo -> toContexoUri(repo.fileUri(relPath), ref, repo.root.fsPath, relPath).
 */
export function specToUri(repo: ScmRepository, spec: UriSpec): Uri {
  const file = repo.fileUri(spec.relPath);
  return spec.kind === "file" ? file : toContexoUri(file, spec.ref, repo.root.fsPath, spec.relPath);
}

/**
 * diff -> {command: 'vscode.diff', title: 'Open Changes', arguments: [left, right, label]};
 * open -> {command: 'vscode.open', title: click.title, arguments: [target]}.
 */
export function commandFor(repo: ScmRepository, click: ClickSpec): Command {
  if (click.kind === "diff") {
    return {
      command: "vscode.diff",
      title: "Open Changes",
      arguments: [specToUri(repo, click.left), specToUri(repo, click.right), click.label],
    };
  }
  return { command: "vscode.open", title: click.title, arguments: [specToUri(repo, click.target)] };
}

/**
 * {relPath, resourceUri: repo.fileUri(relPath), contextValue, command?: commandFor(click),
 * decorations: {tooltip?, strikeThrough?}}; tooltip and strikeThrough are set only when
 * defined / true, and decorations only when one of them is.
 */
export function toResourceState(repo: ScmRepository, d: ResourceDescriptor): ContexoResourceState {
  const decorated = d.tooltip !== undefined || d.strikeThrough;
  return {
    relPath: d.relPath,
    resourceUri: repo.fileUri(d.relPath),
    contextValue: d.contextValue,
    ...(d.click === undefined ? {} : { command: commandFor(repo, d.click) }),
    ...(decorated
      ? {
        decorations: {
          ...(d.tooltip === undefined ? {} : { tooltip: d.tooltip }),
          ...(d.strikeThrough ? { strikeThrough: true } : {}),
        },
      }
      : {}),
  };
}
