// Helpers for the Extension Host scenarios (WP-3.1): alice's pages on disk, bob through
// runCtx, a spy on the live ICtxCli (every ctx call the extension makes, with its result), the
// E15 activity check and bounded "quiet" waits. Tests may read .contexo/.sync; src never does.
import * as assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { COMMAND_IDS } from "../../src/commands/ids";
import type { PageEntry, PullDoc, PushDoc, StatusDoc } from "../../src/contract/types";
import type { IRepository } from "../../src/model/types";
import type { TestApi } from "../../src/testApi";
import { ctxArgv } from "./argv";
import { EXT_VERSION, lastStderrLine, runCtx, type CtxRun } from "./ctx";
import { realCtxEnv } from "./env";
import { waitFor } from "./waitFor";

// ---------- pages on disk ----------

/** <root>/.contexo/<rel> */
export function pageFile(root: string, rel: string): string {
  return path.join(root, ".contexo", ...rel.split("/"));
}

export function writePage(root: string, rel: string, text: string | Buffer): void {
  const file = pageFile(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

export function readPage(root: string, rel: string): Buffer {
  return fs.readFileSync(pageFile(root, rel));
}

/** Append a paragraph to a page body (the result stays in Normalize form: '\n<line>\n'). */
export function appendParagraph(root: string, rel: string, line: string): void {
  fs.appendFileSync(pageFile(root, rel), `\n${line}\n`);
}

/** The base snapshot ctx keeps: <root>/.contexo/.sync/base/<rel> (tests only, D1). */
export function baseBytes(root: string, rel: string): Buffer {
  return fs.readFileSync(path.join(root, ".contexo", ".sync", "base", ...rel.split("/")));
}

/** Files under <root>/.contexo/.sync/backup/ whose name is '<basename of rel>.<stamp>' (resolve --theirs backups). */
export function backupsOf(root: string, rel: string): string[] {
  const dir = path.join(root, ".contexo", ".sync", "backup", ...rel.split("/").slice(0, -1));
  const name = rel.split("/").pop() as string;
  if (!fs.existsSync(dir)) { return []; }
  return fs.readdirSync(dir).filter((f) => f.startsWith(`${name}.`)).map((f) => path.join(dir, f));
}

export function sha256(b: Buffer | Uint8Array): string {
  return crypto.createHash("sha256").update(b).digest("hex");
}

/** True for a path whose file name starts with '<prefix>-' (the scenario's own pages). */
export function ofScenario(prefix: string): (p: { path: string }) => boolean {
  return (p) => (p.path.split("/").pop() ?? "").startsWith(`${prefix}-`);
}

/** RFC 3339 in whole seconds, UTC (E16). */
export function nowRfc3339(): string {
  return new Date().toISOString().replace(/\.\d+Z$/, "Z");
}

// ---------- ctx as a user (runCtx: the extension's spawn rules, E25/E26) ----------

function describe(r: CtxRun): string {
  return `ctx ${r.args.join(" ")} exited ${r.code}; stderr: ${lastStderrLine(r.stderr)}`;
}

/** Run ctx as the user of `home` and parse its stdout JSON; asserts the exit code (default 0). */
export async function ctxJson<T>(home: string, args: readonly string[], o: { exit?: number } = {}): Promise<T> {
  const r = await runCtx(home, args);
  assert.equal(r.code, o.exit ?? 0, describe(r));
  return JSON.parse(r.stdout) as T;
}

/** `ctx status --json --root <root>` (+ --offline) as the user of `home`. */
export function statusAs(home: string, root: string, o: { offline?: boolean } = {}): Promise<StatusDoc> {
  return ctxJson<StatusDoc>(home, ctxArgv.status(root, o.offline === true));
}

/** `ctx show <rel> --at <ref> --root <root>`: the raw bytes (asserts exit 0 and an empty stderr). */
export async function showAs(home: string, root: string, rel: string, ref: string): Promise<Buffer> {
  const r = await runCtx(home, ctxArgv.show(root, rel, ref));
  assert.equal(r.code, 0, describe(r));
  assert.equal(r.stderr, "", `ctx show ${rel} --at ${ref} wrote stderr`);
  return r.stdoutBytes;
}

/** `ctx push --json --yes --root <root> [-m M] -- paths` as the user of `home` (setup and checks). */
export function pushAs(home: string, root: string, paths: string[], message?: string): Promise<PushDoc> {
  return ctxJson<PushDoc>(home, ctxArgv.push(root, { ...(message === undefined ? {} : { message }), paths }));
}

/** `ctx pull --json --root <root>` as the user of `home`. */
export function pullAs(home: string, root: string): Promise<PullDoc> {
  return ctxJson<PullDoc>(home, ctxArgv.pull(root));
}

/** The pages of a status doc that belong to scenario `prefix`. */
export function scenarioPages(doc: StatusDoc, prefix: string): PageEntry[] {
  return doc.pages.filter(ofScenario(prefix));
}

/** path -> state over the pages of scenario `prefix`. */
export function statesOf(doc: StatusDoc, prefix: string): Record<string, string> {
  return Object.fromEntries(scenarioPages(doc, prefix).map((p) => [p.path, p.state]));
}

// ---------- the live ICtxCli spy ----------

export type SpiedMethod = "status" | "show" | "push" | "pull" | "resolve";
const SPIED: readonly SpiedMethod[] = ["status", "show", "push", "pull", "resolve"];

export interface CliCall {
  seq: number;
  method: SpiedMethod;
  args: unknown[];
  start: number;
  end?: number;
  result?: unknown;
  error?: unknown;
}

/**
 * Wraps status/show/push/pull/resolve on the live services.cli object (the model holds the
 * same object, so its statuses are recorded too). Calls are recorded in order with their
 * outcome; restore() puts the prototype methods back.
 */
export class CliSpy {
  readonly calls: CliCall[] = [];
  private readonly restores: (() => void)[] = [];

  constructor(cli: object) {
    const target = cli as Record<string, unknown>;
    for (const method of SPIED) {
      const original = target[method];
      if (typeof original !== "function") { throw new Error(`services.cli.${method} is not a function`); }
      const own = Object.prototype.hasOwnProperty.call(target, method);
      const calls = this.calls;
      target[method] = function spied(...args: unknown[]): unknown {
        const call: CliCall = { seq: calls.length, method, args, start: Date.now() };
        calls.push(call);
        const p = Promise.resolve((original as (...a: unknown[]) => unknown).apply(cli, args));
        p.then((result) => { call.end = Date.now(); call.result = result; }, (error: unknown) => { call.end = Date.now(); call.error = error; });
        return p;
      };
      this.restores.push(() => {
        if (own) { target[method] = original; } else { delete target[method]; }
      });
    }
  }

  /** The number of calls so far (a mark for since()). */
  mark(): number {
    return this.calls.length;
  }

  since(mark: number, method?: SpiedMethod): CliCall[] {
    return this.calls.slice(mark).filter((c) => method === undefined || c.method === method);
  }

  /** Exactly one call of `method` since `mark`. */
  only(mark: number, method: SpiedMethod): CliCall {
    const hits = this.since(mark, method);
    assert.equal(hits.length, 1, `exactly one cli.${method} call since the mark (got ${this.describe(mark)})`);
    return hits[0] as CliCall;
  }

  inFlight(): number {
    return this.calls.filter((c) => c.end === undefined).length;
  }

  /** The calls since mark as text (for failure messages). */
  describe(mark = 0): string {
    return JSON.stringify(this.calls.slice(mark).map((c) => {
      const outcome = c.error !== undefined ? `error ${errorText(c.error)}` : c.end === undefined ? "running" : "ok";
      return `${c.method}(${c.args.filter((a) => typeof a !== "object" || a === null).map((a) => String(a)).join(", ")}${c.method === "status" ? `, offline=${String((c.args[1] as { offline?: boolean } | undefined)?.offline)}` : ""}) ${outcome}`;
    }));
  }

  restore(): void {
    for (const r of this.restores.splice(0).reverse()) { r(); }
  }
}

function errorText(e: unknown): string {
  if (typeof e === "object" && e !== null && "code" in e) {
    const c = e as { code: unknown; exitCode?: unknown; message?: unknown };
    return `${String(c.code)}/${String(c.exitCode)}: ${String(c.message)}`;
  }
  return e instanceof Error ? e.message : String(e);
}

// ---------- the extension's repository ----------

function samePath(a: string, b: string): boolean {
  const fold = process.platform === "darwin" || process.platform === "win32";
  const n = (p: string): string => (fold ? path.resolve(p).toLowerCase() : path.resolve(p));
  return n(a) === n(b);
}

/** alice's repository in the extension (the only workspace folder). */
export function aliceRepo(api: TestApi): IRepository {
  const root = realCtxEnv().alice;
  const repo = api.services.model.repositories.find((r) => samePath(r.root.fsPath, root));
  assert.ok(repo, `no Contexo repository for ${root} (have ${JSON.stringify(api.services.model.repositories.map((r) => r.root.fsPath))})`);
  return repo;
}

/** The extension's status entry for rel (undefined when the status does not list it). */
export function entryOf(api: TestApi, rel: string): PageEntry | undefined {
  return aliceRepo(api).status?.pages.find((p) => p.path === rel);
}

/** The Refresh command (an ONLINE status of every repository); resolves when it has run. */
export async function refreshOnline(): Promise<void> {
  await vscode.commands.executeCommand(COMMAND_IDS.refresh);
}

/**
 * Wait (bounded) until the extension is quiet: no ctx call of the spy in flight, no
 * repository operation, and nothing new for `quietMs` (longer than the 1 s watcher debounce).
 */
export async function quiet(api: TestApi, spy: CliSpy, o: { quietMs?: number; timeoutMs?: number } = {}): Promise<void> {
  const quietMs = o.quietMs ?? 1500;
  let seen = spy.mark();
  let since = Date.now();
  await waitFor(() => {
    const busy = spy.inFlight() > 0 || api.services.model.repositories.some((r) => r.operation !== undefined);
    if (busy || spy.mark() !== seen) {
      seen = spy.mark();
      since = Date.now();
      return false;
    }
    return Date.now() - since >= quietMs;
  }, { timeoutMs: o.timeoutMs ?? 30000, intervalMs: 25, message: `the extension did not go quiet; calls: ${spy.describe(Math.max(0, spy.mark() - 10))}` });
}

/** A SourceControl resource-state-like argument for rel ({resourceUri}), as the SCM view passes it. */
export function resourceOf(api: TestApi, rel: string): { resourceUri: vscode.Uri } {
  return { resourceUri: aliceRepo(api).fileUri(rel) };
}

// ---------- E15: the server's activity feed ----------

export interface ActivityEvent { user_id: string; email: string; action: string; detail?: { paths?: string[]; client?: string }; created_at: number }

/** GET /v1/repos/<repo>/activity with the legacy key (bounded). */
export async function activity(): Promise<{ status: number; events: ActivityEvent[]; raw: string }> {
  const e = realCtxEnv();
  const res = await fetch(`${e.server}/v1/repos/${encodeURIComponent(e.repo)}/activity?limit=500`, {
    headers: { Authorization: `Bearer ${e.key}` },
    signal: AbortSignal.timeout(10000),
  });
  const raw = await res.text();
  let events: ActivityEvent[];
  try {
    events = (JSON.parse(raw) as { events?: ActivityEvent[] }).events ?? [];
  } catch {
    events = [];
  }
  return { status: res.status, events, raw };
}

/**
 * E15: the push of `paths` is attributed to `client`. The legacy server key records no
 * activity rows (handler_activity.go recordActivity returns early for legacy users), so an
 * empty or unreadable feed is a NOTE, never a failure (WP-3.1 Acceptance). When the feed has
 * rows, alice's push of those paths must carry detail.client == client.
 */
export async function checkPushAttribution(scenario: string, paths: readonly string[], client: string): Promise<void> {
  const feed = await activity();
  if (feed.status !== 200) {
    console.log(`NOTE E15: ${scenario}: GET activity with the legacy key answered ${feed.status} (${feed.raw.slice(0, 200)}); attribution to ${client} not checked`);
    return;
  }
  const pushes = feed.events.filter((ev) => ev.action === "push" && (ev.detail?.paths ?? []).some((p) => paths.includes(p)));
  if (feed.events.length === 0 || pushes.length === 0) {
    console.log(`NOTE E15: ${scenario}: the activity feed has ${feed.events.length} event(s) and none for ${paths.join(", ")} (the legacy server key records no activity rows); attribution to ${client} not checked`);
    return;
  }
  assert.ok(pushes.some((ev) => ev.detail?.client === client), `E15: a push of ${paths.join(", ")} is attributed to ${client}: ${JSON.stringify(pushes)}`);
}

/** The X-Contexo-Client the extension sends (E26: contexo-vscode/<package.json version>). */
export const EXTENSION_CLIENT = `contexo-vscode/${EXT_VERSION}`;
