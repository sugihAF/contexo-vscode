// Every contributed command id (FROZEN after WP-0.I). scripts/check-manifest.mjs asserts
// that package.json contributes.commands equals the 'contexo.*' literals in this file.
import type { Services } from "../services";

export const COMMAND_IDS = {
  // src/commands/misc.ts (WP-1.12)
  refresh: "contexo.refresh",
  showLog: "contexo.showLog",
  openInDashboard: "contexo.openInDashboard",
  // src/commands/session.ts (WP-1.12)
  login: "contexo.login",
  init: "contexo.init",
  installCtx: "contexo.installCtx",
  updateCtx: "contexo.updateCtx",
  shareViaAgent: "contexo.shareViaAgent",
  // src/scm/diffCommands.ts (WP-1.9)
  openChange: "contexo.openChange",
  openFile: "contexo.openFile",
  openServerVersion: "contexo.openServerVersion",
  openAllChanges: "contexo.openAllChanges",
  // src/commands/sync.ts (WP-1.13)
  push: "contexo.push",
  pushSelected: "contexo.pushSelected",
  pull: "contexo.pull",
  // src/commands/resolve.ts (WP-1.13)
  resolveOurs: "contexo.resolveOurs",
  resolveTheirs: "contexo.resolveTheirs",
  restoreServerVersion: "contexo.restoreServerVersion",
} as const;

export type CommandName = keyof typeof COMMAND_IDS;
export type CommandId = (typeof COMMAND_IDS)[CommandName];
export const ALL_COMMAND_IDS: readonly CommandId[] = Object.values(COMMAND_IDS);

/** Every command handler: services first, then whatever VS Code passes (resource states, tree items, ...). */
export type CommandHandler = (s: Services, ...args: unknown[]) => Promise<void>;

/** Argument of contexo.shareViaAgent; with no argument the handler copies its default prompt. */
export type ShareViaAgentArgs = { agentPrompt?: string; root?: string };
