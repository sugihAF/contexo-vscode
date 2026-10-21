// STUB (not implemented): WP-1.8 replaces this file. Final export name and signature.
import * as vscode from "vscode";
import type { ExtensionState, IModel, IRepository, ModelDeps } from "./types";

export function createModel(_d: ModelDeps): IModel {
  const state = new vscode.EventEmitter<ExtensionState>();
  const opened = new vscode.EventEmitter<IRepository>();
  const closed = new vscode.EventEmitter<IRepository>();
  return {
    state: "loading",
    onDidChangeState: state.event,
    repositories: [],
    onDidOpenRepository: opened.event,
    onDidCloseRepository: closed.event,
    getRepository: () => undefined,
    resolveTarget: () => undefined,
    refreshAll: async () => undefined,
    initialize: async () => undefined,
    dispose: () => { state.dispose(); opened.dispose(); closed.dispose(); },
  };
}
