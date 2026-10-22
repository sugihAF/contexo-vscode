// Two-user scenarios S1-S7 in the Extension Host (WP-3.1): alice is this workspace (the
// extension under test, spawning CTX_BIN), bob is driven through runCtx with HOME=home-bob, and
// the agent path through `ctx mcp` (mcpDriver). Order: S1, S2, S3, S4, S5, S7, S6 (S6 last: its
// capture buffer would arm the D4 guard for every later push). Each scenario uses only its own
// pages (file names 's<n>-*'), asserts only on them, and leaves them unchanged (or removed), with
// no dirty editor and a fresh prompts recorder.
//
// What the extension did is read through the TestApi (scmSnapshot, treeSnapshot,
// quickDiffOriginal, the repository's status) and through a spy on the live services.cli
// (scenarioKit CliSpy), which records every ctx call with its parsed result (PushDoc, PullDoc,
// ResolveDoc or CtxError). Remote changes appear only after an ONLINE status (the Refresh
// command); the page watcher runs `status --offline`.
import * as assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import type { PushOutcome } from "../../src/cli/types";
import { SAVE_ALL_LABEL } from "../../src/commands/dirtyGuard";
import { COMMAND_IDS } from "../../src/commands/ids";
import { TAKE_SERVER_LABEL, staleMessage, takeServerMessage } from "../../src/commands/resolve";
import { LAST_CTX_VERSION_KEY, ctxVersionKey } from "../../src/commands/session";
import { SHARE_VIA_AGENT_LABEL, distillMessage, pullReport } from "../../src/commands/sync";
import type { PageEntry, PullDoc, ResolveDoc, StatusDoc } from "../../src/contract/types";
import { fromContexoUri } from "../../src/fs/contexoUri";
import { placeholderFor } from "../../src/scm/resourceModel";
import type { TestApi, TreeNodeSnapshot } from "../../src/testApi";
import { activateExtension } from "../helpers/activate";
import {
  E2EPrompts, groupPaths, holdsFor, revertAndCloseEditors, scmRepo, sourceControlOf, waitForStatus,
} from "../helpers/e2e";
import { ctxArgv } from "./argv";
import { realCtxEnv } from "./env";
import {
  CliSpy, EXTENSION_CLIENT, aliceRepo, appendParagraph, backupsOf, baseBytes, checkPushAttribution,
  entryOf, nowRfc3339, ofScenario, pageFile, pullAs, pushAs, quiet, readPage, refreshOnline, resourceOf, sha256,
  showAs, statesOf, statusAs, writePage,
} from "./scenarioKit";
import { withMcpSession } from "./mcpDriver";
import { brokenPageText, pageText, relPathOf, type PageSpec } from "./pages";
import { waitFor } from "./waitFor";

/** The MCP clientInfo.name of the agent path (E15). */
const AGENT_CLIENT = "real-ctx-mcp";

describe("real-ctx scenarios (WP-3.1)", function () {
  this.timeout(120000);

  const e = realCtxEnv();
  let api: TestApi;
  let spy: CliSpy;
  let prompts: E2EPrompts;

  /** Fresh prompts for a phase of a scenario (installed after the extension went quiet). */
  function freshPrompts(): E2EPrompts {
    prompts = new E2EPrompts();
    api.hooks.setPrompts(prompts);
    return prompts;
  }

  /** Every scenario starts quiet, with no editor open and its own prompts recorder. */
  async function begin(): Promise<void> {
    await revertAndCloseEditors();
    await quiet(api, spy);
    freshPrompts();
  }

  function entry(rel: string): PageEntry {
    const p = entryOf(api, rel);
    assert.ok(p, `the extension's status lists ${rel}: ${JSON.stringify(aliceRepo(api).status?.pages.map((x) => `${x.path}:${x.state}`))}`);
    return p;
  }

  function group(id: "conflicts" | "changes" | "new" | "incoming" | "invalid"): string[] {
    return groupPaths(scmRepo(api, e.alice), id);
  }

  /** Online refresh, then wait (bounded) until the extension's status satisfies pred. */
  async function refreshUntil(pred: (s: StatusDoc) => boolean, message: string): Promise<StatusDoc> {
    await refreshOnline();
    return waitForStatus(aliceRepo(api), pred, { timeoutMs: 15000, message });
  }

  /** alice writes, pushes (through ctx itself) and bob pulls: the pages exist on both sides, unchanged. */
  async function seed(specs: readonly PageSpec[], o: { bobPulls?: boolean } = {}): Promise<string[]> {
    const rels = specs.map((s) => relPathOf(s.type, s.slug));
    for (const [i, s] of specs.entries()) { writePage(e.alice, rels[i] as string, pageText(s)); }
    const doc = await pushAs(e.homeAlice, e.alice, rels, "real-ctx seed");
    assert.deepEqual(doc.pushed.map((p) => p.path).sort(), [...rels].sort(), `seed push: ${JSON.stringify(doc)}`);
    if (o.bobPulls !== false) { await pullAs(e.homeBob, e.bob); }
    await refreshUntil((s) => rels.every((r) => s.pages.find((p) => p.path === r)?.state === "unchanged"), `seeded ${rels.join(", ")} unchanged`);
    return rels;
  }

  /** bob appends a paragraph to rel and pushes it; returns the new server sha. */
  async function bobEditsAndPushes(rel: string, line: string): Promise<string> {
    appendParagraph(e.bob, rel, line);
    const doc = await pushAs(e.homeBob, e.bob, [rel], `bob: ${line}`);
    const pushed = doc.pushed.find((p) => p.path === rel);
    assert.ok(pushed?.sha, `bob pushed ${rel}: ${JSON.stringify(doc)}`);
    return pushed.sha;
  }

  /** Run an SCM resource command on one page as VS Code does: (clicked, selected[]). */
  async function onResource(command: string, rel: string): Promise<void> {
    const state = resourceOf(api, rel);
    await vscode.commands.executeCommand(command, state, [state]);
  }

  before(async function () {
    this.timeout(90000);
    api = await activateExtension();
    const binary = await waitFor(async () => {
      const b = await api.services.cli.getBinary();
      return b.kind === "ok" ? b : undefined;
    }, { timeoutMs: 30000, message: "the ctx handshake is ok" });
    // The E37 first-run notice of this activation is decided before any scripted prompts.
    await waitFor(() => api.services.context.globalState.get(LAST_CTX_VERSION_KEY) === ctxVersionKey(binary.version), {
      timeoutMs: 15000, message: "the activation's E37 notice was decided",
    });
    await waitFor(() => api.services.model.state === "ready" && aliceRepo(api).status !== undefined, {
      timeoutMs: 30000, message: `the model is ready with alice's status (state ${api.services.model.state})`,
    });
    spy = new CliSpy(api.services.cli);
  });

  after(async () => {
    spy?.restore();
    await revertAndCloseEditors();
  });

  afterEach(async () => {
    await revertAndCloseEditors();
    assert.deepEqual(vscode.workspace.textDocuments.filter((d) => d.isDirty).map((d) => d.uri.toString()), [], "no dirty editor is left behind");
  });

  // ---------------------------------------------------------------- S1

  it("S1 no false drift, the SHA fix, E15 attribution: 5 pages pushed from the SCM input box are unchanged for alice and bob; one edit counts 1 (E29), pushes 1 page, and a second Push sends nothing", async () => {
    await begin();
    const specs: PageSpec[] = [
      { type: "concept", slug: "s1-alpha", title: "Alpha", body: "Alpha keeps the drift check honest." },
      { type: "concept", slug: "s1-beta", title: "Beta", body: "Beta is tagged.", tags: ["sync", "drift"] },
      { type: "entity", slug: "s1-gamma", title: "Gamma", body: "Gamma is an entity." },
      { type: "analysis", slug: "s1-delta", title: "Delta", body: "Delta analyses the drift." },
      { type: "entity", slug: "s1-epsilon", title: "Epsilon", body: "Epsilon closes the set." },
    ];
    const rels = specs.map((s) => relPathOf(s.type, s.slug)).sort();
    const s1 = ofScenario("s1");
    const allUnchanged = Object.fromEntries(rels.map((r) => [r, "unchanged"]));

    for (const s of specs) { writePage(e.alice, relPathOf(s.type, s.slug), pageText(s)); }
    // The page watcher's `status --offline` shows them as new.
    await waitForStatus(aliceRepo(api), (s) => rels.every((r) => s.pages.find((p) => p.path === r)?.state === "new"), {
      timeoutMs: 15000, message: "the five s1 pages are new",
    });
    assert.deepEqual(group("new").filter((p) => s1({ path: p })), rels, "the New group lists the five pages");

    // Push through the SourceControl input box (acceptInputCommand).
    const sc = sourceControlOf(api, e.alice);
    sc.inputBox.value = "S1: five pages";
    const accept = scmRepo(api, e.alice).acceptInputCommand;
    assert.equal(accept?.command, COMMAND_IDS.push, "Cmd/Ctrl+Enter runs contexo.push");
    let m = spy.mark();
    await vscode.commands.executeCommand(COMMAND_IDS.push, sc);
    const firstCall = spy.only(m, "push");
    assert.deepEqual(firstCall.args, [e.alice, { message: "S1: five pages", paths: rels }], "one push of exactly the five planned pages, -m <input>");
    const first = (firstCall.result as PushOutcome | undefined)?.doc;
    assert.ok(first, `the push resolved with a PushDoc: ${spy.describe(m)}`);
    assert.deepEqual(first.pushed.map((p) => p.path).sort(), rels);
    assert.deepEqual(first.conflicts, []);
    assert.equal(first.message, "S1: five pages", "the input box text is the push message");
    assert.equal(sc.inputBox.value, "", "a clean push clears the input box");

    await pullAs(e.homeBob, e.bob);
    await refreshOnline();
    const alice1 = aliceRepo(api).status as StatusDoc;
    assert.equal(alice1.remote.source, "live");
    assert.deepEqual(statesOf(alice1, "s1"), allUnchanged, "alice: 5 unchanged and nothing else");
    for (const p of alice1.pages.filter(s1)) {
      assert.equal(p.base?.sha, p.remote?.sha, `alice ${p.path}: base.sha == remote.sha (no false drift)`);
      assert.equal(p.base?.stale, false);
    }
    const bob1 = await statusAs(e.homeBob, e.bob);
    assert.deepEqual(statesOf(bob1, "s1"), allUnchanged, "bob: 5 unchanged and nothing else");

    // alice edits one page: Changes has it, and the badge counts exactly 1 (E29).
    const edited = relPathOf("entity", "s1-gamma");
    appendParagraph(e.alice, edited, "Gamma edited by alice.");
    await waitFor(() => group("changes").includes(edited), { timeoutMs: 15000, message: "the edited page is in Changes" });
    assert.deepEqual(group("changes").filter((p) => s1({ path: p })), [edited]);
    await waitFor(() => scmRepo(api, e.alice).count === 1, { timeoutMs: 5000, message: `SourceControl.count == 1 (is ${scmRepo(api, e.alice).count})` });

    sc.inputBox.value = "S1: one edit";
    m = spy.mark();
    await vscode.commands.executeCommand(COMMAND_IDS.push, sc);
    const second = (spy.only(m, "push").result as PushOutcome | undefined)?.doc;
    assert.ok(second, `the second push resolved with a PushDoc: ${spy.describe(m)}`);
    assert.deepEqual(second.pushed.map((p) => p.path), [edited], "PushDoc.pushed has exactly the edited page");
    assert.deepEqual(second.conflicts, []);
    const head = aliceRepo(api).status?.remote.head;
    assert.ok(head, "the post-push online status has a remote head");
    assert.deepEqual(statesOf(aliceRepo(api).status as StatusDoc, "s1"), allUnchanged, "every s1 page is unchanged after the push");

    // A second Push sends nothing: no ctx push at all, and ctx itself agrees (no new commit).
    freshPrompts();
    m = spy.mark();
    await vscode.commands.executeCommand(COMMAND_IDS.push, sc);
    assert.deepEqual(spy.since(m, "push"), [], "the second Push spawns no ctx push");
    await prompts.waitFor("Nothing to push", { method: "info" });
    const again = await pushAs(e.homeAlice, e.alice, rels);
    assert.deepEqual(again.pushed, [], "ctx push of the five pages sends nothing");
    assert.equal(again.new_head, undefined, "no new server commit");
    assert.deepEqual(again.skipped.map((k) => [k.path, k.reason]).sort(), rels.map((r) => [r, "unchanged"]));
    await refreshOnline();
    assert.equal(aliceRepo(api).status?.remote.head, head, "the server head did not move");

    // bob sees exactly one incoming s1 page, then none after his pull.
    const bob2 = await statusAs(e.homeBob, e.bob);
    assert.deepEqual(bob2.pages.filter(s1).filter((p) => p.state !== "unchanged").map((p) => [p.path, p.state]), [[edited, "incoming"]]);
    await pullAs(e.homeBob, e.bob);
    const bob3 = await statusAs(e.homeBob, e.bob);
    assert.deepEqual(statesOf(bob3, "s1"), allUnchanged, "bob: 0 incoming after the pull");

    const binary = await api.services.cli.getBinary();
    assert.equal(binary.kind, "ok");
    assert.equal(binary.kind === "ok" ? binary.path : undefined, e.ctxBin, "the extension runs CTX_BIN");

    await checkPushAttribution("S1", rels, EXTENSION_CLIENT);
  });

  // ---------------------------------------------------------------- S2

  it("S2 edit visible + quick diff: a local edit is in Changes within 2.5 s, and the quick-diff original equals `ctx show --at base` and .sync/base", async () => {
    await begin();
    const [rel] = await seed([{ type: "concept", slug: "s2-quick-diff", title: "Quick diff", body: "The gutter compares against base." }], { bobPulls: false });
    const P = rel as string;
    const original = readPage(e.alice, P);
    await quiet(api, spy);
    const m = spy.mark();
    try {
      const t0 = Date.now();
      appendParagraph(e.alice, P, "S2: a local edit.");
      await waitFor(() => group("changes").includes(P), {
        timeoutMs: 2500, intervalMs: 10, message: `the edit is in Changes within 2.5 s (calls: ${spy.describe(m)})`,
      });
      const elapsed = Date.now() - t0;
      assert.ok(elapsed <= 2500, `Changes updated after ${elapsed} ms`);
      assert.ok(spy.since(m, "status").some((c) => (c.args[1] as { offline?: boolean }).offline === true), `the watcher ran status --offline: ${spy.describe(m)}`);
      assert.equal(entry(P).state, "modified");

      const fileUri = aliceRepo(api).fileUri(P);
      const hook = api.hooks.quickDiffOriginal;
      assert.ok(hook, "the quickDiffOriginal hook is installed");
      const originalUri = await hook(fileUri);
      assert.ok(originalUri, "a modified page has a quick-diff original");
      assert.equal(originalUri.scheme, "contexo");
      const q = fromContexoUri(originalUri);
      assert.deepEqual([q.ref, q.relPath], ["base", P]);
      const served = Buffer.from(await vscode.workspace.fs.readFile(originalUri));
      const shown = await showAs(e.homeAlice, e.alice, P, "base");
      assert.ok(served.equals(shown), "the quick-diff original equals `ctx show --at base` byte for byte");
      assert.ok(shown.equals(baseBytes(e.alice, P)), "`ctx show --at base` equals .sync/base/<p>");
      assert.ok(shown.equals(original), "the base is the pushed bytes");
    } finally {
      writePage(e.alice, P, original);
    }
    await waitFor(() => !group("changes").includes(P), { timeoutMs: 15000, message: "the restored page left Changes" });
  });

  // ---------------------------------------------------------------- S3

  it("S3 conflict round trip: Conflicts after Refresh, Pull keeps alice's bytes (skip conflict), the E9 sidecar offline, the E27 guards, Take Server Version with a backup, then Keep Mine (after a stale) and Push", async () => {
    await begin();
    const [rel] = await seed([{ type: "entity", slug: "s3-ledger", title: "Ledger", body: "Ledger v1." }]);
    const P = rel as string;
    const fileUri = aliceRepo(api).fileUri(P);

    // bob edits and pushes P while alice edits P (saved, not pushed).
    const bobSha1 = await bobEditsAndPushes(P, "Bob line 1.");
    appendParagraph(e.alice, P, "Alice line 1.");
    await refreshOnline();
    await waitFor(() => group("conflicts").includes(P), { timeoutMs: 10000, message: "P is in Conflicts after Refresh" });
    assert.equal(entry(P).state, "conflict");
    assert.equal(entry(P).conflict_kind, "both_modified");
    assert.equal(entry(P).remote?.sha, bobSha1);
    const aliceBytes = readPage(e.alice, P);
    const aliceHash = sha256(aliceBytes);

    // Pull: P is skipped (conflict) and alice's file is untouched.
    let m = spy.mark();
    await vscode.commands.executeCommand(COMMAND_IDS.pull);
    const pullDoc = spy.only(m, "pull").result as PullDoc | undefined;
    assert.ok(pullDoc, `the pull resolved with a PullDoc: ${spy.describe(m)}`);
    assert.ok(pullDoc.skipped.some((k) => k.path === P && k.reason === "conflict"), `P skipped with reason conflict: ${JSON.stringify(pullDoc.skipped)}`);
    assert.ok(!pullDoc.written.some((w) => w.path === P), "P was not written");
    assert.equal(sha256(readPage(e.alice, P)), aliceHash, "alice's file is sha256-identical after the pull");
    await prompts.waitFor(pullReport(pullDoc).message, { method: "info" });
    assert.ok(group("conflicts").includes(P), "P is still in Conflicts after the pull");

    // Offline: the sidecar keeps P a conflict (E9).
    await aliceRepo(api).refresh({ remote: false });
    assert.equal(aliceRepo(api).status?.remote.source, "none", "the last refresh was offline");
    assert.ok(group("conflicts").includes(P), "an offline refresh keeps P in Conflicts");
    const offline = await statusAs(e.homeAlice, e.alice, { offline: true });
    const offP = offline.pages.find((p) => p.path === P);
    assert.equal(offP?.state, "conflict", "status --offline reports P conflict");
    assert.deepEqual(offP?.remote, { sha: bobSha1 }, "the remote side comes from the sidecar: {sha} only (E9)");
    assert.equal(offline.remote.source, "none");

    // E27: an unsaved edit of P. Pull asks to save (Cancel), Take Server Version refuses.
    const doc = await vscode.workspace.openTextDocument(fileUri);
    await vscode.window.showTextDocument(doc);
    const edit = new vscode.WorkspaceEdit();
    edit.insert(fileUri, doc.positionAt(doc.getText().length), "\nAn unsaved S3 edit.\n");
    assert.equal(await vscode.workspace.applyEdit(edit), true, "the edit applies");
    await waitFor(() => doc.isDirty, { timeoutMs: 5000, message: "P's buffer is dirty" });
    freshPrompts();
    m = spy.mark();
    await vscode.commands.executeCommand(COMMAND_IDS.pull);
    const modal = prompts.find("unsaved Contexo page(s)", "confirm");
    assert.ok(modal, `the E27 modal (prompts: ${JSON.stringify(prompts.calls.map((c) => `${c.method}: ${c.message}`))})`);
    assert.equal(modal.message, "1 unsaved Contexo page(s)");
    assert.equal(modal.options?.modal, true);
    assert.equal(modal.options?.confirmLabel, SAVE_ALL_LABEL);
    assert.equal(modal.answer, false, "Cancel");
    await onResource(COMMAND_IDS.resolveTheirs, P);
    await prompts.waitFor(`Save or revert ${P} first`, { method: "warn" });
    assert.equal(prompts.find(takeServerMessage(P), "confirm"), undefined, "refused before the Take Server Version modal");
    assert.deepEqual(spy.since(m).filter((c) => c.method === "pull" || c.method === "resolve"), [], `Cancel and the refusal spawn no pull/resolve: ${spy.describe(m)}`);
    assert.equal(sha256(readPage(e.alice, P)), aliceHash, "the file on disk is unchanged");
    assert.equal(doc.isDirty, true, "nothing was saved");
    await revertAndCloseEditors();
    assert.equal(doc.isDirty, false, "the buffer is reverted");

    // Take Server Version: the server bytes, state unchanged, a backup of alice's version.
    freshPrompts().confirmAnswers = [true];
    const seen = entry(P).remote?.sha;
    m = spy.mark();
    await onResource(COMMAND_IDS.resolveTheirs, P);
    const theirsCall = spy.only(m, "resolve");
    assert.deepEqual(theirsCall.args.slice(1), [P, "theirs", { ifServerSha: seen }], "resolve P --theirs --if-server-sha <the sha the user saw>");
    const theirs = theirsCall.result as ResolveDoc | undefined;
    assert.ok(theirs, `resolve --theirs resolved: ${spy.describe(m)}`);
    assert.equal(theirs.state, "unchanged");
    assert.equal(theirs.file_written, true);
    const confirm = prompts.find(takeServerMessage(P), "confirm");
    assert.equal(confirm?.options?.confirmLabel, TAKE_SERVER_LABEL);
    assert.ok(readPage(e.alice, P).equals(await showAs(e.homeAlice, e.alice, P, "server")), "local bytes == `ctx show P --at server`");
    assert.equal(entry(P).state, "unchanged", "P is unchanged after the follow-up refresh");
    assert.ok(!group("conflicts").includes(P), "P left Conflicts");
    const backups = backupsOf(e.alice, P);
    assert.ok(backups.length >= 1, "a backup exists under .contexo/.sync/backup/");
    assert.ok(backups.some((b) => sha256(fs.readFileSync(b)) === aliceHash), "the backup holds alice's version");
    assert.ok(theirs.backup_file && backups.some((b) => b.endsWith(path.join(...(theirs.backup_file as string).split("/").slice(2)))), `ResolveDoc.backup_file ${String(theirs.backup_file)} is on disk`);

    // Round 2: a new conflict; bob pushes again between Refresh and Keep Mine -> stale (exit 6).
    await pullAs(e.homeBob, e.bob);
    appendParagraph(e.alice, P, "Alice round 2.");
    const bobSha2 = await bobEditsAndPushes(P, "Bob round 2.");
    await refreshUntil((s) => s.pages.some((p) => p.path === P && p.state === "conflict" && p.remote?.sha === bobSha2), "round 2: P is a conflict at bob's sha");
    const bobSha3 = await bobEditsAndPushes(P, "Bob round 2b.");
    assert.equal(entry(P).remote?.sha, bobSha2, "the extension still shows the sha the user saw");
    freshPrompts();
    m = spy.mark();
    await onResource(COMMAND_IDS.resolveOurs, P); // resolves: no unhandled error escapes the command
    const staleCall = spy.only(m, "resolve");
    assert.deepEqual(staleCall.args.slice(1), [P, "ours", { ifServerSha: bobSha2 }]);
    const staleErr = staleCall.error as { code?: string; exitCode?: number } | undefined;
    assert.equal(staleErr?.code, "stale", `Keep Mine after bob's push is stale: ${spy.describe(m)}`);
    assert.equal(staleErr?.exitCode, 6);
    await prompts.waitFor(staleMessage(P), { method: "info" });
    assert.ok(spy.since(m, "status").some((c) => (c.args[1] as { offline?: boolean }).offline === false && c.start >= (staleCall.end ?? Infinity)), "the extension refreshed online after the stale");
    assert.equal(entry(P).remote?.sha, bobSha3, "the refresh shows bob's newest sha");
    assert.equal(entry(P).state, "conflict");
    assert.deepEqual(prompts.calls.filter((c) => c.method === "error"), [], "no error notification");
    await revertAndCloseEditors(); // stale re-opens the conflict diff

    // Keep Mine, then Push: the server holds alice's normalized content.
    freshPrompts();
    m = spy.mark();
    await onResource(COMMAND_IDS.resolveOurs, P);
    const ours = spy.only(m, "resolve").result as ResolveDoc | undefined;
    assert.ok(ours, `Keep Mine resolved: ${spy.describe(m)}`);
    assert.equal(ours.state, "modified");
    assert.equal(ours.file_written, false);
    assert.deepEqual(prompts.calls.filter((c) => c.method === "confirm"), [], "Keep Mine asks nothing");
    assert.equal(entry(P).state, "modified", "P moved from Conflicts to Changes");
    assert.ok(group("changes").includes(P));
    const sc = sourceControlOf(api, e.alice);
    sc.inputBox.value = "S3: keep mine";
    m = spy.mark();
    await vscode.commands.executeCommand(COMMAND_IDS.push, sc);
    const pushed = (spy.only(m, "push").result as PushOutcome | undefined)?.doc;
    assert.ok(pushed?.pushed.some((p) => p.path === P), `alice's version was pushed: ${JSON.stringify(pushed)}`);
    const server = await showAs(e.homeBob, e.bob, P, "server");
    assert.ok(server.equals(baseBytes(e.alice, P)), "bob's `show --at server` equals the bytes alice's base holds after the push");
    assert.ok(server.toString("utf8").includes("Alice round 2."), "the server has alice's version");
    assert.equal(entry(P).state, "unchanged");
    await pullAs(e.homeBob, e.bob);
  });

  // ---------------------------------------------------------------- S4

  it("S4 agent path (D2): `ctx mcp` ctx_push {no_distill} sends alice's edit; after ONE Refresh the page left Changes, unchanged, base.sha == remote.sha", async () => {
    await begin();
    const [rel] = await seed([{ type: "entity", slug: "s4-agent-notes", title: "Agent notes", body: "Written for the agent path." }], { bobPulls: false });
    const Q = rel as string;
    const before = entry(Q).base?.sha;
    appendParagraph(e.alice, Q, "S4: an edit the agent pushes.");
    await waitFor(() => group("changes").includes(Q), { timeoutMs: 15000, message: "the edit is in Changes" });

    const text = await withMcpSession({ bin: e.ctxBin, root: e.alice, home: e.homeAlice }, async (s) => {
      const init = await s.initialize(AGENT_CLIENT);
      assert.equal((init.result as { serverInfo?: { name?: string } } | undefined)?.serverInfo?.name, "contexo");
      const out = await s.callTool("ctx_push", { no_distill: true });
      assert.equal(out.isError, false, out.text);
      return out.text;
    });
    assert.match(text, /Pushed [1-9]\d* page\(s\)/, `ctx_push answered: ${text}`);

    await refreshOnline(); // ONE refresh
    const q = entry(Q);
    assert.equal(q.state, "unchanged", `Q after the agent push and one Refresh: ${JSON.stringify(q)}`);
    assert.ok(q.base?.sha && q.base.sha === q.remote?.sha, "base.sha == remote.sha");
    assert.notEqual(q.base?.sha, before, "the base moved to the agent's push");
    assert.ok(!group("changes").includes(Q), "Q left Changes");
    assert.ok((await showAs(e.homeBob, e.bob, Q, "server")).equals(readPage(e.alice, Q)), "the server holds alice's edited page");

    await checkPushAttribution("S4", [Q], AGENT_CLIENT);
  });

  // ---------------------------------------------------------------- S5

  it("S5 agent conflict path: ctx_push returns <MERGE_REQUIRED> with no SHA bump (D5); after the merge, ctx_push {resolved:[P]} in the same session leaves the server with the merged page and P leaves Conflicts", async () => {
    await begin();
    const spec: PageSpec = { type: "concept", slug: "s5-merge", title: "Merge", body: "Line one." };
    const [rel] = await seed([spec]);
    const P = rel as string;
    appendParagraph(e.alice, P, "Alice adds.");
    const bobSha = await bobEditsAndPushes(P, "Bob adds.");
    await refreshOnline();
    await waitFor(() => group("conflicts").includes(P), { timeoutMs: 10000, message: "P is in Conflicts" });
    const base0 = entry(P).base?.sha;
    assert.ok(base0, "P has a base");
    const merged = pageText({ ...spec, body: "Line one.\n\nAlice adds.\n\nBob adds." });

    await withMcpSession({ bin: e.ctxBin, root: e.alice, home: e.homeAlice }, async (s) => {
      await s.initialize(AGENT_CLIENT);
      const brief = await s.callTool("ctx_push", { no_distill: true });
      assert.equal(brief.isError, false, brief.text);
      assert.ok(brief.text.includes("<MERGE_REQUIRED"), `ctx_push without resolved asks for a merge: ${brief.text}`);
      assert.ok(brief.text.includes(P), "the brief names P");

      await refreshOnline();
      const p = entry(P);
      assert.equal(p.state, "conflict", "P is still a conflict after Refresh");
      assert.equal(p.base?.sha, base0, "no SHA bump: base.sha is unchanged (D5)");
      assert.equal(p.remote?.sha, bobSha);
      assert.ok(group("conflicts").includes(P));

      writePage(e.alice, P, merged); // what ctx_write_page would write
      const done = await s.callTool("ctx_push", { resolved: [P], no_distill: true });
      assert.equal(done.isError, false, done.text);
      assert.ok(!done.text.includes("<MERGE_REQUIRED"), `the resolved push in the same session does not re-brief (D2): ${done.text}`);
      assert.ok(done.text.includes(`Resolved ${P}`), `ctx_push kept the merged version: ${done.text}`);
      assert.match(done.text, /Pushed [1-9]\d* page\(s\)/, "the merged page was pushed (line order is GFR-4, not asserted here)");
    });

    const server = await showAs(e.homeBob, e.bob, P, "server");
    assert.ok(server.equals(baseBytes(e.alice, P)), "bob's `show --at server` equals alice's base bytes");
    assert.ok(server.equals(Buffer.from(merged)), "the server holds the merged page (already in Normalize form)");
    await refreshOnline();
    assert.equal(entry(P).state, "unchanged");
    assert.ok(!group("conflicts").includes(P), "P left Conflicts");
    await pullAs(e.homeBob, e.bob);
  });

  // ---------------------------------------------------------------- S7

  it("S7 invalid page: broken frontmatter is in the Invalid group and the tree's Invalid node (E30), not counted (E29), skipped by push with reason invalid, never on the server", async () => {
    await begin();
    const P = relPathOf("concept", "s7-broken");
    const file = pageFile(e.alice, P);
    const countBefore = scmRepo(api, e.alice).count;
    try {
      writePage(e.alice, P, brokenPageText("s7-broken"));
      await waitFor(() => group("invalid").includes(P), { timeoutMs: 15000, message: "P is in the Invalid group" });
      assert.equal(entry(P).state, "invalid");
      assert.equal(entry(P).invalid?.stage, "parse");

      const roots = api.hooks.treeSnapshot?.().roots ?? [];
      const invalidNode = roots.find((n) => n.id === `${e.alice}|#invalid`);
      assert.ok(invalidNode, `the tree has an Invalid node: ${JSON.stringify(roots.map((n) => n.id))}`);
      assert.equal(invalidNode.label, "Invalid");
      const node = invalidNode.children.find((n: TreeNodeSnapshot) => n.id === `${e.alice}|${P}`);
      assert.ok(node, `P is under Invalid: ${JSON.stringify(invalidNode.children.map((n) => n.id))}`);
      assert.equal(node.contextValue, "page.invalid");
      for (const other of roots.filter((n) => n.id !== `${e.alice}|#invalid`)) {
        assert.ok(!other.children.some((n) => n.id === `${e.alice}|${P}`), `P is listed only under Invalid (also under ${other.id})`);
      }
      assert.equal(scmRepo(api, e.alice).count, countBefore, "the invalid page is not counted (E29)");

      const doc = await pushAs(e.homeAlice, e.alice, [P]);
      assert.deepEqual(doc.pushed, []);
      assert.deepEqual(doc.skipped.filter((k) => k.path === P).map((k) => k.reason), ["invalid"], `push skips P as invalid: ${JSON.stringify(doc.skipped)}`);

      const bob = await statusAs(e.homeBob, e.bob);
      assert.deepEqual(bob.pages.filter(ofScenario("s7")), [], "the server listing never contains an s7 page");
      await refreshOnline();
      assert.equal(entry(P).remote, undefined, "alice's online status has no server side for P");
    } finally {
      fs.rmSync(file, { force: true });
    }
    await waitFor(() => !group("invalid").includes(P), { timeoutMs: 15000, message: "the removed page left Invalid" });
  });

  // ---------------------------------------------------------------- S6 (last)

  it("S6 D4 guard + E26: with a fresh capture buffer and CONTEXO_DISTILL_DISABLE=1 in the Extension Host, Push offers only Share via your agent and sends nothing; Push Selected of an entity alone succeeds", async () => {
    await begin();
    const C = relPathOf("concept", "s6-guarded");
    const E = relPathOf("entity", "s6-ledger");
    const buffer = pageFile(e.alice, "raw/sessions/_pending/s6.jsonl");
    const hadEnv = Object.prototype.hasOwnProperty.call(process.env, "CONTEXO_DISTILL_DISABLE");
    const previousEnv = process.env.CONTEXO_DISTILL_DISABLE;
    try {
      await seed([
        { type: "concept", slug: "s6-guarded", title: "Guarded", body: "A concept page arms the guard." },
        { type: "entity", slug: "s6-ledger", title: "Ledger", body: "An entity page does not." },
      ]);
      appendParagraph(e.alice, C, "S6: a concept edit.");
      appendParagraph(e.alice, E, "S6: an entity edit.");
      process.env.CONTEXO_DISTILL_DISABLE = "1"; // E26: the extension must strip it from every spawn
      fs.mkdirSync(path.dirname(buffer), { recursive: true });
      fs.writeFileSync(buffer, `${JSON.stringify({ ts: nowRfc3339(), turn: 1, user: "Why does S6 change the guarded concept?", assistant: "To prove the D4 guard holds end to end." })}\n`);

      const status = await refreshUntil((s) => s.captures.blocks_push && s.pages.some((p) => p.path === C && p.state === "modified") && s.pages.some((p) => p.path === E && p.state === "modified"),
        "captures.blocks_push is true with both s6 pages modified");
      assert.ok(status.captures.fresh >= 1);
      // Control: the same status with the variable reaching ctx is bypassed (E24), so the
      // extension's blocks_push=true above proves it stripped the variable (E26).
      const leaked = spawnSync(e.ctxBin, ctxArgv.status(e.alice, true), {
        cwd: e.alice, env: { ...process.env, HOME: e.homeAlice, USERPROFILE: e.homeAlice, CONTEXO_DISTILL_DISABLE: "1" }, encoding: "utf8", shell: false, timeout: 30000,
      });
      assert.equal(leaked.status, 0, leaked.stderr);
      assert.equal((JSON.parse(leaked.stdout) as StatusDoc).captures.blocks_push, false, "control: with CONTEXO_DISTILL_DISABLE=1 ctx reports blocks_push false");
      assert.equal(scmRepo(api, e.alice).inputPlaceholder, placeholderFor(status, process.platform), "the input box says Push offers Share via your agent");
      const head = status.remote.head;
      const bobBefore = Object.fromEntries((await statusAs(e.homeBob, e.bob)).pages.filter(ofScenario("s6")).map((p) => [p.path, p.remote?.sha]));
      assert.deepEqual(Object.keys(bobBefore).sort(), [C, E].sort(), "bob's listing has both s6 pages");

      // Push: the D4 modal (answered Cancel), no ctx push, nothing reaches the server.
      freshPrompts();
      const sc = sourceControlOf(api, e.alice);
      sc.inputBox.value = "S6: must not reach the server";
      let m = spy.mark();
      await vscode.commands.executeCommand(COMMAND_IDS.push, sc);
      const modal = prompts.find(distillMessage(status.captures.fresh), "confirm");
      assert.ok(modal, `the D4 modal (prompts: ${JSON.stringify(prompts.calls.map((c) => `${c.method}: ${c.message}`))})`);
      assert.deepEqual(modal.options, { modal: true, confirmLabel: SHARE_VIA_AGENT_LABEL }, "the only button is Share via your agent");
      for (const c of prompts.calls) {
        assert.ok(!/no-distill|push anyway/i.test(JSON.stringify(c)), `D4: no prompt offers a bypass: ${JSON.stringify(c)}`);
      }
      await holdsFor(() => spy.since(m, "push").length === 0, 2500, `a ctx push under blocks_push: ${spy.describe(m)}`);
      await refreshOnline();
      assert.equal(aliceRepo(api).status?.remote.head, head, "remote.head is unchanged");
      assert.equal(entry(C).state, "modified");
      const bobAfter = Object.fromEntries((await statusAs(e.homeBob, e.bob)).pages.filter(ofScenario("s6")).map((p) => [p.path, p.remote?.sha]));
      assert.deepEqual(bobAfter, bobBefore, "bob's listing is unchanged");

      // Push Selected of the entity alone: the guard needs a concept/analysis page, so it goes through.
      freshPrompts();
      m = spy.mark();
      await onResource(COMMAND_IDS.pushSelected, E);
      const call = spy.only(m, "push");
      assert.deepEqual((call.args[1] as { paths?: string[] }).paths, [E], "Push Selected sends only the entity");
      const doc = (call.result as PushOutcome | undefined)?.doc;
      assert.ok(doc, `Push Selected resolved with a PushDoc: ${spy.describe(m)}`);
      assert.deepEqual(doc.pushed.map((p) => p.path), [E]);
      assert.deepEqual(doc.distill, { required: false, bypassed: false }, "the guard did not apply and was not bypassed (E24/E26)");
      assert.equal(entry(E).state, "unchanged");
      assert.equal(entry(C).state, "modified", "the concept page stays unpushed");
      const bobLast = await statusAs(e.homeBob, e.bob);
      assert.equal(bobLast.pages.find((p) => p.path === E)?.state, "incoming", "bob sees the entity push");
      assert.equal(bobLast.pages.find((p) => p.path === C)?.state, "unchanged", "bob never got the concept edit");
    } finally {
      fs.rmSync(buffer, { force: true });
      if (hadEnv) { process.env.CONTEXO_DISTILL_DISABLE = previousEnv; } else { delete process.env.CONTEXO_DISTILL_DISABLE; }
      await revertAndCloseEditors();
      if (fs.existsSync(path.join(e.alice, ".contexo", ".sync", "base", ...C.split("/")))) { writePage(e.alice, C, baseBytes(e.alice, C)); }
    }
    await refreshUntil((s) => !s.captures.blocks_push && s.pages.find((p) => p.path === C)?.state === "unchanged", "the buffer is gone and the concept page is back to its base");
    await pullAs(e.homeBob, e.bob);
  });
});
