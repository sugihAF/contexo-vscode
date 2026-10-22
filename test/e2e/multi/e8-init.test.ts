// e8-init (WP-2.3, label e2e-multi): the real `init --root` argv through WP-1.7's
// terminalInvocation (WP-1.12 request). Only the multi workspace has a folder without a
// Contexo project ('plain'), so this lives beside multiroot.e2e.test.ts.
import * as assert from "node:assert/strict";
import * as path from "node:path";
import * as vscode from "vscode";
import { isOnlineStatus, openWorkspaceCopy, rootOf } from "../../helpers/e2e";

describe("e8-init (e2e-multi): contexo.init runs `init --root <plain>` in the Contexo terminal", function () {
  this.timeout(60000);

  it("init argv is ['init','--root',<plain>] with the terminal invocation of the discovered ctx, then an online refresh of the projects", async () => {
    const w = await openWorkspaceCopy();
    const plain = w.roots.find((r) => path.basename(r) === "plain");
    assert.ok(plain, `the multi workspace has a 'plain' folder (${JSON.stringify(w.roots)})`);
    const expected = w.api.services.cli.terminalInvocation(["init", "--root", plain]);

    let opened: vscode.Terminal | undefined;
    const sub = vscode.window.onDidOpenTerminal((t) => {
      if (opened === undefined && t.name === "Contexo") { opened = t; }
    });
    try {
      await vscode.commands.executeCommand("contexo.init", vscode.Uri.file(plain));
    } finally {
      sub.dispose();
    }
    assert.ok(opened, "a 'Contexo' terminal was opened");
    const opts = opened.creationOptions as vscode.TerminalOptions;
    assert.equal(opts.shellPath, expected.shellPath);
    assert.deepEqual(opts.shellArgs, expected.shellArgs);

    const inits = w.calls().filter((c) => c.argv[0] === "init");
    assert.equal(inits.length, 1, `one init call (got ${JSON.stringify(w.calls().map((c) => c.argv))})`);
    assert.deepEqual(inits[0]?.argv, ["init", "--root", plain]);
    const after = w.calls().filter((c) => isOnlineStatus(c) && (c.start ?? 0) >= (inits[0]?.end ?? Infinity));
    assert.ok(after.length >= 1, "the projects refresh online after init");
    assert.ok(after.every((c) => rootOf(c) !== plain), "the fake init writes nothing, so 'plain' stays without a project and is never given to status");
  });
});
