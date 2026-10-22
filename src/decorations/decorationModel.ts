// Page-state decorations (WP-1.10): what a page in each sync state looks like in the
// Explorer, Source Control and Knowledge views. Pure: no runtime vscode import, so plain
// mocha unit tests load it directly. decorationProvider.ts adapts it to VS Code.
import type { PageState, RelPath, StatusDoc } from "../contract/types";

/** One page's badge (a vscode.FileDecoration as plain data). */
export interface PageDecoration {
  /** At most 2 characters (a VS Code limit); single code points, no variation selectors. */
  readonly badge: string;
  /** ThemeColor id (package.json contributes.colors, or a built-in color); absent for no color. */
  readonly color?: string;
  readonly tooltip: string;
  /** Whether parent folders show it too: only modified (M) and conflict (!). */
  readonly propagate: boolean;
}

function decoration(badge: string, color: string | undefined, tooltip: string, propagate = false): PageDecoration {
  return Object.freeze(color === undefined ? { badge, tooltip, propagate } : { badge, color, tooltip, propagate });
}

/** Every PageState (the compiler rejects a missing one); unchanged is not decorated. */
const TABLE: Record<PageState, PageDecoration | undefined> = {
  unchanged: undefined,
  modified: decoration("M", "contexo.modifiedForeground", "Contexo: modified", true),
  new: decoration("A", "contexo.addedForeground", "Contexo: new"),
  incoming: decoration("↓", "contexo.incomingForeground", "Contexo: incoming change"),
  incoming_new: decoration("↓", "contexo.incomingForeground", "Contexo: incoming new page"),
  conflict: decoration("!", "contexo.conflictForeground", "Contexo: conflict", true),
  deleted_local: decoration("D", "gitDecoration.deletedResourceForeground", "Contexo: deleted locally"),
  invalid: decoration("⚠", "contexo.invalidForeground", "Contexo: invalid page"),
  unverified: decoration("?", undefined, "Contexo: unverified"),
};

/** A Map, so an unknown state string ('toString', '__proto__') can never hit the prototype. */
const BY_STATE: ReadonlyMap<string, PageDecoration> = new Map(
  Object.entries(TABLE).filter((e): e is [string, PageDecoration] => e[1] !== undefined),
);

/** The decoration of a page state; undefined for unchanged and any unknown future state. */
export function decorationForState(state: string): PageDecoration | undefined {
  return BY_STATE.get(state);
}

/**
 * The decorated pages of a status, by path (pages without a decoration are left out). A
 * path listed twice keeps its first entry, like a lookup by path does.
 */
export function decorationsOf(status: StatusDoc | undefined): Map<RelPath, PageDecoration> {
  const out = new Map<RelPath, PageDecoration>();
  const seen = new Set<RelPath>();
  for (const page of status?.pages ?? []) {
    if (seen.has(page.path)) { continue; }
    seen.add(page.path);
    const d = decorationForState(page.state);
    if (d) { out.set(page.path, d); }
  }
  return out;
}

/** Root files ctx generates (lower case); never decorated. */
const ROOT_GENERATED = new Set(["index.md", "tags.md"]);

/**
 * Paths under .contexo/ that are never decorated whatever the status says: any segment
 * starting with '.' (ctx's private sync tree and other hidden files) and the root index.md
 * and tags.md, in any case.
 */
export function isExcludedRelPath(rel: RelPath): boolean {
  return ROOT_GENERATED.has(rel.toLowerCase()) || rel.split("/").some((segment) => segment.startsWith("."));
}

function sameDecoration(a: PageDecoration | undefined, b: PageDecoration | undefined): boolean {
  if (a === b) { return true; }
  if (a === undefined || b === undefined) { return false; }
  return a.badge === b.badge && a.color === b.color && a.tooltip === b.tooltip && a.propagate === b.propagate;
}

/**
 * The paths whose decoration differs between two statuses (added, removed, or any field
 * changed), sorted, without duplicates. undefined stands for "no status": every decorated
 * path of the other side.
 */
export function diff(prev: StatusDoc | undefined, next: StatusDoc | undefined): RelPath[] {
  const before = decorationsOf(prev);
  const after = decorationsOf(next);
  const changed = new Set<RelPath>();
  for (const [relPath, d] of before) {
    if (!sameDecoration(d, after.get(relPath))) { changed.add(relPath); }
  }
  for (const relPath of after.keys()) {
    if (!before.has(relPath)) { changed.add(relPath); }
  }
  return [...changed].sort();
}
