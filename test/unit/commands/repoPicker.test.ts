// repoPicker (src/commands/repoPicker.ts, WP-1.13): which repository and which pages a
// command acts on. Plain mocha: FakeModel/FakeRepository load over the vscode stub, the
// active editor comes from an injected RepoPickerEnv, and Prompts is scripted here.
import * as assert from "node:assert/strict";
import { URI } from "vscode-uri";
import {
  resolveRepo, selectedPages, selectedPaths, selectionOf, sourceControlOf, type RepoPickerEnv,
} from "../../../src/commands/repoPicker";
import type { IRepository } from "../../../src/model/types";
import type { Prompts } from "../../../src/ui/prompts";
import { FakeModel } from "../../helpers/fakeModel";
import { fakeRepository, type FakeRepository } from "../../helpers/fakeRepository";

type VsUri = IRepository["root"];
const asVs = (u: URI): VsUri => u as unknown as VsUri;

/**
 * FakeModel whose resolveTarget(undefined) answers like a window without an active editor
 * (FakeModel would read vscode.window, which the unit stub lacks). `scripted`, when set,
 * answers first, for the fallback test.
 */
class UnitModel extends FakeModel {
  scripted: ((arg: unknown) => IRepository | undefined) | undefined;

  override resolveTarget(arg: unknown): { repository: IRepository; relPath?: string } | undefined {
    const scripted = this.scripted?.(arg);
    if (scripted) { this.resolveTargetCalls.push(arg); return { repository: scripted }; }
    if (arg === undefined && this.repositories.length !== 1) { this.resolveTargetCalls.push(arg); return undefined; }
    return super.resolveTarget(arg);
  }
}

interface PromptCall { method: keyof Prompts; args: unknown[]; }

/** Prompts that log every call; quickPick answers with items[pick(items)] (default: cancelled). */
class ScriptedPrompts {
  readonly calls: PromptCall[] = [];
  pick: (items: readonly unknown[]) => number | undefined = () => undefined;

  readonly prompts: Prompts = {
    info: async (...args) => { this.calls.push({ method: "info", args }); return undefined; },
    warn: async (...args) => { this.calls.push({ method: "warn", args }); return undefined; },
    error: async (...args) => { this.calls.push({ method: "error", args }); return undefined; },
    confirm: async (...args) => { this.calls.push({ method: "confirm", args }); return false; },
    quickPick: async (items, options) => {
      this.calls.push({ method: "quickPick", args: [items, options] });
      const i = this.pick(items);
      return i === undefined ? undefined : items[i];
    },
    inputBox: async (...args) => { this.calls.push({ method: "inputBox", args }); return undefined; },
    copyToClipboard: async (...args) => { this.calls.push({ method: "copyToClipboard", args }); },
    openExternal: async (...args) => { this.calls.push({ method: "openExternal", args }); return false; },
  };
}

/** A RepoPickerEnv whose active editor shows `uri` (or nothing). */
function editorAt(uri?: VsUri): RepoPickerEnv {
  return { activeEditorUri: () => uri };
}
const NO_EDITOR = editorAt(undefined);

/** A SourceControl-shaped object (what VS Code passes to acceptInputCommand and scm/title). */
function sourceControl(root: VsUri | undefined, value = ""): { rootUri: VsUri | undefined; inputBox: { value: string }; id: string } {
  return { id: "contexo", rootUri: root, inputBox: { value } };
}

const page = (repo: FakeRepository, rel: string): VsUri => repo.fileUri(rel);

describe("repoPicker (src/commands/repoPicker.ts)", () => {
  let alpha: FakeRepository;
  let beta: FakeRepository;

  beforeEach(() => {
    alpha = fakeRepository({ root: "/ws/alpha", status: "mixed" });
    beta = fakeRepository({ root: "/ws/beta", status: "mixed" });
  });

  afterEach(() => {
    alpha.dispose();
    beta.dispose();
  });

  it("picks the repo from a SourceControl, a ResourceState[], a tree node, a Uri or the active editor; a quick pick appears only when two repos are still ambiguous", async () => {
    const model = new UnitModel({ repositories: [alpha, beta] });
    const p = new ScriptedPrompts();
    const s = { model, prompts: p.prompts };
    const inBeta = page(beta, "wiki/concepts/auth-flow.md");
    const inAlpha = page(alpha, "wiki/analyses/sync-model.md");

    // 1. SourceControl (rootUri), even while the active editor shows the other repository.
    assert.equal(await resolveRepo(s, sourceControl(beta.root, "msg"), editorAt(inAlpha)), beta, "SourceControl");
    // 2. A ResourceState[]: the first state's resourceUri.
    assert.equal(await resolveRepo(s, [{ resourceUri: inBeta }, { resourceUri: inAlpha }], editorAt(inAlpha)), beta, "ResourceState[]");
    //    ... and a single ResourceState.
    assert.equal(await resolveRepo(s, { resourceUri: inAlpha, contextValue: "modified" }, editorAt(inBeta)), alpha, "ResourceState");
    // 3. A tree node (resourceUri).
    assert.equal(await resolveRepo(s, { resourceUri: inAlpha, label: "sync-model", collapsibleState: 0 }, editorAt(inBeta)), alpha, "tree node");
    // 4. A Uri: a vscode-uri URI from another module copy counts too (duck-typed).
    assert.equal(await resolveRepo(s, inBeta, editorAt(inAlpha)), beta, "Uri");
    assert.equal(await resolveRepo(s, URI.file("/ws/alpha/.contexo/wiki/x.md"), editorAt(inBeta)), alpha, "foreign Uri");
    // 5. Nothing in the argument: the active editor.
    assert.equal(await resolveRepo(s, undefined, editorAt(inBeta)), beta, "active editor");
    assert.equal(await resolveRepo(s, undefined, editorAt(inAlpha)), alpha, "active editor");
    assert.equal(p.calls.length, 0, "no prompt while the target is known");

    // Two repositories, nothing to go by: the quick pick (folder name + fsPath).
    p.pick = (items) => items.length - 1;
    assert.equal(await resolveRepo(s, undefined, NO_EDITOR), beta, "picked");
    assert.equal(p.calls.length, 1);
    const [call] = p.calls;
    assert.equal(call?.method, "quickPick");
    const [items, options] = call?.args as [{ label: string; description: string; repository: IRepository }[], { placeHolder?: string }];
    assert.deepEqual(items.map((i) => [i.label, i.description, i.repository]), [
      ["alpha", alpha.root.fsPath, alpha],
      ["beta", beta.root.fsPath, beta],
    ]);
    assert.equal(options.placeHolder, "Select a Contexo repository");

    // One repository: no quick pick, whatever the argument lacks.
    p.calls.length = 0;
    const single = new UnitModel({ repositories: [alpha] });
    assert.equal(await resolveRepo({ model: single, prompts: p.prompts }, undefined, NO_EDITOR), alpha, "the only repository");
    assert.equal(await resolveRepo({ model: single, prompts: p.prompts }, { unrelated: true }, NO_EDITOR), alpha, "the only repository");
    assert.deepEqual(p.calls, [], "no quick pick for a single repository");
  });

  it("an active editor or Uri outside every repository, or an argument it does not know, falls back to model.resolveTarget, then the quick pick", async () => {
    const model = new UnitModel({ repositories: [alpha, beta] });
    const p = new ScriptedPrompts();
    const s = { model, prompts: p.prompts };
    const opaque = { kind: "something VS Code passed" };
    model.scripted = (arg) => (arg === opaque ? beta : undefined);

    assert.equal(await resolveRepo(s, opaque, editorAt(asVs(URI.file("/elsewhere/notes.md")))), beta, "resolveTarget answered");
    assert.ok(model.resolveTargetCalls.includes(opaque), "resolveTarget got the original argument");
    assert.equal(p.calls.length, 0);

    p.pick = () => 0;
    assert.equal(await resolveRepo(s, asVs(URI.file("/elsewhere/notes.md")), NO_EDITOR), alpha, "still ambiguous: quick pick");
    assert.deepEqual(p.calls.map((c) => c.method), ["quickPick"]);
  });

  it("a repository passed as the argument is used as is", async () => {
    const model = new UnitModel({ repositories: [alpha, beta] });
    const p = new ScriptedPrompts();
    assert.equal(await resolveRepo({ model, prompts: p.prompts }, beta, editorAt(page(alpha, "wiki/a.md"))), beta);
    assert.deepEqual(p.calls, []);
  });

  it("cancelling the quick pick resolves undefined", async () => {
    const model = new UnitModel({ repositories: [alpha, beta] });
    const p = new ScriptedPrompts();
    p.pick = () => undefined;
    assert.equal(await resolveRepo({ model, prompts: p.prompts }, undefined, NO_EDITOR), undefined);
    assert.deepEqual(p.calls.map((c) => c.method), ["quickPick"]);
  });

  it("with no repository open it shows 'No Contexo repository is open.' and resolves undefined", async () => {
    const model = new UnitModel({ repositories: [] });
    const p = new ScriptedPrompts();
    assert.equal(await resolveRepo({ model, prompts: p.prompts }, undefined, NO_EDITOR), undefined);
    assert.deepEqual(p.calls, [{ method: "info", args: ["No Contexo repository is open."] }]);
  });

  it("selectedPages / selectedPaths map resource states, tree nodes and Uris through repo.pageAt: unknown items dropped, duplicates dropped, order kept", () => {
    const rate = page(alpha, "wiki/concepts/rate-limits.md");
    const auth = page(alpha, "wiki/concepts/auth-flow.md");
    const selection = [
      { resourceUri: rate },
      auth, // a Uri
      { resourceUri: asVs(URI.file("/ws/alpha/README.md")) }, // outside .contexo
      { resourceUri: page(alpha, "wiki/concepts/nope.md") }, // not in the status
      { resourceUri: rate }, // again
      { label: "a node without a resourceUri" },
      "not a selection",
      null,
      { resourceUri: page(alpha, "wiki/analyses/sync-model.md"), label: "tree node" },
    ];
    const pages = selectedPages(selection, alpha);
    assert.deepEqual(pages.map((p) => [p.path, p.state]), [
      ["wiki/concepts/rate-limits.md", "conflict"],
      ["wiki/concepts/auth-flow.md", "modified"],
      ["wiki/analyses/sync-model.md", "new"],
    ]);
    assert.equal(pages[0], alpha.status?.pages.find((p) => p.path === "wiki/concepts/rate-limits.md"), "the status entry itself");
    assert.deepEqual(selectedPaths(selection, alpha), ["wiki/concepts/rate-limits.md", "wiki/concepts/auth-flow.md", "wiki/analyses/sync-model.md"]);

    // A single item, a foreign URI copy, and nothing.
    assert.deepEqual(selectedPaths({ resourceUri: auth }, alpha), ["wiki/concepts/auth-flow.md"]);
    assert.deepEqual(selectedPaths(URI.file("/ws/alpha/.contexo/wiki/concepts/auth-flow.md"), alpha), ["wiki/concepts/auth-flow.md"]);
    assert.deepEqual(selectedPaths(undefined, alpha), []);
    assert.deepEqual(selectedPaths([], alpha), []);
    // Another repository's page is unknown to this one.
    assert.deepEqual(selectedPaths([{ resourceUri: page(beta, "wiki/concepts/auth-flow.md") }], alpha), []);
  });

  it("selectionOf: (clicked, selected[]) gives selected[]; (state) gives the state; an empty selected[] falls back to clicked", () => {
    const clicked = { resourceUri: page(alpha, "wiki/concepts/auth-flow.md") };
    const other = { resourceUri: page(alpha, "wiki/analyses/sync-model.md") };
    const selected = [clicked, other];
    assert.equal(selectionOf([clicked, selected]), selected);
    assert.equal(selectionOf([clicked]), clicked);
    assert.equal(selectionOf([clicked, []]), clicked);
    assert.equal(selectionOf([clicked, undefined]), clicked);
    assert.equal(selectionOf([selected]), selected, "an array as the only argument");
    assert.equal(selectionOf([]), undefined);
    // The SCM view spreads a multi-selection: (state1, state2, ...).
    const third = page(alpha, "wiki/concepts/rate-limits.md");
    assert.deepEqual(selectionOf([clicked, other, third]), [clicked, other, third], "spread states and Uris");
    assert.equal(selectionOf([clicked, "not a state"]), clicked, "a spread needs every argument to be a state or Uri");
  });

  it("sourceControlOf accepts objects with rootUri and a string inputBox.value, nothing else", () => {
    const sc = sourceControl(alpha.root, "message");
    assert.equal(sourceControlOf(sc), sc);
    const noRoot = sourceControl(undefined);
    assert.equal(sourceControlOf(noRoot), noRoot, "rootUri may be undefined");
    assert.equal(sourceControlOf({ inputBox: { value: "m" } }), undefined, "no rootUri key");
    assert.equal(sourceControlOf({ rootUri: alpha.root, inputBox: { value: 1 } }), undefined, "value not a string");
    assert.equal(sourceControlOf({ rootUri: alpha.root }), undefined, "no inputBox");
    assert.equal(sourceControlOf({ resourceUri: alpha.root }), undefined, "a resource state");
    assert.equal(sourceControlOf(alpha.root), undefined, "a Uri");
    for (const v of [undefined, null, "contexo", 1, []]) { assert.equal(sourceControlOf(v), undefined, String(v)); }
  });
});
