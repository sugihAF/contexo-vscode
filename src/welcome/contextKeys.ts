// The contexo.state context key and the E37 ctx version notice (WP-1.12).
// contexo.state is the ONLY context key the extension sets: package.json viewsWelcome reads
// it, and the menus use built-in keys (scmProvider, scmResourceState, view, viewItem) only.
import * as vscode from "vscode";
import type { BinaryState } from "../cli/types";
import { ctxVersionNotice } from "../commands/session";
import type { ExtensionState } from "../model/types";
import type { Services } from "../services";
import type { Prompts } from "../ui/prompts";

export const STATE_CONTEXT_KEY = "contexo.state";

/** States before the ctx handshake has run: the version notice waits for the next one. */
const BEFORE_HANDSHAKE: ReadonlySet<ExtensionState> = new Set<ExtensionState>(["loading", "untrusted"]);

/**
 * Sets contexo.state to s.model.state now and on every state change, and shows the E37
 * notice when the ctx binary changes and the first time the state leaves loading.
 */
export function registerContextKeys(s: Services): vscode.Disposable {
  const setState = (state: ExtensionState): void => {
    Promise.resolve(vscode.commands.executeCommand("setContext", STATE_CONTEXT_KEY, state)).catch((err: unknown) => {
      s.log.warn(`setContext ${STATE_CONTEXT_KEY} failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  };

  // Delegates to s.prompts when the notice shows, not when it was triggered (setPrompts).
  const prompts: Pick<Prompts, "info" | "openExternal"> = {
    info: (message, ...actions) => s.prompts.info(message, ...actions),
    openExternal: (uri) => s.prompts.openExternal(uri),
  };
  const notice = (binary?: BinaryState): void => {
    ctxVersionNotice(s.context.globalState, s.cli, prompts, binary).catch((err: unknown) => {
      s.log.warn(`ctx version notice failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  };
  let handshakeSeen = false;
  const onState = (state: ExtensionState): void => {
    setState(state);
    if (!handshakeSeen && !BEFORE_HANDSHAKE.has(state)) {
      handshakeSeen = true;
      notice(); // the handshake is cached by now
    }
  };

  const subs = [
    s.model.onDidChangeState((state) => onState(state)),
    s.cli.onDidChangeBinary((binary) => notice(binary)),
  ];
  onState(s.model.state);
  return new vscode.Disposable(() => {
    for (const d of subs) { d.dispose(); }
  });
}
