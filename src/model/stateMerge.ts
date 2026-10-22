// stateMerge (WP-1.8): the ONE sanctioned state adjustment in the extension (E8, D16,
// decision 7(d)). v1 ctx has no remote cache, so `status --offline` cannot know what the
// server has; this pure function carries the last online incoming / incoming_new /
// conflict results across offline refreshes while base.sha is unchanged. Everywhere else
// the extension only maps ctx's `state` (D1). No vscode import.
import type { ConflictKind, PageEntry, PageState, StateCounts, StatusDoc } from "../contract/types";

/**
 * Overlay of `online` (the last merged result of an ONLINE refresh of this repository) onto
 * `offline` (a result whose remote.source is "none": `status --offline`, or an online call
 * whose remote was unusable, E22). Inputs are never mutated.
 *
 * Returns `offline` itself (same object) when:
 * - online is undefined (no previous online doc), or
 * - offline.remote.source !== "none" (a live result needs no overlay), or
 * - the repository identity differs: online.project.repo_id !== offline.project.repo_id or
 *   online.server.url !== offline.server.url (the old knowledge belongs to another repo).
 *
 * Otherwise returns a NEW StatusDoc. Per path P (exact path match), with on = online entry,
 * off = offline entry, and "same base" = (on.base?.sha ?? "") === (off?.base?.sha ?? ""):
 * - no overlay when on is absent, the base is not the same, or off.state is invalid,
 *   deleted_local, unverified or conflict (an offline sidecar conflict, E9, wins and is never
 *   downgraded);
 * - on incoming     + off unchanged          -> incoming, remote = on.remote
 * - on incoming     + off modified           -> conflict both_modified, remote = on.remote
 * - on conflict     + off unchanged/modified -> conflict with on.conflict_kind, remote = on.remote
 * - on conflict both_added + off new         -> conflict both_added, remote = on.remote
 *   (the base-less form of the row above; WP-1.8 ruling)
 * - on incoming_new + off absent             -> a copy of the online entry, re-added
 * - on incoming_new + off new                -> conflict both_added, remote = on.remote
 * - anything else: off unchanged.
 * An overlaid entry keeps every other field of off (local, base, type, title, tags, notes, …);
 * conflict_kind is present only when the state is conflict.
 *
 * Then: pages are sorted by path in code-point order (Go's byte order); counts are
 * recomputed with countStates (including ahead/behind); auth is a copy of online.auth when
 * offline.auth.state is "unchecked", else offline.auth. Every other field (schema,
 * generated_at, offline, root, contexo_dir, project, server, remote, captures, warnings) is
 * offline's: remote.source stays "none".
 */
export function mergeOffline(online: StatusDoc | undefined, offline: StatusDoc): StatusDoc {
  if (
    online === undefined
    || offline.remote.source !== "none"
    || online.project.repo_id !== offline.project.repo_id
    || online.server.url !== offline.server.url
  ) {
    return offline;
  }
  // Deep copies throughout: the result shares no object with either input.
  const out = structuredClone(offline);
  const onByPath = new Map<string, PageEntry>();
  for (const on of online.pages) {
    if (!onByPath.has(on.path)) { onByPath.set(on.path, on); }
  }
  const offPaths = new Set<string>();
  out.pages = out.pages.map((off) => {
    offPaths.add(off.path);
    const on = onByPath.get(off.path);
    return on === undefined ? off : overlay(on, off);
  });
  for (const on of onByPath.values()) {
    if (on.state === "incoming_new" && !offPaths.has(on.path) && sameBase(on, undefined)) {
      out.pages.push(structuredClone(on));
    }
  }
  out.pages.sort((a, b) => compareCodePoints(a.path, b.path));
  out.counts = countStates(out.pages);
  if (offline.auth.state === "unchecked") { out.auth = structuredClone(online.auth); }
  return out;
}

/** Per-state counts of pages; ahead = modified + new, behind = incoming + incoming_new (contract COUNTS). */
export function countStates(pages: readonly PageEntry[]): StateCounts {
  const c: StateCounts = {
    unchanged: 0, modified: 0, new: 0, incoming: 0, incoming_new: 0,
    conflict: 0, deleted_local: 0, invalid: 0, unverified: 0, ahead: 0, behind: 0,
  };
  for (const p of pages) {
    // PageState is closed (D12); an unknown future state is not counted.
    if (Object.hasOwn(STATE_KEYS, p.state)) { c[p.state]++; }
  }
  c.ahead = c.modified + c.new;
  c.behind = c.incoming + c.incoming_new;
  return c;
}

/** The PageState keys of StateCounts (a lookup table, so ahead/behind are never counted as states). */
const STATE_KEYS: Readonly<Record<PageState, true>> = {
  unchanged: true, modified: true, new: true, incoming: true, incoming_new: true,
  conflict: true, deleted_local: true, invalid: true, unverified: true,
};

/** Offline states that always win: ctx knows them locally (a conflict here is a sidecar conflict, E9). */
const OFFLINE_WINS: ReadonlySet<PageState> = new Set<PageState>(["invalid", "deleted_local", "unverified", "conflict"]);

/** (on.base?.sha ?? "") === (off?.base?.sha ?? ""): the online knowledge still applies. */
function sameBase(on: PageEntry, off: PageEntry | undefined): boolean {
  return (on.base?.sha ?? "") === (off?.base?.sha ?? "");
}

/** The overlay table of mergeOffline for one path present on both sides; off is already a copy. */
function overlay(on: PageEntry, off: PageEntry): PageEntry {
  if (!sameBase(on, off) || OFFLINE_WINS.has(off.state)) { return off; }
  switch (on.state) {
    case "incoming":
      if (off.state === "unchanged") { return adjusted(off, on, "incoming"); }
      if (off.state === "modified") { return adjusted(off, on, "conflict", "both_modified"); }
      return off;
    case "conflict":
      if (off.state === "unchanged" || off.state === "modified") { return adjusted(off, on, "conflict", on.conflict_kind); }
      if (off.state === "new" && on.conflict_kind === "both_added") { return adjusted(off, on, "conflict", "both_added"); }
      return off;
    case "incoming_new":
      if (off.state === "new") { return adjusted(off, on, "conflict", "both_added"); }
      return off;
    default:
      return off;
  }
}

/** off with state (and conflict_kind only for a conflict) and a copy of on.remote; every other field is off's. */
function adjusted(off: PageEntry, on: PageEntry, state: PageState, kind?: ConflictKind): PageEntry {
  const e: PageEntry = { ...off, state };
  if (state === "conflict" && kind !== undefined) { e.conflict_kind = kind; } else { delete e.conflict_kind; }
  if (on.remote !== undefined) { e.remote = structuredClone(on.remote); } else { delete e.remote; }
  return e;
}

/** Orders strings by Unicode code point, which is Go's byte order on UTF-8 (never locale or UTF-16 unit order). */
function compareCodePoints(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const ua = a.charCodeAt(i);
    const ub = b.charCodeAt(i);
    if (ua !== ub) {
      // At the first differing unit, a surrogate pair is read as its full code point (> U+FFFF).
      return (a.codePointAt(i) ?? ua) - (b.codePointAt(i) ?? ub);
    }
  }
  return a.length - b.length;
}
