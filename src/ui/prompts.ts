// User-facing prompts behind an interface, so tests can script answers through
// TestApi.hooks.setPrompts (FROZEN after WP-0.I; additions only).
import * as vscode from "vscode";

export interface ConfirmOptions {
  /** Modal dialog (true) or notification (false). */
  modal: boolean;
  /** Label of the confirming button; confirm() resolves true only when it is chosen. */
  confirmLabel: string;
  detail?: string;
}

export interface Prompts {
  /** Notification; resolves with the chosen action label, or undefined when dismissed. */
  info(message: string, ...actions: string[]): Promise<string | undefined>;
  warn(message: string, ...actions: string[]): Promise<string | undefined>;
  error(message: string, ...actions: string[]): Promise<string | undefined>;
  confirm(message: string, options: ConfirmOptions): Promise<boolean>;
  quickPick<T extends vscode.QuickPickItem>(items: readonly T[], options?: vscode.QuickPickOptions & { canPickMany?: false }): Promise<T | undefined>;
  inputBox(options?: vscode.InputBoxOptions): Promise<string | undefined>;
  copyToClipboard(text: string): Promise<void>;
  /** vscode.env.openExternal; resolves false when the URI was not opened. */
  openExternal(uri: vscode.Uri): Promise<boolean>;
}

/** The vscode.window / vscode.env implementation. */
export function createPrompts(): Prompts {
  return {
    info: async (message, ...actions) => vscode.window.showInformationMessage(message, ...actions),
    warn: async (message, ...actions) => vscode.window.showWarningMessage(message, ...actions),
    error: async (message, ...actions) => vscode.window.showErrorMessage(message, ...actions),
    confirm: async (message, o) => {
      const picked = await vscode.window.showWarningMessage(message, { modal: o.modal, detail: o.detail }, o.confirmLabel);
      return picked === o.confirmLabel;
    },
    quickPick: async (items, options) => vscode.window.showQuickPick(items, { ...options, canPickMany: false }),
    inputBox: async (options) => vscode.window.showInputBox(options),
    copyToClipboard: async (text) => { await vscode.env.clipboard.writeText(text); },
    openExternal: async (uri) => vscode.env.openExternal(uri),
  };
}
