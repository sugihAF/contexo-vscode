// e0 (WP-0.6): activation in a multi-root workspace (label integration-multi, opened on
// .vscode-test/workspaces/multi/multi.code-workspace). Never edited by wave 1; asserts
// only activation and registration, never stub behaviour.
import * as assert from "node:assert/strict";
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

  afterEach(async () => {
    await api?.hooks.resetServices();
  });

  it("activates once in multi.code-workspace (3 folders, 2 with .contexo/config.json), returns TestApi, commands registered once", async () => {
    const folders = vscode.workspace.workspaceFolders ?? [];
    assert.deepEqual(folders.map((f) => f.name), ["alpha", "beta", "plain"]);
    const withConfig: string[] = [];
    for (const f of folders) {
      if (await exists(vscode.Uri.joinPath(f.uri, ".contexo", "config.json"))) { withConfig.push(f.name); }
    }
    assert.deepEqual(withConfig, ["alpha", "beta"]);

    // Activated by workspaceContains (no activate() call first), and only once: a second
    // activate() hands back the same TestApi instead of running activate() again.
    api = await waitForActivation();
    const ext = contexoExtension();
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
