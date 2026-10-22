// pull (WP-2.3): a pull whose PullDoc skips locally edited pages, through the REAL wiring
// (contexo.pull -> E27 guard -> repo.run('pull') -> `ctx pull --json --root R` -> one online
// refresh). The one summary notification is pullReport(doc) (src/commands/sync.ts), naming the
// kept local edits with [Show Changes]; the kept pages' files stay as they were.
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as vscode from "vscode";
import { COMMAND_IDS } from "../../src/commands/ids";
import { SHOW_CHANGES_LABEL, pullReport } from "../../src/commands/sync";
import type { PullDoc } from "../../src/contract/types";
import {
  fixtureOf, groupPaths, isOnlineStatus, openWorkspaceCopy, pagePath, scmRepo, sourceControlOf,
  type CallRecord, type E2EWorkspace,
} from "../helpers/e2e";
import { scenarioOutput } from "../helpers/fixtures";

const AUTH_FLOW = "wiki/concepts/auth-flow.md";
const RATE_LIMITS = "wiki/concepts/rate-limits.md";

function only(w: E2EWorkspace, command: string): CallRecord {
  const hits = w.calls().filter((c) => c.argv[0] === command);
  assert.equal(hits.length, 1, `exactly one ${command} call (got ${JSON.stringify(w.calls().map((c) => c.argv))})`);
  return hits[0] as CallRecord;
}

describe("pull (e2e): a pull that skips local edits reports the kept local edits", function () {
  this.timeout(60000);

  it("e8-pull-skipped: one `pull --json --root R`, one online status after it, and ONE notification equal to pullReport(doc) naming the kept local edits with [Show Changes]; the kept pages are untouched", async () => {
    const w = await openWorkspaceCopy({ scenario: "e8-pull-skipped" });
    const keptBytes = new Map([AUTH_FLOW, RATE_LIMITS].map((p) => [p, fs.readFileSync(pagePath(w.root, p))]));

    await vscode.commands.executeCommand(COMMAND_IDS.pull, sourceControlOf(w.api));

    const pull = only(w, "pull");
    assert.deepEqual(pull.argv, ["pull", "--json", "--root", w.root]);
    assert.equal(pull.exit, 0);
    const online = w.calls().filter((c) => isOnlineStatus(c) && (c.start ?? 0) >= (pull.end ?? Infinity));
    assert.equal(online.length, 1, "repo.run's one online refresh after the pull");

    const out = scenarioOutput("e8-pull-skipped", pull.argv);
    assert.ok(out && out.exit === 0, "the scenario answers the pull");
    const doc = JSON.parse(out.stdout) as PullDoc;
    const keptPaths = doc.skipped.filter((k) => k.reason === "modified" || k.reason === "conflict").map((k) => k.path);
    assert.deepEqual(keptPaths, [AUTH_FLOW, RATE_LIMITS], "the fixture skips a modified and a conflicting page");
    const report = pullReport(doc);
    assert.equal(report.keptLocalEdits, keptPaths.length);

    const note = await w.prompts.waitFor(report.message, { method: "info" });
    assert.equal(note.message, report.message);
    assert.deepEqual(note.actions, [SHOW_CHANGES_LABEL], "kept local edits offer [Show Changes]");
    // Scoped to the pull: the first test of a run can also receive activation's E37 notice.
    const shown = w.prompts.notifications().filter((n) => n.at >= (pull.start ?? 0));
    assert.equal(shown.length, 1, `one summary notification (got ${JSON.stringify(shown)})`);
    assert.deepEqual(w.prompts.calls.filter((c) => c.method === "confirm"), [], "no unsaved page, so no E27 modal");

    for (const [p, bytes] of keptBytes) {
      assert.ok(fs.readFileSync(pagePath(w.root, p)).equals(bytes), `${p} keeps the local edit on disk`);
      assert.ok(bytes.equals(fs.readFileSync(pagePath(fixtureOf(w.root), p))), `${p} is the fixture's local edit`);
    }
    const repo = scmRepo(w.api);
    assert.ok(groupPaths(repo, "changes").includes(AUTH_FLOW), "the kept modified page stays in Changes");
    assert.deepEqual(groupPaths(repo, "conflicts"), [RATE_LIMITS], "the kept conflicting page stays in Conflicts");
  });
});
