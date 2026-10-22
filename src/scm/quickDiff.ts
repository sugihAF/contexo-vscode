// Gutter quick diff against base (WP-1.9). The predicate is pure: a working file gets a
// base original only when ctx reports a usable base for it. Type-only vscode import.
import type { Uri } from "vscode";
import type { PageEntry, PageState } from "../contract/types";
import type { IRepository } from "../model/types";
import type { UriSpec } from "./resourceModel";
import { specToUri } from "./resourceStates";

/** The repository members provideOriginalResource needs. */
export type QuickDiffRepository = Pick<IRepository, "root" | "fileUri" | "relPathOf" | "pageAt">;

/** States whose base is the original of the working file (conflict both_modified is checked apart). */
const BASE_ORIGINAL_STATES: ReadonlySet<PageState> = new Set<PageState>(["unchanged", "modified", "incoming"]);

/** relPath lies under .contexo/.sync/ (first segment '.sync', any case): ctx-private, never a page. */
export function isSyncPath(relPath: string): boolean {
  return (relPath.split("/", 1)[0] ?? "").toLowerCase() === ".sync";
}

/**
 * {kind: 'contexo', ref: 'base', relPath: page.path} only when all hold:
 * - relPath is defined (the file is under <root>/.contexo/) and not a .sync path;
 * - page is defined and has a base with stale === false;
 * - page.state is unchanged, modified or incoming, or conflict with conflict_kind both_modified.
 * Otherwise undefined (new, both_added, invalid, unverified, incoming_new, deleted_local,
 * a stale base, files outside .contexo or under .sync).
 */
export function quickDiffSpec(relPath: string | undefined, page: PageEntry | undefined): UriSpec | undefined {
  if (relPath === undefined || isSyncPath(relPath) || page === undefined) { return undefined; }
  if (page.base === undefined || page.base.stale !== false) { return undefined; }
  const hasBaseOriginal = BASE_ORIGINAL_STATES.has(page.state)
    || (page.state === "conflict" && page.conflict_kind === "both_modified");
  return hasBaseOriginal ? { kind: "contexo", ref: "base", relPath: page.path } : undefined;
}

/**
 * provideOriginalResource for one repository: undefined unless uri.scheme is 'file';
 * otherwise quickDiffSpec(repo.relPathOf(uri), repo.pageAt(uri)) converted with specToUri.
 */
export function originalResource(repo: QuickDiffRepository, uri: Uri): Uri | undefined {
  if (uri.scheme !== "file") { return undefined; }
  const relPath = repo.relPathOf(uri);
  // Outside .contexo/ or under .sync: answer without a page lookup.
  if (relPath === undefined || isSyncPath(relPath)) { return undefined; }
  const spec = quickDiffSpec(relPath, repo.pageAt(uri));
  return spec === undefined ? undefined : specToUri(repo, spec);
}
