// pushPlan / pushSelectedPlan (src/commands/sync.ts, WP-1.13): which pages a push sends.
// Pure functions over StatusDoc / PageEntry; sync.ts itself loads over the vscode stub.
import * as assert from "node:assert/strict";
import { PUSHABLE_STATES, distillMessage, pushPlan, pushSelectedPlan } from "../../../src/commands/sync";
import { PAGE_STATES, type PageEntry, type PageState, type StatusDoc } from "../../../src/contract/types";
import { loadStatusDoc } from "../../helpers/fixtures";

/** A minimal status entry. */
function page(path: string, state: PageState): PageEntry {
  return { path, state, tags: [], notes: [] };
}

/** The 'clean' StatusDoc with its pages replaced (the rest of the doc is irrelevant to the plan). */
function statusWith(pages: PageEntry[]): StatusDoc {
  return { ...loadStatusDoc("clean"), pages };
}

describe("pushPlan / pushSelectedPlan (src/commands/sync.ts)", () => {
  it("mixed plans exactly [wiki/analyses/sync-model.md, wiki/concepts/auth-flow.md]", () => {
    const mixed = loadStatusDoc("mixed");
    // Derived from the fixture too, so a fixture edit cannot silently change what is asserted.
    const expected = mixed.pages.filter((p) => p.state === "modified" || p.state === "new").map((p) => p.path);
    assert.deepEqual(expected, ["wiki/analyses/sync-model.md", "wiki/concepts/auth-flow.md"]);
    assert.deepEqual(pushPlan(mixed), ["wiki/analyses/sync-model.md", "wiki/concepts/auth-flow.md"]);
  });

  it("a clean status gives []", () => {
    assert.deepEqual(pushPlan(loadStatusDoc("clean")), []);
  });

  it("no excluded state is ever planned", () => {
    assert.deepEqual([...PUSHABLE_STATES], ["modified", "new"]);
    assert.equal(PAGE_STATES.length, 9, "the closed v1 PageState enum");
    // One page per state, paths sorted like ctx sorts them (p0 .. p8 in PAGE_STATES order).
    const pages = PAGE_STATES.map((state, i) => page(`wiki/concepts/p${i}-${state}.md`, state));
    assert.deepEqual(pushPlan(statusWith(pages)), ["wiki/concepts/p1-modified.md", "wiki/concepts/p2-new.md"], "status order");

    // The table: alone in a status, each state is planned exactly when it is modified or new.
    for (const state of PAGE_STATES) {
      const planned = pushPlan(statusWith([page("wiki/concepts/only.md", state)]));
      const pushable = state === "modified" || state === "new";
      assert.deepEqual(planned, pushable ? ["wiki/concepts/only.md"] : [], `state ${state}`);
    }
  });

  it("pushSelectedPlan keeps only modified and new", () => {
    const selection = [
      page("wiki/concepts/rate-limits.md", "conflict"),
      page("wiki/concepts/auth-flow.md", "modified"),
      page("wiki/entities/billing.md", "incoming_new"),
      page("wiki/analyses/sync-model.md", "new"),
      page("wiki/concepts/auth-flow.md", "modified"), // selected twice
      page("wiki/concepts/old-name.md", "deleted_local"),
      page("wiki/concepts/broken.md", "invalid"),
      page("wiki/concepts/legacy-sync.md", "unverified"),
      page("wiki/concepts/retry-policy.md", "incoming"),
      page("wiki/entities/gitstore.md", "unchanged"),
    ];
    // The selection's order (not path order), first occurrence kept.
    assert.deepEqual(pushSelectedPlan(selection), ["wiki/concepts/auth-flow.md", "wiki/analyses/sync-model.md"]);
    assert.deepEqual(pushSelectedPlan([]), []);
    for (const state of PAGE_STATES) {
      const pushable = state === "modified" || state === "new";
      assert.deepEqual(pushSelectedPlan([page("a.md", state)]), pushable ? ["a.md"] : [], `state ${state}`);
    }
  });

  it("distillMessage (the D4 modal) asks to keep the decision record (L22 wording)", () => {
    assert.equal(distillMessage(2),
      "2 agent session(s) have not been distilled yet. Share these pages through your agent so the decision record is kept.");
    assert.doesNotMatch(distillMessage(1), /reasoning/i);
  });
});
