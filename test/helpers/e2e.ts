// End-to-end helpers (WP-2.3) for the e2e, e2e-stable and e2e-multi labels: the REAL
// extension wiring (real ctx CLI module, real model) spawning the fake ctx
// (test/fake-ctx/fake-ctx.mjs) against the label's private workspace copy under
// .vscode-test/w/<label> (see .vscode-test.mjs).
//
// - openWorkspaceCopy() puts every workspace folder back to its fixture bytes, selects a
//   scenario through <root>/.fake-ctx/current, scripts the prompts (setPrompts), waits for
//   the extension to go quiet, runs one online refresh, and returns a handle whose calls()
//   are the ctx calls made after that point (calls.jsonl is append-only; marks, not truncation).
// - readCalls()/callsSince() read <root>/.fake-ctx/calls.jsonl of every folder plus the
//   FAKE_CTX_CALLS file (`version` has no --root), pairing each call with the end record
//   that FAKE_CTX_TIMESTAMPS=1 adds ({id, end, exit}).
// - A ROOT afterEach (registered when this module first loads, so it covers every test of
//   the run) audits every new calls.jsonl entry: argv exactly per E25 (rebuilt with
//   src/cli/spawn.ts ctxArgv), --root absolute and equal to a workspace folder, E26 env
//   (NO_COLOR=1, CONTEXO_NO_UPDATE_CHECK=1, CONTEXO_CLIENT=contexo-vscode/<package.json
//   version>, no CONTEXO_DISTILL_DISABLE) and no --no-distill. A violation fails that test
//   (this.test.error) without aborting the run.
// - No sleeps: every wait is waitFor/holdsFor with a fixed bound.
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { ctxArgv } from "../../src/cli/spawn";
import type { ResolveStrategy, StatusDoc } from "../../src/contract/types";
import type { IRepository } from "../../src/model/types";
import type { ScmGroupSnapshot, ScmRepoSnapshot, TestApi } from "../../src/testApi";
import type { ConfirmOptions, Prompts } from "../../src/ui/prompts";
import { activateExtension, contexoExtension } from "./activate";
import { REPO_ROOT, WORKSPACES_DIR } from "./fixtures";
import { waitFor, type WaitForOptions } from "./waitFor";

export { waitFor };

// ---------- calls.jsonl ----------

/** One fake-ctx invocation as calls.jsonl records it (timestamps only with FAKE_CTX_TIMESTAMPS). */
export interface CallRecord {
  argv: string[];
  cwd: string;
  env: Record<string, string | null>;
  id?: string;
  /** Date.now() when the fake ctx started. */
  start?: number;
  /** Date.now() when it exited (absent while it is still running). */
  end?: number;
  exit?: number;
  /** The calls file the record came from. */
  file: string;
  /** Index of the call among that file's call lines. */
  index: number;
}

/** Number of call lines per calls file at some point in time. */
export type CallMark = Readonly<Record<string, number>>;

/** fsPaths of the workspace folders, in order. */
export function workspaceRoots(): string[] {
  return (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
}

/** <root>/.fake-ctx/calls.jsonl */
export function callsFileOf(root: string): string {
  return path.join(root, ".fake-ctx", "calls.jsonl");
}

/** The FAKE_CTX_CALLS file of this label (version calls), if set. */
export function versionCallsFile(): string | undefined {
  const f = process.env.FAKE_CTX_CALLS;
  return f !== undefined && f !== "" ? f : undefined;
}

function callFiles(): string[] {
  const files = workspaceRoots().map(callsFileOf);
  const v = versionCallsFile();
  if (v !== undefined) { files.push(v); }
  return files;
}

/** Every call of one calls file, with its end record merged in. */
export function readCallsFile(file: string): CallRecord[] {
  if (!fs.existsSync(file)) { return []; }
  const calls: CallRecord[] = [];
  const byId = new Map<string, CallRecord>();
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (line.trim() === "") { continue; }
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue; // a line being appended right now
    }
    if (Array.isArray(rec.argv)) {
      const call: CallRecord = { ...(rec as unknown as Omit<CallRecord, "file" | "index">), file, index: calls.length };
      calls.push(call);
      if (typeof rec.id === "string") { byId.set(rec.id, call); }
    } else if (typeof rec.id === "string" && typeof rec.end === "number") {
      const call = byId.get(rec.id);
      if (call) {
        call.end = rec.end;
        if (typeof rec.exit === "number") { call.exit = rec.exit; }
      }
    }
  }
  return calls;
}

/** Every recorded call: of one root, or of every workspace folder plus the version calls. */
export function readCalls(root?: string): CallRecord[] {
  const files = root === undefined ? callFiles() : [callsFileOf(root)];
  return sortCalls(files.flatMap(readCallsFile));
}

/** The current number of call lines of every calls file. */
export function mark(): CallMark {
  const m: Record<string, number> = {};
  for (const f of callFiles()) { m[f] = readCallsFile(f).length; }
  return m;
}

/** The calls recorded after `m` (every calls file), in start order. */
export function callsSince(m: CallMark): CallRecord[] {
  return sortCalls(callFiles().flatMap((f) => readCallsFile(f).filter((c) => c.index >= (m[f] ?? 0))));
}

function sortCalls(calls: CallRecord[]): CallRecord[] {
  return calls.sort((a, b) => (a.start ?? 0) - (b.start ?? 0) || a.file.localeCompare(b.file) || a.index - b.index);
}

export const isOnlineStatus = (c: CallRecord): boolean => c.argv[0] === "status" && !c.argv.includes("--offline");
export const isOfflineStatus = (c: CallRecord): boolean => c.argv[0] === "status" && c.argv.includes("--offline");
/** The value after --root, if any. */
export const rootOf = (c: CallRecord): string | undefined => {
  const i = c.argv.indexOf("--root");
  return i >= 0 ? c.argv[i + 1] : undefined;
};

// ---------- scenarios and files ----------

/** Select a fake-ctx scenario for a folder: writes <root>/.fake-ctx/current. */
export function setScenario(root: string, name: string): void {
  fs.mkdirSync(path.join(root, ".fake-ctx"), { recursive: true });
  fs.writeFileSync(path.join(root, ".fake-ctx", "current"), `${name}\n`);
}

/** The scenario <root>/.fake-ctx/current selects ('' when none). */
export function currentScenario(root: string): string {
  const f = path.join(root, ".fake-ctx", "current");
  return fs.existsSync(f) ? fs.readFileSync(f, "utf8").trim() : "";
}

/** The label's copy directory (the parent of FAKE_CTX_CALLS, see .vscode-test.mjs). */
export function copyDir(): string {
  const v = versionCallsFile();
  if (v === undefined) { throw new Error("FAKE_CTX_CALLS is not set: run the e2e labels through .vscode-test.mjs"); }
  return path.dirname(v);
}

/** The committed fixture folder a workspace folder of this label was copied from. */
export function fixtureOf(root: string): string {
  return path.join(WORKSPACES_DIR, path.relative(copyDir(), root));
}

/** <root>/.contexo/<relPath> */
export function pagePath(root: string, relPath: string): string {
  return path.join(root, ".contexo", ...relPath.split("/"));
}

/** Paths a reset never touches: the append-only call log and ctx's own .sync tree. */
function keep(rel: string): boolean {
  const parts = rel.split(path.sep);
  return (parts[0] === ".fake-ctx" && parts[1] === "calls.jsonl") || (parts[0] === ".contexo" && parts[1] === ".sync");
}

/**
 * Make `dst` byte-equal to `src` (files outside keep() only): writes only differing files and
 * deletes extra ones, so a reset of an untouched folder fires no watcher event.
 */
function syncTree(src: string, dst: string, rel = ""): void {
  const here = path.join(dst, rel);
  const want = new Set<string>();
  if (fs.existsSync(path.join(src, rel))) {
    fs.mkdirSync(here, { recursive: true });
    for (const e of fs.readdirSync(path.join(src, rel), { withFileTypes: true })) {
      const r = path.join(rel, e.name);
      want.add(e.name);
      if (keep(r)) { continue; }
      if (e.isDirectory()) {
        if (fs.existsSync(path.join(dst, r)) && !fs.statSync(path.join(dst, r)).isDirectory()) { fs.rmSync(path.join(dst, r), { force: true }); }
        syncTree(src, dst, r);
      } else {
        const bytes = fs.readFileSync(path.join(src, r));
        const target = path.join(dst, r);
        if (fs.existsSync(target) && fs.statSync(target).isDirectory()) { fs.rmSync(target, { recursive: true, force: true }); }
        if (!fs.existsSync(target) || !fs.readFileSync(target).equals(bytes)) { fs.writeFileSync(target, bytes); }
      }
    }
  }
  if (!fs.existsSync(here)) { return; }
  for (const e of fs.readdirSync(here, { withFileTypes: true })) {
    const r = path.join(rel, e.name);
    if (want.has(e.name) || keep(r)) { continue; }
    if (e.isDirectory() && r.split(path.sep).length === 1 && e.name === ".fake-ctx") { continue; }
    fs.rmSync(path.join(dst, r), { recursive: true, force: true });
  }
}

/** Revert every dirty editor (so a reset never races a buffer) and close all editors. */
export async function revertAndCloseEditors(): Promise<void> {
  for (const doc of vscode.workspace.textDocuments) {
    if (!doc.isDirty) { continue; }
    await vscode.window.showTextDocument(doc, { preview: false });
    await vscode.commands.executeCommand("workbench.action.files.revert");
  }
  await vscode.commands.executeCommand("workbench.action.closeAllEditors");
}

// ---------- prompts ----------

export type PromptMethod = "info" | "warn" | "error" | "confirm" | "quickPick" | "inputBox" | "copyToClipboard" | "openExternal";
export interface PromptCall {
  method: PromptMethod;
  /** The message (notifications, confirm), the clipboard text, or the URI string. */
  message: string;
  actions: string[];
  options?: ConfirmOptions;
  /** What the stub answered. */
  answer?: unknown;
  /** Date.now() when the prompt was shown. */
  at: number;
}

/**
 * Scripted, recording Prompts. Notifications resolve undefined (dismissed) unless a
 * respond() rule matches; confirm() answers from `confirmAnswers` (the last one repeats;
 * default [false]); quickPick picks through `pick` (default: nothing); inputBox answers
 * from `inputAnswers`; copyToClipboard records the text (and writes the real clipboard);
 * openExternal records and returns true.
 */
export class E2EPrompts implements Prompts {
  readonly calls: PromptCall[] = [];
  confirmAnswers: boolean[] = [false];
  inputAnswers: (string | undefined)[] = [];
  pick: ((items: readonly vscode.QuickPickItem[]) => vscode.QuickPickItem | undefined) | undefined;
  private readonly rules: { match: string | RegExp; action: string }[] = [];
  private confirmIndex = 0;

  /** Answer the first notification whose message matches with `action`. */
  respond(match: string | RegExp, action: string): this {
    this.rules.push({ match, action });
    return this;
  }

  info(message: string, ...actions: string[]): Promise<string | undefined> { return this.notify("info", message, actions); }
  warn(message: string, ...actions: string[]): Promise<string | undefined> { return this.notify("warn", message, actions); }
  error(message: string, ...actions: string[]): Promise<string | undefined> { return this.notify("error", message, actions); }

  async confirm(message: string, options: ConfirmOptions): Promise<boolean> {
    const answer = this.confirmAnswers[Math.min(this.confirmIndex++, this.confirmAnswers.length - 1)] ?? false;
    this.calls.push({ method: "confirm", message, actions: [options.confirmLabel], options, answer, at: Date.now() });
    return answer;
  }

  async quickPick<T extends vscode.QuickPickItem>(items: readonly T[]): Promise<T | undefined> {
    const answer = this.pick?.(items) as T | undefined;
    this.calls.push({ method: "quickPick", message: "", actions: items.map((i) => i.label), answer, at: Date.now() });
    return answer;
  }

  async inputBox(): Promise<string | undefined> {
    const answer = this.inputAnswers.shift();
    this.calls.push({ method: "inputBox", message: "", actions: [], answer, at: Date.now() });
    return answer;
  }

  async copyToClipboard(text: string): Promise<void> {
    this.calls.push({ method: "copyToClipboard", message: text, actions: [], at: Date.now() });
    await vscode.env.clipboard.writeText(text);
  }

  async openExternal(uri: vscode.Uri): Promise<boolean> {
    this.calls.push({ method: "openExternal", message: uri.toString(), actions: [], answer: true, at: Date.now() });
    return true;
  }

  /** Notifications (info/warn/error) shown so far. */
  notifications(): PromptCall[] {
    return this.calls.filter((c) => c.method === "info" || c.method === "warn" || c.method === "error");
  }

  /** The first prompt call (any method) whose message contains text / matches the RegExp. */
  find(match: string | RegExp, method?: PromptMethod): PromptCall | undefined {
    return this.calls.find((c) => (method === undefined || c.method === method) && matches(c.message, match));
  }

  /** Wait (bounded) until a prompt whose message matches has been shown. */
  waitFor(match: string | RegExp, o: WaitForOptions & { method?: PromptMethod } = {}): Promise<PromptCall> {
    return waitFor(() => this.find(match, o.method), { timeoutMs: o.timeoutMs ?? 10000, message: o.message ?? `a prompt matching ${String(match)}; shown: ${JSON.stringify(this.calls.map((c) => `${c.method}: ${c.message}`))}` });
  }

  private async notify(method: "info" | "warn" | "error", message: string, actions: string[]): Promise<string | undefined> {
    const rule = this.rules.find((r) => matches(message, r.match) && actions.includes(r.action));
    const answer = rule?.action;
    this.calls.push({ method, message, actions, answer, at: Date.now() });
    return answer;
  }
}

function matches(text: string, match: string | RegExp): boolean {
  return typeof match === "string" ? text.includes(match) : match.test(text);
}

// ---------- waiting ----------

/**
 * Poll `pred` for `ms` and fail as soon as it is falsy (a bounded "nothing happens" check;
 * not a sleep: it watches the whole window).
 */
export async function holdsFor(pred: () => boolean, ms: number, message: string): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (!pred()) { throw new Error(`holdsFor: ${message}`); }
    const left = deadline - Date.now();
    if (left <= 0) { return; }
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(50, left)));
  }
}

/**
 * Calls whose fake ctx has not exited yet (timestamped calls only). A process killed by a
 * signal writes no end record, so a call also counts as ended once its pid (the id's first
 * field) is gone.
 */
function running(calls: readonly CallRecord[]): CallRecord[] {
  return calls.filter((c) => c.start !== undefined && c.end === undefined && pidAlive(Number((c.id ?? "").split("-")[0])));
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) { return false; }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Wait (bounded) until the extension is quiet: no repository operation in flight, every
 * started ctx call ended, and no new call for `quietMs` (longer than the 1 s watcher debounce
 * plus file-event latency).
 */
export async function settle(api: TestApi, o: { quietMs?: number; timeoutMs?: number } = {}): Promise<void> {
  const quietMs = o.quietMs ?? 2000;
  let last = JSON.stringify(mark());
  let since = Date.now();
  await waitFor(() => {
    const now = JSON.stringify(mark());
    if (now !== last) {
      last = now;
      since = Date.now();
      return false;
    }
    const busy = api.services.model.repositories.some((r) => r.operation !== undefined) || running(readCalls()).length > 0;
    if (busy) { since = Date.now(); }
    return !busy && Date.now() - since >= quietMs;
  }, { timeoutMs: o.timeoutMs ?? 30000, intervalMs: 50, message: "the extension did not go quiet" });
}

// ---------- the workspace handle ----------

export interface E2EWorkspace {
  api: TestApi;
  /** The first workspace folder (or the one asked for). */
  root: string;
  /** Every workspace folder. */
  roots: string[];
  prompts: E2EPrompts;
  /** Calls before this mark belong to earlier tests and to the reset itself. */
  start: CallMark;
  /** ctx calls made since the handle was returned. */
  calls(): CallRecord[];
  /** The repository of root (default this.root). */
  repo(root?: string): IRepository;
}

/** What the activation that served this run looked like (captured by the first openWorkspaceCopy). */
export interface StartupRecord {
  calls: CallRecord[];
  /** api.hooks.activationTiming() */
  timing: { activateMs: number; activatedAt: number } | undefined;
}

let startup: StartupRecord | undefined;
let originals: { cli: unknown; model: unknown } | undefined;

/** The calls and timing of the run's activation (undefined before the first openWorkspaceCopy). */
export function startupRecord(): StartupRecord | undefined {
  return startup;
}

/**
 * Reset the label's workspace folders to their fixture bytes, select `scenario` (default: the
 * fixture's own .fake-ctx/current) for `root` (default: every folder), restore the original
 * services, script the prompts, settle, run one online refresh of every repository, settle
 * again, and return the handle.
 */
export async function openWorkspaceCopy(o: { scenario?: string; root?: string; scenarios?: Record<string, string> } = {}): Promise<E2EWorkspace> {
  const api = await activateExtension();
  const roots = workspaceRoots();
  assert.ok(roots.length > 0, "the e2e label opens a workspace");
  if (startup === undefined) {
    // The first call in this host: record the activation before any reset adds calls.
    await waitFor(() => readCalls().some((c) => isOnlineStatus(c) && c.end !== undefined), {
      timeoutMs: 30000, message: "the activation's first online status",
    });
    startup = { calls: readCalls(), timing: api.hooks.activationTiming?.() };
    originals = { cli: api.services.cli, model: api.services.model };
  }
  if (originals && (api.services.cli !== originals.cli || api.services.model !== originals.model)) {
    await api.hooks.resetServices();
  }
  const prompts = new E2EPrompts();
  api.hooks.setPrompts(prompts);
  await revertAndCloseEditors();
  for (const r of roots) {
    syncTree(fixtureOf(r), r);
    const wanted = o.scenarios?.[path.basename(r)] ?? (o.root === undefined || samePath(o.root, r) ? o.scenario : undefined);
    if (wanted !== undefined) { setScenario(r, wanted); }
  }
  await settle(api);
  await waitFor(() => api.services.model.state !== "loading", { timeoutMs: 15000, message: "model left loading" });
  await api.services.model.refreshAll({ remote: true });
  await settle(api);
  const start = mark();
  const root = o.root ?? roots[0] as string;
  return {
    api,
    root,
    roots,
    prompts,
    start,
    calls: () => callsSince(start),
    repo: (r = root) => {
      const repo = api.services.model.repositories.find((x) => samePath(x.root.fsPath, r));
      assert.ok(repo, `no repository for ${r}`);
      return repo;
    },
  };
}

/** Wait (bounded) until repo.status satisfies pred, and return it. */
export function waitForStatus(repo: IRepository, pred: (s: StatusDoc) => boolean, o: WaitForOptions = {}): Promise<StatusDoc> {
  return waitFor(() => (repo.status && pred(repo.status) ? repo.status : undefined), { timeoutMs: o.timeoutMs ?? 10000, message: o.message ?? "repository status" });
}

// ---------- snapshots ----------

/** The SCM snapshot of one repository (default: the first). */
export function scmRepo(api: TestApi, root?: string): ScmRepoSnapshot {
  const repos = api.hooks.scmSnapshot?.().repos ?? [];
  const repo = root === undefined ? repos[0] : repos.find((r) => samePath(r.root, root));
  assert.ok(repo, `no SourceControl for ${root ?? "the first folder"} (have ${JSON.stringify(repos.map((r) => r.root))})`);
  return repo;
}

/** relPaths of an SCM group ([] when the group is absent). */
export function groupPaths(repo: ScmRepoSnapshot, id: ScmGroupSnapshot["id"]): string[] {
  return repo.groups.find((g) => g.id === id)?.resources.map((r) => r.relPath) ?? [];
}

/** The SourceControl object of a repository (acceptInputCommand.arguments[0], WP-1.9). */
export function sourceControlOf(api: TestApi, root?: string): vscode.SourceControl {
  const sc = scmRepo(api, root).acceptInputCommand?.arguments?.[0] as vscode.SourceControl | undefined;
  assert.ok(sc && typeof sc === "object" && "inputBox" in sc, "acceptInputCommand passes the SourceControl as arguments[0]");
  return sc;
}

// ---------- the call audit ----------

function samePath(a: string, b: string): boolean {
  const fold = process.platform === "darwin" || process.platform === "win32";
  const n = (p: string): string => (fold ? path.resolve(p).toLowerCase() : path.resolve(p));
  return n(a) === n(b);
}

const HEX = /^[0-9a-fA-F]{7,64}$/;

/** The E25 argv this call should have had, rebuilt from its own operands (undefined: not a known command shape). */
export function expectedArgv(argv: readonly string[]): string[] | undefined {
  const at = (i: number): string => argv[i] ?? "";
  try {
    switch (argv[0]) {
      case "version":
        return argv[1] === "--short" ? ctxArgv.versionShort() : ctxArgv.version();
      case "status":
        return ctxArgv.status(at(3), argv.includes("--offline"));
      case "show":
        return ctxArgv.show(at(5), at(1), at(3));
      case "pull":
        return ctxArgv.pull(at(3));
      case "push": {
        let i = 5;
        let message: string | undefined;
        let paths: string[] | undefined;
        if (argv[i] === "-m") { message = at(i + 1); i += 2; }
        if (argv[i] === "--") { paths = argv.slice(i + 1); }
        return ctxArgv.push(at(4), { ...(message === undefined ? {} : { message }), ...(paths === undefined ? {} : { paths }) });
      }
      case "resolve": {
        const strategy: ResolveStrategy = argv[2] === "--ours" ? "ours" : "theirs";
        const sha = argv[6] === "--if-server-sha" ? at(7) : undefined;
        return ctxArgv.resolve(at(5), at(1), strategy, sha === undefined ? {} : { ifServerSha: sha });
      }
      case "auth":
        return ["auth", "login", "--root", at(3), ...(argv.includes("--no-browser") ? ["--no-browser"] : [])];
      case "init":
        return ["init", "--root", at(2)];
      case "update":
        return argv.length === 1 ? ["update"] : ["update", "--root", at(2)];
      default:
        return undefined;
    }
  } catch {
    return undefined; // ctxArgv refused the operands (bad path, ref or sha)
  }
}

/** Every E25/E26 violation of one recorded call ([] when it conforms). */
export function auditCall(c: CallRecord, o: { roots: readonly string[]; extVersion: string }): string[] {
  const problems: string[] = [];
  const show = JSON.stringify(c.argv);
  const expected = expectedArgv(c.argv);
  if (expected === undefined) {
    problems.push(`unexpected ctx argv ${show}`);
  } else if (JSON.stringify(expected) !== show) {
    problems.push(`argv ${show} is not the E25 argv ${JSON.stringify(expected)}`);
  }
  if (c.argv[0] === "show" && c.argv.includes("--json")) { problems.push(`show passes --json: ${show}`); }
  if (c.argv[0] === "show" && !["base", "server"].includes(c.argv[3] ?? "") && !HEX.test(c.argv[3] ?? "")) { problems.push(`show ref ${String(c.argv[3])}`); }
  if (c.argv[0] === "version" && c.argv.includes("--root")) { problems.push(`version passes --root: ${show}`); }
  if (c.argv[0] !== "version" && !(c.argv[0] === "update" && c.argv.length === 1)) {
    const r = rootOf(c);
    if (r === undefined || !path.isAbsolute(r)) {
      problems.push(`--root is not absolute: ${show}`);
    } else if (!o.roots.some((w) => samePath(w, r))) {
      problems.push(`--root ${r} is not a workspace folder (${JSON.stringify(o.roots)})`);
    }
  }
  if (c.argv.some((a) => a === "--no-distill" || a.startsWith("--no-distill="))) { problems.push(`argv passes --no-distill: ${show}`); }
  if (c.env.NO_COLOR !== "1") { problems.push(`NO_COLOR=${String(c.env.NO_COLOR)} for ${show}`); }
  if (c.env.CONTEXO_NO_UPDATE_CHECK !== "1") { problems.push(`CONTEXO_NO_UPDATE_CHECK=${String(c.env.CONTEXO_NO_UPDATE_CHECK)} for ${show}`); }
  if (c.env.CONTEXO_CLIENT !== `contexo-vscode/${o.extVersion}`) { problems.push(`CONTEXO_CLIENT=${String(c.env.CONTEXO_CLIENT)} for ${show}`); }
  if (Object.prototype.hasOwnProperty.call(c.env, "CONTEXO_DISTILL_DISABLE")) { problems.push(`CONTEXO_DISTILL_DISABLE reached ctx for ${show}`); }
  return problems;
}

/** The extension version CONTEXO_CLIENT must carry (read from the installed package.json, never hard-coded). */
export function extVersion(): string {
  return String((contexoExtension().packageJSON as { version?: unknown }).version);
}

let audited: CallMark | undefined;

/** Audit every call recorded since the previous audit; returns the problems found. */
export function auditNewCalls(): string[] {
  const roots = workspaceRoots();
  const fresh = audited === undefined ? readCalls() : callsSince(audited);
  audited = mark();
  const version = extVersion();
  return fresh.flatMap((c) => auditCall(c, { roots, extVersion: version }));
}

if (typeof afterEach === "function") {
  // Root-level hook (this module is loaded while mocha loads the first test file).
  afterEach(function auditCtxCalls(this: Mocha.Context) {
    const problems = auditNewCalls();
    if (problems.length > 0) {
      const hook = this.test as unknown as { error(err: unknown): void } | undefined;
      hook?.error(new Error(`ctx call audit (E25/E26) failed:\n- ${problems.join("\n- ")}`));
    }
  });
}

/** The repository root REPO_ROOT-relative fixture dir of a scenario (for tests that read scenario files). */
export const SCENARIOS = path.join(REPO_ROOT, "test", "fixtures", "ctx", "scenarios");
