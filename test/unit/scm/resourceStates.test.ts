// UriSpec / ClickSpec / ResourceDescriptor -> vscode objects (src/scm/resourceStates.ts),
// over a FakeRepository loaded against the vscode stub test:unit preloads. Uris are
// compared by toString(). Also pins that the three scm modules never require vscode at
// runtime (resourceModel and quickDiff stay pure; resourceStates is type-only).
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import { toContexoUri } from "../../../src/fs/contexoUri";
import { groupDescriptors, type ClickSpec, type ResourceDescriptor } from "../../../src/scm/resourceModel";
import { commandFor, specToUri, toResourceState } from "../../../src/scm/resourceStates";
import { fakeRepository } from "../../helpers/fakeRepository";
import { loadStatusDoc } from "../../helpers/fixtures";

const ROOT = "/ws/basic";
const AUTH_FLOW = "wiki/concepts/auth-flow.md";
const OLD_NAME = "wiki/concepts/old-name.md";
const DELETED_LOCAL_TOOLTIP =
  "Deleted locally. Deletes are not synced in this version; Restore Server Version brings it back.";

/** A Command's arguments with every Uri replaced by its string form. */
function plainArgs(args: readonly unknown[] | undefined): unknown[] | undefined {
  return args?.map((a) => (typeof a === "object" && a !== null && "scheme" in a ? String(a) : a));
}

describe("scm resourceStates", () => {
  const repo = fakeRepository({ root: ROOT, status: "mixed" });
  const contexo = (rel: string, ref: "base" | "server" | "empty"): string =>
    toContexoUri(repo.fileUri(rel), ref, repo.root.fsPath, rel).toString();

  it("specToUri: file -> repo.fileUri(rel); contexo -> toContexoUri(repo.fileUri(rel), ref, root.fsPath, rel)", () => {
    const f = specToUri(repo, { kind: "file", relPath: AUTH_FLOW });
    assert.equal(f.scheme, "file");
    assert.equal(f.toString(), repo.fileUri(AUTH_FLOW).toString());
    assert.equal(f.path, `${ROOT}/.contexo/${AUTH_FLOW}`);
    for (const ref of ["base", "server", "empty"] as const) {
      const u = specToUri(repo, { kind: "contexo", ref, relPath: AUTH_FLOW });
      assert.equal(u.scheme, "contexo", ref);
      assert.equal(u.toString(), contexo(AUTH_FLOW, ref), ref);
    }
  });

  it("commandFor: diff -> vscode.diff 'Open Changes' [left, right, label]; open -> vscode.open with the click title [target]", () => {
    const diff: ClickSpec = {
      kind: "diff",
      left: { kind: "contexo", ref: "base", relPath: AUTH_FLOW },
      right: { kind: "file", relPath: AUTH_FLOW },
      label: "auth-flow.md (Base ↔ Local)",
    };
    const d = commandFor(repo, diff);
    assert.deepEqual({ command: d.command, title: d.title, arguments: plainArgs(d.arguments) }, {
      command: "vscode.diff",
      title: "Open Changes",
      arguments: [contexo(AUTH_FLOW, "base"), repo.fileUri(AUTH_FLOW).toString(), "auth-flow.md (Base ↔ Local)"],
    });
    assert.deepEqual(Object.keys(d).sort(), ["arguments", "command", "title"]);

    const open: ClickSpec = { kind: "open", target: { kind: "contexo", ref: "server", relPath: AUTH_FLOW }, title: "Open Server Version" };
    const o = commandFor(repo, open);
    assert.deepEqual({ command: o.command, title: o.title, arguments: plainArgs(o.arguments) }, {
      command: "vscode.open",
      title: "Open Server Version",
      arguments: [contexo(AUTH_FLOW, "server")],
    });
    assert.deepEqual(Object.keys(o).sort(), ["arguments", "command", "title"]);

    const openFile = commandFor(repo, { kind: "open", target: { kind: "file", relPath: AUTH_FLOW }, title: "Open File" });
    assert.deepEqual(plainArgs(openFile.arguments), [repo.fileUri(AUTH_FLOW).toString()]);
    assert.equal(openFile.title, "Open File");
  });

  it("toResourceState: old-name is struck through with the E29 tooltip and opens contexo base; auth-flow has only a tooltip", () => {
    const groups = groupDescriptors(loadStatusDoc("mixed"));
    const changes = groups.find((g) => g.id === "changes");
    const oldName = changes?.resources.find((r) => r.relPath === OLD_NAME);
    const authFlow = changes?.resources.find((r) => r.relPath === AUTH_FLOW);
    assert.ok(oldName && authFlow);

    const s = toResourceState(repo, oldName);
    assert.equal(s.relPath, OLD_NAME);
    assert.equal(s.resourceUri.toString(), repo.fileUri(OLD_NAME).toString());
    assert.equal(s.contextValue, "deleted_local");
    assert.deepEqual(s.decorations, { tooltip: DELETED_LOCAL_TOOLTIP, strikeThrough: true });
    assert.equal(s.command?.command, "vscode.open");
    assert.equal(s.command?.title, "Open Base Version");
    assert.deepEqual(plainArgs(s.command?.arguments), [contexo(OLD_NAME, "base")]);

    const a = toResourceState(repo, authFlow);
    assert.equal(a.relPath, AUTH_FLOW);
    assert.equal(a.resourceUri.toString(), repo.fileUri(AUTH_FLOW).toString());
    assert.equal(a.contextValue, "modified");
    assert.ok(a.decorations, "auth-flow has decorations");
    assert.ok(!("strikeThrough" in a.decorations), "no strikeThrough key unless true");
    assert.deepEqual(a.decorations, { tooltip: "Modified locally" });
    assert.equal(a.command?.command, "vscode.diff");
    assert.deepEqual(plainArgs(a.command?.arguments),
      [contexo(AUTH_FLOW, "base"), repo.fileUri(AUTH_FLOW).toString(), "auth-flow.md (Base ↔ Local)"]);
  });

  it("toResourceState: no decorations key without tooltip or strikeThrough, no command key without a click", () => {
    const bare: ResourceDescriptor = { relPath: "wiki/entities/gitstore.md", contextValue: "unchanged", strikeThrough: false };
    const s = toResourceState(repo, bare);
    assert.deepEqual(Object.keys(s).sort(), ["contextValue", "relPath", "resourceUri"]);
    assert.equal(s.resourceUri.toString(), repo.fileUri("wiki/entities/gitstore.md").toString());
    assert.equal(s.contextValue, "unchanged");

    const struck = toResourceState(repo, { relPath: OLD_NAME, contextValue: "deleted_local", strikeThrough: true });
    assert.deepEqual(struck.decorations, { strikeThrough: true }, "strikeThrough alone");
    assert.ok(!("command" in struck));
  });

  it("resourceModel, resourceStates and quickDiff never require vscode at runtime", () => {
    const load = createRequire(__filename);
    for (const rel of ["../../../src/scm/resourceModel", "../../../src/scm/resourceStates", "../../../src/scm/quickDiff"]) {
      const js = fs.readFileSync(load.resolve(rel), "utf8");
      assert.doesNotMatch(js, /require\(["']vscode["']\)/, `${rel}: type-only vscode imports`);
    }
    const model = fs.readFileSync(load.resolve("../../../src/scm/resourceModel"), "utf8");
    assert.deepEqual([...model.matchAll(/require\(["']([^"']+)["']\)/g)].map((m) => m[1]), ["../contract/types"],
      "resourceModel depends on the contract only");
  });
});
