// e5 (WP-1.11): the 'Contexo › Knowledge' TreeView, driven through the activated extension
// with hooks.overrideServices({model: fakeModel(...)}) and read through hooks.treeSnapshot().
// Real-argv and calls.jsonl assertions belong to WP-2.3's e2e suite.
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import type { PageEntry, StatusDoc } from "../../src/contract/types";
import type { Services } from "../../src/services";
import type { TestApi, TreeNodeSnapshot, TreeSnapshot } from "../../src/testApi";
import { KnowledgeTreeBinding, KnowledgeTreeProvider, type TreeViewSink } from "../../src/tree/knowledgeTree";
import { pageTooltip } from "../../src/tree/treeItems";
import { buildTree, type GroupNode, type PageNode, type TreeNode } from "../../src/tree/treeModel";
import { activateExtension } from "../helpers/activate";
import { fakeModel, type FakeModel } from "../helpers/fakeModel";
import { fakeRepository, type FakeRepository } from "../helpers/fakeRepository";
import { REPO_ROOT, loadStatusDoc } from "../helpers/fixtures";
import { waitFor } from "../helpers/waitFor";
import { MIXED_BADGE, MIXED_GROUPS, MIXED_PENDING } from "../unit/tree/mixedExpectation";

const NOT_LOGGED_IN = "Not logged in: showing local pages only";

function workspaceRoot(): vscode.Uri {
  const folder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(folder, "the integration label opens the 'basic' workspace");
  return folder.uri;
}

/** What treeSnapshot() must show for 'mixed' in a single-repository workspace. */
function expectedMixedRoots(repo: FakeRepository): TreeNodeSnapshot[] {
  const r = repo.root.fsPath;
  return [
    { label: `${MIXED_PENDING} agent session(s) not yet shared`, id: `${r}|#pending`, contextValue: "session", children: [] },
    ...MIXED_GROUPS.map((g) => ({
      label: g.label,
      id: `${r}|#${g.key}`,
      contextValue: "group",
      children: g.pages.map((p) => ({
        label: p.label,
        id: `${r}|${p.path}`,
        ...(p.description !== undefined ? { description: p.description } : {}),
        contextValue: p.contextValue,
        resourceUri: repo.fileUri(p.path).toString(),
        children: [],
      })),
    })),
  ];
}

function snapshot(api: TestApi): TreeSnapshot {
  const snap = api.hooks.treeSnapshot?.();
  assert.ok(snap, "WP-1.11 assigns testHooks.treeSnapshot");
  return snap;
}

function flatten(nodes: TreeNodeSnapshot[]): TreeNodeSnapshot[] {
  return nodes.flatMap((n) => [n, ...flatten(n.children)]);
}

/** Counts the knowledge tree's onDidChangeTreeData fires (each is traced to services.log). */
function countTreeChanges(services: Services): { readonly count: number; restore(): void } {
  const log = services.log as unknown as { trace: (...a: unknown[]) => void };
  const original = log.trace;
  const state = { count: 0 };
  log.trace = (...a: unknown[]) => {
    if (String(a[0]).startsWith("knowledge tree: onDidChangeTreeData")) { state.count++; }
    original.apply(services.log, a);
  };
  return {
    get count() { return state.count; },
    restore() { log.trace = original; },
  };
}

/** A copy of a scenario's StatusDoc with one page's tags replaced. */
function withTags(name: string, relPath: string, tags: string[]): StatusDoc {
  const doc = loadStatusDoc(name);
  (doc.pages.find((p) => p.path === relPath) as PageEntry).tags = tags;
  return doc;
}

describe("e5 knowledge tree", () => {
  let api: TestApi;

  before(async () => {
    api = await activateExtension();
  });

  afterEach(async () => {
    await api.hooks.resetServices();
  });

  async function useModel(m: FakeModel): Promise<FakeModel> {
    await api.hooks.overrideServices({ model: m });
    return m;
  }

  describe("part 1", () => {
    it("treeSnapshot() matches the unit expectation for mixed", async () => {
      const repo = fakeRepository({ root: workspaceRoot(), status: "mixed" });
      await useModel(fakeModel({ repositories: [repo] }));
      const snap = snapshot(api);
      assert.deepEqual(snap.roots, expectedMixedRoots(repo));
      assert.equal(snap.message, undefined);
      // The same rule as the pure model (E30): exactly the local pages of status.pages.
      const pages = flatten(snap.roots).filter((n) => n.contextValue?.startsWith("page."));
      const status = repo.status as StatusDoc;
      assert.deepEqual(pages.map((p) => p.resourceUri).sort(), status.pages.filter((p) => p.local).map((p) => repo.fileUri(p.path).toString()).sort());
    });

    it("badge.value === captures.pending + counts.conflict of mixed", async () => {
      const repo = fakeRepository({ root: workspaceRoot(), status: "mixed" });
      await useModel(fakeModel({ repositories: [repo] }));
      const status = repo.status as StatusDoc;
      const snap = snapshot(api);
      assert.equal(snap.badge?.value, status.captures.pending + status.counts.conflict);
      assert.deepEqual(snap.badge, MIXED_BADGE);
      repo.setStatus("clean");
      assert.equal(snapshot(api).badge, undefined, "no badge when the sum is 0");
      repo.setStatus("mixed");
      assert.deepEqual(snapshot(api).badge, MIXED_BADGE);
    });

    it("e5-not-authenticated: TreeView.message is \"Not logged in: showing local pages only\"; it clears when the state becomes ready", async () => {
      const repo = fakeRepository({ root: workspaceRoot(), status: "e5-not-authenticated" });
      const m = await useModel(fakeModel({ state: "notLoggedIn", repositories: [repo] }));
      let snap = snapshot(api);
      assert.equal(snap.message, NOT_LOGGED_IN);
      const labels = flatten(snap.roots).map((n) => n.label);
      for (const l of ["Auth flow", "Retry policy", "Sync model", "Gitstore", "broken", "1 agent session(s) not yet shared"]) {
        assert.ok(labels.includes(l), `local page ${l} is still listed`);
      }
      assert.ok(!labels.includes("old-name"), "deleted_local is not listed");
      m.setState("ready");
      snap = snapshot(api);
      assert.equal(snap.message, undefined);
      assert.ok(snap.roots.length > 0);
      m.setState("notLoggedIn");
      assert.equal(snapshot(api).message, NOT_LOGGED_IN);
    });

    it("the welcome states (ctx missing, too old, extension too old) render no children and no badge", async () => {
      const repo = fakeRepository({ root: workspaceRoot(), status: "mixed" });
      const m = await useModel(fakeModel({ repositories: [repo] }));
      for (const s of ["ctxMissing", "ctxTooOld", "extensionTooOld"] as const) {
        m.setState(s);
        const snap = snapshot(api);
        assert.deepEqual(snap.roots, [], s);
        assert.equal(snap.badge, undefined, s);
        assert.equal(snap.message, undefined, s);
        m.setState("ready");
        assert.deepEqual(snapshot(api).roots, expectedMixedRoots(repo));
      }
    });

    it("contexo.tree.showSessions=false drops Sessions (config change re-renders)", async () => {
      const repo = fakeRepository({ root: workspaceRoot(), status: "e5-sessions-hidden" });
      await useModel(fakeModel({ repositories: [repo] }));
      const groupsOf = (): string[] => snapshot(api).roots.filter((n) => n.contextValue === "group").map((n) => n.label);
      assert.deepEqual(groupsOf(), ["Concepts", "Entities", "Sessions"]);
      const config = vscode.workspace.getConfiguration("contexo");
      try {
        await config.update("tree.showSessions", false, vscode.ConfigurationTarget.Global);
        await waitFor(() => !groupsOf().includes("Sessions"), { message: "Sessions hidden" });
        assert.deepEqual(groupsOf(), ["Concepts", "Entities"]);
        assert.equal(snapshot(api).roots[0]?.contextValue, "session", "the pending item stays");
      } finally {
        await config.update("tree.showSessions", undefined, vscode.ConfigurationTarget.Global);
      }
      await waitFor(() => groupsOf().includes("Sessions"), { message: "Sessions back" });
    });
  });

  describe("part 2", () => {
    it("e5-two-repos: two top-level repo nodes with distinct ids", async () => {
      const first = fakeRepository({ root: workspaceRoot(), status: "mixed" });
      const second = fakeRepository({ root: path.join(path.dirname(workspaceRoot().fsPath), "e5-beta"), status: "e5-two-repos" });
      const m = await useModel(fakeModel({ repositories: [first, second] }));
      let snap = snapshot(api);
      assert.equal(snap.roots.length, 2);
      const [a, b] = snap.roots as [TreeNodeSnapshot, TreeNodeSnapshot];
      assert.notEqual(a.id, b.id);
      assert.deepEqual([a.label, b.label], [path.basename(workspaceRoot().fsPath), "e5-beta"], "labelled with the workspace-folder name");
      assert.deepEqual([a.contextValue, b.contextValue], ["repository", "repository"]);
      assert.deepEqual(a.children, expectedMixedRoots(first));
      assert.deepEqual(b.children.map((c) => c.label), ["Concepts", "Entities"]);
      const ids = flatten(snap.roots).map((n) => n.id);
      assert.equal(new Set(ids).size, ids.length, "ids are unique across both repositories");
      assert.deepEqual(snap.badge, { value: 4, tooltip: "2 agent session(s) pending · 2 conflict(s)" });

      m.removeRepository(second);
      snap = snapshot(api);
      assert.deepEqual(snap.roots, expectedMixedRoots(first), "back to the single-repository layout");
      m.addRepository(second);
      assert.equal(snapshot(api).roots.length, 2);
    });

    it("an identical status fired again causes no onDidChangeTreeData", async () => {
      const repo = fakeRepository({ root: workspaceRoot(), status: "mixed" });
      await useModel(fakeModel({ repositories: [repo] }));
      const changes = countTreeChanges(api.services);
      try {
        repo.setStatus(loadStatusDoc("mixed"));
        repo.setStatus(loadStatusDoc("mixed"));
        assert.equal(changes.count, 0, "an identical StatusDoc (new object) does not refresh the tree");
        repo.setStatus(withTags("mixed", "wiki/entities/gitstore.md", ["server", "storage", "git"]));
        assert.equal(changes.count, 1, "one changed tag refreshes once");
        const gitstore = flatten(snapshot(api).roots).find((n) => n.label === "Gitstore");
        assert.equal(gitstore?.description, "server, storage, git");
      } finally {
        changes.restore();
      }
    });

    it("a tree item contextValue matches a frozen package.json view/item/context when-clause (read package.json in the test)", async () => {
      const repo = fakeRepository({ root: workspaceRoot(), status: "mixed" });
      await useModel(fakeModel({ repositories: [repo] }));
      const manifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as {
        contributes: { menus: { "view/item/context": { command: string; when: string }[] } };
      };
      const entries = manifest.contributes.menus["view/item/context"].filter((e) => e.when.includes("view == contexo.knowledge"));
      const matches = (when: string, contextValue: string): boolean => {
        const re = /viewItem =~ \/(.+?)\/(?=\s|$)/.exec(when);
        if (re) { return new RegExp(re[1] as string).test(contextValue); }
        const eq = /viewItem == (\S+)/.exec(when);
        return eq !== null && eq[1] === contextValue;
      };
      const nodes = flatten(snapshot(api).roots);
      const pages = nodes.filter((n) => n.contextValue?.startsWith("page."));
      assert.equal(pages.length, 8);
      for (const p of pages) {
        const cmds = entries.filter((e) => matches(e.when, p.contextValue as string)).map((e) => e.command);
        assert.deepEqual(cmds.sort(), ["contexo.openFile", "contexo.openInDashboard"], `${p.contextValue}`);
      }
      const session = nodes.find((n) => n.contextValue === "session");
      assert.ok(session);
      assert.deepEqual(entries.filter((e) => matches(e.when, "session")).map((e) => e.command), ["contexo.shareViaAgent"]);
      for (const n of nodes.filter((x) => !x.contextValue?.startsWith("page.") && x.contextValue !== "session")) {
        assert.deepEqual(entries.filter((e) => matches(e.when, n.contextValue ?? "")), [], `${n.label} gets no item menu`);
      }
    });

    it("the provider fires onDidChangeTreeData only when a repository's treeSignature changes, and getParent walks back to the root", async () => {
      const repo = fakeRepository({ root: workspaceRoot(), status: "mixed" });
      const other = fakeRepository({ root: path.join(path.dirname(workspaceRoot().fsPath), "e5-beta"), status: "e5-two-repos" });
      const m = fakeModel({ repositories: [repo] });
      const provider = new KnowledgeTreeProvider();
      const sink: TreeViewSink = { badge: undefined, message: undefined };
      const fired: (TreeNode | undefined)[] = [];
      const sub = provider.onDidChangeTreeData((e) => { fired.push(e ?? undefined); });
      const binding = new KnowledgeTreeBinding({ ...api.services, model: m }, provider, sink);
      try {
        assert.deepEqual(sink.badge, MIXED_BADGE);
        fired.length = 0;
        repo.setStatus(loadStatusDoc("mixed"));
        assert.deepEqual(fired, []);
        repo.setStatus(withTags("mixed", "wiki/concepts/auth-flow.md", ["auth"]));
        assert.deepEqual(fired, [undefined], "single repository: the whole tree");

        const roots = provider.getChildren() as TreeNode[];
        const concepts = roots.find((n) => n.kind === "group" && n.key === "concepts") as GroupNode;
        const auth = (provider.getChildren(concepts) as PageNode[])[0] as PageNode;
        assert.equal(provider.getParent(auth), concepts);
        assert.equal(provider.getParent(concepts), undefined);
        const item = provider.getTreeItem(auth) as vscode.TreeItem;
        assert.equal(item.tooltip, undefined);
        const resolved = await provider.resolveTreeItem(item, auth, new vscode.CancellationTokenSource().token);
        assert.ok(resolved?.tooltip instanceof vscode.MarkdownString);

        m.addRepository(other);
        const repoNodes = provider.getChildren() as TreeNode[];
        assert.deepEqual(repoNodes.map((n) => n.kind), ["repo", "repo"]);
        const betaRoot = repoNodes[1] as TreeNode;
        const betaConcepts = (provider.getChildren(betaRoot) as TreeNode[])[0] as GroupNode;
        assert.equal(provider.getParent(betaConcepts), betaRoot);
        assert.equal(provider.getParent((provider.getChildren(betaConcepts) as PageNode[])[0] as PageNode), betaConcepts);
        fired.length = 0;
        other.setStatus(withTags("e5-two-repos", "wiki/concepts/caching.md", ["perf", "cdn"]));
        assert.deepEqual(fired, [betaRoot], "two repositories: only the changed repository node, same object");
        assert.equal((provider.getChildren() as TreeNode[])[1], betaRoot, "repository elements keep their identity");
        repo.setStatus(withTags("mixed", "wiki/concepts/auth-flow.md", ["auth"]));
        assert.deepEqual(fired, [betaRoot], "the unchanged repository fires nothing");
      } finally {
        binding.dispose();
        sub.dispose();
        provider.dispose();
        m.dispose();
      }
    });

    it("page tooltips are untrusted MarkdownStrings that escape teammate-authored text", () => {
      const doc = loadStatusDoc("mixed");
      const evil = doc.pages.find((p) => p.path === "wiki/concepts/auth-flow.md") as PageEntry;
      evil.title = "[run](command:workbench.action.terminal.new)";
      evil.reasoning_summary = "<img src=x onerror=alert(1)> **bold** [x](https://evil.example)";
      evil.tags = ["$(alert)", "a_b"];
      const nodes = buildTree([{ root: "/r", name: "r", status: doc }], { showSessions: true });
      const concepts = nodes.find((n) => n.kind === "group" && n.key === "concepts") as GroupNode;
      const page = concepts.pages.find((p) => p.path === "wiki/concepts/auth-flow.md") as PageNode;
      const md = pageTooltip(page);
      assert.equal(md.isTrusted, false);
      assert.equal(md.supportHtml, false);
      assert.equal(md.supportThemeIcons, false);
      assert.ok(!md.value.includes("[x](https://evil.example)"), md.value);
      assert.ok(!md.value.includes("**bold**"), md.value);
      assert.ok(md.value.includes("\\*\\*bold\\*\\*"), md.value);
      assert.ok(md.value.includes("**Summary:**"), "field names stay Markdown");
    });
  });
});
