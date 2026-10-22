// conflict (WP-2.3): push exit 6 -> Conflicts -> Take Server Version / Keep Mine, through the
// REAL wiring and the fake ctx. Every resolve is ONE path per spawn and always carries
// --if-server-sha <the remote.sha the user saw> (E25); `then` rules move each scenario to the
// status ctx would report afterwards, so the follow-up online refresh is what the views show.
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as vscode from "vscode";
import { SHOW_SCM_COMMAND } from "../../src/commands/errorActions";
import { COMMAND_IDS } from "../../src/commands/ids";
import {
  TAKE_SERVER_LABEL, resolveSummary, selectionName, staleMessage, takeServerMessage,
} from "../../src/commands/resolve";
import { SHOW_CONFLICTS_LABEL, pushPlan, pushReport } from "../../src/commands/sync";
import type { ErrorEnvelope, PushDoc, StaleDetails } from "../../src/contract/types";
import { fromContexoUri } from "../../src/fs/contexoUri";
import {
  fixtureOf, groupPaths, isOnlineStatus, openWorkspaceCopy, pagePath, revertAndCloseEditors, scmRepo, sourceControlOf,
  waitFor, type CallRecord, type E2EWorkspace,
} from "../helpers/e2e";
import { scenarioOutput } from "../helpers/fixtures";

const SYNC_MODEL = "wiki/analyses/sync-model.md";
const AUTH_FLOW = "wiki/concepts/auth-flow.md";
const RATE_LIMITS = "wiki/concepts/rate-limits.md";
const RETRY_POLICY = "wiki/concepts/retry-policy.md";

function callsOf(w: E2EWorkspace, command: string): CallRecord[] {
  return w.calls().filter((c) => c.argv[0] === command);
}

function only(w: E2EWorkspace, command: string): CallRecord {
  const hits = callsOf(w, command);
  assert.equal(hits.length, 1, `exactly one ${command} call (got ${JSON.stringify(w.calls().map((c) => c.argv))})`);
  return hits[0] as CallRecord;
}

/** The online statuses that started after `after` ended. */
function onlineAfter(w: E2EWorkspace, after: CallRecord): CallRecord[] {
  assert.ok(after.end !== undefined, `${after.argv.join(" ")} recorded its end`);
  return w.calls().filter((c) => isOnlineStatus(c) && (c.start ?? 0) >= (after.end ?? Infinity));
}

/** What the SCM view passes for a resource: something with a resourceUri. */
function resourceOf(w: E2EWorkspace, relPath: string): { resourceUri: vscode.Uri } {
  return { resourceUri: w.repo().fileUri(relPath) };
}

/** Run an SCM resource command on relPaths as VS Code does: (clicked, selected[]). */
async function onResources(w: E2EWorkspace, command: string, relPaths: readonly string[]): Promise<void> {
  const states = relPaths.map((p) => resourceOf(w, p));
  await vscode.commands.executeCommand(command, states[0], states);
}

/** The remote.sha the current status shows for relPath (what the user saw in the diff). */
function remoteSha(w: E2EWorkspace, relPath: string): string {
  const repo = w.repo();
  const sha = repo.pageAt(repo.fileUri(relPath))?.remote?.sha;
  assert.ok(sha, `${relPath} has a remote.sha`);
  return sha;
}

function confirms(w: E2EWorkspace): E2EWorkspace["prompts"]["calls"] {
  return w.prompts.calls.filter((c) => c.method === "confirm");
}

/** The last non-empty stderr line of a scenario answer, parsed as the ctx.error.v1 envelope. */
function envelopeOf(stderr: string): ErrorEnvelope {
  const line = stderr.split("\n").filter((l) => l.trim() !== "").pop() ?? "";
  return JSON.parse(line) as ErrorEnvelope;
}

/** Record the command ids executed through the shared vscode.commands (the extension uses the same object). */
function recordCommands(): { ids: string[]; restore(): void } {
  const commands = vscode.commands as { executeCommand: typeof vscode.commands.executeCommand };
  const original = commands.executeCommand;
  const ids: string[] = [];
  commands.executeCommand = ((id: string, ...args: unknown[]) => {
    ids.push(id);
    return original.call(vscode.commands, id, ...args);
  }) as typeof vscode.commands.executeCommand;
  return { ids, restore: () => { commands.executeCommand = original; } };
}

/** The active editor tab as a diff (original/modified), or undefined. */
function activeDiff(): vscode.TabInputTextDiff | undefined {
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  return input instanceof vscode.TabInputTextDiff ? input : undefined;
}

function textOf(uri: vscode.Uri): string | undefined {
  return vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString())?.getText();
}

describe("conflict (e2e): push exit 6 -> Conflicts -> Take Server Version / Keep Mine", function () {
  this.timeout(60000);

  it("push exit 6 (stdout PushDoc + conflict envelope) lists the conflict with [Show Conflicts], which reveals the SCM view, and the follow-up online status puts the page in Conflicts (e8-conflict-push)", async () => {
    const w = await openWorkspaceCopy({ scenario: "e8-conflict-push" });
    assert.deepEqual(groupPaths(scmRepo(w.api), "conflicts"), [], "no conflict is known before the push");
    const status = w.repo().status;
    assert.ok(status, "the repository has a status");
    const plan = pushPlan(status);
    assert.deepEqual(plan, [SYNC_MODEL, AUTH_FLOW, RATE_LIMITS]);
    const sc = sourceControlOf(w.api);
    sc.inputBox.value = "Tighten the rate limits";
    w.prompts.respond(RATE_LIMITS, SHOW_CONFLICTS_LABEL);
    const recorded = recordCommands();
    try {
      await vscode.commands.executeCommand(COMMAND_IDS.push, sc);

      const push = only(w, "push");
      assert.deepEqual(push.argv, ["push", "--json", "--yes", "--root", w.root, "-m", "Tighten the rate limits", "--", ...plan]);
      assert.equal(push.exit, 6);
      const out = scenarioOutput("e8-conflict-push", push.argv);
      assert.ok(out, "the scenario answers the push");
      const doc = JSON.parse(out.stdout) as PushDoc;
      const envelope = envelopeOf(out.stderr);
      assert.equal(envelope.error.code, "conflict");
      assert.deepEqual((envelope.error.details as { paths?: string[] }).paths, [RATE_LIMITS], "the envelope names the conflict");
      const report = pushReport(doc);
      assert.deepEqual(report.conflicts, [RATE_LIMITS]);

      const warning = await w.prompts.waitFor(report.message, { method: "warn" });
      assert.equal(warning.message, report.message);
      assert.deepEqual(warning.actions, [SHOW_CONFLICTS_LABEL]);
      await waitFor(() => recorded.ids.includes(SHOW_SCM_COMMAND), { timeoutMs: 5000, message: `[Show Conflicts] runs ${SHOW_SCM_COMMAND}` });
    } finally {
      recorded.restore();
    }

    const push = only(w, "push");
    assert.equal(onlineAfter(w, push).length, 1, "repo.run's one online refresh after the push");
    const repo = scmRepo(w.api);
    assert.deepEqual(groupPaths(repo, "conflicts"), [RATE_LIMITS], "Conflicts lists the conflicting page");
    assert.equal(groupPaths(repo, "changes").includes(AUTH_FLOW), false, "the pushed modified page left Changes");
    assert.deepEqual(groupPaths(repo, "new"), [], "the pushed new page left New");
    assert.equal(sc.inputBox.value, "Tighten the rate limits", "a push with conflicts keeps the message for the next push");
  });

  it("Take Server Version: Cancel spawns nothing; after confirmation one `resolve <path> --theirs --json --root R --if-server-sha <remote.sha>` per path, one after the other, then one online status, and Conflicts is empty (e8-resolve-theirs)", async () => {
    const w = await openWorkspaceCopy({ scenario: "e8-resolve-theirs" });
    const paths = groupPaths(scmRepo(w.api), "conflicts");
    assert.deepEqual(paths, [RATE_LIMITS, RETRY_POLICY]);
    const shas = paths.map((p) => remoteSha(w, p));
    w.prompts.confirmAnswers = [false, true];

    await onResources(w, COMMAND_IDS.resolveTheirs, paths);

    assert.deepEqual(callsOf(w, "resolve"), [], "Cancel spawns no resolve");
    const [cancelled] = confirms(w);
    assert.equal(cancelled?.message, takeServerMessage(selectionName(paths)));
    assert.equal(cancelled?.options?.modal, true);
    assert.equal(cancelled?.options?.confirmLabel, TAKE_SERVER_LABEL);

    await onResources(w, COMMAND_IDS.resolveTheirs, paths);

    assert.equal(confirms(w).length, 2, "one modal for the whole selection");
    const resolves = callsOf(w, "resolve");
    assert.deepEqual(
      resolves.map((c) => c.argv),
      paths.map((p, i) => ["resolve", p, "--theirs", "--json", "--root", w.root, "--if-server-sha", shas[i] as string]),
    );
    assert.ok((resolves[1]?.start ?? 0) >= (resolves[0]?.end ?? Infinity), "one path per spawn, sequentially");
    const last = resolves[resolves.length - 1] as CallRecord;
    assert.equal(onlineAfter(w, last).length, 1, "one online status after the resolves");
    assert.deepEqual(groupPaths(scmRepo(w.api), "conflicts"), [], "Conflicts is empty after the refresh");
    await w.prompts.waitFor(resolveSummary("theirs", 2, 0, 0), { method: "info" });
  });

  it("Take Server Version on a target with unsaved edits is refused before the modal: no spawn, nothing saved (E27)", async () => {
    const w = await openWorkspaceCopy({ scenario: "e8-resolve-theirs" });
    const uri = w.repo().fileUri(RATE_LIMITS);
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc);
    const edit = new vscode.WorkspaceEdit();
    edit.insert(uri, doc.positionAt(doc.getText().length), "\nAn unsaved e2e edit.\n");
    assert.equal(await vscode.workspace.applyEdit(edit), true, "the edit applies");
    assert.equal(doc.isDirty, true);
    w.prompts.confirmAnswers = [true];
    try {
      await onResources(w, COMMAND_IDS.resolveTheirs, [RATE_LIMITS]);

      assert.deepEqual(callsOf(w, "resolve"), [], "no resolve spawn for a dirty target");
      assert.deepEqual(confirms(w), [], "refused before the Take Server Version modal");
      const refusal = w.prompts.notifications().find((n) => n.method === "warn" && n.message.includes(RATE_LIMITS));
      assert.ok(refusal, `a warning names the dirty page: ${JSON.stringify(w.prompts.notifications())}`);
      assert.equal(doc.isDirty, true, "the guard never saves for Take Server Version");
      assert.ok(fs.readFileSync(pagePath(w.root, RATE_LIMITS)).equals(fs.readFileSync(pagePath(fixtureOf(w.root), RATE_LIMITS))), "the file on disk is untouched");
    } finally {
      await revertAndCloseEditors();
    }
  });

  it("Keep Mine runs `resolve <path> --ours --json --root R --if-server-sha <remote.sha>` with no prompt, and the page moves from Conflicts to Changes (e8-resolve-ours)", async () => {
    const w = await openWorkspaceCopy({ scenario: "e8-resolve-ours" });
    assert.deepEqual(groupPaths(scmRepo(w.api), "conflicts"), [RATE_LIMITS, RETRY_POLICY]);
    const sha = remoteSha(w, RATE_LIMITS);

    await onResources(w, COMMAND_IDS.resolveOurs, [RATE_LIMITS]);

    const resolve = only(w, "resolve");
    assert.deepEqual(resolve.argv, ["resolve", RATE_LIMITS, "--ours", "--json", "--root", w.root, "--if-server-sha", sha]);
    assert.equal(resolve.exit, 0);
    assert.deepEqual(confirms(w), [], "Keep Mine is non-destructive: no prompt");
    assert.equal(onlineAfter(w, resolve).length, 1, "one online status after the resolve");
    const repo = scmRepo(w.api);
    assert.deepEqual(groupPaths(repo, "conflicts"), [RETRY_POLICY], "the page left Conflicts");
    assert.ok(groupPaths(repo, "changes").includes(RATE_LIMITS), `the page is in Changes: ${JSON.stringify(groupPaths(repo, "changes"))}`);
    await w.prompts.waitFor(resolveSummary("ours", 1, 0, 0), { method: "info" });
  });

  it("stale (exit 6): an info staleMessage(path), one online status that moves remote.sha to the envelope's server_sha, and the open Server ↔ Local diff re-reads the new server version (e8-stale -> e8-stale-after)", async () => {
    const w = await openWorkspaceCopy({ scenario: "e8-stale" });
    const seen = remoteSha(w, RATE_LIMITS);
    try {
      // The user reviews the conflict: the Conflicts resource opens Server ↔ Local.
      await vscode.commands.executeCommand(COMMAND_IDS.openChange, resourceOf(w, RATE_LIMITS));
      const diff = await waitFor(() => activeDiff(), { timeoutMs: 10000, message: "the conflict diff opened" });
      const left = diff.original;
      assert.equal(left.scheme, "contexo");
      assert.equal(fromContexoUri(left).ref, "server");
      assert.equal(fromContexoUri(left).relPath, RATE_LIMITS);
      const oldServer = scenarioOutput("e8-stale", ["show", RATE_LIMITS, "--at", "server", "--root", w.root])?.stdout ?? "";
      await waitFor(() => textOf(left) === oldServer, { timeoutMs: 10000, message: "the diff shows the server version the user saw" });
      w.prompts.confirmAnswers = [true];

      await onResources(w, COMMAND_IDS.resolveTheirs, [RATE_LIMITS]);

      const resolve = only(w, "resolve");
      assert.deepEqual(resolve.argv, ["resolve", RATE_LIMITS, "--theirs", "--json", "--root", w.root, "--if-server-sha", seen]);
      assert.equal(resolve.exit, 6);
      const out = scenarioOutput("e8-stale", resolve.argv);
      assert.ok(out, "the scenario answers the resolve");
      const envelope = envelopeOf(out.stderr);
      assert.equal(envelope.error.code, "stale");
      const moved = (envelope.error.details as StaleDetails).server_sha;
      await w.prompts.waitFor(staleMessage(RATE_LIMITS), { method: "info" });
      assert.equal(callsOf(w, "resolve").length, 1, "stale is never retried");
      assert.equal(onlineAfter(w, resolve).length, 1, "stale refreshes the status once");
      assert.equal(remoteSha(w, RATE_LIMITS), moved, "the refreshed status shows the moved server version");
      assert.ok(groupPaths(scmRepo(w.api), "conflicts").includes(RATE_LIMITS), "the page is still a conflict");

      // The contexo: FS reports the served server URI as changed, so the diff the user has open
      // reloads with the new server version (one more `show --at server` after the refresh).
      const newServer = scenarioOutput("e8-stale-after", ["show", RATE_LIMITS, "--at", "server", "--root", w.root])?.stdout ?? "";
      assert.notEqual(newServer, oldServer);
      await waitFor(() => textOf(left) === newServer, { timeoutMs: 10000, message: "the open diff re-read the new server version" });
      const refresh = onlineAfter(w, resolve)[0] as CallRecord;
      const reread = callsOf(w, "show").filter((c) => c.argv[3] === "server" && (c.start ?? 0) >= (refresh.end ?? Infinity));
      assert.ok(reread.length >= 1, "the new server version came from a fresh ctx show");
      const still = activeDiff();
      assert.ok(still, "the diff is still the active editor");
      assert.equal(still.original.toString(), left.toString());
    } finally {
      await revertAndCloseEditors();
    }
  });

  it("stale (exit 6) re-opens the Server ↔ Local diff after the refresh even when no editor is open (contract error table: refresh status and re-open the diff)", async () => {
    const w = await openWorkspaceCopy({ scenario: "e8-stale" });
    try {
      assert.equal(activeDiff(), undefined, "no diff is open before the resolve");
      w.prompts.confirmAnswers = [true];
      await onResources(w, COMMAND_IDS.resolveTheirs, [RATE_LIMITS]);
      const resolve = only(w, "resolve");
      assert.equal(resolve.exit, 6);
      await w.prompts.waitFor(staleMessage(RATE_LIMITS), { method: "info" });
      const diff = await waitFor(() => activeDiff(), { timeoutMs: 10000, message: "the extension re-opened the conflict diff" });
      assert.equal(diff.original.scheme, "contexo");
      assert.equal(fromContexoUri(diff.original).ref, "server");
      assert.equal(fromContexoUri(diff.original).relPath, RATE_LIMITS);
      assert.equal(diff.modified.scheme, "file");
      assert.equal(diff.modified.fsPath, w.repo().fileUri(RATE_LIMITS).fsPath);
      const refresh = onlineAfter(w, resolve)[0] as CallRecord;
      assert.ok(refresh, "the stale resolve refreshed the status");
      const newServer = scenarioOutput("e8-stale-after", ["show", RATE_LIMITS, "--at", "server", "--root", w.root])?.stdout ?? "";
      await waitFor(() => textOf(diff.original) === newServer, { timeoutMs: 10000, message: "the re-opened diff shows the new server version" });
    } finally {
      await revertAndCloseEditors();
    }
  });
});
