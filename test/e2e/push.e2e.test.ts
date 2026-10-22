// push (WP-2.3): Push through the SourceControl's acceptInputCommand and the REAL wiring.
// e8-ready-to-push holds only pushable work (sync-model new, auth-flow modified); its push
// rule answers a PushDoc and switches the folder to e8-ready-to-push-done, whose status has
// both pages unchanged, so Changes, New, the decorations and the status bar visibly clear.
// e8-push-dirty answers its OFFLINE status with gitstore modified too: a push after Save All
// (E27) must plan from that refreshed status. argv is asserted through calls.jsonl.
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { SAVE_ALL_LABEL } from "../../src/commands/dirtyGuard";
import { COMMAND_IDS } from "../../src/commands/ids";
import { pushReport } from "../../src/commands/sync";
import type { PushDoc } from "../../src/contract/types";
import { decorationForState } from "../../src/decorations/decorationModel";
import { presentStatusBar } from "../../src/statusBar";
import {
  SCENARIOS, groupPaths, holdsFor, isOfflineStatus, isOnlineStatus, openWorkspaceCopy, pagePath, scmRepo, sourceControlOf,
  waitFor, type CallRecord, type E2EWorkspace,
} from "../helpers/e2e";

const SYNC_MODEL = "wiki/analyses/sync-model.md";
const AUTH_FLOW = "wiki/concepts/auth-flow.md";
const GITSTORE = "wiki/entities/gitstore.md";
/** The WP-1.13 request: quotes, a $(codicon) and a real newline must reach argv after -m unchanged. */
const TRICKY_MESSAGE = 'a "b" $(c)\nd';
/** Inserted (unsaved) into gitstore.md by the E27 tests. */
const UNSAVED_EDIT = "\n<!-- e8: unsaved edit -->\n";
/** Longer than the 1 s trailing debounce plus file-event latency. */
const QUIET_MS = 2500;

const show = (calls: readonly CallRecord[]): string => JSON.stringify(calls.map((c) => c.argv.join(" ")));

/** holdsFor, failing with the calls recorded when the predicate broke (not when the window opened). */
async function hold(w: E2EWorkspace, pred: () => boolean, ms: number, what: string): Promise<void> {
  try {
    await holdsFor(pred, ms, what);
  } catch (err) {
    throw new Error(`${err instanceof Error ? err.message : String(err)}; calls: ${show(w.calls())}`, { cause: err });
  }
}

function only(calls: readonly CallRecord[], command: string): CallRecord {
  const hits = calls.filter((c) => c.argv[0] === command);
  assert.equal(hits.length, 1, `exactly one ${command} call (got ${show(calls)})`);
  return hits[0] as CallRecord;
}

/** Run the SourceControl's acceptInputCommand exactly as VS Code does on Cmd/Ctrl+Enter. */
async function acceptInput(w: E2EWorkspace, message: string): Promise<vscode.SourceControl> {
  const sc = sourceControlOf(w.api);
  sc.inputBox.value = message;
  const accept = scmRepo(w.api).acceptInputCommand;
  assert.ok(accept, "the SourceControl has an acceptInputCommand");
  assert.equal(accept.command, COMMAND_IDS.push);
  await vscode.commands.executeCommand(accept.command, ...(accept.arguments ?? []));
  return sc;
}

/** The online statuses that started after `after` ended. */
function onlineAfter(w: E2EWorkspace, after: CallRecord): CallRecord[] {
  assert.ok(after.end !== undefined, `${after.argv.join(" ")} recorded its end`);
  return w.calls().filter((c) => isOnlineStatus(c) && (c.start ?? 0) >= (after.end ?? Infinity));
}

/** The numbers of the SourceControl status bar command title '$(cloud-upload) A $(cloud-download) B[ $(warning) C]'. */
function aheadBehind(w: E2EWorkspace): [number, number, number] {
  const title = sourceControlOf(w.api).statusBarCommands?.[0]?.title ?? "";
  const m = /^\$\(cloud-upload\) (\d+) \$\(cloud-download\) (\d+)(?: \$\(warning\) (\d+))?$/.exec(title);
  assert.ok(m, `status bar command title ${JSON.stringify(title)}`);
  return [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)];
}

function decorationBadge(w: E2EWorkspace, rel: string): string | undefined {
  return w.api.hooks.decorationFor?.(vscode.Uri.file(pagePath(w.root, rel)))?.badge;
}

/** Open <root>/.contexo/<rel> in an editor and append UNSAVED_EDIT without saving. */
async function dirtyPage(w: E2EWorkspace, rel: string): Promise<vscode.TextDocument> {
  const uri = vscode.Uri.file(pagePath(w.root, rel));
  const doc = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(doc);
  const edit = new vscode.WorkspaceEdit();
  edit.insert(uri, doc.positionAt(doc.getText().length), UNSAVED_EDIT);
  assert.equal(await vscode.workspace.applyEdit(edit), true, "the edit applies");
  assert.equal(doc.isDirty, true, `${rel} is dirty`);
  return doc;
}

function scenarioPushDoc(scenario: string): PushDoc {
  return JSON.parse(fs.readFileSync(path.join(SCENARIOS, scenario, "push.json"), "utf8")) as PushDoc;
}

describe("push (e2e): Push from the SCM input box through the real wiring", function () {
  this.timeout(60000);

  it("acceptInputCommand spawns one push with exactly the 2 planned paths and -m <input>, then one online status; Changes, New, decorations and the status bar clear and the input box empties", async () => {
    const w = await openWorkspaceCopy({ scenario: "e8-ready-to-push" });
    assert.deepEqual(groupPaths(scmRepo(w.api), "changes"), [AUTH_FLOW]);
    assert.deepEqual(groupPaths(scmRepo(w.api), "new"), [SYNC_MODEL]);
    assert.equal(scmRepo(w.api).count, 2);
    assert.equal(decorationBadge(w, AUTH_FLOW), decorationForState("modified")?.badge);
    assert.equal(decorationBadge(w, SYNC_MODEL), decorationForState("new")?.badge);
    assert.deepEqual(aheadBehind(w), [2, 0, 0]);

    const sc = await acceptInput(w, "Document the sync model");

    const push = only(w.calls(), "push");
    assert.deepEqual(push.argv, ["push", "--json", "--yes", "--root", w.root, "-m", "Document the sync model", "--", SYNC_MODEL, AUTH_FLOW]);
    assert.equal(push.exit, 0);
    await hold(w, () => onlineAfter(w, push).length <= 1, QUIET_MS, "more than one online status after the push");
    const online = onlineAfter(w, push);
    assert.equal(online.length, 1, `one online status after the push: ${show(w.calls())}`);
    assert.deepEqual(online[0]?.argv, ["status", "--json", "--root", w.root]);
    assert.ok(!w.calls().some((c) => isOnlineStatus(c) && (c.start ?? 0) < (push.start ?? 0)), "no online status before the push");

    await waitFor(() => groupPaths(scmRepo(w.api), "changes").length === 0, { timeoutMs: 5000, message: "Changes cleared" });
    assert.deepEqual(groupPaths(scmRepo(w.api), "new"), [], "New cleared");
    assert.equal(scmRepo(w.api).count, 0);
    assert.equal(decorationBadge(w, AUTH_FLOW), undefined, "auth-flow decoration cleared");
    assert.equal(decorationBadge(w, SYNC_MODEL), undefined, "sync-model decoration cleared");
    assert.deepEqual(aheadBehind(w), [0, 0, 0], "the SCM status bar command shows nothing to push");
    const status = w.repo().status;
    assert.ok(status);
    assert.equal(w.api.hooks.statusBarSnapshot?.().items[0]?.text, presentStatusBar("ready", [status], false).text, "the Contexo item is back to ready (not busy)");
    assert.equal(sc.inputBox.value, "", "the input box is cleared after a clean push");
    assert.ok(w.prompts.find(pushReport(scenarioPushDoc("e8-ready-to-push")).message, "info"), "the 'Pushed 2 page(s).' notification");
  });

  it("the message `a \"b\" $(c)\\nd` (a real newline) reaches argv after -m verbatim", async () => {
    const w = await openWorkspaceCopy({ scenario: "e8-ready-to-push" });
    await acceptInput(w, TRICKY_MESSAGE);
    const push = only(w.calls(), "push");
    const i = push.argv.indexOf("-m");
    assert.ok(i > 0, `push has -m: ${JSON.stringify(push.argv)}`);
    assert.equal(push.argv[i + 1], TRICKY_MESSAGE, "one argv element, byte for byte");
    assert.deepEqual(push.argv, ["push", "--json", "--yes", "--root", w.root, "-m", TRICKY_MESSAGE, "--", SYNC_MODEL, AUTH_FLOW]);
  });

  it("an unsaved .contexo page gives the '1 unsaved Contexo page(s)' modal; Save All and Continue saves it and refreshes the status before the push is planned and spawned (E27)", async () => {
    const w = await openWorkspaceCopy({ scenario: "e8-push-dirty" });
    const file = pagePath(w.root, GITSTORE);
    const doc = await dirtyPage(w, GITSTORE);
    assert.deepEqual(groupPaths(scmRepo(w.api), "changes"), [AUTH_FLOW], "the buffer edit alone changes nothing (ctx sees disk)");
    w.prompts.confirmAnswers = [true];

    await acceptInput(w, "Save then push");

    const confirm = w.prompts.find("unsaved Contexo page(s)", "confirm");
    assert.ok(confirm, `the E27 modal (prompts: ${JSON.stringify(w.prompts.calls.map((c) => c.message))})`);
    assert.equal(confirm.message, "1 unsaved Contexo page(s)");
    assert.deepEqual(confirm.options, { modal: true, confirmLabel: SAVE_ALL_LABEL, detail: GITSTORE });
    assert.equal(doc.isDirty, false, "Save All saved the page");
    assert.ok(fs.readFileSync(file, "utf8").endsWith(UNSAVED_EDIT), "the edit is on disk");

    const push = only(w.calls(), "push");
    const savedAt = Math.floor(fs.statSync(file).mtimeMs);
    assert.ok(savedAt <= (push.start ?? 0), `the page was saved (${savedAt}) before the push spawned (${String(push.start)})`);
    const refresh = w.calls().find((c) => isOfflineStatus(c) && (c.start ?? 0) >= confirm.at && (c.end ?? Infinity) <= (push.start ?? 0));
    assert.ok(refresh, `an offline status between the modal and the push spawn: ${show(w.calls())}`);
    assert.ok((refresh.start ?? 0) >= savedAt, "the refresh ran after the save");
    assert.deepEqual(push.argv, ["push", "--json", "--yes", "--root", w.root, "-m", "Save then push", "--", SYNC_MODEL, AUTH_FLOW, GITSTORE],
      "the plan comes from the status refreshed after the save (gitstore modified)");
  });

  it("Cancel on the unsaved-page modal spawns nothing and keeps the page dirty (E27)", async () => {
    const w = await openWorkspaceCopy({ scenario: "e8-push-dirty" });
    const file = pagePath(w.root, GITSTORE);
    const before = fs.readFileSync(file);
    const doc = await dirtyPage(w, GITSTORE);
    w.prompts.confirmAnswers = [false];

    await acceptInput(w, "never sent");

    assert.equal(w.prompts.find("unsaved Contexo page(s)", "confirm")?.answer, false);
    // Opening the page may fetch its quick-diff base (`show --at base`); nothing may sync.
    await hold(w, () => !w.calls().some((c) => c.argv[0] === "push" || c.argv[0] === "status"), QUIET_MS, "a push or status after Cancel");
    assert.equal(doc.isDirty, true, "the page is still dirty");
    assert.ok(fs.readFileSync(file).equals(before), "nothing was written to disk");
  });
});
