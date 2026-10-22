// stateMerge (WP-1.8): the ONE sanctioned state adjustment in the extension (E8, D16,
// decision 7(d)). v1 ctx has no remote cache, so `status --offline` cannot know what the
// server has; this pure function carries the last online incoming / incoming_new /
// conflict results across offline refreshes while base.sha is unchanged. Everywhere else
// the extension only maps ctx's `state` (D1). No vscode import.
import type { PageEntry, StateCounts, StatusDoc } from "../contract/types";

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
  void online;
  void offline;
  throw new Error("mergeOffline: not implemented (WP-1.8 lane A)");
}

/** Per-state counts of pages; ahead = modified + new, behind = incoming + incoming_new (contract COUNTS). */
export function countStates(pages: readonly PageEntry[]): StateCounts {
  void pages;
  throw new Error("countStates: not implemented (WP-1.8 lane A)");
}
