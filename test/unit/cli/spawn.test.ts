// createRunner, spawnEnv and terminalEnv (src/cli/spawn.ts; E25, E26, contract §2). Real
// child processes run `node fake-ctx.mjs` (its calls.jsonl records the argv, cwd and env ctx
// received) in temp roots whose paths contain a space; where timing matters, a fake
// ChildProcess is driven by a fake clock. Plain mocha, no vscode.
import * as assert from "node:assert/strict";
import { spawnSync, type ChildProcess, type SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  MAX_CONCURRENT_READS, READ_CLASSES, clientName, createRunner, defaultSpawnFn, spawnEnv, terminalEnv,
  type CliLogger, type Clock, type CommandClass, type CtxInvocation, type CtxRunner, type ProcessResult,
  type RunRequest, type RunnerDeps, type SpawnFn,
} from "../../../src/cli/spawn";
import { CTX_TIMEOUTS_MS, CtxError, KILL_GRACE_MS } from "../../../src/cli/types";
import { FAKE_CTX, REPO_ROOT, scenarioDir } from "../../helpers/fixtures";
import { waitFor } from "../../helpers/waitFor";

// ---------- harness ----------

const PKG_VERSION = (JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as { version: string }).version;
/** The fake ctx the way Test mode runs it (TestCtxSpec): node + fake-ctx.mjs. */
const NODE_FAKE: CtxInvocation = { command: process.execPath, prefixArgs: [FAKE_CTX] };
const CLASSES = Object.keys(CTX_TIMEOUTS_MS) as CommandClass[];
const POSIX = process.platform !== "win32";

/** Env keys the fake records or reads (and NODE_OPTIONS): stripped from the inherited env so each test sets them. */
const CONTROLLED_ENV = [
  "NO_COLOR", "CONTEXO_NO_UPDATE_CHECK", "CONTEXO_CLIENT", "CONTEXO_DISTILL_DISABLE", "FAKE_CTX_SCENARIO", "FAKE_CTX_CALLS", "NODE_OPTIONS",
];

function baseEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of CONTROLLED_ENV) { delete env[k]; }
  return { ...env, ...extra };
}

interface LogLine { level: "info" | "warn" | "error" | "debug"; message: string; }
class MemoryLog implements CliLogger {
  readonly lines: LogLine[] = [];
  info(message: string): void { this.lines.push({ level: "info", message }); }
  warn(message: string): void { this.lines.push({ level: "warn", message }); }
  error(message: string): void { this.lines.push({ level: "error", message }); }
  debug(message: string): void { this.lines.push({ level: "debug", message }); }
  of(level: LogLine["level"]): string[] { return this.lines.filter((l) => l.level === level).map((l) => l.message); }
}

const temps: string[] = [];
const runners: CtxRunner[] = [];
afterEach(() => {
  for (const r of runners.splice(0)) { r.dispose(); }
});
after(() => {
  for (const dir of temps.splice(0)) { fs.rmSync(dir, { recursive: true, force: true }); }
});

/** A fresh temp dir whose path contains a space and a non-ASCII character. */
function tempDir(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `contexo spawn ${label} é-`));
  temps.push(dir);
  return dir;
}

/** A workspace root (with a space) whose .fake-ctx/current selects `scenario`. */
function rootWith(scenario: string): string {
  const root = path.join(tempDir("root"), "my project");
  fs.mkdirSync(path.join(root, ".fake-ctx"), { recursive: true });
  fs.writeFileSync(path.join(root, ".fake-ctx", "current"), `${scenario}\n`);
  return root;
}

interface Call { argv: string[]; cwd: string; env: Record<string, string | null>; }
function callsIn(file: string): Call[] {
  if (!fs.existsSync(file)) { return []; }
  return fs.readFileSync(file, "utf8").split("\n").filter((l) => l !== "").map((l) => JSON.parse(l) as Call);
}
function callsOf(root: string): Call[] {
  return callsIn(path.join(root, ".fake-ctx", "calls.jsonl"));
}

/** Both sides through realpath: macOS /var -> /private/var, Windows 8.3 short names. */
function samePath(a: string | undefined, b: string): boolean {
  return a !== undefined && fs.realpathSync.native(a) === fs.realpathSync.native(b);
}

function realRunner(o: Partial<RunnerDeps> = {}): { runner: CtxRunner; log: MemoryLog } {
  const log = new MemoryLog();
  const runner = createRunner({ extVersion: PKG_VERSION, log, parentEnv: () => baseEnv(), ...o });
  runners.push(runner);
  return { runner, log };
}

/** A ChildProcess stand-in: the test emits its stdio chunks and its exit. */
class FakeChild extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  pid: number | undefined = 4242;
  readonly signals: string[] = [];
  kill(signal?: NodeJS.Signals | number): boolean {
    this.signals.push(String(signal ?? "SIGTERM"));
    return true;
  }
  out(bytes: Buffer | string): void { this.stdout.emit("data", Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes, "utf8")); }
  err(bytes: Buffer | string): void { this.stderr.emit("data", Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes, "utf8")); }
  /** 'exit', then 'close' (stdio flushed). */
  finish(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.emit("exit", code, signal);
    this.emit("close", code, signal);
  }
}

interface Spawned { command: string; args: string[]; options: SpawnOptions; child: FakeChild; }

/** Timers that fire only when the test advances time. */
class FakeClock implements Clock {
  private t = 0;
  private seq = 0;
  private readonly timers = new Map<number, { at: number; fn: () => void }>();
  setTimeout(fn: () => void, ms: number): unknown {
    const id = ++this.seq;
    this.timers.set(id, { at: this.t + ms, fn });
    return id;
  }
  clearTimeout(handle: unknown): void { this.timers.delete(handle as number); }
  now(): number { return this.t; }
  pending(): number { return this.timers.size; }
  advance(ms: number): void {
    const end = this.t + ms;
    for (;;) {
      let next: [number, { at: number; fn: () => void }] | undefined;
      for (const e of this.timers) {
        if (e[1].at <= end && (next === undefined || e[1].at < next[1].at)) { next = e; }
      }
      if (next === undefined) { break; }
      this.timers.delete(next[0]);
      this.t = next[1].at;
      next[1].fn();
    }
    this.t = end;
  }
}

const INV: CtxInvocation = { command: "/opt/ctx/bin/ctx", prefixArgs: [] };
const R = "/work/my project";

function fakeRunner(o: Partial<RunnerDeps> = {}) {
  const spawned: Spawned[] = [];
  const spawnFn: SpawnFn = (command, args, options) => {
    const child = new FakeChild();
    spawned.push({ command, args, options, child });
    return child as unknown as ChildProcess;
  };
  const clock = new FakeClock();
  const log = new MemoryLog();
  const runner = createRunner({ extVersion: "9.9.9", log, spawnFn, clock, parentEnv: () => ({ PATH: "/usr/bin" }), platform: "linux", ...o });
  runners.push(runner);
  const child = (i: number): FakeChild => {
    const s = spawned[i];
    assert.ok(s, `spawn #${i} happened`);
    return s.child;
  };
  return { runner, spawned, clock, log, child };
}

interface Tracked<T> { state: "pending" | "resolved" | "rejected"; value?: T; error?: unknown; }
function track<T>(p: Promise<T>): Tracked<T> {
  const t: Tracked<T> = { state: "pending" };
  p.then((v) => { t.state = "resolved"; t.value = v; }, (e: unknown) => { t.state = "rejected"; t.error = e; });
  return t;
}

/** Let settled promises run their handlers. */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function ctxErrorOf(t: Tracked<unknown>, label = ""): CtxError {
  assert.equal(t.state, "rejected", `${label} rejected`);
  assert.ok(t.error instanceof CtxError, `${label} rejected with a CtxError, got ${String(t.error)}`);
  return t.error;
}

function resultOf(t: Tracked<ProcessResult>, label = ""): ProcessResult {
  assert.equal(t.state, "resolved", `${label} resolved${t.error === undefined ? "" : ` (rejected: ${String(t.error)})`}`);
  assert.ok(t.value, label);
  return t.value;
}

async function rejection(p: Promise<unknown>): Promise<CtxError> {
  try {
    await p;
  } catch (err) {
    assert.ok(err instanceof CtxError, `a CtxError, got ${String(err)}`);
    return err;
  }
  assert.fail("expected a rejection");
}

type Token = NonNullable<RunRequest["token"]>;
/** A minimal CancellationTokenSource (unit tests have no vscode). */
function tokenSource(): { token: Token; cancel(): void; listeners(): number } {
  const listeners = new Set<(e: unknown) => unknown>();
  const token = {
    isCancellationRequested: false,
    onCancellationRequested: (listener: (e: unknown) => unknown) => {
      listeners.add(listener);
      return { dispose: () => { listeners.delete(listener); } };
    },
  };
  return {
    token,
    cancel: () => {
      if (token.isCancellationRequested) { return; }
      token.isCancellationRequested = true;
      for (const l of [...listeners]) { l(undefined); }
    },
    listeners: () => listeners.size,
  };
}

/** Asserts the pinned info line: ctx <JSON args> cwd=<JSON cwd> exit=<label> <ms>ms. */
function assertLogLine(line: string | undefined, args: readonly string[], cwd: string, exit: string, ms?: number): void {
  const prefix = `ctx ${JSON.stringify(args)} cwd=${JSON.stringify(cwd)} exit=${exit} `;
  assert.ok(line !== undefined, `a log line for ${prefix}`);
  assert.ok(line.startsWith(prefix), `${line}\n  does not start with\n${prefix}`);
  assert.match(line.slice(prefix.length), /^\d+ms$/, line);
  if (ms !== undefined) { assert.equal(line.slice(prefix.length), `${ms}ms`); }
}

// ---------- real processes (node fake-ctx.mjs) ----------

describe("spawn.ts: createRunner against the real fake ctx", () => {
  it("the argument `; rm -rf ~ $(x) \"q\" \\n` reaches fake ctx verbatim", async () => {
    const hostile = "; rm -rf ~ $(x) \"q\" \n";
    assert.ok(hostile.includes("\n"), "the argument contains a real newline");
    const root = rootWith("e1-echo");
    const { runner } = realRunner();
    const args = ["push", "--json", "--yes", "--root", root, "-m", hostile, "--", hostile, "wiki/it's a \"page\" `x` %PATH%.md"];
    const r = await runner.run(NODE_FAKE, { cls: "push", args, cwd: root });
    assert.equal(r.exitCode, 0);
    assert.deepEqual(r.args, args, "ProcessResult.args are the ctx args (prefixArgs excluded)");
    const calls = callsOf(root);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]?.argv, args, "every argument arrives as one verbatim element");
  });

  it("shell:false and windowsHide:true", async () => {
    const root = rootWith("e1-echo");
    const seen: { command: string; args: string[]; options: SpawnOptions }[] = [];
    const spy: SpawnFn = (command, args, options) => {
      seen.push({ command, args, options });
      return defaultSpawnFn(command, args, options);
    };
    const parent = baseEnv({ CONTEXO_E1_MARK: "parent" });
    const { runner } = realRunner({ spawnFn: spy, parentEnv: () => parent });
    const args = ["status", "--json", "--root", root];
    const r = await runner.run(NODE_FAKE, { cls: "status", args, cwd: root });
    assert.equal(r.exitCode, 0);
    assert.equal(seen.length, 1);
    const s = seen[0];
    assert.ok(s);
    assert.equal(s.command, process.execPath);
    assert.deepEqual(s.args, [FAKE_CTX, ...args], "[...prefixArgs, ...args]");
    assert.deepEqual(Object.keys(s.options).sort(), ["cwd", "env", "shell", "stdio", "windowsHide"], "exactly these options");
    assert.equal(s.options.shell, false);
    assert.equal(s.options.windowsHide, true);
    assert.deepEqual(s.options.stdio, ["ignore", "pipe", "pipe"]);
    assert.equal(s.options.cwd, root);
    assert.deepEqual(s.options.env, spawnEnv(parent, PKG_VERSION));
    assert.ok(samePath(callsOf(root)[0]?.cwd, root), "the child ran in cwd");
  });

  it("child env has NO_COLOR=1, CONTEXO_NO_UPDATE_CHECK=1, CONTEXO_CLIENT=contexo-vscode/<package version>", async () => {
    assert.match(PKG_VERSION, /^\d+\.\d+\.\d+/);
    const expected = { NO_COLOR: "1", CONTEXO_NO_UPDATE_CHECK: "1", CONTEXO_CLIENT: `contexo-vscode/${PKG_VERSION}` };
    assert.equal(clientName(PKG_VERSION), expected.CONTEXO_CLIENT);
    const root = rootWith("e1-echo");
    let reads = 0;
    const { runner } = realRunner({
      parentEnv: () => { reads++; return baseEnv({ NO_COLOR: "0", CONTEXO_NO_UPDATE_CHECK: "0", CONTEXO_CLIENT: "spoofed/1.0" }); },
    });
    await runner.run(NODE_FAKE, { cls: "status", args: ["status", "--json", "--root", root], cwd: root });
    // The Test-mode env (TestCtxSpec.env, merged as `extra`) cannot override them either.
    await runner.run({ ...NODE_FAKE, env: { NO_COLOR: "0", CONTEXO_CLIENT: "spoofed/2.0" } }, { cls: "pull", args: ["pull", "--json", "--root", root], cwd: root });
    const calls = callsOf(root);
    assert.equal(calls.length, 2);
    for (const c of calls) { assert.deepEqual(c.env, expected, JSON.stringify(c.argv)); }
    assert.equal(reads, 2, "the parent env is read at every spawn");

    // version has no --root: the fake logs it to FAKE_CTX_CALLS (merged from the invocation env).
    const callsFile = path.join(tempDir("calls"), "calls.jsonl");
    const v = await runner.run(
      { ...NODE_FAKE, env: { FAKE_CTX_SCENARIO: "e1-echo", FAKE_CTX_CALLS: callsFile } },
      { cls: "version", args: ["version", "--json"], cwd: os.homedir() },
    );
    assert.equal(v.exitCode, 0);
    const [call] = callsIn(callsFile);
    assert.deepEqual(call?.argv, ["version", "--json"]);
    assert.deepEqual(call?.env, expected);
    assert.ok(samePath(call?.cwd, os.homedir()), "version runs in the home directory");
  });

  it("CONTEXO_DISTILL_DISABLE=1 set in the parent is absent in the child env", async () => {
    const root = rootWith("e1-echo");
    const { runner } = realRunner({ parentEnv: () => baseEnv({ CONTEXO_DISTILL_DISABLE: "1" }) });
    const args = ["push", "--json", "--yes", "--root", root];
    await runner.run(NODE_FAKE, { cls: "push", args, cwd: root });
    await runner.run({ ...NODE_FAKE, env: { CONTEXO_DISTILL_DISABLE: "1" } }, { cls: "push", args, cwd: root });
    const calls = callsOf(root);
    assert.equal(calls.length, 2);
    for (const c of calls) {
      assert.ok(!("CONTEXO_DISTILL_DISABLE" in c.env), `the child saw ${JSON.stringify(c.env)}`);
      assert.ok(!c.argv.includes("--no-distill"));
    }
  });

  it("a real e1-slow process rejects with timeout at a small injected limit", async () => {
    const { runner, log } = realRunner({ limits: { version: 300 } });
    const started = Date.now();
    const err = await rejection(runner.run(
      { ...NODE_FAKE, env: { FAKE_CTX_SCENARIO: "e1-slow" } },
      { cls: "version", args: ["version", "--json"], cwd: os.homedir() },
    ));
    const ms = Date.now() - started;
    assert.equal(err.code, "timeout");
    assert.ok(ms >= 300 && ms < 2_500, `rejected after ${ms}ms (the scenario sleeps 3000ms)`);
    if (POSIX) { assert.equal(err.exitCode, 143, "ended by our SIGTERM"); }
    const info = log.of("info");
    assert.equal(info.length, 1);
    assertLogLine(info[0], ["version", "--json"], os.homedir(), "timeout");
  });

  it("a nonexistent command, a missing cwd or a NUL byte rejects with spawn_failed", async () => {
    const { runner, log } = realRunner();
    const missing = path.join(tempDir("missing"), "no-such-ctx");
    const noCmd = await rejection(runner.run({ command: missing, prefixArgs: [] }, { cls: "version", args: ["version", "--json"], cwd: os.homedir() }));
    assert.equal(noCmd.code, "spawn_failed");
    assert.equal(noCmd.exitCode, -1);
    const gone = path.join(tempDir("cwd"), "gone");
    const noCwd = await rejection(runner.run(NODE_FAKE, { cls: "status", args: ["status", "--json", "--root", gone], cwd: gone }));
    assert.equal(noCwd.code, "spawn_failed");
    const nul = await rejection(runner.run(NODE_FAKE, { cls: "show", args: ["show", "a\u0000b"], cwd: os.tmpdir() }));
    assert.equal(nul.code, "spawn_failed");
    const info = log.of("info");
    assert.equal(info.length, 3, "a failed spawn is logged too");
    assertLogLine(info[0], ["version", "--json"], os.homedir(), "spawn_failed");
    assertLogLine(info[1], ["status", "--json", "--root", gone], gone, "spawn_failed");
    assertLogLine(info[2], ["show", "a\u0000b"], os.tmpdir(), "spawn_failed");
  });

  it("the info log line has the pinned format for a success, a non-zero exit and a timeout", async () => {
    const echo = rootWith("e1-echo");
    const busy = rootWith("busy");
    const slow = rootWith("e1-slow");
    const { runner, log } = realRunner({ limits: { status: 300 } });
    const okArgs = ["pull", "--json", "--root", echo];
    assert.equal((await runner.run(NODE_FAKE, { cls: "pull", args: okArgs, cwd: echo })).exitCode, 0);
    const busyArgs = ["push", "--json", "--yes", "--root", busy];
    const r = await runner.run(NODE_FAKE, { cls: "push", args: busyArgs, cwd: busy });
    assert.equal(r.exitCode, 12, "a non-zero exit resolves with its ProcessResult");
    const slowArgs = ["status", "--json", "--root", slow];
    assert.equal((await rejection(runner.run(NODE_FAKE, { cls: "status", args: slowArgs, cwd: slow }))).code, "timeout");
    const info = log.of("info");
    assert.equal(info.length, 3, "one info line per finished process");
    assertLogLine(info[0], okArgs, echo, "0");
    assertLogLine(info[1], busyArgs, busy, "12");
    assertLogLine(info[2], slowArgs, slow, "timeout");
    const busyStderr = fs.readFileSync(path.join(scenarioDir("busy"), "busy.stderr"), "utf8");
    assert.equal(r.stderr, busyStderr);
    assert.deepEqual(log.of("debug"), [`ctx stderr: ${busyStderr.trimEnd()}`], "stderr at debug, only when non-empty");
  });

  it("no log line contains stdout bytes or env values", async () => {
    const SECRET = "e1-secret-value-7f3a";
    const clean = rootWith("clean");
    const mixed = rootWith("mixed");
    const { runner, log } = realRunner({ parentEnv: () => baseEnv({ CONTEXO_E1_SECRET: SECRET }) });
    const status = await runner.run({ ...NODE_FAKE, env: { CONTEXO_E1_EXTRA: `${SECRET}-extra` } }, { cls: "status", args: ["status", "--json", "--root", clean], cwd: clean });
    assert.equal(JSON.parse(status.stdout.toString("utf8")).schema, "ctx.status.v1");
    const show = await runner.run(NODE_FAKE, { cls: "show", args: ["show", "wiki/concepts/auth-flow.md", "--at", "base", "--root", mixed], cwd: mixed });
    const page = fs.readFileSync(path.join(scenarioDir("mixed"), "show", "auth-flow.base.md"));
    assert.deepEqual(show.stdout, page, "show bytes are exact");
    const notFound = await runner.run(NODE_FAKE, { cls: "show", args: ["show", "wiki/x.md", "--at", "server", "--root", mixed], cwd: mixed });
    assert.equal(notFound.exitCode, 8);
    const pageLines = page.toString("utf8").split("\n").filter((l) => l.length >= 12);
    assert.ok(pageLines.length > 3);
    assert.equal(log.of("info").length, 3);
    for (const { message } of log.lines) {
      assert.ok(!message.includes(SECRET), `env value leaked: ${message}`);
      assert.ok(!/NO_COLOR|CONTEXO_[A-Z]/.test(message) && !message.includes(clientName(PKG_VERSION)), `env leaked: ${message}`);
      assert.ok(!message.includes("ctx.status.v1") && !message.includes("\"pages\""), `status stdout leaked: ${message}`);
      for (const l of pageLines) { assert.ok(!message.includes(l), `show bytes leaked: ${message}`); }
    }
  });

  it("dispose() kills a real running process and rejects it with cancelled", async () => {
    const slow = rootWith("e1-slow");
    const { runner, log } = realRunner();
    const started = Date.now();
    const p = runner.run(NODE_FAKE, { cls: "status", args: ["status", "--json", "--root", slow], cwd: slow });
    await waitFor(() => callsOf(slow).length === 1, { message: "the fake ctx started" });
    runner.dispose();
    const err = await rejection(p);
    assert.equal(err.code, "cancelled");
    assert.ok(Date.now() - started < 2_500, "SIGTERM ended it well before the scenario's 3000ms");
    assertLogLine(log.of("info")[0], ["status", "--json", "--root", slow], slow, "cancelled");
  });

  it("spawn.ts and parse.ts import without the vscode module", () => {
    // npm run test:unit preloads the vscode stub in-process, so the import check runs in a child node.
    const out = path.resolve(__dirname, "..", "..", "..");
    const files = [
      ["src", "cli", "spawn.js"], ["src", "cli", "parse.js"], ["src", "cli", "capabilities.js"], ["src", "cli", "discovery.js"],
      ["src", "contract", "types.js"],
    ].map((p) => path.join(out, ...p));
    for (const f of files) { assert.ok(fs.existsSync(f), `${f} is compiled`); }
    const script = [
      "const files = JSON.parse(process.argv[1]);",
      "const { createRequire } = require('node:module');",
      "let resolvable = true;",
      "try { createRequire(files[0]).resolve('vscode'); } catch { resolvable = false; }",
      "if (resolvable) { console.error('vscode resolves next to the compiled modules: the check would be vacuous'); process.exit(3); }",
      "const mods = files.map((f) => require(f));",
      "if (typeof mods[0].createRunner !== 'function' || typeof mods[1].docFromResult !== 'function') { process.exit(4); }",
      "if (Object.keys(require.cache).some((k) => /vscodeStub/.test(k))) { process.exit(5); }",
      "console.log('loaded ' + mods.length + ' modules without vscode');",
    ].join("\n");
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.NODE_OPTIONS;
    const r = spawnSync(process.execPath, ["-e", script, JSON.stringify(files)], { cwd: os.tmpdir(), env, encoding: "utf8", timeout: 15_000 });
    assert.equal(r.status, 0, `child node exited ${String(r.status)}:\n${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /loaded 5 modules without vscode/);
  });
});

// ---------- fake ChildProcess + fake clock ----------

describe("spawn.ts: createRunner kill path, limits and queue", () => {
  it("cancel sends SIGTERM, then SIGKILL after 2s, and rejects with cancelled", async () => {
    assert.equal(KILL_GRACE_MS, 2_000);
    const { runner, clock, child, log } = fakeRunner();
    const ts = tokenSource();
    const p = track(runner.run(INV, { cls: "push", args: ["push", "--json"], cwd: R, token: ts.token }));
    await flush();
    const c = child(0);
    clock.advance(1_000);
    assert.deepEqual(c.signals, []);
    ts.cancel();
    assert.deepEqual(c.signals, ["SIGTERM"]);
    clock.advance(KILL_GRACE_MS - 1);
    await flush();
    assert.deepEqual(c.signals, ["SIGTERM"], "no SIGKILL before the grace period");
    assert.equal(p.state, "pending", "waits for the exit or the SIGKILL");
    clock.advance(1);
    await flush();
    assert.deepEqual(c.signals, ["SIGTERM", "SIGKILL"]);
    const err = ctxErrorOf(p);
    assert.equal(err.code, "cancelled");
    assert.equal(err.exitCode, -1, "no exit status yet when SIGKILL was sent");
    assert.equal(ts.listeners(), 0, "the token listener is disposed");
    c.finish(null, "SIGKILL");
    await flush();
    assert.equal(log.of("info").length, 1, "a late exit is not logged again");
    assertLogLine(log.of("info")[0], ["push", "--json"], R, "cancelled", 3_000);
  });

  it("a process that exits after SIGTERM rejects at its exit, without SIGKILL", async () => {
    const { runner, clock, child } = fakeRunner();
    const ts = tokenSource();
    const p = track(runner.run(INV, { cls: "show", args: ["show", "a.md"], cwd: R, token: ts.token }));
    await flush();
    ts.cancel();
    child(0).err("interrupted\n");
    child(0).finish(null, "SIGTERM");
    await flush();
    const err = ctxErrorOf(p);
    assert.equal(err.code, "cancelled");
    assert.equal(err.exitCode, 143);
    assert.equal(err.stderr, "interrupted\n");
    clock.advance(10_000);
    assert.deepEqual(child(0).signals, ["SIGTERM"], "the grace timer was cleared");
    assert.equal(clock.pending(), 0, "no timer left behind");
  });

  it("each class rejects with timeout at its own limit", async () => {
    const limits: Record<CommandClass, number> = { version: 101, statusOffline: 202, status: 303, show: 404, push: 505, pull: 606, resolve: 707 };
    for (const injected of [true, false]) {
      for (const cls of CLASSES) {
        const limit = injected ? limits[cls] : CTX_TIMEOUTS_MS[cls];
        const label = `${cls} (${injected ? "injected" : "default"} ${limit}ms)`;
        const { runner, clock, child } = fakeRunner(injected ? { limits } : {});
        const p = track(runner.run(INV, { cls, args: [cls], cwd: R }));
        await flush();
        const c = child(0);
        clock.advance(limit - 1);
        await flush();
        assert.deepEqual(c.signals, [], `${label}: not killed at limit-1`);
        assert.equal(p.state, "pending", label);
        clock.advance(1);
        assert.deepEqual(c.signals, ["SIGTERM"], `${label}: SIGTERM at the limit`);
        c.finish(null, "SIGTERM");
        await flush();
        const err = ctxErrorOf(p, label);
        assert.equal(err.code, "timeout", label);
        assert.equal(err.exitCode, 143, label);
      }
    }
  });

  it("a timeout escalates to SIGKILL after the grace period", async () => {
    const { runner, clock, child, log } = fakeRunner({ limits: { pull: 50 }, killGraceMs: 300 });
    const p = track(runner.run(INV, { cls: "pull", args: ["pull"], cwd: R }));
    clock.advance(50);
    assert.deepEqual(child(0).signals, ["SIGTERM"]);
    clock.advance(299);
    await flush();
    assert.equal(p.state, "pending");
    clock.advance(1);
    await flush();
    assert.deepEqual(child(0).signals, ["SIGTERM", "SIGKILL"], "the injected killGraceMs");
    assert.equal(ctxErrorOf(p).code, "timeout");
    assertLogLine(log.of("info")[0], ["pull"], R, "timeout", 350);
  });

  it("the timeout starts when the process is spawned, not when it is queued", async () => {
    const { runner, clock, child, spawned } = fakeRunner({ maxConcurrentReads: 1, limits: { show: 100 } });
    const first = track(runner.run(INV, { cls: "show", args: ["show", "a.md"], cwd: R }));
    const second = track(runner.run(INV, { cls: "show", args: ["show", "b.md"], cwd: R }));
    clock.advance(90);
    child(0).finish(0);
    await flush();
    assert.equal(resultOf(first).exitCode, 0);
    assert.equal(spawned.length, 2, "the queued read starts when the slot frees");
    clock.advance(99);
    assert.deepEqual(child(1).signals, [], "90ms in the queue do not count");
    assert.equal(second.state, "pending");
    clock.advance(1);
    assert.deepEqual(child(1).signals, ["SIGTERM"]);
  });

  it("at most 4 concurrent reads; two identical in-flight status calls spawn once; offline and online are not coalesced", async () => {
    assert.equal(MAX_CONCURRENT_READS, 4);
    assert.deepEqual([...READ_CLASSES].sort(), ["show", "status", "statusOffline", "version"]);

    // The read limit, FIFO.
    {
      const { runner, spawned, child } = fakeRunner();
      const readClasses: CommandClass[] = ["show", "version", "status", "statusOffline", "show", "status"];
      const reads = readClasses.map((cls, i) => track(runner.run(INV, { cls, args: [cls, `r${i}`], cwd: R })));
      await flush();
      assert.equal(spawned.length, 4, "4 reads run, 2 queue");
      const writes = (["push", "pull", "resolve"] as const).map((cls) => track(runner.run(INV, { cls, args: [cls], cwd: R })));
      await flush();
      assert.equal(spawned.length, 7, "push/pull/resolve are not held back by the read limit");
      assert.deepEqual(spawned.slice(4).map((s) => s.args[0]), ["push", "pull", "resolve"]);
      child(4).finish(0);
      await flush();
      assert.equal(spawned.length, 7, "a finished write frees no read slot");
      child(1).finish(0);
      await flush();
      assert.equal(spawned.length, 8);
      assert.deepEqual(spawned[7]?.args, ["show", "r4"], "queued reads start FIFO");
      child(0).finish(3);
      await flush();
      assert.equal(spawned.length, 9, "a non-zero exit frees its slot too");
      assert.deepEqual(spawned[8]?.args, ["status", "r5"]);
      for (const i of [2, 3, 5, 6, 7, 8]) { child(i).finish(0); }
      await flush();
      for (const [i, t] of [...reads, ...writes].entries()) { resultOf(t, `call ${i}`); }
    }

    // Coalescing.
    {
      const { runner, spawned, child } = fakeRunner();
      const args = ["status", "--json", "--root", R];
      const a = track(runner.run(INV, { cls: "status", args, cwd: R, coalesce: true }));
      const b = track(runner.run(INV, { cls: "status", args: [...args], cwd: R, coalesce: true }));
      await flush();
      assert.equal(spawned.length, 1, "two identical in-flight status calls spawn once");
      const offline = track(runner.run(INV, { cls: "statusOffline", args: [...args, "--offline"], cwd: R, coalesce: true }));
      await flush();
      assert.equal(spawned.length, 2, "offline and online are not coalesced");
      const otherRoot = track(runner.run(INV, { cls: "status", args: ["status", "--json", "--root", "/other"], cwd: "/other", coalesce: true }));
      const otherEnv = track(runner.run({ ...INV, env: { FAKE_CTX_SCENARIO: "mixed" } }, { cls: "status", args, cwd: R, coalesce: true }));
      const plain = track(runner.run(INV, { cls: "status", args, cwd: R }));
      await flush();
      assert.equal(spawned.length, 4, "another root, another env and a call without coalesce get their own process (one queues)");
      child(0).out("{\"schema\":\"ctx.status.v1\"}\n");
      child(0).finish(0);
      await flush();
      const ra = resultOf(a, "a");
      const rb = resultOf(b, "b");
      assert.deepEqual(rb.stdout, ra.stdout);
      assert.equal(ra.stdout.toString("utf8"), "{\"schema\":\"ctx.status.v1\"}\n");
      assert.equal(spawned.length, 5, "the freed slot starts the queued call");
      const again = track(runner.run(INV, { cls: "status", args, cwd: R, coalesce: true }));
      await flush();
      assert.equal(spawned.length, 5, "queued behind the read limit");
      const again2 = track(runner.run(INV, { cls: "status", args, cwd: R, coalesce: true }));
      await flush();
      for (const i of [1, 2, 3]) { child(i).finish(0); }
      await flush();
      assert.equal(spawned.length, 6, "a call coalesces with a queued identical one: one spawn for both");
      child(4).finish(0);
      child(5).finish(0);
      await flush();
      for (const t of [offline, otherRoot, otherEnv, plain, again, again2]) { resultOf(t); }
      const fresh = track(runner.run(INV, { cls: "status", args, cwd: R, coalesce: true }));
      await flush();
      assert.equal(spawned.length, 7, "after it settled, an identical call spawns again");
      child(6).finish(0);
      await flush();
      resultOf(fresh);
    }
  });

  it("a coalesced caller that cancels rejects alone; the shared process is killed only when every caller cancelled", async () => {
    const { runner, spawned, child, log } = fakeRunner();
    const args = ["status", "--json", "--root", R];
    const ta = tokenSource();
    const tb = tokenSource();
    const a = track(runner.run(INV, { cls: "status", args, cwd: R, coalesce: true, token: ta.token }));
    const b = track(runner.run(INV, { cls: "status", args, cwd: R, coalesce: true, token: tb.token }));
    await flush();
    assert.equal(spawned.length, 1);
    ta.cancel();
    await flush();
    assert.equal(ctxErrorOf(a, "a").code, "cancelled", "the cancelling caller rejects at once");
    assert.equal(ta.listeners(), 0);
    assert.equal(b.state, "pending");
    assert.deepEqual(child(0).signals, [], "the process keeps running for the other caller");
    child(0).out("{}");
    child(0).finish(0);
    await flush();
    assert.equal(resultOf(b, "b").stdout.toString(), "{}");
    assert.equal(tb.listeners(), 0);

    const tc = tokenSource();
    const td = tokenSource();
    const c = track(runner.run(INV, { cls: "status", args, cwd: R, coalesce: true, token: tc.token }));
    const d = track(runner.run(INV, { cls: "status", args, cwd: R, coalesce: true, token: td.token }));
    await flush();
    assert.equal(spawned.length, 2);
    tc.cancel();
    await flush();
    assert.equal(ctxErrorOf(c, "c").code, "cancelled");
    assert.deepEqual(child(1).signals, []);
    td.cancel();
    assert.deepEqual(child(1).signals, ["SIGTERM"], "killed once every caller cancelled");
    const e = track(runner.run(INV, { cls: "status", args, cwd: R, coalesce: true }));
    await flush();
    assert.equal(spawned.length, 3, "a dying process is never joined");
    child(1).finish(null, "SIGTERM");
    await flush();
    assert.equal(ctxErrorOf(d, "d").code, "cancelled");
    child(2).finish(0);
    await flush();
    resultOf(e, "e");
    assert.deepEqual(log.of("info").map((l) => / exit=(\S+) /.exec(l)?.[1]), ["0", "cancelled", "0"], "one line per process");
  });

  it("a token cancelled before the spawn rejects with cancelled without spawning", async () => {
    const { runner, spawned, child, log } = fakeRunner();
    const ts = tokenSource();
    ts.cancel();
    const err = await rejection(runner.run(INV, { cls: "push", args: ["push"], cwd: R, token: ts.token }));
    assert.equal(err.code, "cancelled");
    assert.equal(spawned.length, 0);
    assert.equal(ts.listeners(), 0);
    // Joining an in-flight identical call with a cancelled token neither attaches nor kills it.
    const args = ["status", "--json", "--root", R];
    const live = track(runner.run(INV, { cls: "status", args, cwd: R, coalesce: true }));
    const late = await rejection(runner.run(INV, { cls: "status", args, cwd: R, coalesce: true, token: ts.token }));
    assert.equal(late.code, "cancelled");
    assert.equal(spawned.length, 1);
    assert.deepEqual(child(0).signals, []);
    child(0).finish(0);
    await flush();
    resultOf(live);
    assert.equal(log.of("info").length, 1, "only the process that ran is logged");
  });

  it("a queued call cancelled before it starts never spawns", async () => {
    const { runner, spawned, child } = fakeRunner({ maxConcurrentReads: 1 });
    const first = track(runner.run(INV, { cls: "show", args: ["show", "p0"], cwd: R }));
    const ts = tokenSource();
    const queued = track(runner.run(INV, { cls: "show", args: ["show", "p1"], cwd: R, token: ts.token }));
    const tx = tokenSource();
    const ty = tokenSource();
    const args = ["status", "--json", "--root", R];
    const x = track(runner.run(INV, { cls: "status", args, cwd: R, coalesce: true, token: tx.token }));
    const y = track(runner.run(INV, { cls: "status", args, cwd: R, coalesce: true, token: ty.token }));
    const last = track(runner.run(INV, { cls: "show", args: ["show", "p2"], cwd: R }));
    await flush();
    assert.equal(spawned.length, 1);
    ts.cancel();
    tx.cancel();
    ty.cancel();
    await flush();
    assert.equal(ctxErrorOf(queued, "queued").code, "cancelled", "rejects at once");
    assert.equal(ctxErrorOf(x, "x").code, "cancelled");
    assert.equal(ctxErrorOf(y, "y").code, "cancelled");
    child(0).finish(0);
    await flush();
    resultOf(first);
    assert.equal(spawned.length, 2);
    assert.deepEqual(spawned[1]?.args, ["show", "p2"], "the cancelled calls never spawned");
    child(1).finish(0);
    await flush();
    resultOf(last);
    assert.equal(spawned.length, 2);
  });

  it("dispose() rejects queued and running calls with cancelled, and every later run()", async () => {
    const { runner, spawned, child, log } = fakeRunner({ maxConcurrentReads: 1 });
    const running = track(runner.run(INV, { cls: "show", args: ["show", "p0"], cwd: R }));
    const queued = track(runner.run(INV, { cls: "show", args: ["show", "p1"], cwd: R }));
    const push = track(runner.run(INV, { cls: "push", args: ["push"], cwd: R }));
    await flush();
    assert.equal(spawned.length, 2);
    runner.dispose();
    await flush();
    assert.equal(ctxErrorOf(queued, "queued").code, "cancelled");
    assert.deepEqual(child(0).signals, ["SIGTERM"]);
    assert.deepEqual(child(1).signals, ["SIGTERM"]);
    child(0).finish(null, "SIGTERM");
    child(1).finish(null, "SIGTERM");
    await flush();
    assert.equal(ctxErrorOf(running, "running").code, "cancelled");
    assert.equal(ctxErrorOf(push, "push").code, "cancelled");
    assert.equal(spawned.length, 2, "the queued call never spawned");
    const later = await rejection(runner.run(INV, { cls: "status", args: ["status"], cwd: R }));
    assert.equal(later.code, "cancelled");
    assert.equal(spawned.length, 2);
    runner.dispose();
    assert.equal(log.of("info").length, 2);
  });

  it("stdout bytes are binary-exact across chunks", async () => {
    const { runner, child } = fakeRunner();
    const chunks = [Buffer.from([0xff, 0xfe, 0x00, 0x01]), Buffer.from([0xc3]), Buffer.from([0xa9, 0x0d, 0x0a, 0x80]), Buffer.alloc(0), Buffer.from("tail\n")];
    const p = runner.run(INV, { cls: "show", args: ["show", "a.png"], cwd: R });
    for (const c of chunks) { child(0).out(c); }
    child(0).finish(0);
    const r = await p;
    assert.ok(Buffer.isBuffer(r.stdout));
    assert.deepEqual(r.stdout, Buffer.concat(chunks));
    assert.equal(r.exitCode, 0);
    assert.equal(r.signal, null);
    assert.deepEqual(r.args, ["show", "a.png"]);
    assert.equal(r.stderr, "");
  });

  it("a multibyte stderr character split across chunks decodes correctly", async () => {
    const { runner, child } = fakeRunner();
    const text = "Error: page «café» costs € 3 🚀\n";
    const bytes = Buffer.from(text, "utf8");
    const p = runner.run(INV, { cls: "show", args: ["show", "x.md"], cwd: R });
    for (let i = 0; i < bytes.length; i++) { child(0).err(bytes.subarray(i, i + 1)); }
    child(0).finish(8);
    const r = await p;
    assert.equal(r.stderr, text);
    assert.equal(r.exitCode, 8, "a non-zero exit resolves");
  });

  it("settles on close: output written after 'exit' is still collected", async () => {
    const { runner, child, clock } = fakeRunner();
    const p = track(runner.run(INV, { cls: "pull", args: ["pull"], cwd: R }));
    const c = child(0);
    clock.advance(40);
    c.emit("exit", 0, null);
    await flush();
    assert.equal(p.state, "pending", "not settled on exit");
    c.out("late stdout");
    c.err("late stderr");
    c.emit("close", 0, null);
    await flush();
    const r = resultOf(p);
    assert.equal(r.stdout.toString(), "late stdout");
    assert.equal(r.stderr, "late stderr");
    assert.equal(r.durationMs, 40);
  });

  it("a foreign signal resolves with that signal; the log labels it, cancelled and spawn_failed", async () => {
    const { runner, child, clock, log } = fakeRunner();
    const a = track(runner.run(INV, { cls: "show", args: ["show", "a"], cwd: R }));
    clock.advance(250);
    child(0).finish(null, "SIGHUP");
    await flush();
    const r = resultOf(a);
    assert.equal(r.exitCode, null);
    assert.equal(r.signal, "SIGHUP");
    const ts = tokenSource();
    const b = track(runner.run(INV, { cls: "show", args: ["show", "b"], cwd: R, token: ts.token }));
    clock.advance(5);
    ts.cancel();
    child(1).finish(null, "SIGTERM");
    await flush();
    assert.equal(ctxErrorOf(b).code, "cancelled");
    const info = log.of("info");
    assertLogLine(info[0], ["show", "a"], R, "SIGHUP", 250);
    assertLogLine(info[1], ["show", "b"], R, "cancelled", 5);
  });

  it("a spawn 'error' rejects with spawn_failed once; an error after a successful spawn does not settle", async () => {
    const { runner, child, log } = fakeRunner();
    const failed = track(runner.run(INV, { cls: "version", args: ["version", "--json"], cwd: "/home/dana" }));
    const c = child(0);
    c.pid = undefined;
    c.emit("error", Object.assign(new Error("spawn /opt/ctx/bin/ctx ENOENT"), { code: "ENOENT" }));
    c.emit("close", -2, null);
    await flush();
    const err = ctxErrorOf(failed);
    assert.equal(err.code, "spawn_failed");
    assert.match(err.message, /ENOENT/);
    assertLogLine(log.of("info")[0], ["version", "--json"], "/home/dana", "spawn_failed");
    assert.equal(log.of("info").length, 1, "the trailing close is ignored");

    const ok = track(runner.run(INV, { cls: "pull", args: ["pull"], cwd: R }));
    child(1).emit("error", new Error("kill EPERM"));
    await flush();
    assert.equal(ok.state, "pending", "a running process is still awaited");
    child(1).finish(0);
    await flush();
    resultOf(ok);

    const throwing = createRunner({
      extVersion: "9.9.9", log, clock: new FakeClock(), parentEnv: () => ({}), maxConcurrentReads: 1,
      spawnFn: () => { throw Object.assign(new Error("spawn EINVAL"), { code: "EINVAL" }); },
    });
    runners.push(throwing);
    const sync = await rejection(throwing.run(INV, { cls: "status", args: ["status"], cwd: R }));
    assert.equal(sync.code, "spawn_failed", "a synchronous spawn throw (EINVAL, NUL byte) rejects too");
    const again = track(throwing.run(INV, { cls: "status", args: ["status"], cwd: R }));
    await flush();
    assert.equal(ctxErrorOf(again).code, "spawn_failed", "the failed spawn freed its read slot (not queued)");
  });
});

// ---------- env ----------

describe("spawn.ts: spawnEnv and terminalEnv (E26)", () => {
  it("spawnEnv: {...parent, ...extra} with the E26 keys winning over extra and CONTEXO_DISTILL_DISABLE deleted", () => {
    const parent = { PATH: "/usr/bin", HOME: "/home/dana", NO_COLOR: "0", CONTEXO_CLIENT: "x", CONTEXO_DISTILL_DISABLE: "1", KEEP: "parent" };
    const extra = { KEEP: "extra", FAKE_CTX_SCENARIO: "mixed", NO_COLOR: "0", CONTEXO_NO_UPDATE_CHECK: "0", CONTEXO_CLIENT: "y", CONTEXO_DISTILL_DISABLE: "1" };
    const env = spawnEnv(parent, "1.2.3", extra, "linux");
    assert.deepEqual(env, {
      PATH: "/usr/bin", HOME: "/home/dana", KEEP: "extra", FAKE_CTX_SCENARIO: "mixed",
      NO_COLOR: "1", CONTEXO_NO_UPDATE_CHECK: "1", CONTEXO_CLIENT: "contexo-vscode/1.2.3",
    });
    assert.ok(!("CONTEXO_DISTILL_DISABLE" in env));
    assert.equal(parent.CONTEXO_DISTILL_DISABLE, "1", "the parent is not mutated");
    assert.equal(extra.CONTEXO_DISTILL_DISABLE, "1", "extra is not mutated");
    assert.deepEqual(spawnEnv({}, "1.2.3"), { NO_COLOR: "1", CONTEXO_NO_UPDATE_CHECK: "1", CONTEXO_CLIENT: "contexo-vscode/1.2.3" });
    // POSIX env is case-sensitive: other casings are other variables (ctx never reads them).
    const posix = spawnEnv({ contexo_distill_disable: "1", No_Color: "0" }, "1.2.3", undefined, "darwin");
    assert.equal(posix.contexo_distill_disable, "1");
    assert.equal(posix.No_Color, "0");
  });

  it("spawnEnv on win32 removes case variants such as contexo_distill_disable", () => {
    const parent = {
      Path: "C:\\Windows", contexo_distill_disable: "1", Contexo_Distill_Disable: "1", no_color: "0", Contexo_Client: "spoof",
      contexo_no_update_check: "0", OTHER: "kept",
    };
    const env = spawnEnv(parent, "1.2.3", { CONTEXO_distill_DISABLE: "1", nO_cOlOr: "0", Extra: "e" }, "win32");
    assert.deepEqual(env, {
      Path: "C:\\Windows", OTHER: "kept", Extra: "e", NO_COLOR: "1", CONTEXO_NO_UPDATE_CHECK: "1", CONTEXO_CLIENT: "contexo-vscode/1.2.3",
    });
  });

  it("terminalEnv: {...extra} with the E26 keys winning and CONTEXO_DISTILL_DISABLE null", () => {
    const e26 = { NO_COLOR: "1", CONTEXO_NO_UPDATE_CHECK: "1", CONTEXO_CLIENT: "contexo-vscode/1.2.3", CONTEXO_DISTILL_DISABLE: null };
    assert.deepEqual(terminalEnv("1.2.3"), e26);
    assert.deepEqual(
      terminalEnv("1.2.3", { FAKE_CTX_SCENARIO: "clean", NO_COLOR: "0", CONTEXO_CLIENT: "x", CONTEXO_NO_UPDATE_CHECK: "0", CONTEXO_DISTILL_DISABLE: "1" }),
      { FAKE_CTX_SCENARIO: "clean", ...e26 },
    );
  });
});
