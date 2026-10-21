// STUB (not implemented): WP-1.7 replaces this file. Final export name and signature.
import * as vscode from "vscode";
import type { BinaryState, CtxCliDeps, ICtxCli } from "./types";

export function createCtxCli(_d: CtxCliDeps): ICtxCli {
  const binary = new vscode.EventEmitter<BinaryState>();
  const notImplemented = (): Promise<never> => Promise.reject(new Error("ctx CLI not implemented yet (WP-1.7)"));
  return {
    onDidChangeBinary: binary.event,
    getBinary: notImplemented,
    rediscover: notImplemented,
    version: notImplemented,
    status: notImplemented,
    show: notImplemented,
    push: notImplemented,
    pull: notImplemented,
    resolve: notImplemented,
    terminalInvocation: () => { throw new Error("ctx CLI not implemented yet (WP-1.7)"); },
    dispose: () => binary.dispose(),
  };
}
