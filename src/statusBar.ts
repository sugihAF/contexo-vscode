// STUB (not implemented): WP-1.12 replaces the bodies. Final export names and signatures.
import * as vscode from "vscode";
import type { StatusDoc } from "./contract/types";
import type { Services } from "./services";

export function registerStatusBar(_s: Services): vscode.Disposable {
  return new vscode.Disposable(() => undefined);
}

/** SourceControl.statusBarCommands for a repository's status (WP-1.9 imports it; WP-1.12 owns the body). */
export function statusBarCommandsFor(_status: StatusDoc | undefined): vscode.Command[] {
  return [];
}
