// Pure SCM presentation model (WP-1.9): a StatusDoc becomes the five resource-group
// descriptors (strictly through groupFor), per-resource click specs, the View All Changes
// tuples, the E29 badge count and the input-box placeholder. vscode-free: URIs are
// emitted as UriSpec values that resourceStates.ts converts with repo.fileUri and
// toContexoUri. The extension never derives a page state here; it only maps `state`.
import { groupFor, scmCount, type PageEntry, type PageState, type ScmGroup, type StatusDoc } from "../contract/types";

/** A URI to build later: the working file, or a contexo: version of it (toContexoUri). */
export type UriSpec =
  | { kind: "file"; relPath: string }
  | { kind: "contexo"; ref: "base" | "server" | "empty"; relPath: string };

/** What clicking a resource runs: vscode.diff(left, right, label) or vscode.open(target). */
export type ClickSpec =
  | { kind: "diff"; left: UriSpec; right: UriSpec; label: string }
  | { kind: "open"; target: UriSpec; title: string };

/** One SourceControlResourceState, before URIs are built. */
export interface ResourceDescriptor {
  /** page.path ('/'-separated, relative to .contexo/). */
  relPath: string;
  /** resourceState.contextValue: the PageState string itself. */
  contextValue: PageState;
  tooltip?: string;
  strikeThrough: boolean;
  /** Absent when the state has no click (deleted_local with neither base nor server). */
  click?: ClickSpec;
}

export interface GroupDescriptor {
  /** == contract ScmGroup (the resource group id the manifest when-clauses test). */
  id: ScmGroup;
  label: string;
  hideWhenEmpty: boolean;
  /** Sorted by relPath. */
  resources: ResourceDescriptor[];
}

/** One vscode.changes entry: [resourceUri, originalUri, modifiedUri]. */
export type ChangeTuple = [resource: UriSpec, original: UriSpec, modified: UriSpec];

/** Creation (and display) order of the resource groups. */
export const GROUP_ORDER: readonly ScmGroup[] = ["conflicts", "changes", "new", "incoming", "invalid"];

export const GROUP_LABELS: Readonly<Record<ScmGroup, string>> = {
  conflicts: "Conflicts",
  changes: "Changes",
  new: "New",
  incoming: "Incoming",
  invalid: "Invalid",
};

/** E29: the tooltip of a deleted_local resource (which is also struck through). */
export const DELETED_LOCAL_TOOLTIP =
  "Deleted locally. Deletes are not synced in this version; Restore Server Version brings it back.";

const OPEN_FILE = "Open File";
const OPEN_BASE_VERSION = "Open Base Version";
const OPEN_SERVER_VERSION = "Open Server Version";

const fileSpec = (relPath: string): UriSpec => ({ kind: "file", relPath });
const contexoSpec = (ref: "base" | "server" | "empty", relPath: string): UriSpec => ({ kind: "contexo", ref, relPath });

/** Ordinal (code-unit) order: deterministic and locale-free, like ctx's sorted `pages`. */
function byPath(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The pages groupFor puts in `group`, sorted by path (status.pages itself is not reordered). */
function pagesIn(group: ScmGroup, status: StatusDoc | undefined): PageEntry[] {
  return (status?.pages ?? []).filter((p) => groupFor(p.state) === group).sort((a, b) => byPath(a.path, b.path));
}

/** A base ctx can serve: present and not stale. */
function hasUsableBase(page: PageEntry): boolean {
  return page.base !== undefined && page.base.stale === false;
}

function hasServerVersion(page: PageEntry): boolean {
  return (page.remote?.sha ?? "") !== "";
}

/** Every group hides when empty except Changes. */
export function hideWhenEmpty(id: ScmGroup): boolean {
  return id !== "changes";
}

/**
 * The resource tooltip per state (undefined for unchanged and unverified):
 * - modified: 'Modified locally'
 * - new: 'New: not on the server yet'
 * - incoming: 'Changed on the server' (+ ' by <remote.author>' when known)
 * - incoming_new: 'New on the server' (+ ' by <remote.author>')
 * - conflict both_modified: 'Conflict: changed locally and on the server' (+ ' by <remote.author>')
 * - conflict both_added: 'Conflict: created locally and on the server' (+ ' by <remote.author>')
 * - invalid: invalid.message exactly ('ctx cannot read this page' when invalid is absent)
 * - deleted_local: DELETED_LOCAL_TOOLTIP
 */
export function tooltipFor(page: PageEntry): string | undefined {
  const author = page.remote?.author;
  const by = author ? ` by ${author}` : "";
  switch (page.state) {
    case "modified": return "Modified locally";
    case "new": return "New: not on the server yet";
    case "incoming": return `Changed on the server${by}`;
    case "incoming_new": return `New on the server${by}`;
    case "conflict":
      // conflict_kind is required on a conflict (schema); only both_added reads differently.
      return page.conflict_kind === "both_added"
        ? `Conflict: created locally and on the server${by}`
        : `Conflict: changed locally and on the server${by}`;
    case "invalid": return page.invalid?.message ?? "ctx cannot read this page";
    case "deleted_local": return DELETED_LOCAL_TOOLTIP;
    default: return undefined; // unchanged, unverified
  }
}

/** '<basename> (Base ↔ Local)' or '<basename> (Server ↔ Local)'. */
export function diffLabel(relPath: string, left: "Base" | "Server"): string {
  return `${relPath.slice(relPath.lastIndexOf("/") + 1)} (${left} ↔ Local)`;
}

/**
 * What a click runs, per state:
 * - modified: diff(contexo base, file, '<name> (Base ↔ Local)')
 * - deleted_local: open contexo base ('Open Base Version') when page.base exists with
 *   stale === false; otherwise open contexo server ('Open Server Version') when remote.sha
 *   exists; otherwise undefined
 * - new, invalid: open file ('Open File')
 * - incoming, conflict (both kinds): diff(contexo server, file, '<name> (Server ↔ Local)')
 * - incoming_new: open contexo server ('Open Server Version')
 * - unchanged, unverified: undefined
 */
export function clickFor(page: PageEntry): ClickSpec | undefined {
  const rel = page.path;
  switch (page.state) {
    case "modified":
      return { kind: "diff", left: contexoSpec("base", rel), right: fileSpec(rel), label: diffLabel(rel, "Base") };
    case "deleted_local":
      if (hasUsableBase(page)) { return { kind: "open", target: contexoSpec("base", rel), title: OPEN_BASE_VERSION }; }
      return hasServerVersion(page) ? { kind: "open", target: contexoSpec("server", rel), title: OPEN_SERVER_VERSION } : undefined;
    case "new":
    case "invalid":
      return { kind: "open", target: fileSpec(rel), title: OPEN_FILE };
    case "incoming":
    case "conflict":
      return { kind: "diff", left: contexoSpec("server", rel), right: fileSpec(rel), label: diffLabel(rel, "Server") };
    case "incoming_new":
      return { kind: "open", target: contexoSpec("server", rel), title: OPEN_SERVER_VERSION };
    default:
      return undefined; // unchanged, unverified
  }
}

function descriptorFor(page: PageEntry): ResourceDescriptor {
  const tooltip = tooltipFor(page);
  const click = clickFor(page);
  return {
    relPath: page.path,
    contextValue: page.state,
    ...(tooltip === undefined ? {} : { tooltip }),
    strikeThrough: page.state === "deleted_local",
    ...(click === undefined ? {} : { click }),
  };
}

/**
 * The five groups in GROUP_ORDER, always (empty when status is undefined). Membership is
 * groupFor(page.state) only; unchanged and unverified pages are in no group. Each group's
 * resources are sorted by relPath; strikeThrough is true only for deleted_local.
 */
export function groupDescriptors(status: StatusDoc | undefined): GroupDescriptor[] {
  return GROUP_ORDER.map((id) => ({
    id,
    label: GROUP_LABELS[id],
    hideWhenEmpty: hideWhenEmpty(id),
    resources: pagesIn(id, status).map(descriptorFor),
  }));
}

function specKey(s: UriSpec): string[] {
  return s.kind === "file" ? ["file", s.relPath] : ["contexo", s.ref, s.relPath];
}

function clickKey(c: ClickSpec): unknown[] {
  return c.kind === "diff" ? ["diff", specKey(c.left), specKey(c.right), c.label] : ["open", specKey(c.target), c.title];
}

/** A string that changes iff anything rendered for the group changes (id, label, resources). */
export function groupSignature(group: GroupDescriptor): string {
  // Positional (not JSON.stringify(group)), so key order never matters; null marks an absent field.
  return JSON.stringify([
    group.id,
    group.label,
    group.hideWhenEmpty,
    group.resources.map((r) => [
      r.relPath, r.contextValue, r.tooltip ?? null, r.strikeThrough, r.click === undefined ? null : clickKey(r.click),
    ]),
  ]);
}

/**
 * The ids (in `next` order) whose signature differs from `previous` (a missing entry
 * counts as different). The adapter reassigns resourceStates only for these.
 */
export function changedGroups(previous: ReadonlyMap<ScmGroup, string>, next: readonly GroupDescriptor[]): ScmGroup[] {
  return next.filter((g) => previous.get(g.id) !== groupSignature(g)).map((g) => g.id);
}

function tupleFor(page: PageEntry): ChangeTuple | undefined {
  const rel = page.path;
  switch (page.state) {
    case "modified": return [fileSpec(rel), contexoSpec("base", rel), fileSpec(rel)];
    case "deleted_local":
      if (hasUsableBase(page)) { return [fileSpec(rel), contexoSpec("base", rel), contexoSpec("empty", rel)]; }
      return hasServerVersion(page) ? [fileSpec(rel), contexoSpec("server", rel), contexoSpec("empty", rel)] : undefined;
    case "new": return [fileSpec(rel), contexoSpec("empty", rel), fileSpec(rel)];
    case "incoming": return [fileSpec(rel), contexoSpec("server", rel), fileSpec(rel)];
    case "incoming_new": return [fileSpec(rel), contexoSpec("empty", rel), contexoSpec("server", rel)];
    case "conflict": return [fileSpec(rel), contexoSpec("server", rel), fileSpec(rel)];
    default: return undefined; // invalid (and the states in no group)
  }
}

/**
 * View All Changes tuples for one group, in the group's (path) order:
 * - modified: [file, base, file]
 * - deleted_local: [file, base, empty]; with no valid base (missing or stale):
 *   [file, server, empty] when remote.sha exists, else no tuple
 * - new: [file, empty, file]
 * - incoming: [file, server, file]
 * - incoming_new: [file, empty, server]
 * - conflict: [file, server, file]
 * - invalid (and anything else): no tuple
 * (base/server/empty are contexo specs, file is the file spec.)
 */
export function changesTuples(group: ScmGroup, status: StatusDoc | undefined): ChangeTuple[] {
  const out: ChangeTuple[] = [];
  for (const page of pagesIn(group, status)) {
    const t = tupleFor(page);
    if (t) { out.push(t); }
  }
  return out;
}

/** SourceControl.count (E29): scmCount(status.counts, countIncoming); 0 without a status. */
export function countFor(status: StatusDoc | undefined, countIncoming: boolean): number {
  return status === undefined ? 0 : scmCount(status.counts, countIncoming);
}

/** '⌘Enter' on darwin, 'Ctrl+Enter' elsewhere. */
export function keyLabel(platform: string): string {
  return platform === "darwin" ? "⌘Enter" : "Ctrl+Enter";
}

/**
 * The input-box placeholder:
 * - 'Message (<key> to push to Contexo)'
 * - when captures.blocks_push: '<N> agent session(s) not distilled: <key> offers Share via your agent',
 *   N = max(1, captures.fresh)
 * (<key> = keyLabel(platform)).
 */
export function placeholderFor(status: StatusDoc | undefined, platform: string): string {
  const key = keyLabel(platform);
  if (status?.captures.blocks_push === true) {
    return `${Math.max(1, status.captures.fresh)} agent session(s) not distilled: ${key} offers Share via your agent`;
  }
  return `Message (${key} to push to Contexo)`;
}
