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

/** Quick pick placeholder when two or more repositories are still ambiguous. */
export const PICK_REPOSITORY_PLACEHOLDER = "Select a Contexo repository";
/** Info shown when a command runs with no repository open. */
export const NO_REPOSITORY_MESSAGE = "No Contexo repository is open.";

/**
 * A Uri, also one built by another copy of the module (vscode-uri in tests, a second
 * bundle): duck-typed like test/helpers/fakeModel.ts.
 */
function isUri(v: unknown): v is vscode.Uri {
  if (v instanceof vscode.Uri) { return true; }
  const u = v as { scheme?: unknown; path?: unknown; with?: unknown } | null;
  return typeof u === "object" && u !== null && typeof u.scheme === "string" && typeof u.path === "string" && typeof u.with === "function";
}

/** The Uri an item stands for: a Uri itself, or the resourceUri of a resource state or tree node. */
function uriOfItem(v: unknown): vscode.Uri | undefined {
  if (isUri(v)) { return v; }
  if (typeof v === "object" && v !== null) {
    const r = (v as { resourceUri?: unknown }).resourceUri;
    if (isUri(r)) { return r; }
  }
  return undefined;
}

/** arg when it is a SourceControl (an object with rootUri and an inputBox whose value is a string), else undefined. */
export function sourceControlOf(arg: unknown): SourceControlLike | undefined {
  if (typeof arg !== "object" || arg === null || !("rootUri" in arg) || !("inputBox" in arg)) { return undefined; }
  const { rootUri, inputBox } = arg as { rootUri: unknown; inputBox: unknown };
  if (rootUri !== undefined && !isUri(rootUri)) { return undefined; }
  if (typeof inputBox !== "object" || inputBox === null || typeof (inputBox as { value?: unknown }).value !== "string") {
    return undefined;
  }
  return arg as SourceControlLike;
}

/**
 * The selection a command was invoked on. VS Code calls SCM resource commands with
 * (clicked, allSelected[]): allSelected wins when it is a non-empty array; otherwise
 * args[0] (one state, tree node, Uri, or an array of them). The SCM view also spreads a
 * multi-selection as (state1, state2, ...) (its MultipleSelectionActionRunner); when
 * there are two or more arguments and every one is a Uri or has a resourceUri, all of
 * them are the selection.
 */
export function selectionOf(args: readonly unknown[]): unknown {
  const [first, second] = args;
  if (Array.isArray(second) && second.length > 0) { return second; }
  if (args.length > 1 && args.every((a) => uriOfItem(a) !== undefined)) { return [...args]; }
  return first;
}

/** The Uri the argument points at: a SourceControl's rootUri, or the first Uri / resourceUri of an item or array. */
function targetUriOf(arg: unknown): vscode.Uri | undefined {
  const sc = sourceControlOf(arg);
  if (sc) { return sc.rootUri; }
  if (Array.isArray(arg)) {
    for (const item of arg as unknown[]) {
      const uri = uriOfItem(item);
      if (uri) { return uri; }
    }
    return undefined;
  }
  return uriOfItem(arg);
}

/** The workspace folder's name (the last path segment), else its fsPath. */
function folderName(root: vscode.Uri): string {
  return root.path.split("/").filter((s) => s !== "").pop() ?? root.fsPath;
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
 * An open repository passed as arg itself is used as is.
 */
export async function resolveRepo(
  s: Pick<Services, "model" | "prompts">,
  arg: unknown,
  env: RepoPickerEnv = defaultPickerEnv,
): Promise<IRepository | undefined> {
  const model = s.model;
  const repositories = model.repositories;
  if (repositories.length === 0) {
    void s.prompts.info(NO_REPOSITORY_MESSAGE);
    return undefined;
  }
  const given = repositories.find((r) => r === arg);
  if (given) { return given; }

  const uri = targetUriOf(arg);
  const fromArg = uri ? model.getRepository(uri) : undefined;
  if (fromArg) { return fromArg; }

  const editorUri = env.activeEditorUri();
  const fromEditor = editorUri ? model.getRepository(editorUri) : undefined;
  if (fromEditor) { return fromEditor; }

  const target = model.resolveTarget(arg)?.repository;
  if (target) { return target; }

  if (repositories.length === 1) { return repositories[0]; }
  const items = repositories.map((repository) => ({
    label: folderName(repository.root),
    description: repository.root.fsPath,
    repository,
  }));
  const picked = await s.prompts.quickPick(items, { placeHolder: PICK_REPOSITORY_PLACEHOLDER });
  return picked?.repository;
}

/**
 * The status entries of `selection` (a resource state, tree node or Uri, or an array of
 * them) in this repository, through repo.pageAt(resourceUri | uri). Items repo does not know
 * are dropped; duplicates are dropped; order is kept.
 */
export function selectedPages(selection: unknown, repo: Pick<IRepository, "pageAt">): PageEntry[] {
  const items: readonly unknown[] = Array.isArray(selection) ? selection : [selection];
  const seen = new Set<string>();
  const pages: PageEntry[] = [];
  for (const item of items) {
    const uri = uriOfItem(item);
    const page = uri ? repo.pageAt(uri) : undefined;
    if (!page || seen.has(page.path)) { continue; }
    seen.add(page.path);
    pages.push(page);
  }
  return pages;
}

/** selectedPages(selection, repo) mapped to contract relPaths. */
export function selectedPaths(selection: unknown, repo: Pick<IRepository, "pageAt">): string[] {
  return selectedPages(selection, repo).map((p) => p.path);
}
