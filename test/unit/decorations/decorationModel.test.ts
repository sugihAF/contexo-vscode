// Page-state decorations (src/decorations/decorationModel.ts) in plain mocha: the module is
// pure, so no vscode stub is involved.
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { PAGE_STATES, type PageState, type StatusDoc } from "../../../src/contract/types";
import {
  decorationForState,
  decorationsOf,
  isExcludedRelPath,
  type PageDecoration,
} from "../../../src/decorations/decorationModel";
import { loadStatusDoc, REPO_ROOT } from "../../helpers/fixtures";

const DOWN_ARROW = 0x2193;
const WARNING_SIGN = 0x26a0;
const VARIATION_SELECTOR_16 = 0xfe0f;

/** The binding table (WP-1.10 spec): every PageState and what it looks like. */
const EXPECTED: Record<PageState, PageDecoration | undefined> = {
  unchanged: undefined,
  modified: { badge: "M", color: "contexo.modifiedForeground", tooltip: "Contexo: modified", propagate: true },
  new: { badge: "A", color: "contexo.addedForeground", tooltip: "Contexo: new", propagate: false },
  incoming: { badge: String.fromCodePoint(DOWN_ARROW), color: "contexo.incomingForeground", tooltip: "Contexo: incoming change", propagate: false },
  incoming_new: { badge: String.fromCodePoint(DOWN_ARROW), color: "contexo.incomingForeground", tooltip: "Contexo: incoming new page", propagate: false },
  conflict: { badge: "!", color: "contexo.conflictForeground", tooltip: "Contexo: conflict", propagate: true },
  deleted_local: { badge: "D", color: "gitDecoration.deletedResourceForeground", tooltip: "Contexo: deleted locally", propagate: false },
  invalid: { badge: String.fromCodePoint(WARNING_SIGN), color: "contexo.invalidForeground", tooltip: "Contexo: invalid page", propagate: false },
  unverified: { badge: "?", tooltip: "Contexo: unverified", propagate: false },
};

/** A PageDecoration as a plain object (own enumerable keys only), for deepEqual. */
function plain(d: PageDecoration | undefined): PageDecoration | undefined {
  return d === undefined ? undefined : { ...d };
}

function page(doc: StatusDoc, relPath: string): StatusDoc["pages"][number] {
  const p = doc.pages.find((e) => e.path === relPath);
  assert.ok(p, `fixture page ${relPath}`);
  return p;
}

describe("decorationModel", () => {
  it("mixed gives auth-flow M, sync-model A, retry-policy ↓, billing ↓, rate-limits !, broken ⚠, old-name D, and the unverified entry ?", () => {
    const doc = loadStatusDoc("mixed");
    const got = decorationsOf(doc);
    const badges = Object.fromEntries([...got].map(([p, d]) => [p, d.badge]));
    assert.deepEqual(badges, {
      "wiki/analyses/sync-model.md": "A",
      "wiki/concepts/auth-flow.md": "M",
      "wiki/concepts/broken.md": "⚠",
      "wiki/concepts/legacy-sync.md": "?",
      "wiki/concepts/old-name.md": "D",
      "wiki/concepts/rate-limits.md": "!",
      "wiki/concepts/retry-policy.md": "↓",
      "wiki/entities/billing.md": "↓",
    });
    assert.equal(page(doc, "wiki/concepts/legacy-sync.md").state, "unverified", "the ? entry is the unverified one");
    for (const unchanged of ["raw/sessions/2026-10-01-login-debug.md", "wiki/entities/gitstore.md"]) {
      assert.equal(page(doc, unchanged).state, "unchanged");
      assert.equal(got.has(unchanged), false, `${unchanged} (unchanged) gets no decoration`);
    }
    // Each decorated page carries the full decoration of its own state.
    for (const [relPath, d] of got) {
      assert.deepEqual(plain(d), EXPECTED[page(doc, relPath).state], relPath);
    }
  });

  it("maps every PageState to the specified badge, color id, tooltip and propagate", () => {
    for (const state of PAGE_STATES) {
      assert.deepEqual(plain(decorationForState(state)), EXPECTED[state], state);
    }
    const unverified = decorationForState("unverified");
    assert.ok(unverified);
    assert.equal("color" in unverified, false, "unverified has NO color (the key is absent, not undefined)");
  });

  it("every badge is at most 2 characters", () => {
    for (const state of PAGE_STATES) {
      const badge = decorationForState(state)?.badge;
      if (badge === undefined) { continue; }
      assert.ok(badge.length >= 1 && badge.length <= 2, `${state}: ${JSON.stringify(badge)} is 1..2 UTF-16 units`);
      assert.ok([...badge].length <= 2, `${state}: ${JSON.stringify(badge)} is at most 2 code points`);
      assert.equal(badge.includes(String.fromCodePoint(VARIATION_SELECTOR_16)), false, `${state}: no variation selector`);
    }
    for (const [state, cp] of [["incoming", DOWN_ARROW], ["incoming_new", DOWN_ARROW], ["invalid", WARNING_SIGN]] as const) {
      const badge = decorationForState(state)?.badge ?? "";
      assert.deepEqual([...badge].map((c) => c.codePointAt(0)), [cp], `${state}: exactly one code point U+${cp.toString(16).toUpperCase()}`);
    }
  });

  it("propagate only for M and !", () => {
    const propagating = PAGE_STATES.filter((s) => decorationForState(s)?.propagate === true);
    assert.deepEqual(propagating, ["modified", "conflict"]);
    assert.deepEqual(propagating.map((s) => decorationForState(s)?.badge), ["M", "!"]);
    for (const state of PAGE_STATES) {
      const d = decorationForState(state);
      if (d) { assert.equal(typeof d.propagate, "boolean", `${state}: propagate is always a boolean`); }
    }
  });

  it("unchanged and any unknown future state get no decoration", () => {
    for (const state of ["unchanged", "renamed", "", "MODIFIED", "toString", "constructor", "__proto__", "hasOwnProperty"]) {
      assert.equal(decorationForState(state), undefined, JSON.stringify(state));
    }
    const doc = loadStatusDoc("mixed");
    page(doc, "wiki/concepts/auth-flow.md").state = "renamed" as PageState;
    assert.equal(decorationsOf(doc).has("wiki/concepts/auth-flow.md"), false);
  });

  it("decorationsOf(undefined) is empty and decorations cannot be mutated through the table", () => {
    assert.equal(decorationsOf(undefined).size, 0);
    const d = decorationForState("modified");
    assert.ok(d);
    assert.throws(() => { (d as { badge: string }).badge = "X"; }, TypeError);
    assert.equal(decorationForState("modified")?.badge, "M");
  });

  it("every contexo.* color id is contributed by package.json (the others are built-in VS Code colors)", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as {
      contributes: { colors: { id: string }[] };
    };
    const contributed = new Set(pkg.contributes.colors.map((c) => c.id));
    for (const state of PAGE_STATES) {
      const color = decorationForState(state)?.color;
      if (color === undefined) { continue; }
      if (color.startsWith("contexo.")) {
        assert.ok(contributed.has(color), `${state}: ${color} is in contributes.colors`);
      } else {
        assert.ok(color.startsWith("gitDecoration."), `${state}: ${color} is a built-in color`);
      }
    }
  });

  it("isExcludedRelPath: any segment starting with '.', and the root index.md / tags.md in any case", () => {
    for (const rel of [
      ".sync/base/wiki/concepts/rate-limits.md",
      ".sync/lock",
      ".hidden.md",
      "wiki/.drafts/x.md",
      "wiki/concepts/.x.md",
      "index.md",
      "INDEX.md",
      "tags.md",
      "Tags.MD",
    ]) {
      assert.equal(isExcludedRelPath(rel), true, `${rel} is excluded`);
    }
    for (const rel of [
      "wiki/concepts/rate-limits.md",
      "wiki/index.md",
      "raw/tags.md",
      "my.index.md",
      "index.md.bak",
      "wiki/a..b/x.md",
      "config.json",
    ]) {
      assert.equal(isExcludedRelPath(rel), false, `${rel} is not excluded`);
    }
  });
});
