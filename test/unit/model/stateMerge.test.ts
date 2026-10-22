// stateMerge (src/model/stateMerge.ts, WP-1.8): the offline overlay of the last online
// incoming / incoming_new / conflict results, and countStates. Plain mocha: no vscode import.
// Built on the 'mixed' scenario (online) and its offline counterpart (mixed-offline), with
// small hand-made edits via structuredClone where a case needs them.
import * as assert from "node:assert/strict";
import {
  PAGE_STATES,
  type AuthState, type PageEntry, type PageState, type StateCounts, type StatusDoc,
} from "../../../src/contract/types";
import { countStates, mergeOffline } from "../../../src/model/stateMerge";
import { loadStatusDoc } from "../../helpers/fixtures";

const ONLINE: StatusDoc = loadStatusDoc("mixed");
const OFFLINE: StatusDoc = loadStatusDoc("mixed", { offline: true });

const RETRY = "wiki/concepts/retry-policy.md"; // online incoming, offline unchanged
const RATE = "wiki/concepts/rate-limits.md"; // online conflict both_modified, offline modified
const BILLING = "wiki/entities/billing.md"; // online incoming_new, absent offline
const BROKEN = "wiki/concepts/broken.md"; // invalid on both sides
const LEGACY = "wiki/concepts/legacy-sync.md"; // unverified on both sides
const OLD_NAME = "wiki/concepts/old-name.md"; // deleted_local on both sides

const OTHER_SHA = "0123456789abcdef0123456789abcdef01234567";
const SIDECAR_SHA = "fedcba9876543210fedcba9876543210fedcba98";

/** Fresh, independent copies of the two fixture docs. */
function docs(): { online: StatusDoc; offline: StatusDoc } {
  return { online: structuredClone(ONLINE), offline: structuredClone(OFFLINE) };
}

function find(doc: StatusDoc, path: string): PageEntry | undefined {
  return doc.pages.find((p) => p.path === path);
}

function entry(doc: StatusDoc, path: string): PageEntry {
  const e = find(doc, path);
  assert.ok(e, `no entry for ${path}`);
  return e;
}

/** Replaces (or adds) the entry for e.path in doc, in place. */
function put(doc: StatusDoc, e: PageEntry): void {
  const i = doc.pages.findIndex((p) => p.path === e.path);
  if (i < 0) { doc.pages.push(e); } else { doc.pages[i] = e; }
}

/** Compares strings by Unicode code point (Go's byte order on UTF-8), never by locale or UTF-16 unit. */
function byCodePoint(a: string, b: string): number {
  const ca = Array.from(a, (c) => c.codePointAt(0) ?? 0);
  const cb = Array.from(b, (c) => c.codePointAt(0) ?? 0);
  for (let i = 0; i < Math.min(ca.length, cb.length); i++) {
    const d = (ca[i] ?? 0) - (cb[i] ?? 0);
    if (d !== 0) { return d; }
  }
  return ca.length - cb.length;
}

/** mergeOffline, asserting it mutated neither input. */
function merge(online: StatusDoc | undefined, offline: StatusDoc): StatusDoc {
  const before = structuredClone({ online, offline });
  const out = mergeOffline(online, offline);
  assert.deepEqual({ online, offline }, before, "mergeOffline mutated an input");
  return out;
}

/** Every object reachable from v. */
function objectsOf(v: unknown, into = new Set<object>()): Set<object> {
  if (typeof v === "object" && v !== null && !into.has(v)) {
    into.add(v);
    for (const child of Object.values(v)) { objectsOf(child, into); }
  }
  return into;
}

function deepFreeze<T>(v: T): T {
  if (typeof v === "object" && v !== null) {
    for (const child of Object.values(v)) { deepFreeze(child); }
    Object.freeze(v);
  }
  return v;
}

function zeroCounts(): StateCounts {
  return {
    unchanged: 0, modified: 0, new: 0, incoming: 0, incoming_new: 0,
    conflict: 0, deleted_local: 0, invalid: 0, unverified: 0, ahead: 0, behind: 0,
  };
}

/** A minimal entry in `state` at `path`. */
function bare(path: string, state: PageState, extra: Partial<PageEntry> = {}): PageEntry {
  return { path, state, tags: [], notes: [], ...extra };
}

describe("stateMerge", () => {
  describe("mergeOffline", () => {
    it("offline unchanged after online incoming (same base.sha) stays incoming", () => {
      const { online, offline } = docs();
      const off = entry(offline, RETRY);
      const on = entry(online, RETRY);
      assert.equal(off.state, "unchanged");
      assert.equal(on.state, "incoming");
      assert.equal(off.base?.sha, on.base?.sha);

      const got = entry(merge(online, offline), RETRY);
      assert.deepEqual(got, { ...off, state: "incoming", remote: on.remote });
      assert.ok(!("conflict_kind" in got), "conflict_kind only when the state is conflict");
    });

    it("offline modified after online incoming becomes conflict both_modified", () => {
      const { online, offline } = docs();
      const off = entry(offline, RETRY);
      off.state = "modified";
      off.local = { file: RETRY, hash: "sha256:edited-offline" };
      off.updated = "2026-10-15T09:29:00Z";

      const got = entry(merge(online, offline), RETRY);
      assert.deepEqual(got, {
        ...off, state: "conflict", conflict_kind: "both_modified", remote: entry(online, RETRY).remote,
      });
    });

    it("offline unchanged after online conflict stays conflict", () => {
      const { online, offline } = docs();
      const off = entry(offline, RATE);
      off.state = "unchanged";
      off.local = { file: RATE, hash: off.base?.hash };
      const on = entry(online, RATE);
      assert.equal(on.state, "conflict");
      assert.equal(on.conflict_kind, "both_modified");

      const got = entry(merge(online, offline), RATE);
      assert.deepEqual(got, { ...off, state: "conflict", conflict_kind: "both_modified", remote: on.remote });
    });

    it("offline modified after online conflict stays conflict", () => {
      const { online, offline } = docs();
      const off = entry(offline, RATE);
      assert.equal(off.state, "modified");

      const got = entry(merge(online, offline), RATE);
      assert.deepEqual(got, {
        ...off, state: "conflict", conflict_kind: "both_modified", remote: entry(online, RATE).remote,
      });
    });

    it("online conflict both_added + offline new stays conflict both_added", () => {
      const { online, offline } = docs();
      const path = "wiki/entities/ledger.md";
      const remote = { sha: OTHER_SHA, author: "Bob Lee", email: "bob@example.com", message: "Add ledger" };
      put(online, bare(path, "conflict", {
        conflict_kind: "both_added", title: "Ledger", local: { file: path, hash: "sha256:a" }, remote,
      }));
      online.pages.sort((a, b) => byCodePoint(a.path, b.path));
      const off = bare(path, "new", { title: "Ledger (local)", local: { file: path, hash: "sha256:b" } });
      put(offline, off);

      const got = entry(merge(online, offline), path);
      assert.deepEqual(got, { ...off, state: "conflict", conflict_kind: "both_added", remote });
    });

    it("online conflict both_modified + offline new is not overlaid", () => {
      const { online, offline } = docs();
      const off = bare(RATE, "new", { local: { file: RATE, hash: "sha256:recreated" } });
      put(offline, off);

      assert.deepEqual(entry(merge(online, offline), RATE), off);
    });

    it("a missing incoming_new entry is re-added", () => {
      const { online, offline } = docs();
      assert.equal(find(offline, BILLING), undefined);
      const on = entry(online, BILLING);
      assert.equal(on.state, "incoming_new");

      const merged = merge(online, offline);
      const got = entry(merged, BILLING);
      assert.deepEqual(got, on);
      assert.notEqual(got, on, "a copy of the online entry, not the entry itself");
      assert.equal(merged.pages.filter((p) => p.path === BILLING).length, 1);
    });

    it("the re-added entry is sorted into place (code-point path order)", () => {
      const { online, offline } = docs();
      const merged = merge(online, offline);
      assert.deepEqual(merged.pages.map((p) => p.path), online.pages.map((p) => p.path));
      const i = merged.pages.findIndex((p) => p.path === BILLING);
      assert.equal(merged.pages[i - 1]?.path, RETRY);
      assert.equal(merged.pages[i + 1]?.path, "wiki/entities/gitstore.md");
    });

    it("re-added entries sort by code point, not by locale or UTF-16 unit", () => {
      const { online, offline } = docs();
      const upper = "wiki/Zeta.md";
      const fullwidth = "wiki/Ａ.md"; // U+FF21, in the BMP above the surrogates
      const astral = "wiki/\u{1F600}.md"; // U+1F600, a surrogate pair in UTF-16
      const remote = { sha: OTHER_SHA };
      online.pages = [upper, fullwidth, astral].map((p) => bare(p, "incoming_new", { remote }));
      offline.pages = ["wiki/alpha.md", "wiki/b.md"].map((p) => bare(p, "new", { local: { file: p } }));

      const expected = [upper, "wiki/alpha.md", "wiki/b.md", fullwidth, astral];
      assert.deepEqual(merge(online, offline).pages.map((p) => p.path), expected);
      // The order really is the code-point one (and not what the other comparisons give).
      assert.deepEqual([...expected].sort(byCodePoint), expected);
      assert.notDeepEqual([...expected].sort(), expected, "UTF-16 order puts the astral path first");
      assert.notDeepEqual([...expected].sort((a, b) => a.localeCompare(b)), expected);
    });

    it("an incoming_new entry with a base (not the same as an absent one) is not re-added", () => {
      const { online, offline } = docs();
      const on = entry(online, BILLING);
      on.base = { sha: OTHER_SHA, stale: false }; // hand-made: "same base" compares against ""
      assert.equal(find(merge(online, offline), BILLING), undefined);
    });

    it("conflict_kind is present only when the state is conflict", () => {
      const { online, offline } = docs();
      const off = entry(offline, RETRY);
      off.conflict_kind = "both_modified"; // hand-made stray field on an unchanged entry
      const got = entry(merge(online, offline), RETRY);
      assert.equal(got.state, "incoming");
      assert.ok(!("conflict_kind" in got));
    });

    it("an incoming or conflict entry missing offline is not re-added", () => {
      const { online, offline } = docs();
      offline.pages = offline.pages.filter((p) => p.path !== RETRY && p.path !== RATE);

      const merged = merge(online, offline);
      assert.equal(find(merged, RETRY), undefined);
      assert.equal(find(merged, RATE), undefined);
    });

    it("online incoming_new + offline new becomes conflict both_added", () => {
      const { online, offline } = docs();
      const off = bare(BILLING, "new", {
        type: "entity", title: "Billing (local draft)", tags: ["billing"],
        local: { file: BILLING, hash: "sha256:local-billing" },
      });
      put(offline, off);

      const got = entry(merge(online, offline), BILLING);
      assert.deepEqual(got, {
        ...off, state: "conflict", conflict_kind: "both_added", remote: entry(online, BILLING).remote,
      });
    });

    it("the overlay is dropped when base.sha changed", () => {
      const { online, offline } = docs();
      // A pull elsewhere moved the bases: the old online knowledge no longer applies.
      const retry = entry(offline, RETRY);
      assert.ok(retry.base);
      retry.base.sha = OTHER_SHA;
      const rate = entry(offline, RATE);
      assert.ok(rate.base);
      rate.base.sha = SIDECAR_SHA;
      const billing = bare(BILLING, "unchanged", {
        local: { file: BILLING, hash: "sha256:pulled" },
        base: { sha: "79295977d33fb9999f0e2ae8fb77aa43baec243f", stale: false },
      });
      put(offline, billing);
      const rateUnchanged = structuredClone(offline);
      const ru = entry(rateUnchanged, RATE);
      ru.state = "unchanged";

      const merged = merge(online, offline);
      assert.deepEqual(entry(merged, RETRY), retry);
      assert.deepEqual(entry(merged, RATE), rate);
      assert.deepEqual(entry(merged, BILLING), billing);
      assert.deepEqual(entry(merge(online, rateUnchanged), RATE), ru);
    });

    it("an offline sidecar conflict is never downgraded", () => {
      const { online, offline } = docs();
      const sidecar = (e: PageEntry, kind: "both_modified" | "both_added"): PageEntry =>
        ({ ...e, state: "conflict", conflict_kind: kind, remote: { sha: SIDECAR_SHA } });
      const retry = sidecar(entry(offline, RETRY), "both_modified"); // online: incoming
      const rate = sidecar(entry(offline, RATE), "both_modified"); // online: conflict
      const billing = sidecar(bare(BILLING, "new", { local: { file: BILLING } }), "both_added"); // online: incoming_new
      put(offline, retry);
      put(offline, rate);
      put(offline, billing);

      const merged = merge(online, offline);
      assert.deepEqual(entry(merged, RETRY), retry);
      assert.deepEqual(entry(merged, RATE), rate);
      assert.deepEqual(entry(merged, BILLING), billing);
      assert.deepEqual(entry(merged, RATE).remote, { sha: SIDECAR_SHA });
    });

    it("invalid/deleted_local/unverified offline results win", () => {
      for (const path of [BROKEN, OLD_NAME, LEGACY]) {
        for (const onState of ["incoming", "conflict"] as const) {
          const { online, offline } = docs();
          const off = entry(offline, path);
          const on = entry(online, path);
          on.state = onState;
          if (onState === "conflict") { on.conflict_kind = "both_modified"; }
          on.remote = { sha: OTHER_SHA, author: "Bob Lee", message: "server edit" };
          delete on.invalid;
          assert.equal(off.base?.sha, on.base?.sha, "same base: only the offline state decides");

          assert.deepEqual(entry(merge(online, offline), path), off, `${path} after online ${onState}`);
        }
      }
      const { offline } = docs();
      assert.deepEqual(
        [BROKEN, OLD_NAME, LEGACY].map((p) => entry(offline, p).state), ["invalid", "deleted_local", "unverified"],
      );
    });

    it("an offline invalid/deleted_local/unverified result wins over online incoming on a hand-made entry", () => {
      for (const state of ["invalid", "deleted_local", "unverified"] as const) {
        const { online, offline } = docs();
        const off = structuredClone(entry(offline, RETRY));
        off.state = state;
        if (state === "invalid") { off.invalid = { stage: "parse", message: "yaml: bad" }; }
        if (state === "deleted_local") { delete off.local; }
        if (state === "unverified" && off.base) { off.base.stale = true; }
        put(offline, off);

        assert.deepEqual(entry(merge(online, offline), RETRY), off, state);
      }
    });

    it("counts and ahead/behind are recomputed", () => {
      const { online, offline } = docs();
      assert.equal(offline.counts.behind, 0);
      const merged = merge(online, offline);
      assert.deepEqual(merged.counts, {
        unchanged: 2, modified: 1, new: 1, incoming: 1, incoming_new: 1,
        conflict: 1, deleted_local: 1, invalid: 1, unverified: 1, ahead: 2, behind: 2,
      });
      assert.deepEqual(merged.counts, countStates(merged.pages));

      const edited = docs();
      const retry = entry(edited.offline, RETRY);
      retry.state = "modified";
      const merged2 = merge(edited.online, edited.offline);
      assert.deepEqual(merged2.counts, {
        unchanged: 2, modified: 1, new: 1, incoming: 0, incoming_new: 1,
        conflict: 2, deleted_local: 1, invalid: 1, unverified: 1, ahead: 2, behind: 1,
      });
    });

    it("auth comes from online when offline is unchecked", () => {
      const { online, offline } = docs();
      assert.equal(offline.auth.state, "unchecked");
      const merged = merge(online, offline);
      assert.deepEqual(merged.auth, online.auth);
      assert.notEqual(merged.auth, online.auth, "a copy of online.auth");

      for (const state of ["authenticated", "not_authenticated", "rejected"] satisfies AuthState[]) {
        const d = docs();
        d.offline.auth = { state };
        assert.deepEqual(merge(d.online, d.offline).auth, { state }, `offline auth ${state} is kept`);
      }
    });

    it("no overlay without a previous online doc", () => {
      const { offline } = docs();
      assert.equal(merge(undefined, offline), offline);
    });

    it("a live result (remote.source live) is returned as the same object", () => {
      const { online } = docs();
      const live = structuredClone(ONLINE);
      assert.equal(live.remote.source, "live");
      assert.equal(merge(online, live), live);

      const cache = structuredClone(OFFLINE);
      cache.remote.source = "cache"; // reserved in v1, but still not "none"
      assert.equal(merge(online, cache), cache);
    });

    it("a different repository identity (repo_id or server.url) returns offline itself", () => {
      const edits: [string, (d: StatusDoc) => void][] = [
        ["online repo_id differs", (d) => { d.project.repo_id = "other-repo"; }],
        ["online repo_id absent", (d) => { delete d.project.repo_id; }],
        ["online server.url differs", (d) => { d.server.url = "https://other.example.com"; }],
        ["online server.url absent", (d) => { delete d.server.url; }],
      ];
      for (const [label, edit] of edits) {
        const { online, offline } = docs();
        edit(online);
        assert.equal(merge(online, offline), offline, label);
      }
      const { online, offline } = docs();
      offline.project.repo_id = "renamed-repo";
      assert.equal(merge(online, offline), offline, "offline repo_id differs");
    });

    it("remote.source stays none and every other field is offline's", () => {
      const { online, offline } = docs();
      const merged = merge(online, offline);
      assert.notEqual(merged, offline, "an overlay returns a new doc");
      assert.equal(merged.remote.source, "none");
      assert.deepEqual(Object.keys(merged).sort(), Object.keys(offline).sort());
      for (const k of [
        "schema", "generated_at", "offline", "root", "contexo_dir", "project", "server", "remote", "captures", "warnings",
      ] as const) {
        assert.deepEqual(merged[k], offline[k], k);
      }
    });

    it("a merge with nothing to overlay still returns a new doc with recomputed counts", () => {
      const { online, offline } = docs();
      online.pages = online.pages.filter((p) => !["incoming", "incoming_new", "conflict"].includes(p.state));
      offline.counts = zeroCounts();
      const merged = merge(online, offline);
      assert.notEqual(merged, offline);
      assert.deepEqual(merged.pages, offline.pages);
      assert.deepEqual(merged.counts, countStates(offline.pages));
    });

    it("inputs are never mutated", () => {
      const { online, offline } = docs();
      entry(offline, RETRY).state = "modified"; // incoming -> conflict
      put(offline, bare("wiki/aaa.md", "new", { local: { file: "wiki/aaa.md" } })); // out of order
      offline.pages.reverse();
      const before = structuredClone({ online, offline });
      mergeOffline(online, offline);
      assert.deepEqual({ online, offline }, before);

      // Frozen inputs: any write (or an in-place sort) throws in strict mode.
      const frozen = { online: deepFreeze(structuredClone(online)), offline: deepFreeze(structuredClone(offline)) };
      assert.doesNotThrow(() => mergeOffline(frozen.online, frozen.offline));
    });

    it("the merged doc shares no objects with its inputs", () => {
      const { online, offline } = docs();
      const merged = merge(online, offline);
      const inputs = objectsOf({ online, offline });
      for (const o of objectsOf(merged)) { assert.ok(!inputs.has(o), "merged doc aliases an input object"); }
    });
  });

  describe("countStates", () => {
    it("counts nothing for no pages", () => {
      assert.deepEqual(countStates([]), zeroCounts());
    });

    it("counts per state with ahead = modified + new and behind = incoming + incoming_new", () => {
      const pages = PAGE_STATES.map((s, i) => bare(`p${i}.md`, s));
      const one: StateCounts = { ...zeroCounts(), ahead: 2, behind: 2 };
      for (const s of PAGE_STATES) { one[s] = 1; }
      assert.deepEqual(countStates(pages), one);

      const more = [
        bare("a.md", "modified"), bare("b.md", "modified"), bare("c.md", "new"),
        bare("d.md", "incoming"), bare("e.md", "incoming_new"), bare("f.md", "incoming_new"),
        bare("g.md", "conflict", { conflict_kind: "both_added" }),
      ];
      assert.deepEqual(countStates(more), {
        ...zeroCounts(), modified: 2, new: 1, incoming: 1, incoming_new: 2, conflict: 1, ahead: 3, behind: 3,
      });
    });

    it("matches the counts ctx reported for the fixtures", () => {
      assert.deepEqual(countStates(ONLINE.pages), ONLINE.counts);
      assert.deepEqual(countStates(OFFLINE.pages), OFFLINE.counts);
    });
  });
});
