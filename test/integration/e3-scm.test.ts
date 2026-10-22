// e3 (WP-1.9): the Contexo Source Control provider in the VS Code host. Drives
// registerScm through hooks.overrideServices with a fakeModel over a fakeRepository on
// the 'mixed' baseline, and reads only api.hooks.scmSnapshot / quickDiffOriginal (never
// src/testApi's testHooks: the running extension is the bundle, a different module copy).
// It asserts groups, command objects and URIs, never rendered diff content: WP-1.10's
// contexo: FileSystemProvider is not in this worktree, so the diff tests register a
// throwaway read-only provider only while the scheme is free.
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { COMMAND_IDS } from "../../src/commands/ids";
import { CONTEXO_SCHEME, fromContexoUri } from "../../src/fs/contexoUri";
import { statusBarCommandsFor } from "../../src/statusBar";
import type { CommandSnapshot, ScmGroupSnapshot, ScmRepoSnapshot, TestApi } from "../../src/testApi";
import { activateExtension } from "../helpers/activate";
import { fakeModel, type FakeModel } from "../helpers/fakeModel";
import { fakeRepository, type FakeRepository } from "../helpers/fakeRepository";
import { scenarioDir } from "../helpers/fixtures";
import { waitFor } from "../helpers/waitFor";

const RATE = "wiki/concepts/rate-limits.md";
const AUTH = "wiki/concepts/auth-flow.md";
const OLD = "wiki/concepts/old-name.md";
const SYNC = "wiki/analyses/sync-model.md";
const RETRY = "wiki/concepts/retry-policy.md";
const BILLING = "wiki/entities/billing.md";
const BROKEN = "wiki/concepts/broken.md";

/** E29: the tooltip of a deleted_local resource. */
const E29_TOOLTIP = "Deleted locally. Deletes are not synced in this version; Restore Server Version brings it back.";
const KEY = process.platform === "darwin" ? "⌘Enter" : "Ctrl+Enter";

type ResourceView = { relPath: string; contextValue: string; tooltip?: string; strikeThrough?: boolean };
type GroupView = Omit<ScmGroupSnapshot, "resources"> & { resources: ResourceView[] };

/** A group snapshot without the resource commands (asserted in their own tests). */
function viewOf(g: ScmGroupSnapshot): GroupView {
  return {
    id: g.id,
    label: g.label,
    hideWhenEmpty: g.hideWhenEmpty,
    resources: g.resources.map(({ command: _command, ...rest }) => rest),
  };
}

/** The resources' relPaths of one group. */
function pathsOf(snap: ScmRepoSnapshot, id: ScmGroupSnapshot["id"]): string[] {
  const g = snap.groups.find((x) => x.id === id);
  assert.ok(g, `group ${id} missing from the snapshot`);
  return g.resources.map((r) => r.relPath);
}

/**
 * Serves `ctx show` content for contexo: URIs from the mixed scenario's show/ files
 * (empty bytes when there is none, e.g. ref 'empty'). Read-only.
 */
class ShowFileProvider implements vscode.FileSystemProvider {
  private readonly emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.emitter.event;

  private bytes(uri: vscode.Uri): Uint8Array {
    const { ref, relPath } = fromContexoUri(uri);
    const file = path.join(scenarioDir("mixed"), "show", `${path.posix.basename(relPath, ".md")}.${ref}.md`);
    return (ref === "base" || ref === "server") && fs.existsSync(file) ? fs.readFileSync(file) : new Uint8Array();
  }

  watch(): vscode.Disposable { return new vscode.Disposable(() => undefined); }
  stat(uri: vscode.Uri): vscode.FileStat {
    return { type: vscode.FileType.File, ctime: 0, mtime: 0, size: this.bytes(uri).byteLength };
  }
  readFile(uri: vscode.Uri): Uint8Array { return this.bytes(uri); }
  readDirectory(): [string, vscode.FileType][] { return []; }
  createDirectory(uri: vscode.Uri): void { throw vscode.FileSystemError.NoPermissions(uri); }
  writeFile(uri: vscode.Uri): void { throw vscode.FileSystemError.NoPermissions(uri); }
  delete(uri: vscode.Uri): void { throw vscode.FileSystemError.NoPermissions(uri); }
  rename(uri: vscode.Uri): void { throw vscode.FileSystemError.NoPermissions(uri); }
}

/**
 * Registers ShowFileProvider for 'contexo' when no provider owns the scheme yet (a second
 * registration throws); undefined when the scheme is already taken. Called once per suite:
 * after a dispose the host's scheme info lags behind the unregistration, so a per-test
 * re-registration would be skipped.
 */
function registerThrowawayContexoFs(): vscode.Disposable | undefined {
  if (vscode.workspace.fs.isWritableFileSystem(CONTEXO_SCHEME) !== undefined) { return undefined; }
  try {
    return vscode.workspace.registerFileSystemProvider(CONTEXO_SCHEME, new ShowFileProvider(), { isReadonly: true });
  } catch {
    return undefined;
  }
}

describe("e3 scm", () => {
  let api: TestApi;
  let root: vscode.Uri;
  let repo: FakeRepository;
  let model: FakeModel;
  const disposables: vscode.Disposable[] = [];
  /** The throwaway contexo: provider, when this suite registered one. */
  let contexoFs: vscode.Disposable | undefined;

  before(() => {
    contexoFs = registerThrowawayContexoFs();
  });

  after(() => {
    contexoFs?.dispose();
    contexoFs = undefined;
  });

  /** The live snapshot of the repository rooted at `at` (picked by fsPath). */
  function snapshotFor(at: vscode.Uri = root): ScmRepoSnapshot {
    const hook = api.hooks.scmSnapshot;
    assert.ok(hook, "hooks.scmSnapshot is not assigned (registerScm did not set testHooks.scmSnapshot)");
    const found = hook().repos.find((r) => r.root === at.fsPath);
    assert.ok(found, `no ScmRepoSnapshot for ${at.fsPath}`);
    return found;
  }

  /** The roots the snapshot lists. */
  function snapshotRoots(): string[] {
    const hook = api.hooks.scmSnapshot;
    assert.ok(hook, "hooks.scmSnapshot is not assigned");
    return hook().repos.map((r) => r.root);
  }

  async function quickDiffOriginal(uri: vscode.Uri): Promise<vscode.Uri | undefined> {
    const hook = api.hooks.quickDiffOriginal;
    assert.ok(hook, "hooks.quickDiffOriginal is not assigned (registerScm did not set testHooks.quickDiffOriginal)");
    return await hook(uri);
  }

  /** The command a resource's click runs. */
  function commandOf(relPath: string): CommandSnapshot {
    const resource = snapshotFor().groups.flatMap((g) => g.resources).find((r) => r.relPath === relPath);
    assert.ok(resource, `${relPath} is in no group`);
    assert.ok(resource.command, `${relPath} has no command`);
    return resource.command;
  }

  beforeEach(async () => {
    api = await activateExtension();
    await api.hooks.resetServices(); // a test that ran first may have left an override in place
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    root = vscode.workspace.workspaceFolders![0]!.uri;
    repo = fakeRepository({ root, status: "mixed" });
    model = fakeModel({ repositories: [repo] });
    disposables.push(repo, model);
    await api.hooks.overrideServices({ model });
  });

  afterEach(async () => {
    await api.hooks.resetServices();
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    for (const d of disposables.splice(0).reverse()) { d.dispose(); }
  });

  it("scmSnapshot() matches the groups above with count 3", () => {
    const snap = snapshotFor();
    const broken = repo.status?.pages.find((p) => p.path === BROKEN);
    assert.ok(broken?.invalid, "the mixed fixture's broken.md carries invalid");
    assert.deepEqual(snap.groups.map(viewOf), [
      {
        id: "conflicts", label: "Conflicts", hideWhenEmpty: true,
        resources: [{ relPath: RATE, contextValue: "conflict", tooltip: "Conflict: changed locally and on the server by Bob Lee" }],
      },
      {
        id: "changes", label: "Changes", hideWhenEmpty: false,
        resources: [
          { relPath: AUTH, contextValue: "modified", tooltip: "Modified locally" },
          { relPath: OLD, contextValue: "deleted_local", tooltip: E29_TOOLTIP, strikeThrough: true },
        ],
      },
      {
        id: "new", label: "New", hideWhenEmpty: true,
        resources: [{ relPath: SYNC, contextValue: "new", tooltip: "New: not on the server yet" }],
      },
      {
        id: "incoming", label: "Incoming", hideWhenEmpty: true,
        resources: [
          { relPath: RETRY, contextValue: "incoming", tooltip: "Changed on the server by Bob Lee" },
          { relPath: BILLING, contextValue: "incoming_new", tooltip: "New on the server by Bob Lee" },
        ],
      },
      {
        id: "invalid", label: "Invalid", hideWhenEmpty: true,
        resources: [{ relPath: BROKEN, contextValue: "invalid", tooltip: broken.invalid.message }],
      },
    ]);
    assert.equal(snap.count, 3, "E29: conflict + modified + new");
    assert.equal(
      snap.inputPlaceholder,
      process.platform === "darwin" ? "Message (⌘Enter to push to Contexo)" : "Message (Ctrl+Enter to push to Contexo)",
    );
    assert.deepEqual(snap.statusBarCommands, statusBarCommandsFor(repo.status).map((c) => c.command));
  });

  it("acceptInputCommand.command === contexo.push and arguments[0] is the SourceControl", () => {
    const accept = snapshotFor().acceptInputCommand;
    assert.ok(accept, "acceptInputCommand is set");
    assert.equal(accept.command, COMMAND_IDS.push);
    assert.equal(accept.command, "contexo.push");
    assert.equal(accept.title, "Push");
    const sc = accept.arguments?.[0] as vscode.SourceControl | undefined;
    assert.ok(sc, "arguments[0] is present");
    assert.equal(sc.id, "contexo");
    assert.equal(sc.label, "Contexo");
    assert.equal(sc.rootUri?.fsPath, root.fsPath);
    assert.ok(sc.inputBox, "the SourceControl has an inputBox");
    assert.equal(sc.inputBox.placeholder, snapshotFor().inputPlaceholder);
  });

  it("the auth-flow resourceState.command is vscode.diff with a left URI of scheme contexo (ref base) and the file URI on the right", () => {
    const cmd = commandOf(AUTH);
    assert.equal(cmd.command, "vscode.diff");
    assert.equal(cmd.title, "Open Changes");
    const [left, right, label] = cmd.arguments ?? [];
    assert.equal(typeof left, "string", "Uri arguments are snapshotted as strings");
    const leftUri = vscode.Uri.parse(left as string);
    assert.equal(leftUri.scheme, "contexo");
    const parsed = fromContexoUri(leftUri);
    assert.equal(parsed.ref, "base");
    assert.equal(parsed.root, root.fsPath);
    assert.equal(parsed.relPath, AUTH);
    assert.equal(parsed.fileUri.toString(), repo.fileUri(AUTH).toString());
    assert.equal(right, repo.fileUri(AUTH).toString());
    assert.equal(label, "auth-flow.md (Base ↔ Local)");
  });

  it("the billing resourceState.command opens a contexo server URI", () => {
    const cmd = commandOf(BILLING);
    assert.equal(cmd.command, "vscode.open");
    assert.equal(cmd.title, "Open Server Version");
    const target = vscode.Uri.parse(cmd.arguments?.[0] as string);
    assert.equal(target.scheme, "contexo");
    const parsed = fromContexoUri(target);
    assert.equal(parsed.ref, "server");
    assert.equal(parsed.root, root.fsPath);
    assert.equal(parsed.relPath, BILLING);
  });

  it("quickDiffOriginal (provideOriginalResource) returns a contexo URI for auth-flow and undefined for sync-model, broken and a file outside .contexo", async () => {
    const original = await quickDiffOriginal(repo.fileUri(AUTH));
    assert.ok(original, "auth-flow has a base original");
    assert.equal(original.scheme, "contexo");
    const parsed = fromContexoUri(original);
    assert.deepEqual({ ref: parsed.ref, root: parsed.root, relPath: parsed.relPath }, { ref: "base", root: root.fsPath, relPath: AUTH });
    assert.equal(parsed.fileUri.toString(), repo.fileUri(AUTH).toString());

    assert.equal(await quickDiffOriginal(repo.fileUri(SYNC)), undefined, "new: no base");
    assert.equal(await quickDiffOriginal(repo.fileUri(BROKEN)), undefined, "invalid: no quick diff");
    assert.equal(await quickDiffOriginal(vscode.Uri.joinPath(root, "README.md")), undefined, "outside .contexo");
    assert.equal(await quickDiffOriginal(vscode.Uri.file(path.join(path.dirname(root.fsPath), "elsewhere", "x.md"))), undefined, "no repository owns it");
  });

  it("a fakeRepository setStatus moves retry-policy from Incoming to Conflicts", () => {
    assert.deepEqual(pathsOf(snapshotFor(), "incoming"), [RETRY, BILLING]);
    repo.setStatus("e3-retry-conflict");
    const snap = snapshotFor();
    assert.deepEqual(pathsOf(snap, "conflicts"), [RATE, RETRY]);
    assert.deepEqual(pathsOf(snap, "incoming"), [BILLING]);
    const retry = snap.groups.find((g) => g.id === "conflicts")?.resources.find((r) => r.relPath === RETRY);
    assert.equal(retry?.contextValue, "conflict");
    assert.equal(snap.count, 4, "E29: 2 conflicts + 1 modified + 1 new");
  });

  it("closing the repository disposes its SourceControl", async () => {
    const sc = snapshotFor().acceptInputCommand?.arguments?.[0] as vscode.SourceControl | undefined;
    assert.ok(sc, "the live SourceControl");
    const realDispose = sc.dispose.bind(sc);
    let disposeCalls = 0;
    (sc as { dispose: () => void }).dispose = () => { disposeCalls++; realDispose(); };

    model.removeRepository(repo);

    await waitFor(() => disposeCalls > 0, { message: "SourceControl.dispose was not called" });
    assert.equal(disposeCalls, 1);
    assert.ok(!snapshotRoots().includes(root.fsPath), "the snapshot no longer lists the root");
    assert.equal(await quickDiffOriginal(repo.fileUri(AUTH)), undefined);

    repo.setStatus("e3-retry-conflict");
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.ok(!snapshotRoots().includes(root.fsPath), "a later setStatus does not bring it back");
    assert.equal(disposeCalls, 1);
  });

  it("countIncoming=true counts incoming (5)", async () => {
    assert.equal(snapshotFor().count, 3);
    try {
      await vscode.workspace.getConfiguration("contexo").update("scm.countIncoming", true, vscode.ConfigurationTarget.Global);
      await waitFor(() => snapshotFor().count === 5, { message: `count stayed ${snapshotFor().count}` });
    } finally {
      await vscode.workspace.getConfiguration("contexo").update("scm.countIncoming", undefined, vscode.ConfigurationTarget.Global);
    }
    await waitFor(() => snapshotFor().count === 3, { message: "count returns to 3 once the setting is cleared" });
  });

  it("blocks_push switches the input placeholder", () => {
    repo.setStatus("e3-blocks-push");
    assert.equal(snapshotFor().inputPlaceholder, `1 agent session(s) not distilled: ${KEY} offers Share via your agent`);
  });

  it("one SourceControl per repository (multi-root rootUri)", async () => {
    const nestedRoot = vscode.Uri.joinPath(root, "nested-wp19");
    const second = fakeRepository({ root: nestedRoot, status: "mixed" });
    disposables.push(second);
    model.addRepository(second);

    const roots = snapshotRoots();
    assert.deepEqual(roots, [root.fsPath, nestedRoot.fsPath], "one snapshot per repository, in open order");
    const first = snapshotFor(root).acceptInputCommand?.arguments?.[0] as vscode.SourceControl;
    const other = snapshotFor(nestedRoot).acceptInputCommand?.arguments?.[0] as vscode.SourceControl;
    assert.notEqual(first, other, "two SourceControl objects");
    assert.equal(first.rootUri?.fsPath, root.fsPath);
    assert.equal(other.rootUri?.fsPath, nestedRoot.fsPath);
    assert.equal(snapshotFor(nestedRoot).count, 3);

    const a = await quickDiffOriginal(repo.fileUri(AUTH));
    const b = await quickDiffOriginal(second.fileUri(AUTH));
    assert.ok(a && b, "both repositories serve a base original");
    assert.equal(fromContexoUri(a).root, root.fsPath);
    assert.equal(fromContexoUri(b).root, nestedRoot.fsPath);
    assert.equal(fromContexoUri(b).fileUri.toString(), second.fileUri(AUTH).toString());
  });

  it("contexo.openChange opens the Base ↔ Local diff", async () => {
    const file = repo.fileUri(AUTH);

    await vscode.commands.executeCommand(COMMAND_IDS.openChange, { resourceUri: file });

    const tab = await waitFor(() => {
      const t = vscode.window.tabGroups.activeTabGroup.activeTab;
      return t?.input instanceof vscode.TabInputTextDiff ? t : undefined;
    }, { message: "no diff tab became active" });
    const input = tab.input as vscode.TabInputTextDiff;
    assert.equal(input.original.scheme, "contexo");
    const parsed = fromContexoUri(input.original);
    assert.equal(parsed.ref, "base");
    assert.equal(parsed.relPath, AUTH);
    assert.equal(input.modified.toString(), file.toString());
    assert.equal(tab.label, "auth-flow.md (Base ↔ Local)");
    if (contexoFs) {
      // Only with this suite's provider: the left side resolves to the scenario's base version.
      const base = fs.readFileSync(path.join(scenarioDir("mixed"), "show", "auth-flow.base.md"), "utf8");
      assert.equal((await vscode.workspace.openTextDocument(input.original)).getText(), base);
    }
  });

  it("contexo.openAllChanges runs vscode.changes over the group's tuples", async () => {
    const group = { id: "changes", resourceStates: [{ resourceUri: repo.fileUri(AUTH) }] };

    await vscode.commands.executeCommand(COMMAND_IDS.openAllChanges, group);

    const label = await waitFor(() => {
      const l = vscode.window.tabGroups.activeTabGroup.activeTab?.label;
      return l?.startsWith("Contexo: Changes") ? l : undefined;
    }, { message: `active tab is ${JSON.stringify(vscode.window.tabGroups.activeTabGroup.activeTab?.label)}` });
    // The multi-diff editor (VS Code 1.100) labels its tab '<title> (<N> files)': the
    // Changes group of 'mixed' gives two tuples, auth-flow (modified) and old-name (deleted_local).
    const m = /^Contexo: Changes(?: \((\d+) files?\))?$/.exec(label);
    assert.ok(m, `unexpected multi-diff tab label ${JSON.stringify(label)}`);
    if (m[1] !== undefined) { assert.equal(Number(m[1]), 2, "two Changes tuples"); }
  });
});
