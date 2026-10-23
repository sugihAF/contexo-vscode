// e7 (WP-1.13): Push / Push Selected / Pull and Keep Mine / Take Server Version / Restore
// Server Version, driven through vscode.commands.executeCommand over
// hooks.overrideServices({cli: FakeCtxCli, model: fakeModel}).
//
// - FakeCtxCli answers from the e7-* scenario fixtures: the call arguments are turned into
//   the E25 argv ONLY to select the scenario rule (test/helpers/fixtures scenarioOutput).
//   argv is never asserted here; WP-2.3 asserts it through calls.jsonl.
// - Prompts are scripted (confirm answers per test; notifications are dismissed) and every
//   call is recorded, in one event log with the ctx calls, repository refreshes and
//   contexo.shareViaAgent runs, so tests can assert ordering.
// - contexo.shareViaAgent is a sinon stub of vscode.commands.executeCommand (every other id
//   calls through). That works only because the test and the extension share one vscode
//   API object, which the first test proves.
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as sinon from "sinon";
import * as vscode from "vscode";
import { CtxError, type PushOutcome } from "../../src/cli/types";
import { SAVE_ALL_LABEL } from "../../src/commands/dirtyGuard";
import { BUSY_RETRY_MS } from "../../src/commands/errorActions";
import { ALL_COMMAND_IDS, COMMAND_IDS } from "../../src/commands/ids";
import {
  RESTORE_SERVER_LABEL,
  TAKE_SERVER_LABEL,
  restoreServerMessage,
  selectionName,
  staleMessage,
  takeServerMessage,
} from "../../src/commands/resolve";
import { SHARE_VIA_AGENT_LABEL, SHOW_CHANGES_LABEL, SHOW_CONFLICTS_LABEL, distillMessage } from "../../src/commands/sync";
import {
  parseEnvelope,
  type DistillRequiredDetails,
  type PageEntry,
  type PullDoc,
  type PushDoc,
  type ResolveDoc,
  type ResolveStrategy,
  type StatusDoc,
} from "../../src/contract/types";
import type { OperationKind } from "../../src/model/types";
import type { TestApi } from "../../src/testApi";
import type { ConfirmOptions, Prompts } from "../../src/ui/prompts";
import { activateExtension } from "../helpers/activate";
import { FakeCtxCli } from "../helpers/fakeCtxCli";
import { fakeModel } from "../helpers/fakeModel";
import { fakeRepository, type FakeRepository } from "../helpers/fakeRepository";
import { loadStatusDoc, scenarioDir, scenarioOutput } from "../helpers/fixtures";

const SYNC_MODEL = "wiki/analyses/sync-model.md";
const AUTH_FLOW = "wiki/concepts/auth-flow.md";
const RATE_LIMITS = "wiki/concepts/rate-limits.md";
const RETRY_POLICY = "wiki/concepts/retry-policy.md";
const OLD_NAME = "wiki/concepts/old-name.md";
/** pushPlan(mixed): the modified and new pages, in status order. */
const MIXED_PLAN = [SYNC_MODEL, AUTH_FLOW];
/** errorActions busy message (WP-1.13 table). */
const BUSY_TEXT = "Another ctx operation (possibly your agent) is syncing";
/** Appended (unsaved) to a page by the E27 dirty-guard tests. */
const UNSAVED_MARKER = "\n<!-- e7: unsaved edit -->\n";

// ---------- recorder ----------

type CliMethod = "push" | "pull" | "resolve";
interface NotifyCall { method: "info" | "warn" | "error"; message: string; actions: string[] }
interface ConfirmCall { method: "confirm"; message: string; options: ConfirmOptions }
interface OtherPromptCall { method: "quickPick" | "inputBox" | "copyToClipboard" | "openExternal" }
type PromptCall = NotifyCall | ConfirmCall | OtherPromptCall;

interface CliEvent {
  kind: "cli";
  method: CliMethod;
  args: unknown[];
  /** repo.operation while ctx ran (set only inside repo.run of a mutating kind). */
  operation: OperationKind | undefined;
  /** Date.now() when the call started. */
  at: number;
  /** What Recorder.probe returned when the call started. */
  probe: unknown;
}
type E7Event =
  | { kind: "prompt"; call: PromptCall }
  | CliEvent
  | { kind: "refresh"; remote: boolean }
  | { kind: "share"; args: unknown[] };

/** One test's event log, its scripted Prompts and its concurrency probe. */
class Recorder {
  readonly events: E7Event[] = [];
  /** confirm() answers in call order; the last one repeats once the list is used up. */
  confirmAnswers: boolean[] = [false];
  /** Sampled at the start of every ctx call (e.g. whether a page is still dirty). */
  probe: (() => unknown) | undefined;
  /** ctx calls in flight right now, and the most ever in flight at once. */
  inflight = 0;
  maxInflight = 0;
  private confirmIndex = 0;

  /** Records every call; notifications are dismissed (undefined), quickPick picks nothing. */
  readonly prompts: Prompts = {
    info: async (message, ...actions) => this.notify("info", message, actions),
    warn: async (message, ...actions) => this.notify("warn", message, actions),
    error: async (message, ...actions) => this.notify("error", message, actions),
    confirm: async (message, options) => {
      this.events.push({ kind: "prompt", call: { method: "confirm", message, options } });
      const i = Math.min(this.confirmIndex++, this.confirmAnswers.length - 1);
      return this.confirmAnswers[i] ?? false;
    },
    quickPick: async () => { this.other("quickPick"); return undefined; },
    inputBox: async () => { this.other("inputBox"); return undefined; },
    copyToClipboard: async () => { this.other("copyToClipboard"); },
    openExternal: async () => { this.other("openExternal"); return false; },
  };

  prompted(): PromptCall[] {
    return this.events.flatMap((e) => (e.kind === "prompt" ? [e.call] : []));
  }

  notifications(): NotifyCall[] {
    return this.prompted().filter((c): c is NotifyCall => c.method === "info" || c.method === "warn" || c.method === "error");
  }

  /** The first notification whose message contains text (substring match), if any. */
  notified(text: string): NotifyCall | undefined {
    return this.notifications().find((n) => n.message.includes(text));
  }

  confirms(): ConfirmCall[] {
    return this.prompted().filter((c): c is ConfirmCall => c.method === "confirm");
  }

  cliCalls(method?: CliMethod): CliEvent[] {
    return this.events.filter((e): e is CliEvent => e.kind === "cli" && (method === undefined || e.method === method));
  }

  /** The args of every contexo.shareViaAgent run. */
  shares(): unknown[][] {
    return this.events.flatMap((e) => (e.kind === "share" ? [e.args] : []));
  }

  /** Index of the first event matching pred, or -1. */
  indexOf(pred: (e: E7Event) => boolean): number {
    return this.events.findIndex(pred);
  }

  private notify(method: NotifyCall["method"], message: string, actions: string[]): undefined {
    this.events.push({ kind: "prompt", call: { method, message, actions } });
    return undefined;
  }

  private other(method: OtherPromptCall["method"]): void {
    this.events.push({ kind: "prompt", call: { method } });
  }
}

// ---------- fixtures ----------

/** The E25 argv of each call; used only to pick the scenario rule. */
function pushArgv(root: string, o: { message?: string; paths?: string[] }): string[] {
  return [
    "push", "--json", "--yes", "--root", root,
    ...(o.message ? ["-m", o.message] : []),
    ...(o.paths !== undefined && o.paths.length > 0 ? ["--", ...o.paths] : []),
  ];
}

function pullArgv(root: string): string[] {
  return ["pull", "--json", "--root", root];
}

function resolveArgv(root: string, relPath: string, strategy: ResolveStrategy, o?: { ifServerSha?: string }): string[] {
  return ["resolve", relPath, `--${strategy}`, "--json", "--root", root, ...(o?.ifServerSha ? ["--if-server-sha", o.ifServerSha] : [])];
}

/**
 * The ICtxCli result of the scenario rule for argv: exit 0 -> the parsed stdout document
 * (push: {doc}); push exit 6 -> {doc, conflict: the stderr envelope}; any other exit ->
 * throws CtxError.fromProcess(stderr, exit). A missing rule throws a plain Error.
 */
function fixtureAnswer(scenario: string, argv: string[]): unknown {
  const out = scenarioOutput(scenario, argv);
  if (out === undefined) { throw new Error(`scenario ${scenario} has no rule for ctx ${argv.join(" ")}`); }
  if (argv[0] === "push" && out.exit === 0) { return { doc: JSON.parse(out.stdout) as PushDoc } satisfies PushOutcome; }
  if (argv[0] === "push" && out.exit === 6) {
    return { doc: JSON.parse(out.stdout) as PushDoc, conflict: parseEnvelope(out.stderr, 6) } satisfies PushOutcome;
  }
  if (out.exit === 0) { return JSON.parse(out.stdout); }
  throw CtxError.fromProcess(out.stderr, out.exit);
}

/**
 * Script cli's push, pull and resolve to answer from the scenario's rules (fixtureAnswer).
 * Each call is logged to rec first, with repo.operation, the time and rec.probe(), and
 * yields one macrotask before answering, so calls made in parallel would overlap
 * (rec.maxInflight > 1).
 */
function answerFromFixtures(cli: FakeCtxCli, scenario: string, rec: Recorder, repo: FakeRepository): void {
  const answer = async (method: CliMethod, args: unknown[], argv: string[]): Promise<unknown> => {
    rec.events.push({ kind: "cli", method, args, operation: repo.operation, at: Date.now(), probe: rec.probe?.() });
    rec.inflight++;
    rec.maxInflight = Math.max(rec.maxInflight, rec.inflight);
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      return fixtureAnswer(scenario, argv);
    } finally {
      rec.inflight--;
    }
  };
  cli.setHandler("push", async (r, opts) => (await answer("push", [r, opts], pushArgv(r, opts))) as PushOutcome);
  cli.setHandler("pull", async (r) => (await answer("pull", [r], pullArgv(r))) as PullDoc);
  cli.setHandler("resolve", async (r, relPath, strategy, opts) =>
    (await answer("resolve", [r, relPath, strategy, opts], resolveArgv(r, relPath, strategy, opts))) as ResolveDoc);
}

/** A FakeCtxCli answering from the scenario's rules, outside any test harness (fixture checks). */
function fixtureCli(scenario: string, root: vscode.Uri): FakeCtxCli {
  const cli = new FakeCtxCli({ scenario });
  answerFromFixtures(cli, scenario, new Recorder(), fakeRepository({ root }));
  return cli;
}

/** pushPlan's contract, restated for fixture checks: modified and new pages in status order. */
function plannedPaths(status: StatusDoc): string[] {
  return status.pages.filter((p) => p.state === "modified" || p.state === "new").map((p) => p.path);
}

/** A rejection check for assert.rejects: a CtxError with this code and exit code. */
function ctxError(code: string, exitCode: number, more: (err: CtxError) => boolean = () => true): (err: unknown) => boolean {
  return (err) => err instanceof CtxError && err.code === code && err.exitCode === exitCode && more(err);
}

/** A scenario file parsed as JSON (for StatusDocs that no rule serves, e.g. e7-dirty/status-unchanged.json). */
function scenarioJson<T>(scenario: string, file: string): T {
  return JSON.parse(fs.readFileSync(path.join(scenarioDir(scenario), file), "utf8")) as T;
}

/** details of the distill_required envelope e7-distill-required (and e7-blocked) answer push with. */
function distillDetails(): DistillRequiredDetails {
  const stderr = fs.readFileSync(path.join(scenarioDir("e7-distill-required"), "distill_required.stderr"), "utf8");
  const details = parseEnvelope(stderr, 9).error.details as DistillRequiredDetails | undefined;
  assert.ok(details, "e7-distill-required/distill_required.stderr has details");
  return details;
}

function pageOf(status: StatusDoc | undefined, relPath: string): PageEntry {
  const page = status?.pages.find((p) => p.path === relPath);
  assert.ok(page, `${relPath} is in the status`);
  return page;
}

/** page.remote.sha in a scenario's online StatusDoc. */
function remoteSha(scenario: string, relPath: string): string {
  const sha = pageOf(loadStatusDoc(scenario), relPath).remote?.sha;
  assert.ok(sha, `${scenario}: ${relPath} has remote.sha`);
  return sha;
}

/** A clone of e7-ready's status whose pages are exactly n modified pages (sorted, valid entries). */
function bulkStatus(n: number): StatusDoc {
  const doc = structuredClone(loadStatusDoc("e7-ready"));
  const sha = "0123456789abcdef0123456789abcdef01234567";
  doc.pages = Array.from({ length: n }, (_, i): PageEntry => {
    const slug = `bulk-${String(i).padStart(3, "0")}`;
    const relPath = `wiki/concepts/${slug}.md`;
    return {
      path: relPath, state: "modified", type: "concept", slug, title: `Bulk ${i}`, tags: [],
      local: { file: relPath, hash: `sha256:${"1".repeat(64)}` },
      base: { sha, hash: `sha256:${"2".repeat(64)}`, synced_at: "2026-10-15T09:00:00Z", stale: false },
      remote: { sha },
      notes: [],
    };
  });
  doc.counts = {
    unchanged: 0, modified: n, new: 0, incoming: 0, incoming_new: 0, conflict: 0, deleted_local: 0, invalid: 0, unverified: 0,
    ahead: n, behind: 0,
  };
  doc.warnings = [];
  return doc;
}

/**
 * Resolves once reached() holds for doc: checked now, then again on every
 * onDidChangeTextDocument of doc (content and dirty-state changes both fire it). Rejects if
 * doc closes first, i.e. it is not the document the edit went to. No timer: an edit that
 * applyEdit resolved true for has already been synced to doc, so this normally resolves at
 * once; mocha's timeout is the only backstop.
 */
function documentState(doc: vscode.TextDocument, reached: () => boolean, what: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const subscriptions: vscode.Disposable[] = [];
    const settle = (err?: Error): void => {
      for (const s of subscriptions.splice(0)) { s.dispose(); }
      if (err) { reject(err); } else { resolve(); }
    };
    const check = (): void => { if (reached()) { settle(); } };
    subscriptions.push(
      vscode.workspace.onDidChangeTextDocument((e) => { if (e.document === doc) { check(); } }),
      vscode.workspace.onDidCloseTextDocument((d) => {
        if (d === doc) { settle(new Error(`${what}: ${doc.uri.fsPath} closed first (a stale TextDocument)`)); }
      }),
    );
    if (doc.isClosed) { settle(new Error(`${what}: ${doc.uri.fsPath} is closed (a stale TextDocument)`)); return; }
    check();
  });
}

/** No prompt anywhere offers to bypass distillation (D4). */
function assertNoDistillBypass(rec: Recorder): void {
  for (const call of rec.prompted()) {
    assert.ok(!/no-distill|push anyway/i.test(JSON.stringify(call)), `D4: ${JSON.stringify(call)}`);
  }
}

// ---------- tests ----------

describe("e7 sync commands (WP-1.13)", () => {
  let api: TestApi;
  /** Disposed after each test (SourceControls). */
  const disposables: vscode.Disposable[] = [];
  /** Page files a test edited: reverted, closed and restored to these bytes after it. */
  const touched: { uri: vscode.Uri; original: Buffer }[] = [];

  interface Harness {
    root: vscode.Uri;
    repo: FakeRepository;
    cli: FakeCtxCli;
    rec: Recorder;
  }

  interface SetupOptions {
    /** The repository's initial status (default: the scenario's online StatusDoc). */
    status?: StatusDoc;
    /** confirm() answers in order (default [false]: Cancel). */
    confirm?: boolean[];
    /** Runs after every repo.refresh is logged (e.g. setStatus to model the next ctx status). */
    onRefresh?: (call: { remote: boolean }, repo: FakeRepository) => void;
  }

  function workspaceRoot(): vscode.Uri {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    assert.ok(root, "the integration label opens the basic workspace");
    return root;
  }

  /**
   * One repository over the workspace folder with the scenario's status, a FakeCtxCli
   * answering push/pull/resolve from the scenario's rules, scripted prompts and the
   * shareViaAgent spy; then overrideServices({cli, model}).
   */
  async function setup(scenario: string, o: SetupOptions = {}): Promise<Harness> {
    const root = workspaceRoot();
    const repo = fakeRepository({ root, status: o.status ?? loadStatusDoc(scenario) });
    const cli = new FakeCtxCli({ scenario });
    const rec = new Recorder();
    if (o.confirm) { rec.confirmAnswers = o.confirm; }

    answerFromFixtures(cli, scenario, rec, repo);
    repo.onRefresh = (call) => {
      rec.events.push({ kind: "refresh", remote: call.remote });
      o.onRefresh?.(call, repo);
    };

    const realExecute = vscode.commands.executeCommand;
    sinon.stub(vscode.commands, "executeCommand").callsFake(((id: string, ...args: unknown[]) => {
      if (id === COMMAND_IDS.shareViaAgent) {
        rec.events.push({ kind: "share", args });
        return Promise.resolve(undefined);
      }
      return realExecute.call(vscode.commands, id, ...args);
    }) as typeof vscode.commands.executeCommand);

    await api.hooks.overrideServices({ cli, model: fakeModel({ repositories: [repo] }) });
    api.hooks.setPrompts(rec.prompts);
    return { root, repo, cli, rec };
  }

  /** A real SourceControl over the workspace folder whose input box holds message. */
  function sourceControl(h: Harness, message: string): vscode.SourceControl {
    const sc = vscode.scm.createSourceControl("e7-test", "e7", h.root);
    disposables.push(sc);
    sc.inputBox.value = message;
    return sc;
  }

  /** contexo.push as the SCM input box runs it (acceptInputCommand: the SourceControl is args[0]). */
  async function push(h: Harness, message: string): Promise<vscode.SourceControl> {
    const sc = sourceControl(h, message);
    await vscode.commands.executeCommand(COMMAND_IDS.push, sc);
    return sc;
  }

  /** What an SCM resource-state command receives for relPath. */
  function resourceState(h: Harness, relPath: string): { resourceUri: vscode.Uri } {
    return { resourceUri: h.repo.fileUri(relPath) };
  }

  /** Run a resource command on relPaths as (clicked, selected[]). */
  async function onResources(h: Harness, command: string, relPaths: string[]): Promise<void> {
    const states = relPaths.map((p) => resourceState(h, p));
    await vscode.commands.executeCommand(command, states[0], states);
  }

  /**
   * Show uri in an editor and return that editor's own TextDocument (WP-4.4).
   *
   * Never the document workspace.openTextDocument(uri) returns: it answers from the extension
   * host's cache, which can still hold a document whose model the renderer is disposing (its
   * last editor just closed: e7-stale's diff, then the previous test's closeActiveEditor).
   * Showing that document opens a NEW model for the uri, the WorkspaceEdit (applied by uri)
   * lands there, and the cached document closes unchanged: 'rate-limits.md is dirty' could
   * never come true (the D5 flake, which c8edea2's bounded wait could not fix).
   */
  async function showPage(uri: vscode.Uri): Promise<vscode.TextDocument> {
    const doc = (await vscode.window.showTextDocument(uri)).document;
    assert.equal(doc.isClosed, false, `the editor of ${uri.fsPath} shows an open document`);
    return doc;
  }

  /** Open <root>/.contexo/<relPath> in an editor and append UNSAVED_MARKER without saving. */
  async function dirtyPage(h: Harness, relPath: string): Promise<vscode.TextDocument> {
    const uri = h.repo.fileUri(relPath);
    touched.push({ uri, original: fs.readFileSync(uri.fsPath) });
    const doc = await showPage(uri);
    const edit = new vscode.WorkspaceEdit();
    edit.insert(uri, doc.positionAt(doc.getText().length), UNSAVED_MARKER);
    assert.equal(await vscode.workspace.applyEdit(edit), true, "the edit applies");
    await documentState(doc, () => doc.isDirty && doc.getText().endsWith(UNSAVED_MARKER), `${relPath} is dirty`);
    return doc;
  }

  function onDisk(h: Harness, relPath: string): string {
    return fs.readFileSync(h.repo.fileUri(relPath).fsPath, "utf8");
  }

  before(async () => {
    api = await activateExtension();
  });

  afterEach(async () => {
    sinon.restore();
    for (const d of disposables.splice(0)) { d.dispose(); }
    for (const t of touched.splice(0)) {
      // Restore through the document, never by writing the file behind VS Code's back: a
      // cached TextDocument would then be older than the disk, and the next test's save
      // (or edit) of the same page fails with a 'file is newer' conflict.
      const original = t.original.toString("utf8");
      const doc = await showPage(t.uri);
      if (doc.getText() !== original) {
        const edit = new vscode.WorkspaceEdit();
        edit.replace(t.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), original);
        assert.equal(await vscode.workspace.applyEdit(edit), true, `restore ${t.uri.fsPath}`);
        await documentState(doc, () => doc.isDirty && doc.getText() === original, `${t.uri.fsPath} holds the original text`);
      }
      if (doc.isDirty) { assert.equal(await doc.save(), true, `save ${t.uri.fsPath}`); }
      await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
      assert.ok(fs.readFileSync(t.uri.fsPath).equals(t.original), `${t.uri.fsPath} is restored on disk`);
    }
    // No editor outlives its test: e.g. e7-stale's re-opened Base <-> Local diff of
    // rate-limits.md would otherwise stay open into the dirty-guard tests and the next suite.
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    await api.hooks.resetServices();
  });

  describe("e7 harness", () => {
    it("the test and the extension share one vscode API object: a sinon spy on vscode.commands.registerCommand sees every contexo.* registration of overrideServices", async () => {
      const spy = sinon.spy(vscode.commands, "registerCommand");
      await setup("e7-ready");
      const registered = spy.getCalls().map((c) => c.args[0]);
      for (const id of ALL_COMMAND_IDS) {
        assert.ok(registered.includes(id), `${id} was registered through the namespace object the test patched`);
      }
    });

    it("the e7 StatusDocs plan and block as these tests assume", () => {
      assert.deepEqual(plannedPaths(loadStatusDoc("e7-ready")), MIXED_PLAN);
      const blocked = loadStatusDoc("e7-blocked").captures;
      assert.deepEqual([blocked.blocks_push, blocked.fresh], [true, 1]);
      assert.equal(loadStatusDoc("e7-distill-required").captures.blocks_push, false);
      assert.deepEqual(plannedPaths(loadStatusDoc("e7-push-conflict")), [...MIXED_PLAN, RATE_LIMITS]);
      assert.equal(pageOf(loadStatusDoc("e7-pull-skipped"), RATE_LIMITS).state, "unchanged", "only auth-flow keeps a local edit");
      for (const scenario of ["e7-resolve", "e7-stale"]) {
        const conflicts = loadStatusDoc(scenario).pages.filter((p) => p.state === "conflict");
        assert.deepEqual(conflicts.map((p) => p.path), [RATE_LIMITS, RETRY_POLICY]);
        assert.ok(conflicts.every((p) => p.remote?.sha !== undefined), `${scenario}: every conflict has remote.sha`);
        assert.equal(pageOf(loadStatusDoc(scenario), OLD_NAME).state, "deleted_local");
      }
      const noAuth = loadStatusDoc("e7-not-authenticated");
      assert.ok(plannedPaths(noAuth).length > 0 && !noAuth.captures.blocks_push, "e7-not-authenticated reaches ctx push");
      assert.deepEqual(plannedPaths(scenarioJson<StatusDoc>("e7-dirty", "status-unchanged.json")), []);
      assert.deepEqual(plannedPaths(scenarioJson<StatusDoc>("e7-dirty", "status-after-save.json")), [RATE_LIMITS]);
    });

    it("FakeCtxCli answers from the e7 rules as ICtxCli does: exit 0 docs, push exit 6 {doc, conflict}, CtxError otherwise", async () => {
      const uri = workspaceRoot();
      const root = uri.fsPath;
      const sha = (scenario: string, p: string): { ifServerSha: string } => ({ ifServerSha: remoteSha(scenario, p) });

      const ready = fixtureCli("e7-ready", uri);
      const pushed = await ready.push(root, { message: "m", paths: MIXED_PLAN });
      assert.equal(pushed.conflict, undefined);
      assert.deepEqual(pushed.doc.pushed.map((p) => p.path), MIXED_PLAN);
      const upToDate = await ready.pull(root);
      assert.deepEqual([upToDate.written, upToDate.adopted, upToDate.skipped], [[], [], []]);

      const partial = await fixtureCli("e7-push-conflict", uri).push(root, { paths: [...MIXED_PLAN, RATE_LIMITS] });
      assert.deepEqual(partial.doc.pushed.map((p) => p.path), MIXED_PLAN);
      assert.deepEqual(partial.doc.conflicts.map((c) => c.path), [RATE_LIMITS]);
      assert.equal(partial.conflict?.error.code, "conflict");
      assert.deepEqual(partial.conflict?.error.details, { paths: [RATE_LIMITS] });

      const prompt = distillDetails().agent_prompt;
      for (const scenario of ["e7-distill-required", "e7-blocked"]) {
        await assert.rejects(fixtureCli(scenario, uri).push(root, { paths: [AUTH_FLOW] }),
          ctxError("distill_required", 9, (e) => (e.details as DistillRequiredDetails).agent_prompt === prompt), scenario);
      }

      const pulled = await fixtureCli("e7-pull-skipped", uri).pull(root);
      assert.equal(pulled.written.length + pulled.adopted.length, 2);
      assert.deepEqual(pulled.skipped.filter((s) => s.reason === "modified" || s.reason === "conflict").map((s) => s.path), [AUTH_FLOW]);

      const resolve = fixtureCli("e7-resolve", uri);
      for (const p of [RATE_LIMITS, RETRY_POLICY]) {
        for (const strategy of ["theirs", "ours"] as const) {
          const doc = await resolve.resolve(root, p, strategy, sha("e7-resolve", p));
          assert.deepEqual([doc.path, doc.strategy, doc.previous_state, doc.base_sha], [p, strategy, "conflict", remoteSha("e7-resolve", p)]);
        }
      }
      const restored = await resolve.resolve(root, OLD_NAME, "theirs", sha("e7-resolve", OLD_NAME));
      assert.deepEqual([restored.path, restored.previous_state, restored.file_written], [OLD_NAME, "deleted_local", true]);

      const stale = fixtureCli("e7-stale", uri);
      await assert.rejects(stale.resolve(root, RATE_LIMITS, "theirs", sha("e7-stale", RATE_LIMITS)),
        ctxError("stale", 6, (e) => (e.details as { path?: string }).path === RATE_LIMITS));
      assert.equal((await stale.resolve(root, RETRY_POLICY, "theirs", sha("e7-stale", RETRY_POLICY))).path, RETRY_POLICY);

      const busy = fixtureCli("e7-busy", uri);
      for (const call of [() => busy.push(root, { paths: MIXED_PLAN }), () => busy.pull(root), () => busy.resolve(root, RATE_LIMITS, "ours", sha("e7-busy", RATE_LIMITS))]) {
        await assert.rejects(call(), ctxError("busy", 12, (e) => e.retryable));
      }

      const noAuth = fixtureCli("e7-not-authenticated", uri);
      for (const call of [() => noAuth.push(root, { paths: MIXED_PLAN }), () => noAuth.pull(root)]) {
        await assert.rejects(call(), ctxError("not_authenticated", 4, (e) => e.advice.includes("ctx auth login")));
      }

      const dirty = fixtureCli("e7-dirty", uri);
      assert.deepEqual((await dirty.push(root, { paths: [RATE_LIMITS] })).doc.pushed.map((p) => p.path), [RATE_LIMITS]);
      assert.deepEqual((await dirty.pull(root)).written, []);
      assert.equal((await dirty.resolve(root, RATE_LIMITS, "ours", sha("e7-dirty", RATE_LIMITS))).strategy, "ours");
    });
  });

  describe("e7 D4 and push", () => {
    it("e7-blocked (captures.blocks_push=true): push makes no FakeCtxCli.push call, and the modal offers Share via your agent", async () => {
      const h = await setup("e7-blocked");
      const captures = h.repo.status?.captures;
      assert.ok(captures);
      assert.equal(captures.blocks_push, true);

      await push(h, "Share the auth flow");

      assert.deepEqual(h.cli.callsOf("push"), [], "no ctx push");
      assert.equal(h.repo.runCalls.includes("push"), false);
      const confirms = h.rec.confirms();
      assert.equal(confirms.length, 1, "one D4 modal");
      assert.ok(confirms[0]?.message.includes(distillMessage(captures.fresh)), confirms[0]?.message);
      assert.equal(confirms[0]?.options.modal, true);
      assert.equal(confirms[0]?.options.confirmLabel, SHARE_VIA_AGENT_LABEL);
      assert.deepEqual(h.rec.shares(), [], "Cancel shares nothing");
      assertNoDistillBypass(h.rec);
    });

    it("e7-blocked: confirming the D4 modal runs contexo.shareViaAgent with NO argument, and still makes no FakeCtxCli.push call", async () => {
      const h = await setup("e7-blocked", { confirm: [true] });

      await push(h, "Share the auth flow");

      assert.deepEqual(h.rec.shares(), [[]], "shareViaAgent() without arguments");
      assert.deepEqual(h.cli.callsOf("push"), []);
      assertNoDistillBypass(h.rec);
    });

    it("e7-distill-required (CtxError distill_required): the same modal, and executeCommand(shareViaAgent) receives {agentPrompt: details.agent_prompt}", async () => {
      const h = await setup("e7-distill-required", { confirm: [true] });
      const details = distillDetails();
      assert.equal(h.repo.status?.captures.blocks_push, false, "the pre-check passes; ctx refuses");

      await push(h, "Share the auth flow");

      assert.equal(h.cli.callsOf("push").length, 1, "one push, never retried or bypassed");
      const confirms = h.rec.confirms();
      assert.equal(confirms.length, 1, "one D4 modal");
      assert.ok(confirms[0]?.message.includes(distillMessage(details.sessions.length)), confirms[0]?.message);
      assert.equal(confirms[0]?.options.modal, true);
      assert.equal(confirms[0]?.options.confirmLabel, SHARE_VIA_AGENT_LABEL);
      assert.deepEqual(h.rec.shares(), [[{ agentPrompt: details.agent_prompt }]]);
      assertNoDistillBypass(h.rec);
    });

    it("e7-ready: FakeCtxCli.push is called once with root and {message: <input>, paths: [2 planned]}, the push options keys are a subset of {message, paths}, and inputBox.value is cleared", async () => {
      const h = await setup("e7-ready");

      const sc = await push(h, "Document the sync model");

      const calls = h.cli.callsOf("push");
      assert.equal(calls.length, 1);
      const [root, opts] = calls[0] ?? [];
      assert.equal(root, h.root.fsPath);
      assert.deepEqual(opts, { message: "Document the sync model", paths: MIXED_PLAN });
      assert.ok(opts && Object.keys(opts).every((k) => k === "message" || k === "paths"), `keys ${Object.keys(opts ?? {}).join(",")}`);
      assert.equal(sc.inputBox.value, "", "the input box is cleared after a clean push");
      assert.ok(h.rec.notified("Pushed 2 page(s)"), JSON.stringify(h.rec.notifications()));
    });

    it("the message `a \"b\" $(c)\\nd` reaches FakeCtxCli.push unchanged", async () => {
      const h = await setup("e7-ready");
      const message = "a \"b\" $(c)\nd";

      await push(h, message);

      const calls = h.cli.callsOf("push");
      assert.equal(calls.length, 1);
      assert.equal(calls[0]?.[1].message, message);
    });

    it("a 151-page plan passes paths undefined", async () => {
      const h = await setup("e7-ready", { status: bulkStatus(151) });

      await push(h, "Bulk edit");

      const calls = h.cli.callsOf("push");
      assert.equal(calls.length, 1);
      assert.equal(calls[0]?.[1].paths, undefined, "above PUSH_PATHS_MAX ctx pushes every changed page");
      assert.equal(calls[0]?.[1].message, "Bulk edit");
    });

    it("a 150-page plan still passes all 150 paths", async () => {
      const status = bulkStatus(150);
      const h = await setup("e7-ready", { status });

      await push(h, "Bulk edit");

      const calls = h.cli.callsOf("push");
      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0]?.[1].paths, status.pages.map((p) => p.path));
    });

    it("an empty plan says Nothing to push with no push call", async () => {
      const h = await setup("e7-dirty", { status: scenarioJson<StatusDoc>("e7-dirty", "status-unchanged.json") });

      await push(h, "Nothing here");

      assert.deepEqual(h.cli.callsOf("push"), []);
      assert.equal(h.repo.runCalls.includes("push"), false);
      assert.ok(h.rec.notified("Nothing to push"), JSON.stringify(h.rec.notifications()));
      assert.deepEqual(h.rec.confirms(), []);
    });

    it("pushSelected pushes only the selected modified/new pages and makes no blocks_push pre-check (e7-blocked: auth-flow + rate-limits selected -> paths [auth-flow])", async () => {
      const h = await setup("e7-blocked");
      assert.equal(h.repo.status?.captures.blocks_push, true);

      await onResources(h, COMMAND_IDS.pushSelected, [AUTH_FLOW, RATE_LIMITS]);

      const calls = h.cli.callsOf("push");
      assert.equal(calls.length, 1, "ctx push runs despite blocks_push: its distill guard decides");
      assert.equal(calls[0]?.[0], h.root.fsPath);
      assert.deepEqual(calls[0]?.[1].paths, [AUTH_FLOW], "the conflict page is not pushed");
      const pushAt = h.rec.indexOf((e) => e.kind === "cli" && e.method === "push");
      const modalAt = h.rec.indexOf((e) => e.kind === "prompt" && e.call.method === "confirm");
      assert.ok(modalAt > pushAt, "the D4 modal comes only from ctx's distill_required, after the push");
      assert.equal(h.rec.confirms()[0]?.options.confirmLabel, SHARE_VIA_AGENT_LABEL);
      assertNoDistillBypass(h.rec);
    });
  });

  describe("e7 outcomes", () => {
    it("e7-push-conflict (PushOutcome with conflicts): the warning lists wiki/concepts/rate-limits.md and a remote refresh follows", async () => {
      const h = await setup("e7-push-conflict");

      await push(h, "Tighten the rate limits");

      assert.equal(h.cli.callsOf("push").length, 1);
      const warning = h.rec.notifications().find((n) => n.method === "warn" && n.message.includes(RATE_LIMITS));
      assert.ok(warning, JSON.stringify(h.rec.notifications()));
      assert.ok(warning.actions.includes(SHOW_CONFLICTS_LABEL), `actions ${warning.actions.join(",")}`);
      assert.deepEqual(h.repo.refreshCalls, [{ remote: true }], "repo.run's own refresh, no second one");
      const pushAt = h.rec.indexOf((e) => e.kind === "cli" && e.method === "push");
      const refreshAt = h.rec.indexOf((e) => e.kind === "refresh" && e.remote);
      assert.ok(refreshAt > pushAt, "the remote refresh follows the push");
    });

    it("e7-pull-skipped mentions 1 kept local edit", async () => {
      const h = await setup("e7-pull-skipped");

      await vscode.commands.executeCommand(COMMAND_IDS.pull);

      assert.equal(h.cli.callsOf("pull").length, 1);
      const kept = h.rec.notified("Kept your local edits to 1 page(s)");
      assert.ok(kept, JSON.stringify(h.rec.notifications()));
      assert.ok(kept.actions.includes(SHOW_CHANGES_LABEL), `actions ${kept.actions.join(",")}`);
      assert.ok(h.rec.notified("Pulled 2 page(s)"), JSON.stringify(h.rec.notifications()));
    });

    it("an up-to-date pull says Already up to date", async () => {
      const h = await setup("e7-ready");

      await vscode.commands.executeCommand(COMMAND_IDS.pull);

      assert.equal(h.cli.callsOf("pull").length, 1);
      assert.ok(h.rec.notified("Already up to date"), JSON.stringify(h.rec.notifications()));
      assert.equal(h.rec.notified("Pulled"), undefined);
    });

    it("push and pull both go through repo.run with kinds push and pull", async () => {
      const h = await setup("e7-ready");

      await push(h, "Document the sync model");
      await vscode.commands.executeCommand(COMMAND_IDS.pull);

      assert.deepEqual(h.repo.runCalls.filter((k) => k === "push" || k === "pull"), ["push", "pull"]);
      assert.deepEqual(h.rec.cliCalls().map((c) => [c.method, c.operation]), [["push", "push"], ["pull", "pull"]],
        "each ctx call runs inside its repo.run");
    });
  });

  describe("e7 resolve", () => {
    it('resolveTheirs + Cancel makes no FakeCtxCli.resolve call; Confirm makes one resolve(root, path, "theirs", {ifServerSha: page.remote.sha}) per selected path, sequentially, inside one repo.run("resolve")', async () => {
      const h = await setup("e7-resolve", { confirm: [false, true] });
      const paths = [RATE_LIMITS, RETRY_POLICY];

      await onResources(h, COMMAND_IDS.resolveTheirs, paths);

      assert.deepEqual(h.cli.callsOf("resolve"), [], "Cancel resolves nothing");
      assert.equal(h.repo.runCalls.includes("resolve"), false);
      const [cancelled] = h.rec.confirms();
      assert.ok(cancelled?.message.includes(takeServerMessage(selectionName(paths))), cancelled?.message);
      assert.equal(cancelled?.options.modal, true);
      assert.equal(cancelled?.options.confirmLabel, TAKE_SERVER_LABEL);

      await onResources(h, COMMAND_IDS.resolveTheirs, paths);

      assert.equal(h.rec.confirms().length, 2, "one modal for the whole selection");
      assert.deepEqual(
        h.cli.callsOf("resolve"),
        paths.map((p) => [h.root.fsPath, p, "theirs", { ifServerSha: remoteSha("e7-resolve", p) }]),
      );
      assert.equal(h.repo.runCalls.filter((k) => k === "resolve").length, 1, "one repo.run('resolve')");
      assert.deepEqual(h.rec.cliCalls("resolve").map((c) => c.operation), ["resolve", "resolve"]);
      assert.equal(h.rec.maxInflight, 1, "sequential: never two ctx resolves at once");
    });

    it("resolveOurs passes ours with ifServerSha and no prompt", async () => {
      const h = await setup("e7-resolve");
      const paths = [RATE_LIMITS, RETRY_POLICY];

      await onResources(h, COMMAND_IDS.resolveOurs, paths);

      assert.deepEqual(
        h.cli.callsOf("resolve"),
        paths.map((p) => [h.root.fsPath, p, "ours", { ifServerSha: remoteSha("e7-resolve", p) }]),
      );
      assert.deepEqual(h.rec.confirms(), [], "Keep Mine is non-destructive: no confirmation");
      assert.equal(h.repo.runCalls.filter((k) => k === "resolve").length, 1);
      assert.equal(h.rec.maxInflight, 1);
    });

    it("a multi-selection the SCM view spreads as (state1, state2) resolves every selected page", async () => {
      const h = await setup("e7-resolve");
      const paths = [RATE_LIMITS, RETRY_POLICY];

      await vscode.commands.executeCommand(COMMAND_IDS.resolveOurs, ...paths.map((p) => resourceState(h, p)));

      assert.deepEqual(h.cli.callsOf("resolve").map((a) => a[1]), paths);
      assert.equal(h.repo.runCalls.filter((k) => k === "resolve").length, 1);
    });

    it("restoreServerVersion asks restoreServerMessage(<path>) with Restore Server Version, then resolves theirs with the page's remote.sha", async () => {
      const h = await setup("e7-resolve", { confirm: [true] });
      assert.equal(pageOf(h.repo.status, OLD_NAME).state, "deleted_local");

      await onResources(h, COMMAND_IDS.restoreServerVersion, [OLD_NAME]);

      const confirms = h.rec.confirms();
      assert.equal(confirms.length, 1);
      assert.ok(confirms[0]?.message.includes(restoreServerMessage(selectionName([OLD_NAME]))), confirms[0]?.message);
      assert.equal(confirms[0]?.options.modal, true);
      assert.equal(confirms[0]?.options.confirmLabel, RESTORE_SERVER_LABEL);
      assert.deepEqual(h.cli.callsOf("resolve"), [[h.root.fsPath, OLD_NAME, "theirs", { ifServerSha: remoteSha("e7-resolve", OLD_NAME) }]]);
    });

    it("resolveOurs on a page that is neither conflict nor unverified (incoming retry-policy) makes no resolve call and shows an info", async () => {
      const h = await setup("e7-ready");
      assert.equal(pageOf(h.repo.status, RETRY_POLICY).state, "incoming");

      await onResources(h, COMMAND_IDS.resolveOurs, [RETRY_POLICY]);

      assert.deepEqual(h.cli.callsOf("resolve"), []);
      assert.equal(h.repo.runCalls.includes("resolve"), false);
      const infos = h.rec.notifications().filter((n) => n.method === "info");
      assert.ok(infos.length > 0, "an info explains why nothing was resolved");
      assert.ok(infos.every((n) => !/not implemented/i.test(n.message)), JSON.stringify(infos));
    });

    it("e7-stale triggers a remote refresh and an info message, and other paths still run", async () => {
      const h = await setup("e7-stale", { confirm: [true] });

      await onResources(h, COMMAND_IDS.resolveTheirs, [RATE_LIMITS, RETRY_POLICY]);

      assert.deepEqual(h.cli.callsOf("resolve").map((a) => a[1]), [RATE_LIMITS, RETRY_POLICY], "the stale path does not stop the others");
      const info = h.rec.notifications().find((n) => n.method === "info" && n.message.includes(staleMessage(RATE_LIMITS)));
      assert.ok(info, JSON.stringify(h.rec.notifications()));
      assert.deepEqual(h.repo.refreshCalls, [{ remote: true }], "repo.run's own remote refresh, exactly once");
      const staleAt = h.rec.indexOf((e) => e.kind === "cli" && e.method === "resolve");
      assert.ok(h.rec.indexOf((e) => e.kind === "refresh" && e.remote) > staleAt);
    });

    it("e7-not-authenticated offers Log in", async () => {
      const h = await setup("e7-not-authenticated");

      await push(h, "Share the auth flow");

      assert.equal(h.cli.callsOf("push").length, 1);
      assert.ok(h.rec.notifications().some((n) => n.actions.includes("Log in")), `push: ${JSON.stringify(h.rec.notifications())}`);

      const before = h.rec.notifications().length;
      await vscode.commands.executeCommand(COMMAND_IDS.pull);

      assert.equal(h.cli.callsOf("pull").length, 1);
      const afterPull = h.rec.notifications().slice(before);
      assert.ok(afterPull.some((n) => n.actions.includes("Log in")), `pull: ${JSON.stringify(afterPull)}`);
    });

    it("e7-busy retries exactly once after about 1 s", async function () {
      this.timeout(10_000);
      const h = await setup("e7-busy");

      await push(h, "Share the auth flow");

      const pushes = h.rec.cliCalls("push");
      assert.equal(pushes.length, 2, "one automatic retry, then stop");
      const gap = (pushes[1]?.at ?? 0) - (pushes[0]?.at ?? 0);
      assert.ok(gap >= BUSY_RETRY_MS * 0.9, `retry after ${gap} ms`);
      const busy = h.rec.notified(BUSY_TEXT);
      assert.ok(busy, JSON.stringify(h.rec.notifications()));
      assert.ok(busy.actions.includes("Retry"), `actions ${busy.actions.join(",")}`);
      const secondAt = h.rec.events.indexOf(pushes[1] as E7Event);
      assert.ok(h.rec.indexOf((e) => e.kind === "prompt" && e.call === busy) > secondAt, "[Retry] is offered only after the automatic retry");
      // The one real wait this file allows (busy retry timing): no second automatic retry follows.
      await new Promise<void>((resolve) => setTimeout(resolve, BUSY_RETRY_MS * 1.5));
      assert.equal(h.rec.cliCalls("push").length, 2, "no further automatic retry after [Retry] is offered");
    });
  });

  describe("e7 E27 dirty guard (e7-dirty: an open page with an unsaved WorkspaceEdit)", () => {
    it("pull + Cancel makes no FakeCtxCli.pull call", async () => {
      const h = await setup("e7-dirty");
      const doc = await dirtyPage(h, RATE_LIMITS);

      await vscode.commands.executeCommand(COMMAND_IDS.pull);

      assert.deepEqual(h.cli.callsOf("pull"), []);
      assert.equal(h.repo.runCalls.includes("pull"), false);
      const confirms = h.rec.confirms();
      assert.equal(confirms.length, 1);
      assert.ok(confirms[0]?.message.includes("1 unsaved Contexo page(s)"), confirms[0]?.message);
      assert.equal(confirms[0]?.options.modal, true);
      assert.equal(confirms[0]?.options.confirmLabel, SAVE_ALL_LABEL);
      assert.equal(doc.isDirty, true, "Cancel saves nothing");
      assert.deepEqual(h.repo.refreshCalls, []);
    });

    it("pull + Save All saves the document, then pulls", async () => {
      const h = await setup("e7-dirty", { confirm: [true] });
      const doc = await dirtyPage(h, RATE_LIMITS);
      h.rec.probe = () => ({ dirty: doc.isDirty, saved: onDisk(h, RATE_LIMITS).includes(UNSAVED_MARKER) });

      await vscode.commands.executeCommand(COMMAND_IDS.pull);

      assert.ok(h.rec.confirms()[0]?.message.includes("1 unsaved Contexo page(s)"));
      assert.equal(doc.isDirty, false);
      assert.ok(onDisk(h, RATE_LIMITS).includes(UNSAVED_MARKER), "the edit is on disk");
      const pulls = h.rec.cliCalls("pull");
      assert.equal(pulls.length, 1);
      assert.deepEqual(pulls[0]?.probe, { dirty: false, saved: true }, "saved before ctx pull ran");
      assert.deepEqual(h.repo.refreshCalls[0], { remote: false }, "ensureSaved refreshes after saving");
      assert.ok(h.rec.indexOf((e) => e.kind === "refresh" && !e.remote) < h.rec.indexOf((e) => e.kind === "cli"));
    });

    it("push + Save All refreshes the status before planning", async () => {
      const afterSave = scenarioJson<StatusDoc>("e7-dirty", "status-after-save.json");
      const h = await setup("e7-dirty", {
        status: scenarioJson<StatusDoc>("e7-dirty", "status-unchanged.json"),
        confirm: [true],
        onRefresh: (call, repo) => { if (!call.remote) { repo.setStatus(afterSave); } },
      });
      await dirtyPage(h, RATE_LIMITS);

      await push(h, "Lower the burst ceiling");

      assert.ok(h.rec.confirms()[0]?.message.includes("1 unsaved Contexo page(s)"));
      assert.deepEqual(h.repo.refreshCalls[0], { remote: false });
      const calls = h.cli.callsOf("push");
      assert.equal(calls.length, 1, "the freshly saved page is planned");
      assert.deepEqual(calls[0]?.[1].paths, [RATE_LIMITS]);
      assert.equal(h.rec.notified("Nothing to push"), undefined);
      assert.ok(h.rec.indexOf((e) => e.kind === "refresh" && !e.remote) < h.rec.indexOf((e) => e.kind === "cli"));
    });

    it("resolveTheirs on the dirty target is refused with no resolve call", async () => {
      const h = await setup("e7-dirty", { confirm: [true] });
      const doc = await dirtyPage(h, RATE_LIMITS);

      await onResources(h, COMMAND_IDS.resolveTheirs, [RATE_LIMITS]);

      assert.deepEqual(h.cli.callsOf("resolve"), []);
      assert.equal(h.repo.runCalls.includes("resolve"), false);
      const refusal = h.rec.notifications().find((n) => n.method === "warn" && n.message.includes("Save or revert") && n.message.includes(RATE_LIMITS));
      assert.ok(refusal, JSON.stringify(h.rec.notifications()));
      assert.deepEqual(h.rec.confirms(), [], "refused before the Take Server Version modal");
      assert.equal(doc.isDirty, true, "the guard never saves for theirs");
    });

    it("resolveOurs on a dirty target is not blocked", async () => {
      const h = await setup("e7-dirty");
      const doc = await dirtyPage(h, RATE_LIMITS);

      await onResources(h, COMMAND_IDS.resolveOurs, [RATE_LIMITS]);

      assert.deepEqual(h.cli.callsOf("resolve"), [[h.root.fsPath, RATE_LIMITS, "ours", { ifServerSha: remoteSha("e7-dirty", RATE_LIMITS) }]]);
      assert.deepEqual(h.rec.confirms(), []);
      assert.equal(doc.isDirty, true);
    });
  });
});
