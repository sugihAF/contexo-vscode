// diff (WP-2.3): click-to-diff, the contexo: file system and the gutter quick diff through the
// REAL wiring. A resource's click is its SourceControlResourceState.command (scmSnapshot);
// the opened editor is observed through vscode.window.tabGroups (TabInputTextDiff), and the
// left side is read back through vscode.workspace.fs, which `ctx show` serves byte for byte.
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { fromContexoUri, toContexoUri } from "../../src/fs/contexoUri";
import { diffLabel } from "../../src/scm/resourceModel";
import type { ScmGroupSnapshot } from "../../src/testApi";
import {
  SCENARIOS, openWorkspaceCopy, pagePath, revertAndCloseEditors, scmRepo, waitFor,
  type CallRecord, type E2EWorkspace,
} from "../helpers/e2e";
import { loadScenario, selectRule } from "../helpers/fixtures";

const SYNC_MODEL = "wiki/analyses/sync-model.md";
const AUTH_FLOW = "wiki/concepts/auth-flow.md";
const RATE_LIMITS = "wiki/concepts/rate-limits.md";
const RETRY_POLICY = "wiki/concepts/retry-policy.md";

/** The bytes the fake ctx prints on stdout for argv under `scenario` (a stdoutFile rule). */
function stdoutBytes(scenario: string, argv: readonly string[]): Buffer {
  const rule = selectRule(loadScenario(scenario), argv);
  assert.ok(rule?.stdoutFile, `${scenario} answers ${argv.join(" ")} from a file`);
  return fs.readFileSync(path.resolve(SCENARIOS, scenario, rule.stdoutFile));
}

function showCalls(w: E2EWorkspace): CallRecord[] {
  return w.calls().filter((c) => c.argv[0] === "show");
}

/** The active editor tab as a diff, or undefined. */
function activeDiff(): { tab: vscode.Tab; input: vscode.TabInputTextDiff } | undefined {
  const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
  return tab && tab.input instanceof vscode.TabInputTextDiff ? { tab, input: tab.input } : undefined;
}

/** A Uri argument of a CommandSnapshot (the snapshot turns Uris into strings). */
function uriArg(v: unknown): vscode.Uri {
  assert.equal(typeof v, "string", `a Uri argument: ${JSON.stringify(v)}`);
  return vscode.Uri.parse(v as string);
}

function isFileNotFound(err: unknown): boolean {
  return err instanceof vscode.FileSystemError && err.code === "FileNotFound";
}

describe("diff (e2e): click-to-diff, contexo: content and the quick-diff original", function () {
  this.timeout(60000);

  const cases: { group: ScmGroupSnapshot["id"]; relPath: string; ref: "base" | "server"; side: "Base" | "Server" }[] = [
    { group: "changes", relPath: AUTH_FLOW, ref: "base", side: "Base" },
    { group: "incoming", relPath: RETRY_POLICY, ref: "server", side: "Server" },
    { group: "conflicts", relPath: RATE_LIMITS, ref: "server", side: "Server" },
  ];
  for (const c of cases) {
    it(`a ${c.group} resource (${c.relPath}) opens vscode.diff with a contexo: ref=${c.ref} left side and the file: right side, and the left content equals the fake ctx's show bytes (e8-diff)`, async () => {
      const w = await openWorkspaceCopy({ scenario: "e8-diff" });
      try {
        const group = scmRepo(w.api).groups.find((g) => g.id === c.group);
        const resource = group?.resources.find((r) => r.relPath === c.relPath);
        assert.ok(resource?.command, `${c.relPath} is in ${c.group} with a click command`);
        assert.equal(resource.command.command, "vscode.diff");
        const [left, right, label] = resource.command.arguments ?? [];
        assert.equal(label, diffLabel(c.relPath, c.side));

        // The click: the resource's own command, with its own arguments.
        await vscode.commands.executeCommand("vscode.diff", uriArg(left), uriArg(right), label);

        const opened = await waitFor(() => activeDiff(), { timeoutMs: 10000, message: "a diff editor opened" });
        assert.equal(opened.tab.label, label);
        const original = opened.input.original;
        assert.equal(original.scheme, "contexo");
        const q = fromContexoUri(original);
        assert.equal(q.ref, c.ref);
        assert.equal(q.relPath, c.relPath);
        assert.equal(q.root, w.root);
        assert.equal(opened.input.modified.scheme, "file");
        assert.equal(opened.input.modified.fsPath, pagePath(w.root, c.relPath));

        const argv = ["show", c.relPath, "--at", c.ref, "--root", w.root];
        const expected = stdoutBytes("e8-diff", argv);
        const bytes = await vscode.workspace.fs.readFile(original);
        assert.ok(Buffer.from(bytes).equals(expected), "the left side is the show output byte for byte");
        await waitFor(() => vscode.workspace.textDocuments.find((d) => d.uri.toString() === original.toString())?.getText() === expected.toString("utf8"), {
          timeoutMs: 10000, message: "the diff's left document holds the show output",
        });
        const shows = showCalls(w);
        assert.ok(shows.length >= 1, "the left side came from ctx show");
        for (const s of shows) { assert.deepEqual(s.argv, argv, "only the left side is shown (no --json)"); }
      } finally {
        await revertAndCloseEditors();
      }
    });
  }

  it("base_unavailable degrades as WP-1.10 documents: ctx exit 8 base_unavailable -> FileNotFound from the contexo: FS, never cached (two reads, two ctx show calls) (e8-diff-base-unavailable)", async () => {
    const w = await openWorkspaceCopy({ scenario: "e8-diff-base-unavailable" });
    const resource = scmRepo(w.api).groups.find((g) => g.id === "changes")?.resources.find((r) => r.relPath === AUTH_FLOW);
    assert.ok(resource?.command, "auth-flow is in Changes with a click command");
    const left = uriArg(resource.command.arguments?.[0]);
    assert.equal(fromContexoUri(left).ref, "base");
    // The scenario's status gives auth-flow a verified base version (sha + hash) that no other
    // scenario serves, so no earlier read in this run can have cached its bytes.
    const page = w.repo().pageAt(w.repo().fileUri(AUTH_FLOW));
    assert.equal(page?.base?.stale, false, "the status reports a verified base, so only ctx can say it is unavailable");

    await assert.rejects(Promise.resolve(vscode.workspace.fs.readFile(left)), isFileNotFound, "the first read is FileNotFound");
    await assert.rejects(Promise.resolve(vscode.workspace.fs.readFile(left)), isFileNotFound, "the second read is FileNotFound too");

    const shows = showCalls(w);
    assert.equal(shows.length, 2, `the error is never cached: each read asks ctx again (got ${shows.length})`);
    for (const s of shows) {
      assert.deepEqual(s.argv, ["show", AUTH_FLOW, "--at", "base", "--root", w.root]);
      assert.equal(s.exit, 8);
    }
  });

  it("the quick-diff original of a modified file is its base contexo: URI (and a new page has none) (e8-diff)", async () => {
    const w = await openWorkspaceCopy({ scenario: "e8-diff" });
    const hook = w.api.hooks.quickDiffOriginal;
    assert.ok(hook, "the SCM module installed the quickDiffOriginal hook");
    const file = vscode.Uri.file(pagePath(w.root, AUTH_FLOW));

    const original = await hook(file);

    assert.ok(original, "a modified page has a quick-diff original");
    assert.equal(original.toString(), toContexoUri(file, "base", w.repo().root.fsPath, AUTH_FLOW).toString());
    const q = fromContexoUri(original);
    assert.deepEqual([q.ref, q.root, q.relPath], ["base", w.root, AUTH_FLOW]);
    const bytes = await vscode.workspace.fs.readFile(original);
    assert.ok(Buffer.from(bytes).equals(stdoutBytes("e8-diff", ["show", AUTH_FLOW, "--at", "base", "--root", w.root])), "the original reads the base bytes");
    assert.equal(await hook(vscode.Uri.file(pagePath(w.root, SYNC_MODEL))), undefined, "a new page has no base to diff against");
  });
});
