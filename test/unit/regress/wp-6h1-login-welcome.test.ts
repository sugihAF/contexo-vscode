// WP-6H.1 (NO-GO defect D1, acceptance row E4): with no credentials the Knowledge view must
// show its viewsWelcome entry for `contexo.state == notLoggedIn` (Log In and the
// `ctx auth login --no-browser` hint). VS Code renders viewsWelcome content only while the
// tree has no root nodes AND TreeView.message is unset or "", so the binding must leave the
// message unset whenever the notLoggedIn tree is empty. Drives the real KnowledgeTreeBinding
// over the unit vscode stub; the one API it borrows beyond the stub is
// workspace.getWorkspaceFolder (only the repository's display name), shimmed for this file.
import * as assert from "node:assert/strict";
import type { StatusDoc } from "../../../src/contract/types";
import type { ExtensionState, IModel, IRepository } from "../../../src/model/types";
import type { Services } from "../../../src/services";
import type { TreeSnapshot } from "../../../src/testApi";
import { KnowledgeTreeBinding, KnowledgeTreeProvider, type TreeViewSink } from "../../../src/tree/knowledgeTree";
import { NOT_LOGGED_IN_MESSAGE } from "../../../src/tree/treeModel";
import { fakeRepository, type FakeRepository } from "../../helpers/fakeRepository";
import { loadStatusDoc } from "../../helpers/fixtures";
import { vscodeStub } from "../../helpers/vscodeStub";

const ROOT = "/fixture-root";

/** The not-authenticated StatusDoc of a freshly initialized project: no pages, no sessions. */
function noPages(): StatusDoc {
  const s = loadStatusDoc("not-authenticated");
  const counts = { ...s.counts };
  for (const k of Object.keys(counts) as (keyof typeof counts)[]) { counts[k] = 0; }
  return { ...s, pages: [], counts, captures: { ...s.captures, pending: 0, fresh: 0, sessions: [] } };
}

/** Not authenticated, with one listed page and it in the Sessions group. */
function sessionsOnly(): StatusDoc {
  const s = noPages();
  const page = loadStatusDoc("not-authenticated").pages.find((p) => p.type === "source");
  assert.ok(page, "the not-authenticated fixture has a source page");
  return { ...s, pages: [page] };
}

/** VS Code's shouldShowWelcome(): no root nodes and an unset or empty message. */
function welcomeShows(snap: TreeSnapshot): boolean {
  return snap.roots.length === 0 && (snap.message === undefined || snap.message === "");
}

interface Harness {
  binding: KnowledgeTreeBinding;
  view: TreeViewSink;
  repo: FakeRepository;
  setState(s: ExtensionState): void;
  setShowSessions(v: boolean): void;
  dispose(): void;
}

function bind(state: ExtensionState, status: StatusDoc | string): Harness {
  let current = state;
  let showSessions = true;
  const stateEmitter = new vscodeStub.EventEmitter<ExtensionState>();
  const configEmitter = new vscodeStub.EventEmitter<void>();
  const never = new vscodeStub.EventEmitter<IRepository>();
  const repo = fakeRepository({ root: ROOT, status });
  const model: Pick<IModel, "state" | "onDidChangeState" | "repositories" | "onDidOpenRepository" | "onDidCloseRepository"> = {
    get state() { return current; },
    onDidChangeState: stateEmitter.event,
    repositories: [repo],
    onDidOpenRepository: never.event,
    onDidCloseRepository: never.event,
  };
  const services = {
    model,
    config: { get treeShowSessions() { return showSessions; }, onDidChange: configEmitter.event },
    log: { trace: () => undefined },
  } as unknown as Services;
  const provider = new KnowledgeTreeProvider();
  const view: TreeViewSink = {};
  const binding = new KnowledgeTreeBinding(services, provider, view);
  return {
    binding,
    view,
    repo,
    setState(s) { current = s; stateEmitter.fire(s); },
    setShowSessions(v) { showSessions = v; configEmitter.fire(); },
    dispose() {
      binding.dispose();
      provider.dispose();
      repo.dispose();
    },
  };
}

describe("WP-6H.1 login-welcome: an empty notLoggedIn Knowledge tree leaves TreeView.message unset so the Log In welcome shows (D1, E4)", () => {
  let h: Harness | undefined;

  before(() => {
    Reflect.defineProperty(vscodeStub, "workspace", {
      value: { getWorkspaceFolder: () => undefined },
      configurable: true,
    });
  });
  after(() => { Reflect.deleteProperty(vscodeStub, "workspace"); });
  afterEach(() => {
    h?.dispose();
    h = undefined;
  });

  it("an initialized project with no credentials and no pages: no roots and no message, so the welcome shows", () => {
    h = bind("notLoggedIn", noPages());
    const snap = h.binding.snapshot();
    assert.deepEqual(snap.roots, []);
    assert.equal(h.view.message, undefined, "TreeView.message hides the notLoggedIn welcome");
    assert.ok(welcomeShows(snap));
  });

  it("entering notLoggedIn from loading on an empty tree sets no message", () => {
    h = bind("loading", noPages());
    assert.ok(welcomeShows(h.binding.snapshot()), "loading");
    h.setState("notLoggedIn");
    assert.equal(h.view.message, undefined);
    assert.ok(welcomeShows(h.binding.snapshot()), "notLoggedIn");
  });

  it("listed local pages keep 'showing local pages only'; the welcome returns when the last listed page goes, and leaves when one comes back", () => {
    h = bind("notLoggedIn", "not-authenticated");
    let snap = h.binding.snapshot();
    assert.ok(snap.roots.length > 0, "local pages are listed");
    assert.equal(snap.message, NOT_LOGGED_IN_MESSAGE);
    h.repo.setStatus(noPages());
    snap = h.binding.snapshot();
    assert.deepEqual(snap.roots, []);
    assert.equal(h.view.message, undefined);
    assert.ok(welcomeShows(snap));
    h.repo.setStatus("not-authenticated");
    snap = h.binding.snapshot();
    assert.ok(snap.roots.length > 0);
    assert.equal(snap.message, NOT_LOGGED_IN_MESSAGE);
  });

  it("contexo.tree.showSessions=false hiding the only listed group empties the tree and clears the message (and back)", () => {
    h = bind("notLoggedIn", sessionsOnly());
    assert.deepEqual(h.binding.snapshot().roots.map((n) => n.label), ["Sessions"]);
    assert.equal(h.view.message, NOT_LOGGED_IN_MESSAGE);
    h.setShowSessions(false);
    assert.equal(h.view.message, undefined);
    assert.ok(welcomeShows(h.binding.snapshot()));
    h.setShowSessions(true);
    assert.equal(h.view.message, NOT_LOGGED_IN_MESSAGE);
  });

  it("ready and the other states never set a message, empty tree or not", () => {
    for (const s of ["loading", "ready", "ctxMissing", "ctxTooOld", "extensionTooOld", "noRepositories", "untrusted"] as const) {
      h = bind(s, noPages());
      assert.equal(h.view.message, undefined, s);
      h.repo.setStatus("not-authenticated");
      assert.equal(h.view.message, undefined, s);
      h.dispose();
      h = undefined;
    }
  });
});
