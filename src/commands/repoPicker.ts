// Which repository and which pages a command acts on (WP-1.13).
import * as vscode from "vscode";
import type { PageEntry } from "../contract/types";
import type { IRepository } from "../model/types";
import type { Services } from "../services";

/** What the picker reads from VS Code; injectable so unit tests never touch vscode.window. */
export interface RepoPickerEnv {
  /** The active text editor's document Uri, if any. */
  activeEditorUri(): vscode.Uri | undefined;
}

export const defaultPickerEnv: RepoPickerEnv = {
  activeEditorUri: () => vscode.window.activeTextEditor?.document.uri,
};

/** The part of a vscode.SourceControl the push handler uses (duck-typed). */
export interface SourceControlLike {
  readonly rootUri: vscode.Uri | undefined;
  readonly inputBox: { value: string };
}

/** arg when it is a SourceControl (an object with rootUri and an inputBox whose value is a string), else undefined. */
export function sourceControlOf(arg: unknown): SourceControlLike | undefined {
  void arg;
  throw new Error("not implemented");
}

/**
 * The selection a command was invoked on. VS Code calls SCM resource commands with
 * (clicked, allSelected[]): allSelected wins when it is a non-empty array; otherwise
 * args[0] (one state, tree node, Uri, or an array of them).
 */
export function selectionOf(args: readonly unknown[]): unknown {
  void args;
  throw new Error("not implemented");
}

/**
 * The target repository, from the first of:
 * 1. a SourceControl (acceptInputCommand / scm/title argument): model.getRepository(rootUri);
 * 2. a SourceControlResourceState, or an array of them (the first one's resourceUri);
 * 3. a tree node (resourceUri);
 * 4. a Uri;
 * 5. the active editor (env.activeEditorUri());
 * then model.resolveTarget(arg); then the only repository; then a quick pick over
 * model.repositories (label: folder name, description: fsPath), shown only when two or
 * more repositories are still ambiguous. undefined when the user cancels the pick, or when
 * no repository is open (then an info 'No Contexo repository is open.' is shown, not awaited).
 */
export async function resolveRepo(
  s: Pick<Services, "model" | "prompts">,
  arg: unknown,
  env: RepoPickerEnv = defaultPickerEnv,
): Promise<IRepository | undefined> {
  void s; void arg; void env;
  throw new Error("not implemented");
}

/**
 * The status entries of `selection` (a resource state, tree node or Uri, or an array of
 * them) in this repository, through repo.pageAt(resourceUri | uri). Items repo does not know
 * are dropped; duplicates are dropped; order is kept.
 */
export function selectedPages(selection: unknown, repo: Pick<IRepository, "pageAt">): PageEntry[] {
  void selection; void repo;
  throw new Error("not implemented");
}

/** selectedPages(selection, repo) mapped to contract relPaths. */
export function selectedPaths(selection: unknown, repo: Pick<IRepository, "pageAt">): string[] {
  return selectedPages(selection, repo).map((p) => p.path);
}
