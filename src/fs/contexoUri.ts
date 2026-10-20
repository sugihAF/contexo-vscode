// contexo: URIs for read-only page versions served by `ctx show` (FROZEN after WP-0.I).
// Type-only vscode import: works with vscode-uri's URI in unit tests.
import type { Uri } from "vscode";
import type { ShowRef } from "../contract/types";

export const CONTEXO_SCHEME = "contexo";

interface ContexoQuery { ref: ShowRef; root: string; path: string; }

/**
 * The `ref` version of a working file. Keeps the file's path (so the language mode and
 * editor title are right) and puts {ref, root, path} in the query as JSON, like Git's
 * toGitUri. root = workspace-folder fsPath, relPath = '/'-separated path under .contexo/.
 */
export function toContexoUri(fileUri: Uri, ref: ShowRef, root: string, relPath: string): Uri {
  const query: ContexoQuery = { ref, root, path: relPath };
  return fileUri.with({ scheme: CONTEXO_SCHEME, query: JSON.stringify(query) });
}

/** Inverse of toContexoUri. Throws on a non-contexo Uri or a malformed query. */
export function fromContexoUri(uri: Uri): { ref: ShowRef; root: string; relPath: string; fileUri: Uri } {
  if (uri.scheme !== CONTEXO_SCHEME) {
    throw new Error(`not a ${CONTEXO_SCHEME}: uri: ${uri.toString()}`);
  }
  let q: Partial<ContexoQuery>;
  try {
    q = JSON.parse(uri.query) as Partial<ContexoQuery>;
  } catch {
    throw new Error(`malformed ${CONTEXO_SCHEME}: query: ${uri.query}`);
  }
  if (typeof q !== "object" || q === null || typeof q.ref !== "string" || typeof q.root !== "string" || typeof q.path !== "string") {
    throw new Error(`malformed ${CONTEXO_SCHEME}: query: ${uri.query}`);
  }
  return { ref: q.ref, root: q.root, relPath: q.path, fileUri: uri.with({ scheme: "file", query: "" }) };
}
