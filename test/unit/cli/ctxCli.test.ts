// createCtxCli wiring (WP-1.7): the handshake gate inside the CLI, E25 argv end to end,
// show 'empty', push widening and exit 6, terminalInvocation, contexo.path changes,
// rediscover and dispose. Plain mocha against the vscode stub; every ctx process is the real
// fake ctx (node test/fake-ctx/fake-ctx.mjs), driven by a Test-mode CONTEXO_TEST_CTX spec or
// by the POSIX shim test/fake-ctx/bin/ctx through contexo.path.
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createCtxCliWith, type CtxCliOptions } from "../../../src/cli/ctxCli";
import { nodeDiscoveryFs, type DiscoveryFs } from "../../../src/cli/discovery";
import { defaultSpawnFn, type SpawnFn } from "../../../src/cli/spawn";
import { CtxError, PUSH_PATHS_MAX, TEST_CTX_ENV, type CtxCliDeps, type ICtxCli, type TestCtxSpec } from "../../../src/cli/types";
import type { ContexoConfig } from "../../../src/services";
import { FAKE_CTX, REPO_ROOT, loadStatusDoc, scenarioDir } from "../../helpers/fixtures";

const EXT_VERSION = "9.9.9-test";
const SHIM = path.join(REPO_ROOT, "test", "fake-ctx", "bin", "ctx");

type LogOutputChannel = CtxCliDeps["log"];
type ExtensionContext = CtxCliDeps["context"];

interface Recorder { lines: string[]; log: LogOutputChannel; }

function recordingLog(): Recorder {
  const lines: string[] = [];
  const at = (level: string) => (m: string): void => { lines.push(`${level} ${m}`); };
  const log = { info: at("info"), warn: at("warn"), error: at("error"), debug: at("debug"), trace: at("trace") };
  return { lines, log: log as unknown as LogOutputChannel };
}

/** A ContexoConfig whose path can be changed; setPath fires onDidChange like a settings edit. */
function fakeConfig(initial?: string): ContexoConfig & { setPath(p: string | undefined): void } {
  let current = initial;
  let listeners: (() => unknown)[] = [];
  const onDidChange = ((l: () => unknown) => {
    listeners.push(l);
    return { dispose: () => { listeners = listeners.filter((x) => x !== l); } };
  }) as unknown as ContexoConfig["onDidChange"];
  return {
    get path() { return current; },
    remoteRefreshEnabled: true,
    remoteRefreshIntervalSeconds: 180,
    scmCountIncoming: false,
    decorationsEnabled: true,
    treeShowSessions: true,
    onDidChange,
    setPath(p) {
      current = p;
      for (const l of [...listeners]) { l(); }
    },
  };
}

const context = { extensionMode: 3, extension: { packageJSON: { version: EXT_VERSION } } } as unknown as ExtensionContext;

interface SpawnCall { command: string; args: string[]; cwd: string | undefined; }

function spawnSpy(): { fn: SpawnFn; calls: SpawnCall[] } {
  const calls: SpawnCall[] = [];
  const fn: SpawnFn = (command, args, options) => {
    calls.push({ command, args: [...args], cwd: typeof options.cwd === "string" ? options.cwd : undefined });
    return defaultSpawnFn(command, args, options);
  };
  return { fn, calls };
}

/** ctx args of a recorded spawn (prefixArgs [FAKE_CTX] stripped in Test mode). */
function ctxArgs(c: SpawnCall): string[] {
  return c.args[0] === FAKE_CTX ? c.args.slice(1) : c.args;
}

/** A temp project root whose fake-ctx scenario is `scenario`. */
function tempRoot(scenario: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wp17-ctxcli-"));
  fs.mkdirSync(path.join(root, ".fake-ctx"), { recursive: true });
  fs.writeFileSync(path.join(root, ".fake-ctx", "current"), `${scenario}\n`);
  return root;
}

function callsOf(root: string): { argv: string[]; env: Record<string, string | null> }[] {
  const file = path.join(root, ".fake-ctx", "calls.jsonl");
  if (!fs.existsSync(file)) { return []; }
  return fs.readFileSync(file, "utf8").split("\n").filter((l) => l !== "")
    .map((l) => JSON.parse(l) as { argv: string[]; env: Record<string, string | null> });
}

/** Test-mode options: the fake ctx through CONTEXO_TEST_CTX; `versionScenario` answers the handshake. */
function testModeOptions(o: { versionScenario?: string; parentEnv?: NodeJS.ProcessEnv; spawnFn?: SpawnFn } = {}): CtxCliOptions {
  const spec: TestCtxSpec = { command: process.execPath, prefixArgs: [FAKE_CTX] };
  if (o.versionScenario !== undefined) { spec.env = { FAKE_CTX_SCENARIO: o.versionScenario }; }
  return {
    testMode: true,
    isTrusted: () => true,
    env: { ...(o.parentEnv ?? process.env), [TEST_CTX_ENV]: JSON.stringify(spec) },
    homedir: () => os.tmpdir(),
    ...(o.spawnFn ? { spawnFn: o.spawnFn } : {}),
  };
}

async function rejectsWith(p: Promise<unknown>, code: string): Promise<CtxError> {
  let caught: unknown;
  try { await p; } catch (err) { caught = err; }
  assert.ok(caught instanceof CtxError, `expected a CtxError ${code}, got ${String(caught)}`);
  assert.equal(caught.code, code, caught.message);
  return caught;
}

describe("createCtxCli wiring", () => {
  const clis: ICtxCli[] = [];
  const roots: string[] = [];
  const make = (o: CtxCliOptions, config: ContexoConfig = fakeConfig(), log = recordingLog()): { cli: ICtxCli; log: Recorder } => {
    const cli = createCtxCliWith({ context, log: log.log, config }, o);
    clis.push(cli);
    return { cli, log };
  };
  const root = (scenario: string): string => {
    const r = tempRoot(scenario);
    roots.push(r);
    return r;
  };

  afterEach(() => {
    for (const c of clis.splice(0)) { c.dispose(); }
    for (const r of roots.splice(0)) { fs.rmSync(r, { recursive: true, force: true }); }
  });

  for (const [scenario, kind] of [["e1-too-old", "tooOld"], ["e1-old-ctx-0.6.6", "tooOld"], ["ctx-contract2", "extensionTooOld"], ["e1-not-ctx", "missing"]] as const) {
    it(`no non-version spawn while the binary is not ok: ${scenario} -> ${kind}, every method rejects spawn_failed`, async () => {
      const spy = spawnSpy();
      const r = root("mixed");
      const { cli } = make(testModeOptions({ versionScenario: scenario, spawnFn: spy.fn }));
      assert.equal((await cli.getBinary()).kind, kind);
      await rejectsWith(cli.status(r, { offline: false }), "spawn_failed");
      await rejectsWith(cli.status(r, { offline: true }), "spawn_failed");
      await rejectsWith(cli.show(r, "wiki/concepts/auth-flow.md", "base"), "spawn_failed");
      await rejectsWith(cli.push(r, { message: "m", paths: ["wiki/concepts/auth-flow.md"] }), "spawn_failed");
      await rejectsWith(cli.pull(r), "spawn_failed");
      await rejectsWith(cli.resolve(r, "wiki/concepts/auth-flow.md", "theirs"), "spawn_failed");
      assert.ok(spy.calls.length > 0, "the handshake ran");
      for (const c of spy.calls) { assert.equal(ctxArgs(c)[0], "version", `only version probes: ${JSON.stringify(c.args)}`); }
      assert.deepEqual(callsOf(r), [], "the fake ctx never saw a call under the project root");
    });
  }

  it("status runs the E25 argv in the root and returns the fixture StatusDoc", async () => {
    const r = root("mixed");
    const spy = spawnSpy();
    const { cli } = make(testModeOptions({ spawnFn: spy.fn }));
    const online = await cli.status(r, { offline: false });
    const offline = await cli.status(r, { offline: true });
    assert.equal(online.pages.length, loadStatusDoc("mixed").pages.length);
    assert.equal(online.captures.pending, loadStatusDoc("mixed").captures.pending);
    assert.equal(offline.offline, true);
    assert.deepEqual(callsOf(r).map((c) => c.argv), [
      ["status", "--json", "--root", r],
      ["status", "--json", "--root", r, "--offline"],
    ]);
    const statusSpawn = spy.calls.find((c) => ctxArgs(c)[0] === "status");
    assert.equal(statusSpawn?.cwd, r, "cwd is the root");
    const versionSpawn = spy.calls.find((c) => ctxArgs(c)[0] === "version");
    assert.equal(versionSpawn?.cwd, os.tmpdir(), "version runs in the home directory");
  });

  it("the spawn env is E26: CONTEXO_CLIENT from the extension version, CONTEXO_DISTILL_DISABLE stripped", async () => {
    const r = root("mixed");
    const { cli } = make(testModeOptions({ parentEnv: { ...process.env, CONTEXO_DISTILL_DISABLE: "1" } }));
    await cli.status(r, { offline: true });
    const [call] = callsOf(r);
    assert.deepEqual(call?.env, { NO_COLOR: "1", CONTEXO_NO_UPDATE_CHECK: "1", CONTEXO_CLIENT: `contexo-vscode/${EXT_VERSION}` });
  });

  it("show returns the raw bytes; the 'empty' ref returns zero bytes without spawning", async () => {
    const r = root("mixed");
    const spy = spawnSpy();
    const { cli } = make(testModeOptions({ spawnFn: spy.fn }));
    const bytes = await cli.show(r, "wiki/concepts/retry-policy.md", "base");
    assert.ok(bytes instanceof Uint8Array);
    assert.deepEqual(Buffer.from(bytes), fs.readFileSync(path.join(scenarioDir("mixed"), "show", "retry-policy.base.md")));
    const spawnsBefore = spy.calls.length;
    const empty = await cli.show(r, "wiki/concepts/new-page.md", "empty");
    assert.equal(empty.byteLength, 0);
    assert.equal(spy.calls.length, spawnsBefore, "'empty' never spawns");
    assert.deepEqual(callsOf(r).map((c) => c.argv), [["show", "wiki/concepts/retry-policy.md", "--at", "base", "--root", r]]);
    await rejectsWith(cli.show(r, "wiki/concepts/none.md", "server"), "page_not_found");
  });

  it("an argument that could be read as a flag is refused before spawning", async () => {
    const r = root("mixed");
    const { cli } = make(testModeOptions());
    await rejectsWith(cli.show(r, "--root=/etc", "base"), "invalid_path");
    await rejectsWith(cli.show(r, "wiki/a.md", "--at=server"), "usage");
    await rejectsWith(cli.resolve(r, "-x.md", "ours"), "invalid_path");
    assert.deepEqual(callsOf(r), []);
  });

  it(`push passes -m and the paths; more than ${PUSH_PATHS_MAX} paths are omitted and the widening is logged`, async () => {
    const r = root("push-success");
    const log = recordingLog();
    const { cli } = make(testModeOptions(), fakeConfig(), log);
    await cli.push(r, { message: "two words", paths: ["wiki/a.md", "wiki/b.md"] });
    await cli.push(r, { message: "", paths: [] });
    const many = Array.from({ length: PUSH_PATHS_MAX + 1 }, (_, i) => `wiki/p${i}.md`);
    await cli.push(r, { paths: many });
    assert.deepEqual(callsOf(r).map((c) => c.argv), [
      ["push", "--json", "--yes", "--root", r, "-m", "two words", "--", "wiki/a.md", "wiki/b.md"],
      ["push", "--json", "--yes", "--root", r],
      ["push", "--json", "--yes", "--root", r],
    ]);
    assert.ok(log.lines.some((l) => /widen/i.test(l) && l.includes(String(PUSH_PATHS_MAX + 1))), log.lines.join("\n"));
  });

  it("push exit 6 resolves a PushOutcome with the conflicts and the conflict envelope", async () => {
    const r = root("push-conflict");
    const { cli } = make(testModeOptions());
    const out = await cli.push(r, { message: "m" });
    assert.ok(out.doc.conflicts.length > 0);
    assert.equal(out.conflict?.error.code, "conflict");
  });

  it("pull and resolve parse their documents; distill_required keeps details.agent_prompt", async () => {
    const { cli } = make(testModeOptions());
    assert.equal((await cli.pull(root("pull-skipped"))).schema, "ctx.pull.v1");
    const theirs = await cli.resolve(root("resolve-theirs"), "wiki/concepts/retry-policy.md", "theirs", { ifServerSha: "f0e1d2c3b4a5968778695a4b3c2d1e0f9a8b7c6d" });
    assert.equal(theirs.strategy, "theirs");
    const err = await rejectsWith(cli.push(root("push-distill-required"), { message: "m" }), "distill_required");
    assert.equal(typeof (err.details as { agent_prompt?: unknown }).agent_prompt, "string");
  });

  it("version() runs version --json for any binary with a path and rejects for a missing one", async () => {
    const ok = make(testModeOptions()).cli;
    assert.equal((await ok.version()).schema, "ctx.version.v1");
    const tooOld = make(testModeOptions({ versionScenario: "e1-too-old" })).cli;
    assert.equal((await tooOld.version()).contract_version, 0);
    const missing = make(testModeOptions({ versionScenario: "e1-not-ctx" })).cli;
    await rejectsWith(missing.version(), "spawn_failed");
  });

  it("terminalInvocation is the no-shell invocation with the E26 env; it throws before a binary is known", async () => {
    const { cli } = make(testModeOptions());
    assert.throws(() => cli.terminalInvocation(["auth", "login"]), (e: unknown) => e instanceof CtxError && e.code === "spawn_failed");
    await cli.getBinary();
    const t = cli.terminalInvocation(["auth", "login"]);
    assert.equal(t.shellPath, process.execPath);
    assert.deepEqual(t.shellArgs, [FAKE_CTX, "auth", "login"]);
    assert.equal(t.env?.CONTEXO_DISTILL_DISABLE, null);
    assert.equal(t.env?.CONTEXO_CLIENT, `contexo-vscode/${EXT_VERSION}`);
    const tooOld = make(testModeOptions({ versionScenario: "e1-old-ctx-0.6.6" })).cli;
    assert.equal((await tooOld.getBinary()).kind, "tooOld");
    assert.deepEqual(tooOld.terminalInvocation(["update"]).shellArgs, [FAKE_CTX, "update"], "Update ctx works for a too-old ctx");
  });

  it("logs the resolved binary once per discovery, and every call with argv, duration and exit code", async () => {
    const r = root("mixed");
    const log = recordingLog();
    const { cli } = make(testModeOptions(), fakeConfig(), log);
    await cli.getBinary();
    await cli.getBinary();
    await cli.status(r, { offline: true });
    const binaryLines = log.lines.filter((l) => l.startsWith("info ctx binary "));
    assert.equal(binaryLines.length, 1, log.lines.join("\n"));
    assert.match(binaryLines[0] ?? "", /ok: .* version 0\.7\.0 contract 1 capabilities \[/);
    assert.ok(log.lines.some((l) => l.startsWith(`info ctx ${JSON.stringify(["status", "--json", "--root", r, "--offline"])}`) && / exit=0 \d+ms$/.test(l)), log.lines.join("\n"));
    assert.ok(!log.lines.some((l) => l.includes("NO_COLOR") || l.includes(TEST_CTX_ENV)), "the env is never logged");
  });

  it("an untrusted workspace spawns nothing", async () => {
    const spy = spawnSpy();
    const { cli } = make({ ...testModeOptions({ spawnFn: spy.fn }), isTrusted: () => false });
    assert.equal((await cli.getBinary()).kind, "missing");
    await rejectsWith(cli.status(root("mixed"), { offline: true }), "spawn_failed");
    assert.equal(spy.calls.length, 0);
  });

  it("dispose() makes every later call reject without spawning", async () => {
    const spy = spawnSpy();
    const { cli } = make(testModeOptions({ spawnFn: spy.fn }));
    await cli.getBinary();
    const before = spy.calls.length;
    cli.dispose();
    await rejectsWith(cli.status(root("mixed"), { offline: true }), "cancelled");
    assert.equal(spy.calls.length, before);
  });

  (process.platform === "win32" ? it.skip : it)("a contexo.path change re-runs discovery (reusing the cache) and fires onDidChangeBinary; rediscover() re-probes and fires", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "wp17-home-"));
    roots.push(home);
    // Only the shim and the temp home are visible, so no real ctx on this machine is ever probed.
    const visible: DiscoveryFs = { stat: (p) => (p === SHIM || p.startsWith(home) ? nodeDiscoveryFs.stat(p) : Promise.resolve(undefined)) };
    const spy = spawnSpy();
    const config = fakeConfig(SHIM);
    const { cli } = make({
      testMode: false, isTrusted: () => true, fs: visible, platform: process.platform, homedir: () => home, spawnFn: spy.fn,
      env: { PATH: "/usr/bin:/bin", FAKE_CTX_NODE: process.execPath },
    }, config);
    const fired: string[] = [];
    cli.onDidChangeBinary((s) => { fired.push(s.kind); });

    const first = await cli.getBinary();
    assert.equal(first.kind, "ok");
    assert.equal(first.kind === "ok" ? first.path : "", SHIM);
    assert.deepEqual(fired, [], "the first discovery is not a change");
    const probes = spy.calls.length;

    config.setPath(path.join(home, "missing", "ctx"));
    assert.equal((await cli.getBinary()).kind, "missing");
    config.setPath(SHIM);
    assert.equal((await cli.getBinary()).kind, "ok");
    assert.deepEqual(fired, ["missing", "ok"]);
    assert.equal(spy.calls.length, probes, "a settings change reuses the path+mtime+size cache");

    const again = await cli.rediscover();
    assert.equal(again.kind, "ok");
    assert.deepEqual(fired, ["missing", "ok", "ok"]);
    assert.ok(spy.calls.length > probes, "rediscover() drops the cache and probes again");
  });
});
