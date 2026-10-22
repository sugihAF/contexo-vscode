// onboarding (WP-2.3): every way the extension can start short of 'ready', through the REAL
// wiring. Discovery cases without the Test-mode override build their own CtxCli from the tsc
// copy (createCtxCliWith: testMode false, an empty PATH and home, and a DiscoveryFs that sees
// nothing outside this test's temp dir, so no real ctx on this machine is found) and swap it
// in with api.hooks.overrideServices({cli}); openWorkspaceCopy() of the next test (and this
// file's afterEach) restores the original services. Handshake cases switch the fake ctx's
// `version` answer through env FAKE_CTX_SCENARIO (always restored) plus cli.rediscover().
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { describeBinary, missingCapabilities } from "../../src/cli/capabilities";
import { createCtxCliWith } from "../../src/cli/ctxCli";
import { REJECTED_EXT_MESSAGE, nodeDiscoveryFs, type DiscoveryFs } from "../../src/cli/discovery";
import { CtxError, type ICtxCli } from "../../src/cli/types";
import { ACTION_LABELS, errorActions } from "../../src/commands/errorActions";
import { COMMAND_IDS } from "../../src/commands/ids";
import { LAST_CTX_VERSION_KEY, ctxVersionKey } from "../../src/commands/session";
import type { VersionDoc } from "../../src/contract/types";
import type { ExtensionState } from "../../src/model/types";
import type { ContexoConfig } from "../../src/services";
import { STATUS_BAR_ITEM_ID } from "../../src/statusBar";
import type { StatusBarItemSnapshot, TestApi } from "../../src/testApi";
import {
  SCENARIOS, holdsFor, isOnlineStatus, openWorkspaceCopy, readCalls, sourceControlOf, waitFor,
  type CallRecord, type E2EWorkspace,
} from "../helpers/e2e";
import { BUILTIN_VERSION_DOC, REPO_ROOT } from "../helpers/fixtures";

interface Recorder { lines: string[]; log: vscode.LogOutputChannel }

/** A LogOutputChannel stand-in that records '<level> <message>' lines (CtxCliDeps.log). */
function recordingLog(): Recorder {
  const lines: string[] = [];
  const at = (level: string) => (m: string): void => { lines.push(`${level} ${m}`); };
  const log = { info: at("info"), warn: at("warn"), error: at("error"), debug: at("debug"), trace: at("trace") };
  return { lines, log: log as unknown as vscode.LogOutputChannel };
}

/** A ContexoConfig whose contexo.path is fixed. */
function configWithPath(p: string): ContexoConfig {
  const none = (() => ({ dispose: () => undefined })) as unknown as ContexoConfig["onDidChange"];
  return {
    path: p, remoteRefreshEnabled: true, remoteRefreshIntervalSeconds: 180, scmCountIncoming: false,
    decorationsEnabled: true, treeShowSessions: true, onDidChange: none,
  };
}

function versionDocOf(scenario: string): VersionDoc {
  return JSON.parse(fs.readFileSync(path.join(SCENARIOS, scenario, "version.json"), "utf8")) as VersionDoc;
}

function statusItem(api: TestApi): StatusBarItemSnapshot | undefined {
  return api.hooks.statusBarSnapshot?.().items.find((i) => i.id === STATUS_BAR_ITEM_ID);
}

async function waitForState(api: TestApi, state: ExtensionState): Promise<void> {
  await waitFor(() => api.services.model.state === state, {
    timeoutMs: 15000, message: `contexo.state ${state} (now ${api.services.model.state})`,
  });
}

function callsOf(w: E2EWorkspace, command: string): CallRecord[] {
  return w.calls().filter((c) => c.argv[0] === command);
}

describe("onboarding (e2e): ctx missing, too old, extension too old, not logged in, not initialized, and the E37 notice", function () {
  this.timeout(60000);

  let api: TestApi | undefined;
  let overridden = false;
  const clis: ICtxCli[] = [];
  const temps: string[] = [];
  const savedScenario = process.env.FAKE_CTX_SCENARIO;

  /** Restore FAKE_CTX_SCENARIO and the original handshake (a no-op when the env never changed). */
  async function restoreHandshake(a: TestApi): Promise<void> {
    if (process.env.FAKE_CTX_SCENARIO === savedScenario) { return; }
    if (savedScenario === undefined) { delete process.env.FAKE_CTX_SCENARIO; } else { process.env.FAKE_CTX_SCENARIO = savedScenario; }
    await a.services.cli.rediscover();
  }

  /**
   * A CtxCli with NO Test-mode override: testMode false, PATH and home are empty temp dirs, and
   * its DiscoveryFs answers only for contexo.path and paths under this test's temp dir (every
   * other location, e.g. /opt/homebrew/bin/ctx, reads as absent). Records each stat.
   */
  function isolatedCli(a: TestApi, contexoPath: string): { cli: ICtxCli; log: Recorder; stats: string[] } {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wp23-onboard-"));
    temps.push(tmp);
    const home = path.join(tmp, "home");
    const bin = path.join(tmp, "bin");
    fs.mkdirSync(home);
    fs.mkdirSync(bin);
    const stats: string[] = [];
    const isolated: DiscoveryFs = {
      stat: async (p) => {
        stats.push(p);
        return p === contexoPath || p.startsWith(tmp + path.sep) ? nodeDiscoveryFs.stat(p) : undefined;
      },
    };
    const log = recordingLog();
    const cli = createCtxCliWith(
      { context: a.services.context, log: log.log, config: configWithPath(contexoPath) },
      { env: { PATH: bin }, homedir: () => home, fs: isolated, testMode: false, isTrusted: () => true },
    );
    clis.push(cli);
    return { cli, log, stats };
  }

  async function override(a: TestApi, cli: ICtxCli): Promise<void> {
    overridden = true;
    await a.hooks.overrideServices({ cli });
  }

  afterEach(async () => {
    if (api) {
      await restoreHandshake(api);
      if (overridden) { await api.hooks.resetServices(); }
    }
    overridden = false;
    for (const c of clis.splice(0)) { c.dispose(); }
    for (const d of temps.splice(0)) { fs.rmSync(d, { recursive: true, force: true }); }
  });

  it("a nonexistent contexo.path with no test override -> ctxMissing: discovery tries it first, finds no ctx anywhere, spawns nothing, and the status bar offers Install ctx", async () => {
    const w = await openWorkspaceCopy();
    api = w.api;
    const missing = path.join(os.tmpdir(), "wp23-onboard-nonexistent", "ctx");
    assert.equal(fs.existsSync(missing), false);
    const { cli, log, stats } = isolatedCli(w.api, missing);

    await override(w.api, cli);

    await waitForState(w.api, "ctxMissing");
    assert.deepEqual(await cli.getBinary(), { kind: "missing" });
    assert.equal(stats[0], missing, "contexo.path is the first candidate (E35)");
    assert.ok(log.lines.some((l) => l.startsWith("warn ") && l.includes(missing)), `the skipped contexo.path is logged:\n${log.lines.join("\n")}`);
    assert.ok(log.lines.includes(`info ${describeBinary({ kind: "missing" })}`), "discovery logs that no ctx was found");
    await waitFor(() => statusItem(w.api)?.command === COMMAND_IDS.installCtx, { timeoutMs: 5000, message: "the status bar offers Install ctx" });
    assert.deepEqual(w.calls(), [], "no ctx process was started");
  });

  it("a contexo.path ending in .cmd is rejected with REJECTED_EXT_MESSAGE ('point contexo.path at ctx.exe', E35) before any stat or spawn -> ctxMissing", async () => {
    const w = await openWorkspaceCopy();
    api = w.api;
    const cmd = path.join(REPO_ROOT, "test", "fake-ctx", "bin", "ctx.cmd");
    assert.ok(fs.existsSync(cmd), "the .cmd shim exists");
    assert.equal(REJECTED_EXT_MESSAGE, "point contexo.path at ctx.exe");
    const { cli, log, stats } = isolatedCli(w.api, cmd);

    await override(w.api, cli);

    await waitForState(w.api, "ctxMissing");
    const rejection = log.lines.find((l) => l.startsWith("warn ") && l.includes(REJECTED_EXT_MESSAGE));
    assert.ok(rejection, `the rejection is logged:\n${log.lines.join("\n")}`);
    assert.ok(rejection.includes(cmd), "the warning names the rejected path");
    assert.equal(stats.includes(cmd), false, "a .cmd contexo.path is rejected before any stat");
    assert.deepEqual(await cli.getBinary(), { kind: "missing" });
    assert.deepEqual(w.calls(), [], "the .cmd is never spawned");
  });

  const handshakes: { scenario: string; state: ExtensionState; kind: string; statusCommand: string }[] = [
    { scenario: "ctx-missing-caps", state: "ctxTooOld", kind: "tooOld", statusCommand: COMMAND_IDS.updateCtx },
    { scenario: "ctx-contract2", state: "extensionTooOld", kind: "extensionTooOld", statusCommand: "workbench.extensions.search" },
  ];
  for (const h of handshakes) {
    it(`version ${h.scenario} (FAKE_CTX_SCENARIO + rediscover) -> ${h.state}: one \`version --json\`, no status while it lasts, and the original handshake brings ready back`, async () => {
      const w = await openWorkspaceCopy();
      api = w.api;
      const doc = versionDocOf(h.scenario);

      process.env.FAKE_CTX_SCENARIO = h.scenario;
      const binary = await w.api.services.cli.rediscover();

      assert.equal(binary.kind, h.kind);
      if (binary.kind === "tooOld") {
        assert.deepEqual(binary.missing, missingCapabilities(doc.capabilities));
        assert.ok(binary.missing.length > 0, "the fixture lacks required capabilities");
        assert.equal(binary.versionText, doc.version);
      } else if (binary.kind === "extensionTooOld") {
        assert.equal(binary.contractVersion, doc.contract_version);
      }
      await waitForState(w.api, h.state);
      await waitFor(() => statusItem(w.api)?.command === h.statusCommand, { timeoutMs: 5000, message: `the status bar runs ${h.statusCommand}` });
      const versions = callsOf(w, "version");
      assert.deepEqual(versions.map((c) => c.argv), [["version", "--json"]], "one handshake, no --short fallback (the doc parses)");
      await holdsFor(() => w.calls().every((c) => c.argv[0] !== "status"), 1500, `no ctx status runs while the state is ${h.state}`);

      await restoreHandshake(w.api);
      await waitForState(w.api, "ready");
    });
  }

  it("not-authenticated -> notLoggedIn: the status bar and a failing push offer Log in, and Log in runs `ctx auth login --root R` (e8-onboard-not-authenticated)", async () => {
    const w = await openWorkspaceCopy({ scenario: "e8-onboard-not-authenticated" });
    api = w.api;
    assert.equal(w.api.services.model.state, "notLoggedIn");
    await waitFor(() => statusItem(w.api)?.command === COMMAND_IDS.login, { timeoutMs: 5000, message: "the status bar offers Log in" });
    const stderr = fs.readFileSync(path.join(SCENARIOS, "not-authenticated", "not_authenticated.stderr"), "utf8");
    const presentation = errorActions(CtxError.fromProcess(stderr, 4));
    assert.deepEqual(presentation.actions.map((a) => a.label), [ACTION_LABELS.logIn]);
    w.prompts.respond(presentation.message, ACTION_LABELS.logIn);
    const sc = sourceControlOf(w.api);
    sc.inputBox.value = "share the auth flow";

    await vscode.commands.executeCommand(COMMAND_IDS.push, sc);

    const push = callsOf(w, "push");
    assert.equal(push.length, 1);
    assert.equal(push[0]?.exit, 4);
    const note = await w.prompts.waitFor(presentation.message, { method: "warn" });
    assert.deepEqual(note.actions, [ACTION_LABELS.logIn]);
    const auth = await waitFor(() => callsOf(w, "auth").find((c) => c.end !== undefined), { timeoutMs: 20000, message: "Log in ran ctx auth login in a terminal" });
    assert.deepEqual(auth.argv, ["auth", "login", "--root", w.root]);
    await waitFor(() => w.calls().some((c) => isOnlineStatus(c) && (c.start ?? 0) >= (auth.end ?? Infinity) && c.end !== undefined), {
      timeoutMs: 20000, message: "the login is followed by an online refresh",
    });
  });

  it("not_initialized (ctx exits 5 for the project) -> the repository closes -> noRepositories: no SourceControl, and the status bar offers Initialize Contexo (e8-onboard-not-initialized)", async () => {
    const w = await openWorkspaceCopy({ scenario: "e8-onboard-not-initialized" });
    api = w.api;

    await waitForState(w.api, "noRepositories");

    assert.deepEqual(w.api.services.model.repositories, []);
    assert.deepEqual(w.api.hooks.scmSnapshot?.().repos, [], "no SourceControl");
    await waitFor(() => statusItem(w.api)?.command === COMMAND_IDS.init, { timeoutMs: 5000, message: "the status bar offers Initialize Contexo" });
    const last = readCalls(w.root).filter(isOnlineStatus).pop();
    assert.deepEqual(last?.argv, ["status", "--json", "--root", w.root]);
    assert.equal(last?.exit, 5, "ctx said not_initialized");
  });

  it("the E37 notice is shown once per ctx version: once for the current ctx, not again for the same version, once more for a new version (FAKE_CTX_SCENARIO=e8-onboard-version)", async () => {
    const w = await openWorkspaceCopy();
    api = w.api;
    const memento = w.api.services.context.globalState;
    const before = memento.get<string>(LAST_CTX_VERSION_KEY);
    const key0 = ctxVersionKey(BUILTIN_VERSION_DOC);
    const next = versionDocOf("e8-onboard-version");
    const key1 = ctxVersionKey(next);
    assert.notEqual(key1, key0);
    const t0 = Date.now();
    const noticesFor = (key: string): number =>
      w.prompts.notifications().filter((n) => n.method === "info" && n.at >= t0 && n.message.includes(`ctx ${key}`)).length;
    try {
      // A first run: no notice recorded for any version.
      await memento.update(LAST_CTX_VERSION_KEY, undefined);
      await w.api.services.cli.rediscover();
      await waitFor(() => noticesFor(key0) === 1, { timeoutMs: 10000, message: `the notice for ctx ${key0}` });
      assert.equal(memento.get(LAST_CTX_VERSION_KEY), key0);

      await w.api.services.cli.rediscover();
      await holdsFor(() => noticesFor(key0) === 1, 1500, `the same ctx ${key0} shows no second notice`);

      process.env.FAKE_CTX_SCENARIO = "e8-onboard-version";
      const binary = await w.api.services.cli.rediscover();
      assert.equal(binary.kind === "ok" ? binary.version.version : binary.kind, next.version);
      await waitFor(() => noticesFor(key1) === 1, { timeoutMs: 10000, message: `the notice for ctx ${key1}` });
      assert.equal(memento.get(LAST_CTX_VERSION_KEY), key1);
      await w.api.services.cli.rediscover();
      await holdsFor(() => noticesFor(key1) === 1, 1500, `the same ctx ${key1} shows no second notice`);
      assert.equal(noticesFor(key0), 1);
    } finally {
      await restoreHandshake(w.api);
      await memento.update(LAST_CTX_VERSION_KEY, before);
    }
  });
});
