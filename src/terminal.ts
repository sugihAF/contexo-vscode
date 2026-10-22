// Interactive ctx commands (auth login, init, update) in a VS Code terminal (WP-1.12).
// ctx itself is the terminal process (shellPath = ctx, no shell); when it exits the
// extension refreshes every repository. The terminal stays open so the user can read it.
import * as vscode from "vscode";
import type { TerminalInvocation } from "./cli/types";
import type { Services } from "./services";

export const TERMINAL_NAME = "Contexo";
export const TERMINAL_POLL_MS = 1_000;
export const TERMINAL_TIMEOUT_MS = 10 * 60_000;

export interface RunCtxInTerminalOptions {
  pollMs?: number;
  timeoutMs?: number;
  /** runs after exit, before the refresh */
  beforeRefresh?: () => Promise<unknown>;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Run `ctx <args>` in a new Contexo terminal (cwd = root when known), wait for it to exit,
 * then run o.beforeRefresh and an online refreshAll. Resolves with the exit code, or
 * undefined when it is unknown (timeout) or ctx could not be started.
 */
export async function runCtxInTerminal(s: Services, root: string | undefined, args: string[], o: RunCtxInTerminalOptions = {}): Promise<number | undefined> {
  let inv: TerminalInvocation;
  try {
    inv = s.cli.terminalInvocation(args);
  } catch (err) {
    s.log.error(`cannot run ctx ${args.join(" ")} in a terminal: ${errorMessage(err)}`);
    void s.prompts.error(`Contexo: cannot run ctx: ${errorMessage(err)}`);
    return undefined;
  }

  const options: vscode.TerminalOptions = { name: TERMINAL_NAME, shellPath: inv.shellPath, shellArgs: inv.shellArgs };
  if (root !== undefined) { options.cwd = root; }
  if (inv.env) { options.env = inv.env; }
  s.log.info(`terminal: ctx ${args.join(" ")}${root !== undefined ? ` (cwd ${root})` : ""}`);
  const terminal = vscode.window.createTerminal(options);
  terminal.show();

  const code = await waitForTerminalExit(terminal, o.pollMs ?? TERMINAL_POLL_MS, o.timeoutMs ?? TERMINAL_TIMEOUT_MS);
  s.log.info(`terminal: ctx ${args[0] ?? ""} ${code === undefined ? "did not report an exit code" : `exited with ${code}`}`);

  try {
    await o.beforeRefresh?.();
  } catch (err) {
    s.log.warn(`after ctx ${args[0] ?? ""}: ${errorMessage(err)}`);
  }
  try {
    await s.model.refreshAll({ remote: true });
  } catch (err) {
    s.log.warn(`refresh after ctx ${args[0] ?? ""} failed: ${errorMessage(err)}`);
  }
  return code;
}

/**
 * Resolves with the terminal's exit code once exitStatus is set (polled every pollMs) or the
 * terminal closes, whichever comes first; undefined after timeoutMs. A terminal whose process
 * is ctx can stay open after ctx exits, so closing alone is not enough.
 */
export function waitForTerminalExit(terminal: vscode.Terminal, pollMs: number, timeoutMs: number): Promise<number | undefined> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (code: number | undefined): void => {
      if (done) { return; }
      done = true;
      clearInterval(poll);
      clearTimeout(timer);
      closed.dispose();
      resolve(code);
    };
    const check = (): void => {
      if (terminal.exitStatus) { finish(terminal.exitStatus.code); }
    };
    const poll = setInterval(check, pollMs);
    const timer = setTimeout(() => finish(undefined), timeoutMs);
    const closed = vscode.window.onDidCloseTerminal((t) => {
      if (t === terminal) { finish(t.exitStatus?.code); }
    });
    check();
  });
}
