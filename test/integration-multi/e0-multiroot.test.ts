// e0 (WP-0.6): activation in a multi-root workspace (label integration-multi, opened on
// .vscode-test/workspaces/multi/multi.code-workspace). Never edited by wave 1; asserts
// only activation and registration, never stub behaviour.
//
// Durability: wave-1 tests in this label (WP-1.8's e2-multiroot) add .contexo/config.json
// to 'plain' and remove folders, and mocha may run their files first. So the workspace
// shape is read from the committed fixture definition, never from the live folders.
import * as assert from "node:assert/strict";
import * as path from "node:path";
import * as vscode from "vscode";
import { ALL_COMMAND_IDS } from "../../src/commands/ids";
import type { TestApi } from "../../src/testApi";
import { contexoExtension, waitForActivation } from "../helpers/activate";

async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

describe("e0 multi-root", () => {
  let api: TestApi | undefined;

  beforeEach(async () => {
    // A wave-1 test that ran first may have left an override in place.
    await contexoExtension().exports?.hooks.resetServices();
  });

  afterEach(async () => {
    await api?.hooks.resetServices();
  });

  it("activates once in multi.code-workspace (3 folders, 2 with .contexo/config.json), returns TestApi, commands registered once", async () => {
    const ext = contexoExtension();
    assert.equal(path.basename(vscode.workspace.workspaceFile?.fsPath ?? ""), "multi.code-workspace");

    const fixture = vscode.Uri.joinPath(ext.extensionUri, "test", "fixtures", "workspaces", "multi");
    const def = JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(fixture, "multi.code-workspace"))).toString("utf8")) as { folders: { path: string }[] };
    assert.deepEqual(def.folders.map((f) => f.path), ["alpha", "beta", "plain"]);
    const withConfig: string[] = [];
    for (const f of def.folders) {
      if (await exists(vscode.Uri.joinPath(fixture, f.path, ".contexo", "config.json"))) { withConfig.push(f.path); }
    }
    assert.deepEqual(withConfig, ["alpha", "beta"]);

    // Activated by workspaceContains (no activate() call first), and only once: a second
    // activate() hands back the same TestApi instead of running activate() again.
    api = await waitForActivation();
    assert.equal(await ext.activate(), api);
    assert.equal(ext.exports, api);
    assert.equal(api.services.context.extensionMode, vscode.ExtensionMode.Test);
    for (const hook of ["overrideServices", "resetServices", "setPrompts"] as const) {
      assert.equal(typeof api.hooks[hook], "function", `hooks.${hook}`);
    }

    const all = await vscode.commands.getCommands(true);
    for (const id of ALL_COMMAND_IDS) {
      assert.equal(all.filter((c) => c === id).length, 1, `${id} must be registered exactly once`);
    }
  });
});
