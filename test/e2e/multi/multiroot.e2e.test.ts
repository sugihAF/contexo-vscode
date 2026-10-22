// multiroot (WP-2.3): multi.code-workspace (label e2e-multi) through the REAL wiring: folders
// alpha (.contexo, scenario mixed), beta (.contexo, scenario clean) and plain (no .contexo).
// One Repository and one SourceControl per Contexo folder, none for plain; a push from
// alpha's SourceControl spawns ctx with --root alpha only, and refreshes alpha only.
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { COMMAND_IDS } from "../../../src/commands/ids";
import { pushPlan } from "../../../src/commands/sync";
import { scmCount } from "../../../src/contract/types";
import {
  isOnlineStatus, openWorkspaceCopy, readCalls, rootOf, scmRepo, sourceControlOf,
  type CallRecord, type E2EWorkspace,
} from "../../helpers/e2e";

/** The workspace folder fsPath whose basename is `name`. */
function folder(w: E2EWorkspace, name: string): string {
  const root = w.roots.find((r) => path.basename(r) === name);
  assert.ok(root, `workspace folder ${name} (have ${JSON.stringify(w.roots)})`);
  return root;
}

/** Path equality, ignoring case on the case-insensitive file systems (darwin, win32). */
function samePath(a: string, b: string): boolean {
  const fold = process.platform === "darwin" || process.platform === "win32";
  const n = (p: string): string => (fold ? path.resolve(p).toLowerCase() : path.resolve(p));
  return n(a) === n(b);
}

describe("multiroot (e2e): one SourceControl per Contexo folder, and a push touches only its own root", function () {
  this.timeout(60000);

  it("alpha and beta each get a Repository and a SourceControl; the plain folder gets neither, and no ctx call ever names it", async () => {
    const w = await openWorkspaceCopy();
    assert.deepEqual(w.roots.map((r) => path.basename(r)), ["alpha", "beta", "plain"]);
    const alpha = folder(w, "alpha");
    const beta = folder(w, "beta");
    const plain = folder(w, "plain");
    assert.equal(fs.existsSync(path.join(plain, ".contexo", "config.json")), false, "plain has no Contexo project");

    assert.deepEqual(w.api.services.model.repositories.map((r) => r.root.fsPath), [alpha, beta]);
    assert.equal(w.api.services.model.getRepository(vscode.Uri.file(plain)), undefined);
    const scm = w.api.hooks.scmSnapshot?.().repos ?? [];
    assert.deepEqual(scm.map((r) => r.root), [alpha, beta], "two SourceControls, in folder order");
    for (const root of [alpha, beta]) {
      const status = w.repo(root).status;
      assert.ok(status, `${path.basename(root)} has a status`);
      assert.equal(scmRepo(w.api, root).count, scmCount(status.counts, false), `${path.basename(root)}'s own count`);
    }
    assert.equal(scmRepo(w.api, alpha).count, 3, "alpha is mixed");
    assert.equal(scmRepo(w.api, beta).count, 0, "beta is clean");
    for (const c of readCalls()) {
      const r = rootOf(c);
      assert.ok(r === undefined || !samePath(r, plain), `no ctx call for the plain folder: ${JSON.stringify(c.argv)}`);
    }
  });

  it("a push from alpha's SourceControl spawns exactly one `push ... --root <alpha>` with alpha's planned paths, then refreshes alpha only: no call names beta or plain (alpha e8-multi-push, beta clean)", async () => {
    const w = await openWorkspaceCopy({ scenarios: { alpha: "e8-multi-push", beta: "clean" } });
    const alpha = folder(w, "alpha");
    const beta = folder(w, "beta");
    const status = w.repo(alpha).status;
    assert.ok(status, "alpha has a status");
    const plan = pushPlan(status);
    assert.ok(plan.length > 0, "alpha has pages to push");
    const betaBox = sourceControlOf(w.api, beta).inputBox;
    betaBox.value = "beta message";
    const sc = sourceControlOf(w.api, alpha);
    sc.inputBox.value = "push alpha";

    await vscode.commands.executeCommand(COMMAND_IDS.push, sc);

    const pushes = w.calls().filter((c) => c.argv[0] === "push");
    assert.equal(pushes.length, 1, `exactly one push (got ${JSON.stringify(pushes.map((c) => c.argv))})`);
    const push = pushes[0] as CallRecord;
    assert.deepEqual(push.argv, ["push", "--json", "--yes", "--root", alpha, "-m", "push alpha", "--", ...plan]);
    assert.ok(push.end !== undefined, "the push ended");
    const refreshes = w.calls().filter((c) => isOnlineStatus(c) && (c.start ?? 0) >= (push.end ?? Infinity));
    assert.equal(refreshes.length, 1, "one online status after the push");
    const refresh = refreshes[0] as CallRecord;
    assert.deepEqual(refresh.argv, ["status", "--json", "--root", alpha], "the follow-up refresh is alpha's");

    const windowEnd = refresh.end ?? Date.now();
    const elsewhere = w.calls().filter((c) => c.argv[0] !== "version" && (c.start ?? 0) <= windowEnd && !samePath(rootOf(c) ?? "", alpha));
    assert.deepEqual(elsewhere.map((c) => c.argv), [], "the push flow spawned nothing for beta or plain");
    assert.equal(sc.inputBox.value, "", "alpha's input box is cleared after its push");
    assert.equal(betaBox.value, "beta message", "beta's input box is untouched");
  });
});
