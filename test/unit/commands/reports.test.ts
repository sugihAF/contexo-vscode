// The pure summaries behind the push, pull and resolve notifications (WP-1.13).
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { resolveSummary } from "../../../src/commands/resolve";
import { pullReport, pushReport } from "../../../src/commands/sync";
import type { PullDoc, PushDoc } from "../../../src/contract/types";
import { REPO_ROOT } from "../../helpers/fixtures";

function vendored<T>(file: string): T {
  return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "test", "fixtures", "contract", "v1", file), "utf8")) as T;
}

function pullDoc(o: Partial<PullDoc> = {}): PullDoc {
  return { ...vendored<PullDoc>("pull.up-to-date.json"), ...o };
}

describe("pushReport", () => {
  it("a clean push says 'Pushed N page(s)' and clears the input box", () => {
    const r = pushReport(vendored<PushDoc>("push.ok.json"));
    assert.equal(r.severity, "info");
    assert.ok(r.message.startsWith("Pushed 2 page(s)."), r.message);
    assert.deepEqual(r.conflicts, []);
    assert.equal(r.clearInput, true);
  });

  it("a partial push warns with every conflict path and names the notable skips once; the input box is kept", () => {
    const r = pushReport(vendored<PushDoc>("push.partial-conflict.json"));
    assert.equal(r.severity, "warning");
    assert.deepEqual(r.conflicts, ["wiki/entities/settlement-batch.md"]);
    assert.ok(r.message.includes("Pushed 2 page(s)."), r.message);
    assert.ok(r.message.includes("wiki/entities/settlement-batch.md"), r.message);
    assert.ok(r.message.includes("wiki/concepts/retry-policy.md (conflict)"), r.message);
    assert.ok(r.message.includes("wiki/entities/payment-gateway.md (invalid)"), r.message);
    assert.equal(r.message.split("Skipped").length - 1, 1, "skips are mentioned once");
    assert.equal(r.clearInput, false);
  });

  it("a push that sent nothing says so, keeps the input box, and does not mention unchanged skips", () => {
    const r = pushReport(vendored<PushDoc>("push.nothing.json"));
    assert.equal(r.severity, "info");
    assert.ok(r.message.startsWith("Nothing was pushed."), r.message);
    assert.ok(!r.message.includes("Skipped"), r.message);
    assert.equal(r.clearInput, false);
  });
});

describe("pullReport", () => {
  it("nothing written or adopted says Already up to date", () => {
    const r = pullReport(pullDoc());
    assert.equal(r.message, "Already up to date.");
    assert.equal(r.keptLocalEdits, 0);
  });

  it("counts written pages and adds ', M already identical' only when pages were adopted", () => {
    assert.ok(pullReport(vendored<PullDoc>("pull.ok.json")).message.startsWith("Pulled 2 page(s)."));
    const adopted = pullReport(pullDoc({ written: [{ path: "a.md", sha: "1".repeat(40), kind: "create" }], adopted: [{ path: "b.md", sha: "2".repeat(40) }] }));
    assert.ok(adopted.message.startsWith("Pulled 1 page(s), 1 already identical."), adopted.message);
  });

  it("modified and conflict skips are kept local edits; deleted_local skips point at Restore Server Version", () => {
    const r = pullReport(vendored<PullDoc>("pull.skipped-and-adopted.json"));
    assert.equal(r.keptLocalEdits, 3, "2 conflict + 1 modified");
    assert.ok(r.message.includes("Kept your local edits to 3 page(s)"), r.message);
    assert.ok(r.message.includes("1 locally deleted page(s) not restored (use Restore Server Version)"), r.message);
  });

  it("invalid, case_collision and changed_during_pull skips are named once, as is any unknown reason", () => {
    const r = pullReport(pullDoc({
      skipped: [
        { path: "a/Inv.md", state: "invalid", reason: "invalid" },
        { path: "b/Case.md", reason: "case_collision" },
        { path: "b/case.md", reason: "case_collision" },
        { path: "c/moving.md", reason: "changed_during_pull" },
        { path: "d/future.md", reason: "some_future_reason" },
      ],
    }));
    for (const p of ["a/Inv.md", "b/Case.md", "b/case.md", "c/moving.md", "d/future.md (some_future_reason)"]) {
      assert.equal(r.message.split(p).length - 1, 1, `${p} named once in: ${r.message}`);
    }
    assert.ok(r.message.startsWith("Already up to date."), r.message);
    assert.equal(r.keptLocalEdits, 0);
  });
});

describe("resolveSummary", () => {
  it("one line per flow, with the skipped and not-run counts when there are any", () => {
    assert.equal(resolveSummary("theirs", 2, 0, 0), "Took the server version of 2 page(s).");
    assert.equal(resolveSummary("restore", 1, 0, 0), "Restored 1 page(s) from the server.");
    assert.equal(resolveSummary("ours", 1, 1, 0), "Kept your version of 1 page(s); push to publish it (1 skipped).");
    assert.equal(resolveSummary("theirs", 0, 1, 2), "Took the server version of 0 page(s) (1 skipped, 2 not run).");
  });
});
