// Activates the extension under test inside the VS Code test host and returns its
// TestApi (integration only: imports vscode at runtime). activate() returns the TestApi
// only in ExtensionMode.Test, which @vscode/test-cli runs give.
import * as vscode from "vscode";
import type { TestApi } from "../../src/testApi";
import { waitFor } from "./waitFor";

/** publisher.name from package.json (WP-P.2 EXTENSION_ID). */
export const EXTENSION_ID = "contexo.contexo";

/** The extension under test; throws when the host did not load it. */
export function contexoExtension(): vscode.Extension<TestApi> {
  const ext = vscode.extensions.getExtension<TestApi>(EXTENSION_ID);
  if (!ext) {
    throw new Error(`${EXTENSION_ID} is not installed in this extension host (is extensionDevelopmentPath the repo root?)`);
  }
  return ext;
}

function apiOf(api: TestApi | undefined): TestApi {
  if (api === undefined) {
    throw new Error(`${EXTENSION_ID} activated but returned no TestApi (it is returned only in ExtensionMode.Test)`);
  }
  return api;
}

/** Activate the extension (or reuse the running activation) and return its TestApi. */
export async function activateExtension(): Promise<TestApi> {
  const ext = contexoExtension();
  return apiOf(await ext.activate());
}

/**
 * Wait until VS Code activates the extension through its activation events, WITHOUT
 * calling activate(), and return its TestApi. Use it to prove event-driven activation
 * (workspaceContains:.contexo/config.json); otherwise prefer activateExtension().
 */
export async function waitForActivation(o: { timeoutMs?: number } = {}): Promise<TestApi> {
  const ext = contexoExtension();
  await waitFor(() => ext.isActive, {
    timeoutMs: o.timeoutMs ?? 15000,
    message: `${EXTENSION_ID} was not activated by its activation events`,
  });
  return apiOf(ext.exports);
}
