// e1 (WP-1.7): the real CtxCli inside the VS Code extension host, driving the fake ctx through
// CONTEXO_TEST_CTX (set by .vscode-test.mjs, honoured only in ExtensionMode.Test). Each test
// builds its own CtxCli (createCtxCliWith) with a recording log and a temp project root, so it
// neither depends on nor disturbs the extension's own services or the shared test workspace.
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { createCtxCliWith, type CtxCliOptions } from "../../src/cli/ctxCli";
import { CtxError, TEST_CTX_ENV, type BinaryState, type ICtxCli, type TestCtxSpec } from "../../src/cli/types";
import { createConfig, type ContexoConfig } from "../../src/services";
import type { TestApi } from "../../src/testApi";
import { activateExtension } from "../helpers/activate";
import { REPO_ROOT, loadStatusDoc } from "../helpers/fixtures";

interface Recorder { lines: string[]; log: vscode.LogOutputChannel; }

function recordingLog(): Recorder {
  const lines: string[] = [];
  const at = (level: string) => (m: string): void => { lines.push(`${level} ${m}`); };
  const log = { info: at("info"), warn: at("warn"), error: at("error"), debug: at("debug"), trace: at("trace") };
  return { lines, log: log as unknown as vscode.LogOutputChannel };
}

/** A ContexoConfig with a fixed empty contexo.path (the e1 tests that do not edit settings). */
function staticConfig(): ContexoConfig {
  const none = (() => ({ dispose: () => undefined })) as unknown as ContexoConfig["onDidChange"];
  return {
    path: undefined, remoteRefreshEnabled: true, remoteRefreshIntervalSeconds: 180, scmCountIncoming: false,
    decorationsEnabled: true, treeShowSessions: true, onDidChange: none,
  };
}

/** The CONTEXO_TEST_CTX spec this host was started with. */
function hostSpec(): TestCtxSpec {
  const raw = process.env[TEST_CTX_ENV];
  assert.ok(raw, `${TEST_CTX_ENV} must be set by .vscode-test.mjs`);
  return JSON.parse(raw) as TestCtxSpec;
}

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** A temp project root whose fake-ctx scenario is `scenario`. */
function tempRoot(scenario: string): string {
  const root = tempDir("wp17-e1-");
  fs.mkdirSync(path.join(root, ".fake-ctx"));
  fs.writeFileSync(path.join(root, ".fake-ctx", "current"), `${scenario}\n`);
  return root;
}

function readCalls(file: string): { argv: string[]; env: Record<string, string | null> }[] {
  if (!fs.existsSync(file)) { return []; }
  return fs.readFileSync(file, "utf8").split("\n").filter((l) => l !== "")
    .map((l) => JSON.parse(l) as { argv: string[]; env: Record<string, string | null> });
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out after ${ms} ms waiting for ${what}`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e: unknown) => { clearTimeout(t); reject(e); });
  });
}

describe("e1 ctx CLI (fake ctx in the extension host)", () => {
  let api: TestApi;
  const clis: ICtxCli[] = [];
  const dirs: string[] = [];

  const make = (o: CtxCliOptions = {}, config: ContexoConfig = staticConfig()): { cli: ICtxCli; log: Recorder } => {
    const log = recordingLog();
    const cli = createCtxCliWith({ context: api.services.context, log: log.log, config }, o);
    clis.push(cli);
    return { cli, log };
  };
  const root = (scenario: string): string => {
    const r = tempRoot(scenario);
    dirs.push(r);
    return r;
  };

  before(async () => {
    api = await activateExtension();
  });

  afterEach(() => {
    for (const c of clis.splice(0)) { c.dispose(); }
    for (const d of dirs.splice(0)) { fs.rmSync(d, { recursive: true, force: true }); }
  });

  it("the extension's own services.cli is the real CtxCli and handshakes ok with the fake ctx", async () => {
    await api.hooks.resetServices();
    const state = await api.services.cli.getBinary();
    assert.equal(state.kind, "ok");
    assert.equal(state.kind === "ok" ? state.version.contract_version : -1, 1);
    assert.equal(api.services.context.extensionMode, vscode.ExtensionMode.Test);
  });

  it("status against the mixed scenario returns the fixture page count and captures.pending", async () => {
    const r = root("mixed");
    const { cli } = make();
    const doc = await cli.status(r, { offline: false });
    const fixture = loadStatusDoc("mixed");
    assert.equal(doc.schema, "ctx.status.v1");
    assert.equal(doc.pages.length, fixture.pages.length);
    assert.equal(doc.captures.pending, fixture.captures.pending);
    const [call] = readCalls(path.join(r, ".fake-ctx", "calls.jsonl"));
    assert.deepEqual(call?.argv, ["status", "--json", "--root", r]);
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as { version: string };
    assert.deepEqual(call?.env, { NO_COLOR: "1", CONTEXO_NO_UPDATE_CHECK: "1", CONTEXO_CLIENT: `contexo-vscode/${pkg.version}` }, "E26 env, CONTEXO_DISTILL_DISABLE absent");
  });

  it("e1-too-old: getBinary() is tooOld, cli.status rejects, and calls.jsonl/spawn log contains version calls only, no status", async () => {
    const r = root("mixed");
    const scratch = tempDir("wp17-e1-calls-");
    dirs.push(scratch);
    const versionCalls = path.join(scratch, "version-calls.jsonl");
    const spec: TestCtxSpec = { ...hostSpec(), env: { FAKE_CTX_SCENARIO: "e1-too-old", FAKE_CTX_CALLS: versionCalls } };
    const { cli, log } = make({ env: { ...process.env, [TEST_CTX_ENV]: JSON.stringify(spec) } });

    const state = await cli.getBinary();
    assert.equal(state.kind, "tooOld");
    assert.equal(state.kind === "tooOld" ? state.versionText : undefined, "0.6.9");
    await assert.rejects(cli.status(r, { offline: false }), (e: unknown) => e instanceof CtxError && e.code === "spawn_failed");
    await assert.rejects(cli.status(r, { offline: true }), (e: unknown) => e instanceof CtxError && e.code === "spawn_failed");

    const calls = readCalls(versionCalls);
    assert.ok(calls.length > 0, "the handshake reached the fake ctx");
    for (const c of calls) { assert.equal(c.argv[0], "version", JSON.stringify(c.argv)); }
    assert.deepEqual(readCalls(path.join(r, ".fake-ctx", "calls.jsonl")), [], "no call under the project root");
    const spawned = log.lines.filter((l) => l.startsWith("info ctx ["));
    assert.ok(spawned.length > 0);
    for (const l of spawned) { assert.ok(l.startsWith('info ctx ["version",'), l); }
  });

  it("every call is logged with argv, duration and exit code", async () => {
    const r = root("mixed");
    const { cli, log } = make();
    await cli.status(r, { offline: true });
    await cli.show(r, "wiki/concepts/retry-policy.md", "base");
    await assert.rejects(cli.show(r, "wiki/concepts/nope.md", "server"), (e: unknown) => e instanceof CtxError && e.code === "page_not_found");
    const expect = (args: string[], exit: number): void => {
      const prefix = `info ctx ${JSON.stringify(args)} cwd=${JSON.stringify(r)} exit=${exit} `;
      assert.ok(log.lines.some((l) => l.startsWith(prefix) && /\d+ms$/.test(l)), `missing '${prefix}<ms>ms' in:\n${log.lines.join("\n")}`);
    };
    expect(["status", "--json", "--root", r, "--offline"], 0);
    expect(["show", "wiki/concepts/retry-policy.md", "--at", "base", "--root", r], 0);
    expect(["show", "wiki/concepts/nope.md", "--at", "server", "--root", r], 8);
    assert.ok(log.lines.some((l) => /^info ctx binary ok: .* contract 1 capabilities \[/.test(l)), "the resolved binary is logged");
  });

  it("changing contexo.path fires onDidChangeBinary", async () => {
    const settings = vscode.workspace.getConfiguration("contexo");
    const config = createConfig();
    try {
      const { cli, log } = make({}, config);
      assert.equal((await cli.getBinary()).kind, "ok");
      const changed = new Promise<BinaryState>((resolve) => { cli.onDidChangeBinary(resolve); });
      await settings.update("path", path.join(os.tmpdir(), "wp17-e1-nonexistent", "ctx"), vscode.ConfigurationTarget.Global);
      const state = await withTimeout(changed, 10_000, "onDidChangeBinary");
      assert.equal(state.kind, "ok", "Test mode keeps the CONTEXO_TEST_CTX fake");
      assert.ok(log.lines.some((l) => l.includes("contexo.path changed")), log.lines.join("\n"));
      const again = new Promise<BinaryState>((resolve) => { cli.onDidChangeBinary(resolve); });
      await cli.rediscover();
      assert.equal((await withTimeout(again, 10_000, "onDidChangeBinary after rediscover()")).kind, "ok");
    } finally {
      await settings.update("path", undefined, vscode.ConfigurationTarget.Global);
      config.dispose();
    }
  });
});
