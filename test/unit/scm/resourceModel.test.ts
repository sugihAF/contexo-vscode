// The pure SCM presentation model (src/scm/resourceModel.ts) over the WP-0.6 'mixed'
// baseline: group membership strictly through groupFor, path order, contextValue = the
// PageState, tooltips, click specs, the E29 count, group signatures and the input-box
// placeholder. Plain mocha: no vscode import (the module itself is vscode-free).
import * as assert from "node:assert/strict";
import { PAGE_STATES, groupFor, type PageEntry, type ScmGroup, type StatusDoc } from "../../../src/contract/types";
import {
  DELETED_LOCAL_TOOLTIP, GROUP_LABELS, GROUP_ORDER, changedGroups, clickFor, countFor, diffLabel, groupDescriptors,
  groupSignature, hideWhenEmpty, keyLabel, placeholderFor, tooltipFor,
  type ClickSpec, type GroupDescriptor, type ResourceDescriptor, type UriSpec,
} from "../../../src/scm/resourceModel";
import { loadStatusDoc } from "../../helpers/fixtures";

/** The 'mixed' page paths (test/fixtures/ctx/scenarios/mixed/status.json). */
const P = {
  loginDebug: "raw/sessions/2026-10-01-login-debug.md",
  syncModel: "wiki/analyses/sync-model.md",
  authFlow: "wiki/concepts/auth-flow.md",
  broken: "wiki/concepts/broken.md",
  legacySync: "wiki/concepts/legacy-sync.md",
  oldName: "wiki/concepts/old-name.md",
  rateLimits: "wiki/concepts/rate-limits.md",
  retryPolicy: "wiki/concepts/retry-policy.md",
  billing: "wiki/entities/billing.md",
  gitstore: "wiki/entities/gitstore.md",
} as const;

const file = (relPath: string): UriSpec => ({ kind: "file", relPath });
const base = (relPath: string): UriSpec => ({ kind: "contexo", ref: "base", relPath });
const server = (relPath: string): UriSpec => ({ kind: "contexo", ref: "server", relPath });

const mixed = (): StatusDoc => loadStatusDoc("mixed");

function pageOf(doc: StatusDoc, relPath: string): PageEntry {
  const p = doc.pages.find((e) => e.path === relPath);
  if (!p) { throw new Error(`no page ${relPath}`); }
  return p;
}

/** A deep copy of one 'mixed' page, edited by `edit`. */
function mixedPage(relPath: string, edit: (p: PageEntry) => void = () => undefined): PageEntry {
  const p = structuredClone(pageOf(mixed(), relPath));
  edit(p);
  return p;
}

function resourceOf(groups: readonly GroupDescriptor[], relPath: string): ResourceDescriptor {
  for (const g of groups) {
    const r = g.resources.find((e) => e.relPath === relPath);
    if (r) { return r; }
  }
  throw new Error(`${relPath} is in no group`);
}

function groupIdsOf(groups: readonly GroupDescriptor[], relPath: string): ScmGroup[] {
  return groups.filter((g) => g.resources.some((r) => r.relPath === relPath)).map((g) => g.id);
}

function signatures(groups: readonly GroupDescriptor[]): Map<ScmGroup, string> {
  return new Map(groups.map((g) => [g.id, groupSignature(g)]));
}

describe("scm resourceModel", () => {
  it("groupDescriptors(mixed): five groups in GROUP_ORDER, path-sorted members, contextValue = PageState, E29 deleted_local tooltip + strikeThrough", () => {
    assert.deepEqual([...GROUP_ORDER], ["conflicts", "changes", "new", "incoming", "invalid"]);
    assert.deepEqual({ ...GROUP_LABELS }, {
      conflicts: "Conflicts", changes: "Changes", new: "New", incoming: "Incoming", invalid: "Invalid",
    });
    for (const id of GROUP_ORDER) { assert.equal(hideWhenEmpty(id), id !== "changes", id); }

    const doc = mixed();
    const groups = groupDescriptors(doc);
    assert.deepEqual(groups.map((g) => [g.id, g.label, g.hideWhenEmpty]), [
      ["conflicts", "Conflicts", true],
      ["changes", "Changes", false],
      ["new", "New", true],
      ["incoming", "Incoming", true],
      ["invalid", "Invalid", true],
    ]);
    assert.deepEqual(Object.fromEntries(groups.map((g) => [g.id, g.resources.map((r) => [r.relPath, r.contextValue])])), {
      conflicts: [[P.rateLimits, "conflict"]],
      changes: [[P.authFlow, "modified"], [P.oldName, "deleted_local"]],
      new: [[P.syncModel, "new"]],
      incoming: [[P.retryPolicy, "incoming"], [P.billing, "incoming_new"]],
      invalid: [[P.broken, "invalid"]],
    });

    assert.equal(DELETED_LOCAL_TOOLTIP,
      "Deleted locally. Deletes are not synced in this version; Restore Server Version brings it back.");
    assert.deepEqual(resourceOf(groups, P.oldName), {
      relPath: P.oldName,
      contextValue: "deleted_local",
      tooltip: DELETED_LOCAL_TOOLTIP,
      strikeThrough: true,
      click: { kind: "open", target: base(P.oldName), title: "Open Base Version" },
    });
    assert.deepEqual(resourceOf(groups, P.authFlow), {
      relPath: P.authFlow,
      contextValue: "modified",
      tooltip: "Modified locally",
      strikeThrough: false,
      click: { kind: "diff", left: base(P.authFlow), right: file(P.authFlow), label: "auth-flow.md (Base ↔ Local)" },
    });
    const broken = resourceOf(groups, P.broken);
    assert.equal(broken.tooltip, pageOf(doc, P.broken).invalid?.message);
    assert.equal(broken.tooltip, "page: parse frontmatter: yaml: line 9: found unexpected end of stream");

    for (const g of groups) {
      for (const r of g.resources) {
        const page = pageOf(doc, r.relPath);
        assert.equal(r.strikeThrough, r.relPath === P.oldName, `${r.relPath}: strikeThrough only for deleted_local`);
        assert.equal(r.tooltip, tooltipFor(page), `${r.relPath}: tooltip`);
        const click = clickFor(page);
        if (click === undefined) {
          assert.ok(!("click" in r), `${r.relPath}: no click key`);
        } else {
          assert.deepEqual(r.click, click, `${r.relPath}: click`);
        }
      }
    }
  });

  it("unchanged and unverified pages appear in no group", () => {
    const groups = groupDescriptors(mixed());
    for (const rel of [P.gitstore, P.loginDebug, P.legacySync]) {
      assert.deepEqual(groupIdsOf(groups, rel), [], rel);
    }
    assert.equal(groups.reduce((n, g) => n + g.resources.length, 0), 7, "10 pages, 3 in no group");
  });

  it("every group's resources are sorted by relPath even when the input pages are shuffled; groupDescriptors(undefined) gives 5 empty groups", () => {
    const expected = groupDescriptors(mixed());
    for (const order of ["reversed", "rotated", "interleaved"] as const) {
      const doc = mixed();
      const pages = [...doc.pages];
      if (order === "reversed") { pages.reverse(); }
      if (order === "rotated") { pages.push(...pages.splice(0, 4)); }
      if (order === "interleaved") {
        const odd = pages.filter((_, i) => i % 2 === 1);
        const even = pages.filter((_, i) => i % 2 === 0).reverse();
        pages.splice(0, pages.length, ...odd, ...even);
      }
      doc.pages = pages;
      const groups = groupDescriptors(doc);
      assert.deepEqual(groups, expected, order);
      for (const g of groups) {
        const paths = g.resources.map((r) => r.relPath);
        assert.deepEqual(paths, [...paths].sort(), `${order}: ${g.id} sorted`);
      }
    }

    const none = groupDescriptors(undefined);
    assert.deepEqual(none.map((g) => [g.id, g.label, g.hideWhenEmpty, g.resources]), [
      ["conflicts", "Conflicts", true, []],
      ["changes", "Changes", false, []],
      ["new", "New", true, []],
      ["incoming", "Incoming", true, []],
      ["invalid", "Invalid", true, []],
    ]);
    const empty = mixed();
    empty.pages = [];
    assert.deepEqual(groupDescriptors(empty), none, "a StatusDoc without pages gives the same 5 empty groups");
  });

  it("membership equals groupFor(state) for every page of mixed (no other mapping)", () => {
    const doc = mixed();
    const groups = groupDescriptors(doc);
    for (const p of doc.pages) {
      const g = groupFor(p.state);
      assert.deepEqual(groupIdsOf(groups, p.path), g === undefined ? [] : [g], `${p.path} (${p.state})`);
    }
    // Every PageState, on a page whose other fields stay those of auth-flow: only `state` decides.
    for (const state of PAGE_STATES) {
      const one = mixed();
      one.pages = [mixedPage(P.authFlow, (p) => { p.state = state; })];
      const g = groupFor(state);
      assert.deepEqual(groupIdsOf(groupDescriptors(one), P.authFlow), g === undefined ? [] : [g], state);
      if (g !== undefined) {
        assert.equal(resourceOf(groupDescriptors(one), P.authFlow).contextValue, state, `${state}: contextValue`);
      }
    }
  });

  it("count is 3 by default and 5 with countIncoming (E29)", () => {
    const doc = mixed();
    assert.equal(countFor(doc, false), 3);
    assert.equal(countFor(doc, true), 5);
    assert.equal(countFor(undefined, false), 0);
    assert.equal(countFor(undefined, true), 0);
  });

  it("deleted_local, invalid and unverified are never counted", () => {
    const doc = mixed();
    doc.counts.deleted_local = 50;
    doc.counts.invalid = 40;
    doc.counts.unverified = 30;
    doc.counts.unchanged = 20;
    assert.equal(countFor(doc, false), 3);
    assert.equal(countFor(doc, true), 5);

    doc.counts.incoming = 10;
    doc.counts.incoming_new = 7;
    assert.equal(countFor(doc, false), 3, "incoming is not counted without countIncoming");
    assert.equal(countFor(doc, true), 3 + 17, "incoming + incoming_new with countIncoming");

    doc.counts.conflict = 4;
    doc.counts.modified = 5;
    doc.counts.new = 6;
    assert.equal(countFor(doc, false), 15, "conflict + modified + new");
  });

  it("click kinds: modified=diff(base,file); deleted_local=open(contexo base), falling back to contexo server when base.stale; new/invalid=open(file); incoming/conflict=diff(server,file); incoming_new=open(contexo server)", () => {
    const expected: Record<string, ClickSpec | undefined> = {
      [P.authFlow]: { kind: "diff", left: base(P.authFlow), right: file(P.authFlow), label: "auth-flow.md (Base ↔ Local)" },
      [P.oldName]: { kind: "open", target: base(P.oldName), title: "Open Base Version" },
      [P.syncModel]: { kind: "open", target: file(P.syncModel), title: "Open File" },
      [P.broken]: { kind: "open", target: file(P.broken), title: "Open File" },
      [P.retryPolicy]: { kind: "diff", left: server(P.retryPolicy), right: file(P.retryPolicy), label: "retry-policy.md (Server ↔ Local)" },
      [P.rateLimits]: { kind: "diff", left: server(P.rateLimits), right: file(P.rateLimits), label: "rate-limits.md (Server ↔ Local)" },
      [P.billing]: { kind: "open", target: server(P.billing), title: "Open Server Version" },
      [P.gitstore]: undefined,
      [P.loginDebug]: undefined,
      [P.legacySync]: undefined,
    };
    const doc = mixed();
    assert.deepEqual(Object.keys(expected).sort(), doc.pages.map((p) => p.path).sort(), "every mixed page has an expectation");
    for (const p of doc.pages) { assert.deepEqual(clickFor(p), expected[p.path], `${p.path} (${p.state})`); }

    const serverVersion: ClickSpec = { kind: "open", target: server(P.oldName), title: "Open Server Version" };
    const stale = mixedPage(P.oldName, (p) => { p.base = { sha: p.base?.sha ?? "", stale: true }; });
    assert.deepEqual(clickFor(stale), serverVersion, "deleted_local with a stale base -> contexo server");
    const noBase = mixedPage(P.oldName, (p) => { delete p.base; });
    assert.deepEqual(clickFor(noBase), serverVersion, "deleted_local without a base -> contexo server");
    const staleNoRemote = mixedPage(P.oldName, (p) => { p.base = { sha: p.base?.sha ?? "", stale: true }; delete p.remote; });
    assert.equal(clickFor(staleNoRemote), undefined, "deleted_local with a stale base and no remote -> no command");
    const nothing = mixedPage(P.oldName, (p) => { delete p.base; delete p.remote; });
    assert.equal(clickFor(nothing), undefined, "deleted_local with neither side -> no command");

    const bothAdded = mixedPage(P.rateLimits, (p) => { p.conflict_kind = "both_added"; delete p.base; });
    assert.deepEqual(clickFor(bothAdded),
      { kind: "diff", left: server(P.rateLimits), right: file(P.rateLimits), label: "rate-limits.md (Server ↔ Local)" });

    const staleNoRemoteDoc = mixed();
    staleNoRemoteDoc.pages = [staleNoRemote];
    assert.ok(!("click" in resourceOf(groupDescriptors(staleNoRemoteDoc), P.oldName)), "no click key on the descriptor");

    assert.equal(diffLabel("wiki/concepts/auth-flow.md", "Base"), "auth-flow.md (Base ↔ Local)");
    assert.equal(diffLabel("top.md", "Server"), "top.md (Server ↔ Local)");
  });

  it("tooltips per state: author suffix from remote.author, invalid.message, the E29 deleted_local text, none for unchanged/unverified", () => {
    assert.equal(tooltipFor(mixedPage(P.retryPolicy)), "Changed on the server by Bob Lee");
    assert.equal(tooltipFor(mixedPage(P.billing)), "New on the server by Bob Lee");
    assert.equal(tooltipFor(mixedPage(P.rateLimits)), "Conflict: changed locally and on the server by Bob Lee");
    assert.equal(tooltipFor(mixedPage(P.rateLimits, (p) => { p.conflict_kind = "both_added"; delete p.base; })),
      "Conflict: created locally and on the server by Bob Lee");

    const anonymous = (p: PageEntry): void => { if (p.remote) { delete p.remote.author; } };
    assert.equal(tooltipFor(mixedPage(P.retryPolicy, anonymous)), "Changed on the server");
    assert.equal(tooltipFor(mixedPage(P.billing, anonymous)), "New on the server");
    assert.equal(tooltipFor(mixedPage(P.rateLimits, anonymous)), "Conflict: changed locally and on the server");
    assert.equal(tooltipFor(mixedPage(P.rateLimits, (p) => { anonymous(p); p.conflict_kind = "both_added"; })),
      "Conflict: created locally and on the server");
    assert.equal(tooltipFor(mixedPage(P.retryPolicy, (p) => { delete p.remote; })), "Changed on the server");
    // The frontmatter author (page.author, 'alice') is not the server-side author.
    assert.equal(mixedPage(P.retryPolicy).author, "alice");

    assert.equal(tooltipFor(mixedPage(P.authFlow)), "Modified locally");
    assert.equal(tooltipFor(mixedPage(P.syncModel)), "New: not on the server yet");
    assert.equal(tooltipFor(mixedPage(P.broken)), "page: parse frontmatter: yaml: line 9: found unexpected end of stream");
    assert.equal(tooltipFor(mixedPage(P.broken, (p) => { delete p.invalid; })), "ctx cannot read this page");
    assert.equal(tooltipFor(mixedPage(P.oldName)), DELETED_LOCAL_TOOLTIP);
    assert.equal(tooltipFor(mixedPage(P.gitstore)), undefined);
    assert.equal(tooltipFor(mixedPage(P.loginDebug)), undefined);
    assert.equal(tooltipFor(mixedPage(P.legacySync)), undefined);
  });

  it("an unchanged group signature produces no reassignment", () => {
    const before = groupDescriptors(mixed());
    const prev = signatures(before);
    assert.deepEqual(changedGroups(prev, groupDescriptors(structuredClone(mixed()))), []);
    assert.deepEqual(changedGroups(new Map(), before), [...GROUP_ORDER], "a missing entry counts as different");
    assert.deepEqual(changedGroups(new Map([["new", groupSignature(before[2] as GroupDescriptor)]]), before),
      ["conflicts", "changes", "incoming", "invalid"]);

    assert.deepEqual(changedGroups(prev, groupDescriptors(loadStatusDoc("e3-retry-conflict"))), ["conflicts", "incoming"]);

    const author = mixed();
    const rp = pageOf(author, P.retryPolicy);
    if (rp.remote) { rp.remote.author = "Carol Diaz"; }
    assert.deepEqual(changedGroups(prev, groupDescriptors(author)), ["incoming"], "a tooltip-only change");

    const click = mixed();
    pageOf(click, P.oldName).base = { sha: "6cdaea343dff8071da0bca651f4f201d0f471f61", stale: true };
    assert.deepEqual(changedGroups(prev, groupDescriptors(click)), ["changes"], "a click-only change");

    const invisible = mixed();
    invisible.generated_at = "2026-10-15T10:00:00Z";
    invisible.counts.unchanged = 99;
    pageOf(invisible, P.authFlow).reasoning_summary = "Rewritten.";
    pageOf(invisible, P.authFlow).updated = "2026-10-15T09:59:00Z";
    pageOf(invisible, P.gitstore).title = "Git store";
    assert.deepEqual(changedGroups(prev, groupDescriptors(invisible)), [], "fields nothing renders do not reassign");

    const empties = groupDescriptors(undefined);
    assert.equal(new Set(empties.map(groupSignature)).size, 5, "empty groups still differ by id");
    assert.deepEqual(changedGroups(prev, empties), [...GROUP_ORDER]);
  });

  it("blocks_push=true switches the placeholder, with the platform key label", () => {
    assert.equal(keyLabel("darwin"), "⌘Enter");
    assert.equal(keyLabel("linux"), "Ctrl+Enter");
    assert.equal(keyLabel("win32"), "Ctrl+Enter");

    const doc = mixed();
    assert.equal(placeholderFor(doc, "darwin"), "Message (⌘Enter to push to Contexo)");
    assert.equal(placeholderFor(doc, "linux"), "Message (Ctrl+Enter to push to Contexo)");
    assert.equal(placeholderFor(doc, "win32"), "Message (Ctrl+Enter to push to Contexo)");
    assert.equal(placeholderFor(undefined, "darwin"), "Message (⌘Enter to push to Contexo)");
    assert.equal(placeholderFor(undefined, "linux"), "Message (Ctrl+Enter to push to Contexo)");

    const blocked = loadStatusDoc("e3-blocks-push");
    assert.equal(placeholderFor(blocked, "darwin"), "1 agent session(s) not distilled: ⌘Enter offers Share via your agent");
    assert.equal(placeholderFor(blocked, "win32"), "1 agent session(s) not distilled: Ctrl+Enter offers Share via your agent");
    assert.equal(placeholderFor(blocked, "linux"), "1 agent session(s) not distilled: Ctrl+Enter offers Share via your agent");

    const zero = mixed();
    zero.captures.blocks_push = true;
    zero.captures.fresh = 0;
    assert.equal(placeholderFor(zero, "darwin"), "1 agent session(s) not distilled: ⌘Enter offers Share via your agent", "N = max(1, fresh)");
    const three = mixed();
    three.captures.blocks_push = true;
    three.captures.fresh = 3;
    assert.equal(placeholderFor(three, "darwin"), "3 agent session(s) not distilled: ⌘Enter offers Share via your agent");

    const freshButAllowed = mixed();
    freshButAllowed.captures.fresh = 2;
    assert.equal(placeholderFor(freshButAllowed, "darwin"), "Message (⌘Enter to push to Contexo)", "only blocks_push switches it");
  });
});
