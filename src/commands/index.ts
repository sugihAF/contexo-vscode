// Registers every contributed command (FROZEN after WP-0.I). Each id maps to the named
// handler export of its owning module. Handlers take (s, ...args: unknown[]) and narrow
// their arguments themselves; read s.cli/s.model/s.prompts inside the body.
import * as vscode from "vscode";
import { resolveOurs, resolveTheirs, restoreServerVersion } from "./resolve";
import { openInDashboard, refresh, showLog } from "./misc";
import { init, installCtx, login, shareViaAgent, updateCtx } from "./session";
import { pull, push, pushSelected } from "./sync";
import { openAllChanges, openChange, openFile, openServerVersion } from "../scm/diffCommands";
import type { Services } from "../services";
import { COMMAND_IDS, type CommandHandler, type CommandName } from "./ids";

export const COMMAND_HANDLERS: { readonly [K in CommandName]: CommandHandler } = {
  refresh,
  showLog,
  openInDashboard,
  login,
  init,
  installCtx,
  updateCtx,
  shareViaAgent,
  openChange,
  openFile,
  openServerVersion,
  openAllChanges,
  push,
  pushSelected,
  pull,
  resolveOurs,
  resolveTheirs,
  restoreServerVersion,
};

export function registerCommands(s: Services): vscode.Disposable {
  const subs = (Object.keys(COMMAND_IDS) as CommandName[]).map((name) =>
    vscode.commands.registerCommand(COMMAND_IDS[name], async (...args: unknown[]) => {
      try {
        await COMMAND_HANDLERS[name](s, ...args);
      } catch (err) {
        s.log.error(`${COMMAND_IDS[name]} failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
        throw err;
      }
    }),
  );
  return vscode.Disposable.from(...subs);
}
