// activation (WP-2.3): the 'mixed' scenario as the REAL wiring renders it after a settled
// online refresh: the five SCM resource groups and the E29 count, the file decorations, the
// Knowledge tree (E30 membership, Concepts, Invalid, badge), the SourceControl status bar
// command, the Contexo status bar item and contexo.state. Observed only through the TestApi
// snapshot hooks and the real SourceControl object (sourceControlOf).
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as sinon from "sinon";
import * as vscode from "vscode";
import { COMMAND_IDS } from "../../src/commands/ids";
import type { StatusDoc } from "../../src/contract/types";
import { decorationForState } from "../../src/decorations/decorationModel";
import { DELETED_LOCAL_TOOLTIP } from "../../src/scm/resourceModel";
import { STATUS_BAR_ITEM_ID, presentStatusBar } from "../../src/statusBar";
import type { TreeNodeSnapshot } from "../../src/testApi";
import { treeBadge } from "../../src/tree/treeModel";
import { STATE_CONTEXT_KEY } from "../../src/welcome/contextKeys";
import { SCENARIOS, groupPaths, openWorkspaceCopy, pagePath, scmRepo, sourceControlOf, waitFor } from "../helpers/e2e";

const LOGIN_DEBUG = "raw/sessions/2026-10-01-login-debug.md";
const SYNC_MODEL = "wiki/analyses/sync-model.md";
const AUTH_FLOW = "wiki/concepts/auth-flow.md";
const BROKEN = "wiki/concepts/broken.md";
const LEGACY_SYNC = "wiki/concepts/legacy-sync.md";
const OLD_NAME = "wiki/concepts/old-name.md";
const RATE_LIMITS = "wiki/concepts/rate-limits.md";
const RETRY_POLICY = "wiki/concepts/retry-policy.md";
const BILLING = "wiki/entities/billing.md";
const GITSTORE = "wiki/entities/gitstore.md";

/** WP-1.11.md TREE_BADGE_MIXED. */
const TREE_BADGE_MIXED = 3;

/** The online StatusDoc the 'mixed' scenario serves. */
function mixedStatus(): StatusDoc {
  return JSON.parse(fs.readFileSync(path.join(SCENARIOS, "mixed", "status.json"), "utf8")) as StatusDoc;
}

/** '/'-separated *.md pages under <root>/.contexo on disk (no root index.md/tags.md, no dot segments). */
function localPages(root: string): string[] {
  const hub = path.join(root, ".contexo");
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith(".")) { continue; }
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      const rel = path.relative(hub, full).split(path.sep).join("/");
      if (rel.endsWith(".md") && rel !== "index.md" && rel !== "tags.md") { out.push(rel); }
    }
  };
  walk(hub);
  return out.sort();
}

/** relPath of a tree node's resourceUri (file:<root>/.contexo/<relPath>). */
function relOfNode(root: string, node: TreeNodeSnapshot): string {
  assert.ok(node.resourceUri, `tree node ${node.label} has a resourceUri`);
  const fsPath = vscode.Uri.parse(node.resourceUri).fsPath;
  return path.relative(path.join(root, ".contexo"), fsPath).split(path.sep).join("/");
}

/** Every page node ('page.<state>') of the tree, depth first. */
function pageNodes(nodes: readonly TreeNodeSnapshot[]): TreeNodeSnapshot[] {
  return nodes.flatMap((n) => [...((n.contextValue ?? "").startsWith("page.") ? [n] : []), ...pageNodes(n.children)]);
}

/** A tree node by its WP-1.11 id. */
function nodeById(nodes: readonly TreeNodeSnapshot[], id: string): TreeNodeSnapshot {
  const found = nodes.find((n) => n.id === id);
  assert.ok(found, `tree node ${id} (have ${JSON.stringify(nodes.map((n) => n.id))})`);
  return found;
}

/** The numbers of a '$(cloud-upload) A $(cloud-download) B[ $(warning) C]' title. */
function aheadBehind(title: string): { ahead: number; behind: number; conflicts: number } {
  const m = /^\$\(cloud-upload\) (\d+) \$\(cloud-download\) (\d+)(?: \$\(warning\) (\d+))?$/.exec(title);
  assert.ok(m, `status bar command title ${JSON.stringify(title)}`);
  return { ahead: Number(m[1]), behind: Number(m[2]), conflicts: Number(m[3] ?? 0) };
}

describe("activation (e2e): the mixed scenario through the real wiring", function () {
  this.timeout(60000);

  it("SCM: Conflicts 1, Changes 2 (auth-flow modified, old-name deleted_local with the E29 tooltip), New 1, Incoming 2, Invalid 1; SourceControl.count == 3", async () => {
    const w = await openWorkspaceCopy({ scenario: "mixed" });
    const repo = scmRepo(w.api);
    assert.deepEqual(repo.groups.map((g) => g.id), ["conflicts", "changes", "new", "incoming", "invalid"]);
    assert.deepEqual(groupPaths(repo, "conflicts"), [RATE_LIMITS]);
    assert.deepEqual(groupPaths(repo, "changes"), [AUTH_FLOW, OLD_NAME]);
    assert.deepEqual(groupPaths(repo, "new"), [SYNC_MODEL]);
    assert.deepEqual(groupPaths(repo, "incoming"), [RETRY_POLICY, BILLING]);
    assert.deepEqual(groupPaths(repo, "invalid"), [BROKEN]);

    const states = new Map(repo.groups.flatMap((g) => g.resources.map((r) => [r.relPath, r] as const)));
    assert.equal(states.get(RATE_LIMITS)?.contextValue, "conflict");
    assert.equal(states.get(AUTH_FLOW)?.contextValue, "modified");
    assert.equal(states.get(OLD_NAME)?.contextValue, "deleted_local");
    assert.equal(states.get(OLD_NAME)?.tooltip, DELETED_LOCAL_TOOLTIP, "E29 tooltip on the deleted_local resource");
    assert.equal(states.get(OLD_NAME)?.strikeThrough, true, "deleted_local is struck through");
    assert.equal(states.get(RETRY_POLICY)?.contextValue, "incoming");
    assert.equal(states.get(BILLING)?.contextValue, "incoming_new");
    assert.equal(states.get(BROKEN)?.contextValue, "invalid");
    for (const rel of [LOGIN_DEBUG, LEGACY_SYNC, GITSTORE]) {
      assert.equal(states.has(rel), false, `${rel} (unchanged/unverified) is in no group`);
    }

    assert.equal(repo.count, 3, "E29: conflict + modified + new");
    assert.equal(sourceControlOf(w.api).count, 3, "the real SourceControl.count");
    assert.equal(repo.acceptInputCommand?.command, COMMAND_IDS.push);
  });

  it("contexo.scm.countIncoming=true adds Incoming to the count: SourceControl.count 5, back to 3 when reset", async () => {
    const w = await openWorkspaceCopy({ scenario: "mixed" });
    const config = (): vscode.WorkspaceConfiguration => vscode.workspace.getConfiguration("contexo");
    try {
      await config().update("scm.countIncoming", true, vscode.ConfigurationTarget.Global);
      await waitFor(() => scmRepo(w.api).count === 5, { timeoutMs: 5000, message: "count 5 with countIncoming" });
    } finally {
      await config().update("scm.countIncoming", undefined, vscode.ConfigurationTarget.Global);
    }
    await waitFor(() => scmRepo(w.api).count === 3, { timeoutMs: 5000, message: "count back to 3" });
    assert.deepEqual(w.calls(), [], "a settings change runs no ctx call");
  });

  it("every SCM resource with a local file has the decoration of its state; unverified gets '?', unchanged pages none", async () => {
    const w = await openWorkspaceCopy({ scenario: "mixed" });
    const decorationFor = w.api.hooks.decorationFor;
    assert.ok(decorationFor, "decorationFor hook");
    const withFile: string[] = [];
    for (const group of scmRepo(w.api).groups) {
      for (const r of group.resources) {
        const file = pagePath(w.root, r.relPath);
        if (!fs.existsSync(file)) { continue; }
        withFile.push(r.relPath);
        const expected = decorationForState(r.contextValue);
        assert.ok(expected, `${r.contextValue} has a decoration`);
        assert.deepEqual(decorationFor(vscode.Uri.file(file)), {
          badge: expected.badge, tooltip: expected.tooltip, propagate: expected.propagate,
          ...(expected.color === undefined ? {} : { color: expected.color }),
        }, `decoration of ${r.relPath} (${r.contextValue})`);
      }
    }
    assert.deepEqual(withFile.sort(), [SYNC_MODEL, AUTH_FLOW, BROKEN, RATE_LIMITS, RETRY_POLICY].sort(),
      "old-name (deleted_local) and billing (incoming_new) have no local file");
    assert.equal(decorationFor(vscode.Uri.file(pagePath(w.root, LEGACY_SYNC)))?.badge, decorationForState("unverified")?.badge);
    for (const rel of [LOGIN_DEBUG, GITSTORE]) {
      assert.equal(decorationFor(vscode.Uri.file(pagePath(w.root, rel))), undefined, `${rel} (unchanged) is not decorated`);
    }
    for (const rel of ["index.md", "tags.md"]) {
      assert.equal(decorationFor(vscode.Uri.file(pagePath(w.root, rel))), undefined, `generated ${rel} is not decorated`);
    }
  });

  it("Knowledge tree: exactly the pages with a local file (no billing, no old-name), Concepts 4, broken.md under Invalid, badge == treeBadge(mixed) == 3", async () => {
    const w = await openWorkspaceCopy({ scenario: "mixed" });
    const snap = w.api.hooks.treeSnapshot?.();
    assert.ok(snap, "treeSnapshot hook");
    const R = w.root;

    const listed = pageNodes(snap.roots).map((n) => relOfNode(R, n)).sort();
    assert.deepEqual(listed, localPages(R), "E30: the tree lists exactly the pages whose working file exists");
    assert.equal(listed.length, 8);
    assert.ok(!listed.includes(BILLING) && !listed.includes(OLD_NAME), "incoming_new and deleted_local are not listed");

    assert.equal(snap.roots[0]?.id, `${R}|#pending`, "the pending agent-session item comes first (captures.pending 2)");
    const concepts = nodeById(snap.roots, `${R}|#concepts`);
    assert.deepEqual(concepts.children.map((n) => relOfNode(R, n)), [AUTH_FLOW, LEGACY_SYNC, RATE_LIMITS, RETRY_POLICY]);
    assert.equal(nodeById(concepts.children, `${R}|${RATE_LIMITS}`).contextValue, "page.conflict");
    const invalid = nodeById(snap.roots, `${R}|#invalid`);
    assert.deepEqual(invalid.children.map((n) => relOfNode(R, n)), [BROKEN]);
    assert.equal(invalid.children[0]?.contextValue, "page.invalid");
    assert.deepEqual(nodeById(snap.roots, `${R}|#entities`).children.map((n) => relOfNode(R, n)), [GITSTORE]);

    const expected = treeBadge([mixedStatus()]);
    assert.ok(expected, "treeBadge(mixed) is defined");
    assert.equal(expected.value, TREE_BADGE_MIXED, "WP-1.11.md TREE_BADGE_MIXED");
    assert.deepEqual(snap.badge, expected, "the TreeView badge is treeBadge over the mixed status");
  });

  it("status bar: the SourceControl command shows ahead 2, behind 2 and 1 conflict; the Contexo item is the ready presentation; model.state is ready", async () => {
    const w = await openWorkspaceCopy({ scenario: "mixed" });
    const commands = sourceControlOf(w.api).statusBarCommands ?? [];
    assert.equal(commands.length, 1);
    const cmd = commands[0] as vscode.Command;
    assert.equal(cmd.command, COMMAND_IDS.refresh);
    assert.deepEqual(aheadBehind(cmd.title), { ahead: 2, behind: 2, conflicts: 1 });
    assert.ok(String(cmd.tooltip).startsWith("2 to push · 2 incoming · 1 conflict(s) · "), `tooltip ${String(cmd.tooltip)}`);
    assert.deepEqual(scmRepo(w.api).statusBarCommands, [COMMAND_IDS.refresh]);

    assert.equal(w.api.services.model.state, "ready");
    const status = w.repo().status;
    assert.ok(status);
    const ready = presentStatusBar("ready", [status], false);
    assert.deepEqual(w.api.hooks.statusBarSnapshot?.().items, [
      { id: STATUS_BAR_ITEM_ID, text: ready.text, tooltip: ready.tooltip, command: ready.command.command },
    ]);
  });

  it("contexo.state is set to ready (setContext seen on a re-wire of the same services)", async () => {
    const w = await openWorkspaceCopy({ scenario: "mixed" });
    const spy = sinon.spy(vscode.commands, "executeCommand");
    try {
      await w.api.hooks.overrideServices({}); // re-runs wire() over the same cli and model
      const stateCalls = (): unknown[] => spy.getCalls()
        .filter((c) => c.args[0] === "setContext" && c.args[1] === STATE_CONTEXT_KEY)
        .map((c) => c.args[2]);
      await waitFor(() => stateCalls().length >= 1, { timeoutMs: 5000, message: "setContext contexo.state" });
      assert.deepEqual(stateCalls(), ["ready"]);
    } finally {
      spy.restore();
    }
    assert.equal(w.api.services.model.state, "ready");
    assert.deepEqual(groupPaths(scmRepo(w.api), "conflicts"), [RATE_LIMITS], "the re-wired SourceControl renders the same status");
  });
});
