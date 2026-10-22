// E27: ctx only sees bytes on disk, so unsaved Contexo editors are saved (or the
// operation is cancelled) before push, pushSelected and pull, and Take Server Version
// refuses a dirty target (WP-1.13).
import * as vscode from "vscode";
import type { IRepository } from "../model/types";
import type { Services } from "../services";

/** push, pushSelected, pull: save-or-cancel modal; theirs: refuse dirty targets; ours: no check. */
export type GuardMode = "push" | "pushSelected" | "pull" | "theirs" | "ours";

/** The part of a vscode.TextDocument the guard uses. */
export interface SavableDocument {
  readonly uri: vscode.Uri;
  readonly isDirty: boolean;
  save(): Thenable<boolean>;
}

/** Injectable so unit tests never touch vscode.workspace. */
export interface DirtyGuardEnv {
  textDocuments(): readonly SavableDocument[];
}

export const defaultDirtyGuardEnv: DirtyGuardEnv = {
  textDocuments: () => vscode.workspace.textDocuments,
};

/** Label of the confirming button of the '<N> unsaved Contexo page(s)' modal. */
export const SAVE_ALL_LABEL = "Save All and Continue";

/** The documents with isDirty whose uri is a file: Uri under repo.contexoDir (repo.relPathOf(uri) defined), in docs order. */
export function dirtyDocumentsOf(repo: Pick<IRepository, "relPathOf">, docs: readonly SavableDocument[]): SavableDocument[] {
  void repo; void docs;
  throw new Error("not implemented");
}

/**
 * The E27 guard; resolves true when the operation may go on.
 * - push, pushSelected, pull: no dirty page -> true without a prompt. Otherwise the modal
 *   s.prompts.confirm('<N> unsaved Contexo page(s)', {modal: true, confirmLabel:
 *   SAVE_ALL_LABEL, detail: <the relPaths>}); Cancel -> false. Save All -> doc.save() each
 *   (in order); any save resolving false -> an error 'Could not save <relPath>; nothing was
 *   synced.' (not awaited) and false; then await repo.refresh({remote: false}) and true.
 * - theirs: any of o.targets dirty -> a warning 'Save or revert <relPath[, relPath...]> first'
 *   (not awaited) and false; otherwise true. Never saves.
 * - ours: true, no check.
 */
export async function ensureSaved(
  s: Pick<Services, "prompts">,
  repo: IRepository,
  o: { mode: GuardMode; targets?: readonly string[] },
  env: DirtyGuardEnv = defaultDirtyGuardEnv,
): Promise<boolean> {
  void s; void repo; void o; void env;
  throw new Error("not implemented");
}
