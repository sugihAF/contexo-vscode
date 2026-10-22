// The Contexo Source Control provider (WP-1.9): one vscode.SourceControl per repository
// with the Conflicts / Changes / New / Incoming / Invalid groups, the E29 badge count, the
// Cmd/Ctrl+Enter input box bound to contexo.push and the quick diff against base. All
// presentation comes from the pure resourceModel; this adapter only creates the VS Code
// objects, reassigns a group's resourceStates when its signature changes (no flicker),
// and assigns testHooks.scmSnapshot / testHooks.quickDiffOriginal for the e3 host tests.
import * as vscode from "vscode";
import { COMMAND_IDS } from "../commands/ids";
import type { ScmGroup } from "../contract/types";
import type { IRepository } from "../model/types";
import type { Services } from "../services";
import { statusBarCommandsFor } from "../statusBar";
import {
  testHooks, type CommandSnapshot, type ScmGroupSnapshot, type ScmRepoSnapshot, type ScmResourceSnapshot,
  type ScmSnapshot,
} from "../testApi";
import { originalResource } from "./quickDiff";
import {
  GROUP_LABELS, GROUP_ORDER, changedGroups, countFor, groupDescriptors, groupSignature, hideWhenEmpty, placeholderFor,
} from "./resourceModel";
import { toResourceState, type ContexoResourceState } from "./resourceStates";

/** What a resource group created here belongs to (looked up by diffCommands.openAllChanges). */
export interface GroupContext {
  readonly repository: IRepository;
  readonly id: ScmGroup;
}

const groupContexts = new WeakMap<object, GroupContext>();

/** The repository and group id of a SourceControlResourceGroup this module created, else undefined. */
export function groupContextOf(group: unknown): GroupContext | undefined {
  return typeof group === "object" && group !== null ? groupContexts.get(group) : undefined;
}

/** One repository's SourceControl and everything hanging off it. */
interface RepoScm extends vscode.Disposable {
  readonly sourceControl: vscode.SourceControl;
  update(): void;
  snapshot(): ScmRepoSnapshot;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.stack ?? err.message : String(err);
}

/** A vscode.Uri, also one from another module copy (duck-typed like test/helpers/fakeModel). */
export function isUri(v: unknown): v is vscode.Uri {
  if (v instanceof vscode.Uri) { return true; }
  const u = v as { scheme?: unknown; path?: unknown; with?: unknown } | null;
  return typeof u === "object" && u !== null && typeof u.scheme === "string" && typeof u.path === "string" && typeof u.with === "function";
}

/** A vscode.Command as plain data: Uri arguments become uri.toString(), every other argument passes through. */
function commandSnapshot(c: vscode.Command): CommandSnapshot {
  const snap: CommandSnapshot = { command: c.command, title: c.title };
  if (c.tooltip !== undefined) { snap.tooltip = c.tooltip; }
  if (c.arguments !== undefined) { snap.arguments = c.arguments.map((a: unknown) => (isUri(a) ? a.toString() : a)); }
  return snap;
}

function resourceSnapshot(repo: IRepository, r: vscode.SourceControlResourceState): ScmResourceSnapshot {
  const relPath = (r as Partial<ContexoResourceState>).relPath ?? repo.relPathOf(r.resourceUri) ?? r.resourceUri.toString();
  const snap: ScmResourceSnapshot = { relPath, contextValue: r.contextValue ?? "" };
  if (r.decorations?.tooltip !== undefined) { snap.tooltip = r.decorations.tooltip; }
  if (r.decorations?.strikeThrough === true) { snap.strikeThrough = true; }
  if (r.command) { snap.command = commandSnapshot(r.command); }
  return snap;
}

/** Creates the SourceControl of one repository and keeps it in step with repo.status. */
function createRepoScm(s: Services, repo: IRepository): RepoScm {
  const sourceControl = vscode.scm.createSourceControl("contexo", "Contexo", repo.root);
  const groups = new Map<ScmGroup, vscode.SourceControlResourceGroup>();
  const signatures = new Map<ScmGroup, string>();
  let statusSub: vscode.Disposable | undefined;
  try {
    for (const id of GROUP_ORDER) {
      const group = sourceControl.createResourceGroup(id, GROUP_LABELS[id]);
      group.hideWhenEmpty = hideWhenEmpty(id);
      groupContexts.set(group, { repository: repo, id });
      groups.set(id, group);
    }
    sourceControl.acceptInputCommand = { command: COMMAND_IDS.push, title: "Push", arguments: [sourceControl] };
    sourceControl.quickDiffProvider = {
      provideOriginalResource: (uri: vscode.Uri) => {
        try {
          return originalResource(repo, uri);
        } catch (err) {
          s.log.error(`scm quick diff failed for ${uri.toString()}: ${errorText(err)}`);
          return undefined;
        }
      },
    };
  } catch (err) {
    sourceControl.dispose();
    throw err;
  }

  const update = (): void => {
    try {
      const status = repo.status;
      const descriptors = groupDescriptors(status);
      const changed = new Set(changedGroups(signatures, descriptors));
      for (const d of descriptors) {
        const group = groups.get(d.id);
        if (!group || !changed.has(d.id)) { continue; }
        group.resourceStates = d.resources.map((r) => toResourceState(repo, r));
        signatures.set(d.id, groupSignature(d));
      }
      sourceControl.count = countFor(status, s.config.scmCountIncoming);
      sourceControl.inputBox.placeholder = placeholderFor(status, process.platform);
      sourceControl.statusBarCommands = statusBarCommandsFor(status);
    } catch (err) {
      s.log.error(`scm update failed for ${repo.root.fsPath}: ${errorText(err)}`);
    }
  };

  const snapshot = (): ScmRepoSnapshot => {
    const groupSnaps: ScmGroupSnapshot[] = [...groups.values()].map((g) => ({
      id: g.id as ScmGroup,
      label: g.label,
      hideWhenEmpty: g.hideWhenEmpty === true,
      resources: g.resourceStates.map((r) => resourceSnapshot(repo, r)),
    }));
    const snap: ScmRepoSnapshot = {
      root: repo.root.fsPath,
      count: sourceControl.count ?? 0,
      inputPlaceholder: sourceControl.inputBox.placeholder,
      statusBarCommands: (sourceControl.statusBarCommands ?? []).map((c) => c.command),
      groups: groupSnaps,
    };
    if (sourceControl.acceptInputCommand) { snap.acceptInputCommand = commandSnapshot(sourceControl.acceptInputCommand); }
    return snap;
  };

  update();
  statusSub = repo.onDidChangeStatus(() => update());

  return {
    sourceControl,
    update,
    snapshot,
    dispose: () => {
      statusSub?.dispose();
      statusSub = undefined;
      sourceControl.dispose();
    },
  };
}

/** Resolves a ProviderResult to the hook's Uri | undefined (null counts as undefined). */
function settle(result: vscode.ProviderResult<vscode.Uri>, done: () => void): vscode.Uri | undefined | Promise<vscode.Uri | undefined> {
  if (result !== null && typeof result === "object" && typeof (result as PromiseLike<unknown>).then === "function") {
    return Promise.resolve(result as PromiseLike<vscode.Uri | null | undefined>)
      .then((u) => u ?? undefined)
      .finally(done);
  }
  done();
  return (result as vscode.Uri | null | undefined) ?? undefined;
}

/**
 * One SourceControl per repository of s.model (open order), created now and on
 * onDidOpenRepository, disposed on onDidCloseRepository and with the returned Disposable.
 * The model captured here is the one this wiring serves: overrideServices re-runs wire(),
 * which disposes this registration and registers again over the new model.
 */
export function registerScm(s: Services): vscode.Disposable {
  const model = s.model;
  const entries = new Map<IRepository, RepoScm>();

  const open = (repo: IRepository): void => {
    if (entries.has(repo)) { return; }
    try {
      entries.set(repo, createRepoScm(s, repo));
    } catch (err) {
      s.log.error(`scm: cannot create the SourceControl for ${repo.root.fsPath}: ${errorText(err)}`);
    }
  };
  const close = (repo: IRepository): void => {
    const entry = entries.get(repo);
    if (!entry) { return; }
    entries.delete(repo);
    try {
      entry.dispose();
    } catch (err) {
      s.log.error(`scm: dispose failed for ${repo.root.fsPath}: ${errorText(err)}`);
    }
  };

  for (const repo of model.repositories) { open(repo); }
  const subs: vscode.Disposable[] = [
    model.onDidOpenRepository((repo) => open(repo)),
    model.onDidCloseRepository((repo) => close(repo)),
    s.config.onDidChange(() => {
      for (const entry of entries.values()) { entry.update(); }
    }),
  ];

  const scmSnapshot = (): ScmSnapshot => ({ repos: [...entries.values()].map((e) => e.snapshot()) });
  const quickDiffOriginal = (uri: vscode.Uri): vscode.Uri | undefined | Promise<vscode.Uri | undefined> => {
    const repo = s.model.getRepository(uri);
    const provider = repo ? entries.get(repo)?.sourceControl.quickDiffProvider : undefined;
    if (!provider?.provideOriginalResource) { return undefined; }
    const cts = new vscode.CancellationTokenSource();
    try {
      return settle(provider.provideOriginalResource(uri, cts.token), () => cts.dispose());
    } catch (err) {
      cts.dispose();
      throw err;
    }
  };
  testHooks.scmSnapshot = scmSnapshot;
  testHooks.quickDiffOriginal = quickDiffOriginal;

  return new vscode.Disposable(() => {
    for (const sub of subs) { sub.dispose(); }
    for (const repo of [...entries.keys()]) { close(repo); }
    if (testHooks.scmSnapshot === scmSnapshot) { delete testHooks.scmSnapshot; }
    if (testHooks.quickDiffOriginal === quickDiffOriginal) { delete testHooks.quickDiffOriginal; }
  });
}
