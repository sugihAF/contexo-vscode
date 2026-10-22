// The shared Go/TS SCM-group check (E29, E30, E33; WP-2.3) over the vendored contract
// fixture test/fixtures/contract/v1/classify.cases.json: for every row, the contract
// mapping groupFor(expected.state) equals the row's scm_group, the SCM module's grouping
// (groupDescriptors in src/scm/resourceModel.ts, named in WP-1.9.md) puts the page in
// exactly that group, the SourceControl.count rule counts it per E29, and the knowledge
// tree lists it per E30. Plain mocha: the modules under test are vscode-free.
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  groupFor, listedInTree, scmCount,
  type PageEntry, type PageState, type ScmGroup, type StateCounts, type StatusDoc,
} from "../../../src/contract/types";
import { countFor, groupDescriptors } from "../../../src/scm/resourceModel";
import { buildTree, type GroupNode, type PageNode, type TreeNode } from "../../../src/tree/treeModel";
import { REPO_ROOT, loadStatusDoc } from "../../helpers/fixtures";

interface SideInput { kind: string; sha?: string; hash?: string }
interface ClassifyCase {
  id: string;
  desc: string;
  input: { local: SideInput; base: SideInput; remote: SideInput };
  expected: { state: PageState | ""; conflict_kind?: string; notes: string[] };
  scm_group: ScmGroup | null;
}

const CASES_FILE = path.join(REPO_ROOT, "test", "fixtures", "contract", "v1", "classify.cases.json");
const cases = (JSON.parse(fs.readFileSync(CASES_FILE, "utf8")) as { cases: ClassifyCase[] }).cases;

/** States SourceControl.count always counts (E29). */
const COUNTED: ReadonlySet<string> = new Set(["conflict", "modified", "new"]);
/** States counted only with contexo.scm.countIncoming. */
const COUNTED_WITH_INCOMING: ReadonlySet<string> = new Set(["incoming", "incoming_new"]);

const SHA = "1a8e354f429932ea44e404851bc0356126bfe13f";
const HASH = "sha256:c962f57bf6627ac871cc526e11f26500dcf1f1e1ba64623c448fa09ae61ef7dc";

/** One PageEntry shaped like ctx would emit it for the row (sides present per the row's input). */
function entryFor(c: ClassifyCase, state: PageState): PageEntry {
  const rel = `wiki/concepts/${c.id}.md`;
  const e: PageEntry = { path: rel, state, type: "concept", slug: c.id, tags: [], notes: [...c.expected.notes] };
  if (c.input.local.kind !== "absent") {
    e.local = { file: rel, ...(c.input.local.kind === "invalid" ? {} : { hash: c.input.local.hash ?? HASH }) };
  }
  if (c.input.base.kind !== "none") {
    e.base = { sha: c.input.base.sha ?? SHA, hash: c.input.base.hash ?? HASH, stale: c.input.base.kind !== "valid" };
  }
  if (c.input.remote.kind === "present") { e.remote = { sha: c.input.remote.sha ?? SHA }; }
  if (state === "conflict") { e.conflict_kind = (c.expected.conflict_kind ?? "both_modified") as PageEntry["conflict_kind"]; }
  if (state === "invalid") { e.invalid = { stage: "parse", message: "frontmatter: cannot parse" }; }
  return e;
}

function zeroCounts(): StateCounts {
  return {
    unchanged: 0, modified: 0, new: 0, incoming: 0, incoming_new: 0, conflict: 0,
    deleted_local: 0, invalid: 0, unverified: 0, ahead: 0, behind: 0,
  };
}

/** The 'mixed' StatusDoc with only this entry (counts recomputed). */
function statusWith(entry: PageEntry): StatusDoc {
  const doc = loadStatusDoc("mixed");
  const counts = zeroCounts();
  counts[entry.state] = 1;
  counts.ahead = entry.state === "modified" || entry.state === "new" ? 1 : 0;
  counts.behind = entry.state === "incoming" || entry.state === "incoming_new" ? 1 : 0;
  return { ...doc, pages: [entry], counts, captures: { ...doc.captures, pending: 0, fresh: 0, blocks_push: false, sessions: [] } };
}

function treePages(nodes: readonly TreeNode[]): PageNode[] {
  return nodes.flatMap((n): PageNode[] => {
    switch (n.kind) {
      case "page": return [n];
      case "group": return n.pages;
      case "repo": return treePages(n.children);
      default: return [];
    }
  });
}

function treeGroups(nodes: readonly TreeNode[]): GroupNode[] {
  return nodes.flatMap((n): GroupNode[] => (n.kind === "group" ? [n] : n.kind === "repo" ? treeGroups(n.children) : []));
}

describe("contract: SCM groups, count and tree membership over classify.cases.json (E29, E30)", () => {
  it("the vendored fixture has the 21 contract rows", () => {
    assert.equal(cases.length, 21);
    assert.equal(new Set(cases.map((c) => c.id)).size, 21, "row ids are unique");
  });

  for (const c of cases) {
    describe(`${c.id}: ${c.desc}`, () => {
      const state = c.expected.state;

      it(`groupFor(${JSON.stringify(state)}) == scm_group ${JSON.stringify(c.scm_group)}`, () => {
        const group = state === "" ? undefined : groupFor(state);
        assert.equal(group ?? null, c.scm_group);
      });

      if (state === "") {
        it("no entry: no group, no count, no tree item", () => {
          assert.equal(c.scm_group, null);
          assert.equal(c.input.local.kind, "absent", "a row without an entry has no local file");
        });
        return;
      }

      const entry = entryFor(c, state);
      const doc = statusWith(entry);

      it("the SCM module's grouping (groupDescriptors) equals groupFor", () => {
        const holding = groupDescriptors(doc).filter((g) => g.resources.some((r) => r.relPath === entry.path)).map((g) => g.id);
        assert.deepEqual(holding, c.scm_group === null ? [] : [c.scm_group]);
        for (const g of groupDescriptors(doc)) {
          for (const r of g.resources) { assert.equal(r.contextValue, state, "contextValue is the PageState"); }
        }
      });

      it("SourceControl.count (E29): counted per state, incoming only with countIncoming", () => {
        const plain = COUNTED.has(state) ? 1 : 0;
        const withIncoming = plain + (COUNTED_WITH_INCOMING.has(state) ? 1 : 0);
        assert.equal(scmCount(doc.counts, false), plain);
        assert.equal(scmCount(doc.counts, true), withIncoming);
        assert.equal(countFor(doc, false), plain, "the SCM module uses the E29 rule");
        assert.equal(countFor(doc, true), withIncoming, "the SCM module uses the E29 rule (countIncoming)");
      });

      it("knowledge tree (E30): listed iff the working file exists; invalid under 'Invalid'", () => {
        const hasLocal = c.input.local.kind !== "absent";
        assert.equal(listedInTree(entry), hasLocal);
        if (state === "incoming_new" || state === "deleted_local") {
          assert.equal(hasLocal, false, `${state} has no working file`);
        }
        const nodes = buildTree([{ root: "/r", name: "r", status: doc }], { showSessions: true });
        const listed = treePages(nodes).filter((p) => p.path === entry.path);
        assert.equal(listed.length, hasLocal ? 1 : 0, "the tree lists exactly the entries with a local file");
        if (hasLocal) {
          const holder = treeGroups(nodes).find((g) => g.pages.some((p) => p.path === entry.path));
          assert.equal(holder?.key === "invalid", state === "invalid", "only invalid entries sit under 'Invalid'");
        }
      });
    });
  }

  it("mixed: count is 3, 5 with countIncoming; deleted_local, invalid and unverified are never counted", () => {
    const mixed = loadStatusDoc("mixed");
    assert.equal(scmCount(mixed.counts, false), 3);
    assert.equal(scmCount(mixed.counts, true), 5);
    assert.equal(countFor(mixed, false), 3);
    assert.equal(countFor(mixed, true), 5);
    for (const state of ["deleted_local", "invalid", "unverified"] as const) {
      const bumped = { ...mixed.counts, [state]: mixed.counts[state] + 7 };
      assert.equal(scmCount(bumped, false), 3, `${state} never counts`);
      assert.equal(scmCount(bumped, true), 5, `${state} never counts, even with countIncoming`);
    }
  });
});
