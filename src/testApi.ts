// What activate() returns in ExtensionMode.Test (FROZEN after WP-0.I; additions only).
import type { Uri } from "vscode";
import type { ICtxCli } from "./cli/types";
import type { ScmGroup } from "./contract/types";
import type { IModel } from "./model/types";
import type { Services } from "./services";
import type { Prompts } from "./ui/prompts";

export interface ScmResourceSnapshot {
  relPath: string;
  /** resourceState.contextValue == the PageState. */
  contextValue: string;
  tooltip?: string;
  strikeThrough?: boolean;
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
}
export interface ScmSnapshot { repos: ScmRepoSnapshot[]; }

export interface TreeNodeSnapshot {
  label: string;
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
}

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
 * WP-1.9: `testHooks.scmSnapshot = () => ...`. Tests must read hooks through the
 * TestApi returned by activate() (api.hooks.scmSnapshot?.()), never import this
 * object: the running extension is the esbuild bundle, a different module copy.
 */
export const testHooks: Partial<SnapshotHooks> = {};

/** The seam implementation extension.ts hands to createTestApi. */
export interface ServiceSeam {
  overrideServices(o: { cli?: ICtxCli; model?: IModel }): Promise<void>;
  resetServices(): Promise<void>;
  setPrompts(p: Prompts): void;
}

/** Builds the TestApi; snapshot hooks are live getters over testHooks. */
export function createTestApi(services: Services, seam: ServiceSeam): TestApi {
  const hooks = {
    overrideServices: (o: { cli?: ICtxCli; model?: IModel }) => seam.overrideServices(o),
    resetServices: () => seam.resetServices(),
    setPrompts: (p: Prompts) => seam.setPrompts(p),
  } as TestHooks;
  for (const key of ["scmSnapshot", "treeSnapshot", "decorationFor", "statusBarSnapshot"] as const) {
    Object.defineProperty(hooks, key, { enumerable: true, get: () => testHooks[key] });
  }
  return { services, hooks };
}
