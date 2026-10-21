// What activate() returns in ExtensionMode.Test (FROZEN after WP-0.I; additions only).
import type { Uri } from "vscode";
import type { ICtxCli } from "./cli/types";
import type { ScmGroup } from "./contract/types";
import type { IModel } from "./model/types";
import type { Services } from "./services";
import type { Prompts } from "./ui/prompts";

/**
 * A vscode.Command as plain data. Uri arguments become uri.toString(); every other argument
 * is passed through unchanged (acceptInputCommand's arguments[0] is the SourceControl object
 * itself, so a test can check its id and rootUri).
 */
export interface CommandSnapshot {
  command: string;
  title: string;
  tooltip?: string;
  arguments?: unknown[];
}

export interface ScmResourceSnapshot {
  relPath: string;
  /** resourceState.contextValue == the PageState. */
  contextValue: string;
  tooltip?: string;
  strikeThrough?: boolean;
  /** resourceState.command (what a click runs); absent when the state has none. */
  command?: CommandSnapshot;
}
export interface ScmGroupSnapshot {
  /** Resource group id == contract ScmGroup. */
  id: ScmGroup;
  label: string;
  hideWhenEmpty: boolean;
  resources: ScmResourceSnapshot[];
}
export interface ScmRepoSnapshot {
  /** Workspace folder fsPath. */
  root: string;
  count: number;
  inputPlaceholder: string;
  /** Command ids of SourceControl.statusBarCommands. */
  statusBarCommands: string[];
  groups: ScmGroupSnapshot[];
  /** SourceControl.acceptInputCommand (Cmd/Ctrl+Enter in the input box). */
  acceptInputCommand?: CommandSnapshot;
}
export interface ScmSnapshot { repos: ScmRepoSnapshot[]; }

export interface TreeNodeSnapshot {
  label: string;
  /** TreeItem.id (WP-1.11: '<root>|<path>', '<root>|#<group>', '<root>|#pending'). */
  id?: string;
  description?: string;
  /** 'page.<state>' for pages, 'session' for the pending-capture item. */
  contextValue?: string;
  /** resourceUri.toString() */
  resourceUri?: string;
  children: TreeNodeSnapshot[];
}
export interface TreeSnapshot {
  message?: string;
  badge?: { value: number; tooltip: string };
  roots: TreeNodeSnapshot[];
}

export interface DecorationSnapshot {
  badge?: string;
  tooltip?: string;
  /** ThemeColor id, e.g. 'contexo.modifiedForeground'. */
  color?: string;
  propagate?: boolean;
}

export interface StatusBarItemSnapshot { id: string; text: string; tooltip?: string; command?: string; }
export interface StatusBarSnapshot { items: StatusBarItemSnapshot[]; }

export interface SnapshotHooks {
  scmSnapshot(): ScmSnapshot;
  treeSnapshot(): TreeSnapshot;
  decorationFor(uri: Uri): DecorationSnapshot | undefined;
  statusBarSnapshot(): StatusBarSnapshot;
  /**
   * What the QuickDiffProvider of the SourceControl that owns `uri` returns from
   * provideOriginalResource(uri); undefined when no repository owns it (WP-1.9).
   */
  quickDiffOriginal(uri: Uri): Uri | undefined | Promise<Uri | undefined>;
}

/** Every SnapshotHooks member: the compiler rejects a missing or an unknown key. */
const SNAPSHOT_HOOK_KEYS: Record<keyof SnapshotHooks, true> = {
  scmSnapshot: true,
  treeSnapshot: true,
  decorationFor: true,
  statusBarSnapshot: true,
  quickDiffOriginal: true,
};

export type TestHooks = {
  /**
   * 1. dispose the current wiring;
   * 2. replace services.cli and/or services.model in the ONE Services object (when only
   *    cli is given, the model is rebuilt with createModel over that cli);
   * 3. re-run wire(), so every register* call sees the override.
   * The originals stay alive (not disposed) so resetServices can restore them; models
   * the seam built itself are disposed when replaced. Test-supplied cli/model objects
   * are never disposed by the seam.
   */
  overrideServices(o: { cli?: ICtxCli; model?: IModel }): Promise<void>;
  /** Restore the original cli and model the same way (dispose wiring, swap, re-wire); also restores the original prompts. */
  resetServices(): Promise<void>;
  /** Swap services.prompts in place (no re-wire). The model sees it too (ModelDeps.prompts delegates). */
  setPrompts(p: Prompts): void;
} & Partial<SnapshotHooks>;

export interface TestApi {
  services: Services;
  hooks: TestHooks;
}

/**
 * Owning modules assign their snapshot hook here when they register, e.g.
 * WP-1.9: `testHooks.scmSnapshot = () => ...` and `testHooks.quickDiffOriginal = ...`;
 * every SnapshotHooks member reaches api.hooks. Tests must read hooks through the
 * TestApi returned by activate() (api.hooks.scmSnapshot?.()), never import this
 * object: the running extension is the esbuild bundle, a different module copy.
 */
export const testHooks: Partial<SnapshotHooks> = {};

/** The seam implementation extension.ts hands to createTestApi (the TestHooks methods). */
export type ServiceSeam = Pick<TestHooks, "overrideServices" | "resetServices" | "setPrompts">;

/** Builds the TestApi; snapshot hooks are live getters over testHooks. */
export function createTestApi(services: Services, seam: ServiceSeam): TestApi {
  const hooks = {
    overrideServices: (o: { cli?: ICtxCli; model?: IModel }) => seam.overrideServices(o),
    resetServices: () => seam.resetServices(),
    setPrompts: (p: Prompts) => seam.setPrompts(p),
  } as TestHooks;
  for (const key of Object.keys(SNAPSHOT_HOOK_KEYS) as (keyof SnapshotHooks)[]) {
    Object.defineProperty(hooks, key, { enumerable: true, get: () => testHooks[key] });
  }
  return { services, hooks };
}
