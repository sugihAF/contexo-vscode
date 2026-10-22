// View All Changes tuples (changesTuples in src/scm/resourceModel.ts): one
// [resource, original, modified] UriSpec triple per page of a group, per the table in its
// doc comment, in path order. Plain mocha over the 'mixed' baseline; no vscode import.
import * as assert from "node:assert/strict";
import { groupFor, type PageEntry, type PageState, type ScmGroup, type StatusDoc } from "../../../src/contract/types";
import { GROUP_ORDER, changesTuples, type ChangeTuple, type UriSpec } from "../../../src/scm/resourceModel";
import { loadStatusDoc } from "../../helpers/fixtures";

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
const empty = (relPath: string): UriSpec => ({ kind: "contexo", ref: "empty", relPath });

const mixed = (): StatusDoc => loadStatusDoc("mixed");

/** 'mixed' reduced to the one page at relPath, edited by `edit`. */
function only(relPath: string, edit: (p: PageEntry) => void = () => undefined): StatusDoc {
  const doc = mixed();
  const p = doc.pages.find((e) => e.path === relPath);
  if (!p) { throw new Error(`no page ${relPath}`); }
  edit(p);
  doc.pages = [p];
  return doc;
}

/** The group a single-page doc's page belongs to (every case below has one). */
function groupOf(doc: StatusDoc): ScmGroup {
  const g = groupFor((doc.pages[0] as PageEntry).state);
  if (!g) { throw new Error("page in no group"); }
  return g;
}

describe("scm changesTuples", () => {
  const table: [PageState, string, ChangeTuple][] = [
    ["modified", P.authFlow, [file(P.authFlow), base(P.authFlow), file(P.authFlow)]],
    ["deleted_local", P.oldName, [file(P.oldName), base(P.oldName), empty(P.oldName)]],
    ["new", P.syncModel, [file(P.syncModel), empty(P.syncModel), file(P.syncModel)]],
    ["incoming", P.retryPolicy, [file(P.retryPolicy), server(P.retryPolicy), file(P.retryPolicy)]],
    ["incoming_new", P.billing, [file(P.billing), empty(P.billing), server(P.billing)]],
    ["conflict", P.rateLimits, [file(P.rateLimits), server(P.rateLimits), file(P.rateLimits)]],
  ];
  for (const [state, rel, tuple] of table) {
    it(`${state}: [${tuple.map((s) => (s.kind === "file" ? "file" : s.ref)).join(", ")}]`, () => {
      const doc = only(rel);
      assert.equal((doc.pages[0] as PageEntry).state, state);
      assert.deepEqual(changesTuples(groupOf(doc), doc), [tuple]);
    });
  }

  it("conflict both_added (no base): [file, server, file]", () => {
    const doc = only(P.rateLimits, (p) => { p.conflict_kind = "both_added"; delete p.base; });
    assert.deepEqual(changesTuples("conflicts", doc), [[file(P.rateLimits), server(P.rateLimits), file(P.rateLimits)]]);
  });

  it("deleted_local with a stale or missing base: [file, server, empty]; with no remote either: no tuple", () => {
    const viaServer: ChangeTuple = [file(P.oldName), server(P.oldName), empty(P.oldName)];
    const stale = (p: PageEntry): void => { p.base = { sha: p.base?.sha ?? "", stale: true }; };
    assert.deepEqual(changesTuples("changes", only(P.oldName, stale)), [viaServer], "stale base");
    assert.deepEqual(changesTuples("changes", only(P.oldName, (p) => { delete p.base; })), [viaServer], "missing base");
    assert.deepEqual(changesTuples("changes", only(P.oldName, (p) => { stale(p); delete p.remote; })), [], "stale base, no remote");
    assert.deepEqual(changesTuples("changes", only(P.oldName, (p) => { delete p.base; delete p.remote; })), [], "neither side");
  });

  it("invalid has no tuple; changesTuples(x, undefined) is []", () => {
    assert.deepEqual(changesTuples("invalid", mixed()), []);
    for (const g of GROUP_ORDER) { assert.deepEqual(changesTuples(g, undefined), [], g); }
  });

  it("the incoming group of mixed gives retry-policy then billing; each group is in path order", () => {
    const doc = mixed();
    assert.deepEqual(changesTuples("incoming", doc), [
      [file(P.retryPolicy), server(P.retryPolicy), file(P.retryPolicy)],
      [file(P.billing), empty(P.billing), server(P.billing)],
    ]);
    assert.deepEqual(changesTuples("changes", doc), [
      [file(P.authFlow), base(P.authFlow), file(P.authFlow)],
      [file(P.oldName), base(P.oldName), empty(P.oldName)],
    ]);
    const reversed = mixed();
    reversed.pages.reverse();
    for (const g of GROUP_ORDER) {
      assert.deepEqual(changesTuples(g, reversed), changesTuples(g, doc), `${g}: reversed input`);
    }
  });

  it("a page whose state is not in the group is never included", () => {
    const doc = mixed();
    const resources = (g: ScmGroup): string[] => changesTuples(g, doc).map((t) => t[0].relPath);
    assert.deepEqual(resources("conflicts"), [P.rateLimits]);
    assert.deepEqual(resources("changes"), [P.authFlow, P.oldName]);
    assert.deepEqual(resources("new"), [P.syncModel]);
    assert.deepEqual(resources("incoming"), [P.retryPolicy, P.billing]);
    assert.deepEqual(resources("invalid"), []);
    for (const g of GROUP_ORDER) {
      for (const t of changesTuples(g, doc)) {
        const page = doc.pages.find((p) => p.path === t[0].relPath);
        assert.equal(page && groupFor(page.state), g, `${t[0].relPath} in ${g}`);
        assert.ok(t.every((s) => s.relPath === t[0].relPath), `${t[0].relPath}: every side names the same page`);
      }
    }
    for (const rel of [P.gitstore, P.loginDebug, P.legacySync]) {
      for (const g of GROUP_ORDER) {
        assert.ok(!changesTuples(g, doc).some((t) => t[0].relPath === rel), `${rel} never in ${g}`);
      }
    }
    // A conflict page asked for as 'incoming' (and an incoming page as 'conflicts') is left out.
    assert.deepEqual(changesTuples("incoming", only(P.rateLimits)), []);
    assert.deepEqual(changesTuples("conflicts", only(P.retryPolicy)), []);
    assert.deepEqual(changesTuples("changes", only(P.broken)), []);
  });
});
