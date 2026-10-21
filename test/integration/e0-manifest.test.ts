// e0 (WP-0.6): manifest structure as the host sees it. Never edited by wave 1. It must
// not assert version, displayName, description, categories or keywords (WP-4.3 owns the
// listing fields).
import * as assert from "node:assert/strict";
import * as vscode from "vscode";
import { ALL_COMMAND_IDS } from "../../src/commands/ids";
import type { TestApi } from "../../src/testApi";
import { contexoExtension, waitForActivation } from "../helpers/activate";

interface Manifest {
  extensionKind?: unknown;
  capabilities?: { untrustedWorkspaces?: { supported?: unknown } };
  engines?: { vscode?: unknown };
  activationEvents?: unknown;
  contributes?: { commands?: { command: string }[] };
}

/** The extension's package.json exactly as shipped (the host may add implicit activation events to ext.packageJSON). */
async function manifestOnDisk(): Promise<Manifest> {
  const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(contexoExtension().extensionUri, "package.json"));
  return JSON.parse(Buffer.from(bytes).toString("utf8")) as Manifest;
}

describe("e0 manifest", () => {
  let api: TestApi | undefined;

  afterEach(async () => {
    await api?.hooks.resetServices();
  });

  it("every contributes.commands id is in vscode.commands.getCommands(true)", async () => {
    api = await waitForActivation();
    const contributed = (contexoExtension().packageJSON as Manifest).contributes?.commands?.map((c) => c.command) ?? [];
    assert.deepEqual([...contributed].sort(), [...ALL_COMMAND_IDS].sort(), "contributes.commands == ids.ts");
    const registered = new Set(await vscode.commands.getCommands(true));
    const missing = contributed.filter((id) => !registered.has(id));
    assert.deepEqual(missing, [], "contributed but not registered");
  });

  it("packageJSON: extensionKind [workspace], untrustedWorkspaces.supported false, engines ^1.100.0, no enabledApiProposals, exact activationEvents", async () => {
    const pkg = await manifestOnDisk();
    assert.deepEqual(pkg.extensionKind, ["workspace"]);
    assert.equal(pkg.capabilities?.untrustedWorkspaces?.supported, false);
    assert.equal(pkg.engines?.vscode, "^1.100.0");
    assert.equal("enabledApiProposals" in pkg, false, "no enabledApiProposals");
    assert.deepEqual(pkg.activationEvents, ["workspaceContains:.contexo/config.json", "onFileSystem:contexo"]);
    // Not Extension.extensionKind: in a local window every extension reports UI.
  });
});
