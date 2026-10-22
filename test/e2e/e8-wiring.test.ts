// e8-wiring (WP-2.3): the real-argv and calls.jsonl assertions that wave-1 acceptance could
// not make (moved from WP-1.10/1.12/1.13). Everything runs through the REAL extension wiring
// (the real ctx CLI module spawning the fake ctx), observed only through calls.jsonl, the
// terminal's creation options and the TestApi snapshots. The root call audit in
// test/helpers/e2e.ts also checks every call's argv and env.
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { login, sessionSeams } from "../../src/commands/session";
import { toContexoUri } from "../../src/fs/contexoUri";
import {
  SCENARIOS, holdsFor, isOnlineStatus, openWorkspaceCopy, pagePath, readCalls, sourceControlOf, waitFor,
  type CallRecord, type E2EWorkspace,
} from "../helpers/e2e";

const SYNC_MODEL = "wiki/analyses/sync-model.md";
const AUTH_FLOW = "wiki/concepts/auth-flow.md";
const CRLF_BOM = "wiki/concepts/crlf-bom.md";

function only(calls: readonly CallRecord[], command: string): CallRecord {
  const hits = calls.filter((c) => c.argv[0] === command);
  assert.equal(hits.length, 1, `exactly one ${command} call (got ${JSON.stringify(calls.map((c) => c.argv))})`);
  return hits[0] as CallRecord;
}

/** Run a terminal command and return the Contexo terminal it opened. */
async function withTerminal(run: () => Thenable<unknown>): Promise<vscode.Terminal> {
  let opened: vscode.Terminal | undefined;
  const sub = vscode.window.onDidOpenTerminal((t) => {
    if (opened === undefined && t.name === "Contexo") { opened = t; }
  });
  try {
    await run();
  } finally {
    sub.dispose();
  }
  assert.ok(opened, "a 'Contexo' terminal was opened");
  return opened;
}

/** The online statuses that started after `after` ended. */
function onlineAfter(w: E2EWorkspace, after: CallRecord): CallRecord[] {
  assert.ok(after.end !== undefined, `${after.argv.join(" ")} recorded its end`);
  return w.calls().filter((c) => isOnlineStatus(c) && (c.start ?? 0) >= (after.end ?? Infinity));
}

describe("e8-wiring: real argv and env through calls.jsonl (E25, E26)", function () {
  this.timeout(60000);

  it("show argv is ['show', P, '--at', 'base', '--root', R] with no --json, and the bytes come back byte-identical (scenario e4-fs)", async () => {
    const w = await openWorkspaceCopy({ scenario: "e4-fs" });
    const file = vscode.Uri.file(pagePath(w.root, CRLF_BOM));
    const uri = toContexoUri(file, "base", w.repo().root.fsPath, CRLF_BOM);
    const bytes = await vscode.workspace.fs.readFile(uri);
    const expected = fs.readFileSync(path.join(SCENARIOS, "e4-fs", "show", "crlf-bom.base.md"));
    assert.ok(Buffer.from(bytes).equals(expected), "BOM and CRLF bytes survive ctx show -> contexo: FS");
    const show = only(w.calls(), "show");
    assert.deepEqual(show.argv, ["show", CRLF_BOM, "--at", "base", "--root", w.root]);
    assert.ok(!show.argv.includes("--json"));
  });

  it("login: the terminal runs cli.terminalInvocation(['auth','login','--root',R]) and exactly one online status follows its exit", async () => {
    const w = await openWorkspaceCopy({ scenario: "e8-wiring" });
    const R = w.root;
    const expected = w.api.services.cli.terminalInvocation(["auth", "login", "--root", R]);
    const terminal = await withTerminal(() => vscode.commands.executeCommand("contexo.login"));
    const opts = terminal.creationOptions as vscode.TerminalOptions;
    assert.equal(opts.shellPath, expected.shellPath, "shellPath is the discovered ctx (in Test mode the CONTEXO_TEST_CTX command)");
    assert.deepEqual(opts.shellArgs, expected.shellArgs);
    assert.deepEqual((opts.shellArgs as string[]).slice(-4), ["auth", "login", "--root", R]);
    assert.equal((opts.env ?? {}).CONTEXO_DISTILL_DISABLE, null, "the terminal env unsets CONTEXO_DISTILL_DISABLE (E26)");

    const auth = only(w.calls(), "auth");
    assert.deepEqual(auth.argv, ["auth", "login", "--root", R]);
    assert.equal(auth.exit, 0);
    await holdsFor(() => onlineAfter(w, auth).length <= 1, 1500, "at most one online status after login");
    const online = onlineAfter(w, auth);
    assert.equal(online.length, 1, `exactly one online status after the terminal closed (got ${JSON.stringify(w.calls().map((c) => c.argv))})`);
    assert.deepEqual(online[0]?.argv, ["status", "--json", "--root", R]);
  });

  it("login in a remote window passes --no-browser (WP-1.12 seam over the tsc copy)", async () => {
    const w = await openWorkspaceCopy({ scenario: "e8-wiring" });
    const previous = sessionSeams.remoteName;
    sessionSeams.remoteName = () => "ssh-remote";
    try {
      await withTerminal(() => login(w.api.services));
    } finally {
      sessionSeams.remoteName = previous;
    }
    assert.deepEqual(only(w.calls(), "auth").argv, ["auth", "login", "--root", w.root, "--no-browser"]);
  });

  it("update: `update --root R` in the terminal, then a fresh handshake (rediscover) before the online refresh", async () => {
    const w = await openWorkspaceCopy({ scenario: "e8-wiring" });
    await withTerminal(() => vscode.commands.executeCommand("contexo.updateCtx"));
    const update = only(w.calls(), "update");
    assert.deepEqual(update.argv, ["update", "--root", w.root]);
    const after = w.calls().filter((c) => (c.start ?? 0) >= (update.end ?? Infinity));
    const handshake = after.find((c) => c.argv[0] === "version" && c.argv[1] === "--json");
    assert.ok(handshake, "rediscover re-runs `version --json`");
    // The binary change (WP-1.8) and runCtxInTerminal's refreshAll may each refresh online
    // (they coalesce only when they overlap): at least one, every one after the handshake ended.
    const online = after.filter(isOnlineStatus);
    assert.ok(online.length >= 1 && online.length <= 2, `online statuses after the update: ${online.length}`);
    for (const s of online) { assert.ok((s.start ?? 0) >= (handshake.end ?? Infinity), "the refresh follows the new handshake"); }
  });

  it("push argv is ['push','--json','--yes','--root',R,'-m',M,'--',...paths] with the planned paths, then one online status", async () => {
    const w = await openWorkspaceCopy({ scenario: "e8-wiring" });
    const sc = sourceControlOf(w.api);
    sc.inputBox.value = "e8 wiring push";
    await vscode.commands.executeCommand("contexo.push", sc);
    const push = only(w.calls(), "push");
    assert.deepEqual(push.argv, ["push", "--json", "--yes", "--root", w.root, "-m", "e8 wiring push", "--", SYNC_MODEL, AUTH_FLOW]);
    assert.equal(onlineAfter(w, push).length, 1, "one online status after the push");
  });

  it("a 151-path push passes no paths (PUSH_PATHS_MAX) and no CONTEXO_DISTILL_DISABLE", async () => {
    const w = await openWorkspaceCopy({ scenario: "e8-push-151" });
    await waitFor(() => w.repo().status?.counts.modified === 151, { message: "the 151-page status" });
    const sc = sourceControlOf(w.api);
    sc.inputBox.value = "";
    await vscode.commands.executeCommand("contexo.push", sc);
    const push = only(w.calls(), "push");
    assert.deepEqual(push.argv, ["push", "--json", "--yes", "--root", w.root]);
    assert.ok(!push.argv.includes("--"));
    assert.ok(!Object.prototype.hasOwnProperty.call(push.env, "CONTEXO_DISTILL_DISABLE"));
  });

  it("push and pull fired together run serially: the pull starts after the push ended (push delayMs 1500)", async () => {
    const w = await openWorkspaceCopy({ scenario: "e8-wiring" });
    const sc = sourceControlOf(w.api);
    sc.inputBox.value = "";
    const pushing = vscode.commands.executeCommand("contexo.push", sc);
    await waitFor(() => w.calls().some((c) => c.argv[0] === "push"), { timeoutMs: 10000, message: "the push spawned" });
    const pulling = vscode.commands.executeCommand("contexo.pull", sc);
    await Promise.all([pushing, pulling]);
    const push = only(w.calls(), "push");
    const pull = only(w.calls(), "pull");
    assert.ok(push.end !== undefined && pull.start !== undefined, "both calls are timestamped");
    assert.ok((pull.start ?? 0) >= (push.end ?? Infinity), `pull started ${String(pull.start)} before the push ended ${String(push.end)}`);
    assert.ok((push.end ?? 0) - (push.start ?? 0) >= 1400, "the push really took its delayMs");
  });

  it("CONTEXO_DISTILL_DISABLE is set in the host env, yet absent from every recorded call env (E26)", () => {
    assert.equal(process.env.CONTEXO_DISTILL_DISABLE, "1", "the e2e label launches the host with CONTEXO_DISTILL_DISABLE=1");
    const all = readCalls();
    assert.ok(all.length > 0, "calls were recorded");
    for (const c of all) {
      assert.ok(!Object.prototype.hasOwnProperty.call(c.env, "CONTEXO_DISTILL_DISABLE"), `CONTEXO_DISTILL_DISABLE reached ${c.argv.join(" ")}`);
    }
  });
});
