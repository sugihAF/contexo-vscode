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
  return docs.filter((d) => d.isDirty && d.uri.scheme === "file" && repo.relPathOf(d.uri) !== undefined);
}

/** A dirty document's relPath (dirtyDocumentsOf guarantees one; the fsPath is only a fallback). */
function relPathOfDoc(repo: Pick<IRepository, "relPathOf">, d: SavableDocument): string {
  return repo.relPathOf(d.uri) ?? d.uri.fsPath;
}

/** doc.save(), with a rejection counted as a failed save. */
async function trySave(d: SavableDocument): Promise<boolean> {
  try {
    return (await d.save()) === true;
  } catch {
    return false;
  }
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
  if (o.mode === "ours") { return true; }
  const dirty = dirtyDocumentsOf(repo, env.textDocuments());

  if (o.mode === "theirs") {
    const targets = new Set(o.targets ?? []);
    // A target matches by the editor's relPath, or by its status entry's path (pageAt
    // handles case-insensitive file systems, where the editor's casing may differ).
    const isTarget = (d: SavableDocument): boolean => {
      const entry = repo.pageAt(d.uri)?.path;
      return targets.has(relPathOfDoc(repo, d)) || (entry !== undefined && targets.has(entry));
    };
    const blocked = dirty.filter(isTarget).map((d) => relPathOfDoc(repo, d));
    if (blocked.length === 0) { return true; }
    void s.prompts.warn(`Save or revert ${blocked.join(", ")} first`);
    return false;
  }

  if (dirty.length === 0) { return true; }
  const relPaths = dirty.map((d) => relPathOfDoc(repo, d));
  const confirmed = await s.prompts.confirm(`${dirty.length} unsaved Contexo page(s)`, {
    modal: true,
    confirmLabel: SAVE_ALL_LABEL,
    detail: relPaths.join("\n"),
  });
  if (!confirmed) { return false; }
  for (const [i, d] of dirty.entries()) {
    if (!(await trySave(d))) {
      void s.prompts.error(`Could not save ${relPaths[i] ?? relPathOfDoc(repo, d)}; nothing was synced.`);
      return false;
    }
  }
  // The saved bytes change the page states (a buffer edit shows as modified only on disk).
  await repo.refresh({ remote: false });
  return true;
}
