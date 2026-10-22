// decorationModel.diff in plain mocha: which page decorations changed between two statuses.
import * as assert from "node:assert/strict";
import type { PageEntry, PageState, StatusDoc } from "../../../src/contract/types";
import { diff } from "../../../src/decorations/decorationModel";
import { loadStatusDoc } from "../../helpers/fixtures";

/** The pages 'mixed' decorates (every state but unchanged), sorted. */
const MIXED_DECORATED = [
  "wiki/analyses/sync-model.md",
  "wiki/concepts/auth-flow.md",
  "wiki/concepts/broken.md",
  "wiki/concepts/legacy-sync.md",
  "wiki/concepts/old-name.md",
  "wiki/concepts/rate-limits.md",
  "wiki/concepts/retry-policy.md",
  "wiki/entities/billing.md",
];

function page(doc: StatusDoc, relPath: string): PageEntry {
  const p = doc.pages.find((e) => e.path === relPath);
  assert.ok(p, `fixture page ${relPath}`);
  return p;
}

function entry(relPath: string, state: PageState | (string & {})): PageEntry {
  return { path: relPath, state: state as PageState, tags: [], notes: [] };
}

describe("decorations diff", () => {
  it("diff of two statuses returns exactly the changed paths", () => {
    const prev = loadStatusDoc("mixed");
    const next = structuredClone(prev);
    page(next, "wiki/concepts/retry-policy.md").state = "conflict"; // ↓ -> !: changed
    next.pages = next.pages.filter((p) => p.path !== "wiki/concepts/old-name.md"); // D -> gone: removed
    next.pages.push(entry("wiki/concepts/fresh.md", "new")); // gone -> A: added
    const authFlowBase = page(next, "wiki/concepts/auth-flow.md").base;
    assert.ok(authFlowBase);
    authFlowBase.sha = "0000000000000000000000000000000000000000"; // M stays M: not reported
    page(next, "wiki/concepts/rate-limits.md").title = "Rate limits (v2)"; // ! stays !: not reported
    page(next, "wiki/entities/gitstore.md").title = "Gitstore (renamed)"; // undecorated either way
    next.pages = next.pages.filter((p) => p.path !== "raw/sessions/2026-10-01-login-debug.md"); // unchanged -> gone: nothing to clear

    const changed = ["wiki/concepts/fresh.md", "wiki/concepts/old-name.md", "wiki/concepts/retry-policy.md"];
    assert.deepEqual(diff(prev, next), changed);
    assert.deepEqual(diff(next, prev), changed, "symmetric");

    assert.deepEqual(diff(undefined, prev), MIXED_DECORATED, "undefined -> doc reports every decorated path");
    assert.deepEqual(diff(prev, undefined), MIXED_DECORATED, "doc -> undefined clears every decorated path");
    assert.deepEqual(diff(undefined, undefined), []);
    assert.deepEqual(diff(prev, structuredClone(prev)), [], "an equal status changes nothing");
    assert.deepEqual(diff(prev, prev), []);
  });

  it("any field change counts: incoming -> incoming_new keeps the badge and color but changes the tooltip", () => {
    const prev = loadStatusDoc("mixed");
    const next = structuredClone(prev);
    page(next, "wiki/concepts/retry-policy.md").state = "incoming_new";
    assert.deepEqual(diff(prev, next), ["wiki/concepts/retry-policy.md"]);
  });

  it("a page becoming unchanged is reported; unchanged -> an unknown future state is not", () => {
    const prev = loadStatusDoc("mixed");
    const next = structuredClone(prev);
    page(next, "wiki/concepts/auth-flow.md").state = "unchanged";
    page(next, "wiki/entities/gitstore.md").state = "renamed" as PageState;
    assert.deepEqual(diff(prev, next), ["wiki/concepts/auth-flow.md"]);
  });

  it("the result is sorted with no duplicates whatever the page order", () => {
    const prev = loadStatusDoc("clean");
    const next = structuredClone(prev);
    next.pages = [
      entry("wiki/z.md", "modified"),
      entry("raw/a.md", "new"),
      entry("wiki/m.md", "conflict"),
      entry("wiki/z.md", "modified"),
      entry("raw/a.md", "new"),
    ];
    const got = diff(prev, next);
    assert.deepEqual(got, ["raw/a.md", "wiki/m.md", "wiki/z.md"]);
    assert.deepEqual(diff(next, prev), got);
  });
});
