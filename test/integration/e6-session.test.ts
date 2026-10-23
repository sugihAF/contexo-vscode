// e6 (WP-1.12): the session commands (login, init, installCtx, updateCtx, shareViaAgent),
// the misc commands (refresh, openInDashboard), the busy status bar item, the contexo.state
// context key and the E37 ctx version notice, over FakeCtxCli + fakeModel.
//
// Commands run through vscode.commands.executeCommand reach the esbuild bundle; a seam of
// src/commands/session.ts (sessionSeams) changes only the tsc copy this file imports, so the
// seam tests call that copy's handlers directly. installCtx never answers "Run in Terminal"
// through executeCommand: the bundle would run the real install script.
import * as assert from "node:assert/strict";
import * as vscode from "vscode";
import type { BinaryState } from "../../src/cli/types";
import * as session from "../../src/commands/session";
import * as terminal from "../../src/terminal";
import type { TestApi } from "../../src/testApi";
import type { ConfirmOptions, Prompts } from "../../src/ui/prompts";
import { activateExtension } from "../helpers/activate";
import { FAKE_BINARY_PATH, FAKE_VERSION_DOC, FakeCtxCli, exitingTerminalInvocation } from "../helpers/fakeCtxCli";
import { fakeModel, type FakeModel } from "../helpers/fakeModel";
import { fakeRepository, type FakeRepository } from "../helpers/fakeRepository";
import { waitFor } from "../helpers/waitFor";

const UNIX_INSTALL = "curl -fsSL https://raw.githubusercontent.com/sugihAF/Contexo/main/scripts/install.sh | sh";
const WIN32_INSTALL = "iwr -useb https://raw.githubusercontent.com/sugihAF/Contexo/main/scripts/install.ps1 | iex";
const INSTALL_DOCS = "https://docs.contexo.live/start/install/";
const DEFAULT_PROMPT = "Push my pending Contexo changes with the ctx_push tool. Distill the pending session into a source page first when ctx_push asks you to.";
const COPIED = "Prompt copied. Paste it into your agent chat (Claude Code, Cursor, Codex).";
const NOTICE_PREFIX = "Contexo is using ctx ";
const TERMINAL_WAIT = { timeoutMs: 15000 };

interface PromptCall { method: keyof Prompts; args: unknown[]; }

/** A Prompts that records every call with its arguments; confirm/info/quickPick answers are scriptable. */
class RecordingPrompts implements Prompts {
  readonly calls: PromptCall[] = [];
  confirmAnswer: (message: string, options: ConfirmOptions) => boolean = () => false;
  infoAnswer: (message: string, actions: string[]) => string | undefined = () => undefined;
  quickPickAnswer: (items: readonly vscode.QuickPickItem[]) => vscode.QuickPickItem | undefined = () => undefined;

  async info(message: string, ...actions: string[]): Promise<string | undefined> {
    this.calls.push({ method: "info", args: [message, ...actions] });
    return this.infoAnswer(message, actions);
  }
  async warn(message: string, ...actions: string[]): Promise<string | undefined> {
    this.calls.push({ method: "warn", args: [message, ...actions] });
    return undefined;
  }
  async error(message: string, ...actions: string[]): Promise<string | undefined> {
    this.calls.push({ method: "error", args: [message, ...actions] });
    return undefined;
  }
  async confirm(message: string, options: ConfirmOptions): Promise<boolean> {
    this.calls.push({ method: "confirm", args: [message, options] });
    return this.confirmAnswer(message, options);
  }
  async quickPick<T extends vscode.QuickPickItem>(items: readonly T[], options?: vscode.QuickPickOptions): Promise<T | undefined> {
    this.calls.push({ method: "quickPick", args: [items, options] });
    return this.quickPickAnswer(items) as T | undefined;
  }
  async inputBox(options?: vscode.InputBoxOptions): Promise<string | undefined> {
    this.calls.push({ method: "inputBox", args: [options] });
    return undefined;
  }
  async copyToClipboard(text: string): Promise<void> {
    this.calls.push({ method: "copyToClipboard", args: [text] });
  }
  async openExternal(uri: vscode.Uri): Promise<boolean> {
    this.calls.push({ method: "openExternal", args: [uri] });
    return true;
  }

  /** The arguments of every call to one method, in order. */
  callsOf(method: keyof Prompts): unknown[][] {
    return this.calls.filter((c) => c.method === method).map((c) => c.args);
  }
  /** The first argument (the message) of every call to one method. */
  messages(method: "info" | "warn" | "error"): string[] {
    return this.callsOf(method).map((a) => a[0] as string);
  }
  /** Every openExternal target as uri.toString(true). */
  opened(): string[] {
    return this.callsOf("openExternal").map((a) => (a[0] as vscode.Uri).toString(true));
  }
}

/** An in-memory vscode.Memento. */
class MemoryMemento implements vscode.Memento {
  private readonly data = new Map<string, unknown>();
  keys(): readonly string[] { return [...this.data.keys()]; }
  get<T>(key: string): T | undefined;
  get<T>(key: string, defaultValue: T): T;
  get<T>(key: string, defaultValue?: T): T | undefined {
    return this.data.has(key) ? this.data.get(key) as T : defaultValue;
  }
  async update(key: string, value: unknown): Promise<void> {
    if (value === undefined) { this.data.delete(key); } else { this.data.set(key, value); }
  }
}

type ExecuteCommand = typeof vscode.commands.executeCommand;

describe("e6 status bar and session commands", () => {
  let api: TestApi;
  let cli: FakeCtxCli;
  let root: string;
  let repo: FakeRepository;
  let model: FakeModel;
  let prompts: RecordingPrompts;
  let opened: vscode.Terminal[];
  let openSub: vscode.Disposable | undefined;
  const undo: (() => void)[] = [];

  /** Wrap vscode.commands.executeCommand (shared with the running extension) with a recording spy. */
  function spyExecuteCommand(intercept: (command: string) => boolean = () => false): unknown[][] {
    const commands = vscode.commands as { executeCommand: ExecuteCommand };
    const desc = Object.getOwnPropertyDescriptor(commands, "executeCommand");
    assert.ok(!Object.isFrozen(commands) && desc?.writable === true, "vscode.commands.executeCommand must be writable for the spy");
    const original = commands.executeCommand;
    const seen: unknown[][] = [];
    commands.executeCommand = ((command: string, ...rest: unknown[]) => {
      seen.push([command, ...rest]);
      if (intercept(command)) { return Promise.resolve(undefined); }
      return original.call(vscode.commands, command, ...rest);
    }) as ExecuteCommand;
    undo.push(() => { commands.executeCommand = original; });
    return seen;
  }

  /**
   * Terminals opened during this test that were created with the given name (creationOptions:
   * VS Code renames terminal.name to the process title, e.g. "Code" for the fake's node).
   */
  function terminalsNamed(name: string): vscode.Terminal[] {
    return opened.filter((t) => (t.creationOptions as vscode.TerminalOptions).name === name);
  }

  beforeEach(async () => {
    api = await activateExtension();
    opened = [];
    openSub = vscode.window.onDidOpenTerminal((t) => { opened.push(t); });
    // A console program on win32 (WP-4.4): there the default's Electron binary never reports its exit.
    cli = new FakeCtxCli().setResult("terminalInvocation", exitingTerminalInvocation(0));
    root = vscode.workspace.workspaceFolders![0]!.uri.fsPath;
    repo = fakeRepository({ root, status: "e6-ready" });
    model = fakeModel({ repositories: [repo] });
    prompts = new RecordingPrompts();
    await api.hooks.overrideServices({ cli, model });
    api.hooks.setPrompts(prompts);
  });

  afterEach(async () => {
    for (const f of undo.splice(0).reverse()) { f(); }
    await api.hooks.resetServices();
    openSub?.dispose();
    openSub = undefined;
    for (const t of opened) { t.dispose(); }
    repo.dispose();
  });

  describe("part 1: login runs ctx in a terminal", () => {
    it("contexo.login calls FakeCtxCli.terminalInvocation with [auth, login, --root, <root>], and the created terminal's creationOptions.shellPath equals the fake's returned shellPath", async () => {
      await vscode.commands.executeCommand("contexo.login");

      assert.deepEqual(cli.callsOf("terminalInvocation"), [[["auth", "login", "--root", root]]]);
      const created = await waitFor(() => terminalsNamed(terminal.TERMINAL_NAME)[0], TERMINAL_WAIT);
      assert.equal(terminalsNamed(terminal.TERMINAL_NAME).length, 1, "one Contexo terminal");
      const options = created.creationOptions as vscode.TerminalOptions;
      const expected = exitingTerminalInvocation(0);
      assert.equal(options.shellPath, expected.shellPath, "ctx itself is the terminal process");
      assert.deepEqual(options.shellArgs, expected.shellArgs);
      assert.deepEqual(options.env, expected.env);
      assert.equal(vscode.Uri.file(String(options.cwd)).fsPath, vscode.Uri.file(root).fsPath, "cwd is the repository root");
      assert.ok(
        prompts.messages("info").includes("Contexo: log in in the terminal; ctx opens your browser."),
        `local login hint: ${JSON.stringify(prompts.messages("info"))}`,
      );
    });

    it("with the remoteName seam set, the args end with --no-browser", async () => {
      const original = session.sessionSeams.remoteName;
      session.sessionSeams.remoteName = () => "ssh-remote";
      try {
        assert.equal(session.sessionSeams.remoteName(), "ssh-remote", "the tsc copy's seam is overridden");
        await session.login(api.services);
      } finally {
        session.sessionSeams.remoteName = original;
      }
      assert.deepEqual(cli.callsOf("terminalInvocation"), [[["auth", "login", "--root", root, "--no-browser"]]]);
      assert.ok(
        prompts.messages("info").includes("Contexo: log in in the terminal; in a remote window ctx prints a link to open and asks you to paste the token."),
        `remote login hint: ${JSON.stringify(prompts.messages("info"))}`,
      );
    });

    it("after the terminal process exits (the fake's process exits with 0), fakeModel.refreshAll({remote:true}) is called", async () => {
      assert.deepEqual(model.refreshAllCalls, [], "precondition: no refresh yet");
      await vscode.commands.executeCommand("contexo.login");
      await waitFor(() => model.refreshAllCalls.length > 0, TERMINAL_WAIT);
      assert.deepEqual(model.refreshAllCalls, [{ remote: true }]);
      assert.deepEqual(repo.refreshCalls, [{ remote: true }]);
      const created = terminalsNamed(terminal.TERMINAL_NAME)[0];
      assert.ok(created, "the terminal was created");
      assert.equal(created.exitStatus?.code, 0, "refreshAll runs after the ctx process exited");
    });

    it("a terminalInvocation that throws shows an error and creates no terminal", async () => {
      cli.setError("terminalInvocation", new Error("ctx is not available"));
      await vscode.commands.executeCommand("contexo.login");
      assert.deepEqual(prompts.messages("error"), ["Contexo: cannot run ctx: ctx is not available"]);
      assert.deepEqual(terminalsNamed(terminal.TERMINAL_NAME), []);
      assert.deepEqual(model.refreshAllCalls, [], "nothing ran, so nothing to refresh");
    });

    it("runCtxInTerminal returns the exit code, and undefined after the timeout (still refreshing)", async () => {
      cli.enqueue("terminalInvocation", exitingTerminalInvocation(3), exitingTerminalInvocation(0, { afterMs: 60_000 }));
      const order: string[] = [];
      const exited = await terminal.runCtxInTerminal(api.services, root, ["status"], {
        pollMs: 20, timeoutMs: 10000, beforeRefresh: async () => { order.push("beforeRefresh"); },
      });
      assert.equal(exited, 3);
      assert.deepEqual(order, ["beforeRefresh"]);
      assert.deepEqual(model.refreshAllCalls, [{ remote: true }]);

      const started = Date.now();
      const timedOut = await terminal.runCtxInTerminal(api.services, root, ["status"], { pollMs: 20, timeoutMs: 400 });
      assert.equal(timedOut, undefined);
      assert.ok(Date.now() - started < 5000, "gave up after the timeout");
      assert.deepEqual(model.refreshAllCalls, [{ remote: true }, { remote: true }], "refreshes after a timeout too");
      assert.equal(terminalsNamed(terminal.TERMINAL_NAME).length, 2);
    });
  });

  describe("part 2: context key, status bar, install and share", () => {
    it("the contexo.state context key follows model.state for ctxMissing, notLoggedIn and ready", async () => {
      const seen = spyExecuteCommand();
      await api.hooks.overrideServices({ cli, model }); // re-wire under the spy
      const states = (): unknown[] => seen.filter((c) => c[0] === "setContext" && c[1] === "contexo.state").map((c) => c[2]);
      await waitFor(() => states().length >= 1);
      assert.deepEqual(states(), ["ready"], "set at registration");

      model.setState("ctxMissing");
      model.setState("notLoggedIn");
      model.setState("ready");
      await waitFor(() => states().length >= 4);
      assert.deepEqual(states(), ["ready", "ctxMissing", "notLoggedIn", "ready"]);

      const keys = seen.filter((c) => c[0] === "setContext").map((c) => c[1]);
      assert.deepEqual([...new Set(keys)], ["contexo.state"], "contexo.state is the only context key");
    });

    it("statusBarSnapshot shows $(sync~spin) Contexo during a fake operation", async () => {
      await waitFor(() => api.hooks.statusBarSnapshot?.().items[0]?.text === "$(cloud) Contexo");
      repo.setOperation("push");
      await waitFor(() => api.hooks.statusBarSnapshot?.().items[0]?.text === "$(sync~spin) Contexo");
      const busy = api.hooks.statusBarSnapshot!().items;
      assert.equal(busy.length, 1);
      assert.equal(busy[0]?.id, "contexo.status");

      repo.setOperation(undefined);
      await waitFor(() => api.hooks.statusBarSnapshot?.().items[0]?.text === "$(cloud) Contexo");
      assert.equal(api.hooks.statusBarSnapshot!().items[0]?.id, "contexo.status");
    });

    it("installCtx creates no terminal unless Run in Terminal is chosen", async () => {
      assert.equal(session.INSTALL_COMMANDS.unix, UNIX_INSTALL);
      assert.equal(session.INSTALL_COMMANDS.win32, WIN32_INSTALL);
      assert.equal(session.installCommandFor("win32"), WIN32_INSTALL);
      for (const p of ["darwin", "linux", "freebsd"] as const) { assert.equal(session.installCommandFor(p), UNIX_INSTALL, p); }
      const command = session.installCommandFor(process.platform);
      const settings = spyExecuteCommand((id) => id === "workbench.action.openSettings");
      prompts.confirmAnswer = () => false;
      prompts.infoAnswer = () => undefined;

      await vscode.commands.executeCommand("contexo.installCtx");

      const confirms = prompts.callsOf("confirm");
      assert.equal(confirms.length, 1);
      const [message, options] = confirms[0] as [string, ConfirmOptions];
      assert.equal(message, "Install the Contexo CLI (ctx)?");
      assert.equal(options.modal, true);
      assert.equal(options.confirmLabel, "Run in Terminal");
      assert.ok(options.detail?.includes(`\n\n${command}\n\n`), `detail names the verbatim command: ${options.detail}`);
      const hint = prompts.callsOf("info").find((a) => a[0] === `Install ctx by running: ${command}`);
      assert.deepEqual(hint, [`Install ctx by running: ${command}`, "Open install docs", "Locate ctx…"]);
      assert.deepEqual(opened, [], "no terminal");
      assert.deepEqual(prompts.opened(), []);

      prompts.infoAnswer = (m) => (m.startsWith("Install ctx by running: ") ? "Open install docs" : undefined);
      await vscode.commands.executeCommand("contexo.installCtx");
      assert.deepEqual(prompts.opened(), [INSTALL_DOCS]);
      assert.deepEqual(opened, [], "still no terminal");

      prompts.infoAnswer = (m) => (m.startsWith("Install ctx by running: ") ? "Locate ctx…" : undefined);
      await vscode.commands.executeCommand("contexo.installCtx");
      assert.deepEqual(settings.filter((c) => c[0] === "workbench.action.openSettings"), [["workbench.action.openSettings", "contexo.path"]]);
      assert.deepEqual(opened, [], "still no terminal");
      assert.equal(prompts.callsOf("confirm").length, 3);
      assert.deepEqual(cli.callsOf("terminalInvocation"), [], "installing never runs ctx");
    });

    it("installCtx runs the install command in one shell terminal only after Run in Terminal, then rediscovers ctx when it closes", async () => {
      const original = session.sessionSeams.installCommand;
      session.sessionSeams.installCommand = () => "echo contexo-install-test";
      undo.push(() => { session.sessionSeams.installCommand = original; });
      assert.equal(session.sessionSeams.installCommand(process.platform), "echo contexo-install-test", "the tsc copy's seam is overridden");
      // Safety belt: confirm only ever answers yes for the harmless test command.
      prompts.confirmAnswer = (_m, o) => o.detail?.includes("\n\necho contexo-install-test\n\n") === true;

      await session.installCtx(api.services);

      assert.equal(prompts.callsOf("confirm").length, 1);
      const shells = await waitFor(() => { const t = terminalsNamed("Contexo: install ctx"); return t.length > 0 ? t : undefined; }, TERMINAL_WAIT);
      assert.equal(shells.length, 1);
      assert.equal(opened.length, 1, "exactly one terminal");
      const options = shells[0]!.creationOptions as vscode.TerminalOptions;
      assert.equal(options.shellPath, undefined, "the default shell");
      assert.deepEqual(cli.callsOf("rediscover"), [], "no rediscover before the terminal closes");

      shells[0]!.dispose();
      await waitFor(() => cli.callsOf("rediscover").length >= 1, TERMINAL_WAIT);
      assert.deepEqual(cli.callsOf("terminalInvocation"), []);
    });

    it('shareViaAgent({agentPrompt:"X"}) writes X to env.clipboard; with no argument it writes the default prompt', async () => {
      assert.equal(session.DEFAULT_AGENT_PROMPT, DEFAULT_PROMPT);
      assert.equal(session.SHARE_COPIED_MESSAGE, COPIED);

      await vscode.commands.executeCommand("contexo.shareViaAgent", { agentPrompt: "X" });
      await vscode.commands.executeCommand("contexo.shareViaAgent");
      await vscode.commands.executeCommand("contexo.shareViaAgent", { label: "Pending session", contextValue: "session" });
      await vscode.commands.executeCommand("contexo.shareViaAgent", { agentPrompt: "" });

      assert.deepEqual(prompts.callsOf("copyToClipboard"), [["X"], [DEFAULT_PROMPT], [DEFAULT_PROMPT], [DEFAULT_PROMPT]]);
      assert.equal(prompts.messages("info").filter((m) => m === COPIED).length, 4);
      assert.deepEqual(cli.callsOf("terminalInvocation"), []);
      assert.deepEqual(cli.callsOf("push"), []);
      assert.deepEqual(opened, []);
    });
  });

  describe("part 3: version notice and dashboard", () => {
    it("ctxVersionNotice shows once per version, again after a version change, and keys dev builds on version+commit", async () => {
      const memento = new MemoryMemento();
      const p = new RecordingPrompts();
      const ok = (version: Partial<typeof FAKE_VERSION_DOC>): BinaryState =>
        ({ kind: "ok", path: FAKE_BINARY_PATH, version: { ...FAKE_VERSION_DOC, ...version } });
      const notices = (): unknown[][] => p.callsOf("info").filter((a) => String(a[0]).startsWith(NOTICE_PREFIX));
      const shownFor = async (b: BinaryState): Promise<boolean> => {
        cli.binary = b;
        return session.ctxVersionNotice(memento, cli, p, undefined);
      };

      assert.equal(await shownFor(ok({ version: "0.7.0" })), true, "first 0.7.0");
      assert.equal(memento.get(session.LAST_CTX_VERSION_KEY), "0.7.0");
      assert.deepEqual(notices(), [[
        "Contexo is using ctx 0.7.0. Restart your agent sessions so their Contexo MCP server runs this ctx; older MCP servers can still overwrite local edits.",
        "Learn more",
      ]]);
      assert.equal(await shownFor(ok({ version: "0.7.0" })), false, "0.7.0 again");
      assert.equal(await shownFor(ok({ version: "0.7.1" })), true, "0.7.1");
      assert.equal(notices().length, 2);

      assert.equal(session.ctxVersionKey({ ...FAKE_VERSION_DOC, version: "0.7.1", dev_build: false, commit: "abc1234" }), "0.7.1");
      assert.equal(await shownFor(ok({ version: "dev", dev_build: true, commit: "abc1234" })), true, "dev build abc1234");
      assert.equal(memento.get(session.LAST_CTX_VERSION_KEY), "dev+abc1234");
      assert.ok(String(notices()[2]?.[0]).startsWith("Contexo is using ctx dev+abc1234. "));
      assert.equal(await shownFor(ok({ version: "dev", dev_build: true, commit: "abc1234" })), false, "same dev build");
      assert.equal(await shownFor(ok({ version: "dev", dev_build: true, commit: "def5678" })), true, "dev build def5678");
      assert.equal(notices().length, 4);

      assert.equal(await shownFor({ kind: "missing" }), false, "missing");
      assert.equal(await shownFor({ kind: "tooOld", path: FAKE_BINARY_PATH, missing: ["status.json"] }), false, "tooOld");
      assert.equal(await shownFor({ kind: "extensionTooOld", path: FAKE_BINARY_PATH, contractVersion: 2 }), false, "extensionTooOld");
      assert.equal(notices().length, 4, "a non-ok binary shows nothing");
      assert.equal(memento.get(session.LAST_CTX_VERSION_KEY), "dev+def5678", "a non-ok binary leaves the memento alone");

      // An explicit binary (onDidChangeBinary) wins over getBinary.
      const getBinaryCalls = cli.callsOf("getBinary").length;
      assert.equal(await session.ctxVersionNotice(memento, cli, p, ok({ version: "0.8.0" })), true, "explicit binary");
      assert.equal(cli.callsOf("getBinary").length, getBinaryCalls, "no getBinary when a binary is given");

      // Two racing triggers for one new version show one notice.
      const raced = await Promise.all([shownFor(ok({ version: "0.9.0" })), session.ctxVersionNotice(memento, cli, p, ok({ version: "0.9.0" }))]);
      assert.deepEqual(raced.filter(Boolean).length, 1, `one of the racing triggers shows it: ${JSON.stringify(raced)}`);
      assert.equal(notices().length, 6);

      // "Learn more" opens the install docs.
      p.infoAnswer = (m) => (m.startsWith(NOTICE_PREFIX) ? "Learn more" : undefined);
      assert.equal(await shownFor(ok({ version: "1.0.0" })), true);
      await waitFor(() => p.opened().length === 1);
      assert.deepEqual(p.opened(), [INSTALL_DOCS]);
    });

    it("registerContextKeys shows the notice once the state leaves loading, and again when the ctx binary changes", async () => {
      // Unique versions: the test profile's real globalState remembers the last key across runs.
      const v1 = `0.0.0-e6.${Date.now()}`;
      const v2 = `${v1}.1`;
      const ok = (version: string): BinaryState => ({ kind: "ok", path: FAKE_BINARY_PATH, version: { ...FAKE_VERSION_DOC, version } });
      const fresh = new FakeCtxCli({ binary: ok(v1) });
      const loading = fakeModel({ repositories: [repo], state: "loading" });
      await api.hooks.overrideServices({ cli: fresh, model: loading });
      const noticesFor = (v: string): string[] => prompts.messages("info").filter((m) => m.startsWith(`${NOTICE_PREFIX}${v}. `));
      assert.deepEqual(fresh.callsOf("getBinary"), [], "no notice while loading");

      loading.setState("ready");
      await waitFor(() => noticesFor(v1).length === 1);
      loading.setState("notLoggedIn");
      fresh.fireBinary(ok(v2));
      await waitFor(() => noticesFor(v2).length === 1);
      assert.equal(fresh.callsOf("getBinary").length, 1, "one handshake-time notice; the binary event carries its own state");
      assert.equal(noticesFor(v1).length, 1);
      assert.equal(api.services.context.globalState.get(session.LAST_CTX_VERSION_KEY), v2);
    });

    it("e6-self-hosted: openInDashboard opens nothing and shows the no-dashboard message", async () => {
      repo.setStatus("e6-self-hosted");
      await vscode.commands.executeCommand("contexo.openInDashboard");
      assert.deepEqual(prompts.opened(), []);
      assert.ok(
        prompts.messages("info").includes("No dashboard is configured for https://contexo.internal.example"),
        JSON.stringify(prompts.messages("info")),
      );
    });

    it("openInDashboard with a page Uri opens that page's dashboard URL", async () => {
      const page = vscode.Uri.joinPath(vscode.Uri.file(root), ".contexo", "wiki", "concepts", "auth-flow.md");
      await vscode.commands.executeCommand("contexo.openInDashboard", page);
      assert.deepEqual(prompts.opened(), ["https://app.example.test/repos/r_test/page/wiki/concepts/auth-flow.md"]);
    });

    it("openInDashboard with a tree item opens the page; with no page it opens the repository", async () => {
      const page = vscode.Uri.joinPath(vscode.Uri.file(root), ".contexo", "wiki", "entities", "gitstore.md");
      await vscode.commands.executeCommand("contexo.openInDashboard", { label: "gitstore", resourceUri: page });
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
      await vscode.commands.executeCommand("contexo.openInDashboard");
      assert.deepEqual(prompts.opened(), [
        "https://app.example.test/repos/r_test/page/wiki/entities/gitstore.md",
        "https://app.example.test/repos/r_test",
      ]);
    });

    it("openInDashboard with no status yet, or no target, explains instead of opening", async () => {
      const bare = fakeRepository({ root });
      await api.hooks.overrideServices({ cli, model: fakeModel({ repositories: [bare] }) });
      await vscode.commands.executeCommand("contexo.openInDashboard");
      await api.hooks.overrideServices({ cli, model: fakeModel({ repositories: [] }) });
      await vscode.commands.executeCommand("contexo.openInDashboard");
      assert.deepEqual(prompts.opened(), []);
      const infos = prompts.messages("info");
      assert.ok(infos.includes("Contexo: no status yet for this project; refresh and try again."), JSON.stringify(infos));
      assert.ok(infos.includes("Contexo: open a Contexo page or project first."), JSON.stringify(infos));
      bare.dispose();
    });

    it("contexo.refresh calls refreshAll({remote:true})", async () => {
      await vscode.commands.executeCommand("contexo.refresh");
      assert.deepEqual(model.refreshAllCalls, [{ remote: true }]);
      assert.deepEqual(prompts.calls, [], "no prompt");
    });

    it("contexo.updateCtx calls terminalInvocation([update, --root, <root>]) and then rediscover", async () => {
      await vscode.commands.executeCommand("contexo.updateCtx");
      assert.deepEqual(cli.callsOf("terminalInvocation"), [[["update", "--root", root]]]);
      const methods = cli.calls.map((c) => c.method);
      const invoked = methods.indexOf("terminalInvocation");
      const rediscovered = methods.indexOf("rediscover", invoked);
      assert.ok(rediscovered > invoked, `rediscover after the terminal: ${JSON.stringify(methods)}`);
      assert.deepEqual(model.refreshAllCalls, [{ remote: true }]);
      assert.equal(terminalsNamed(terminal.TERMINAL_NAME).length, 1);
    });

    it("contexo.init with no repositories calls terminalInvocation([init, --root, <root>])", async () => {
      const empty = fakeModel({ repositories: [], state: "noRepositories" });
      await api.hooks.overrideServices({ cli, model: empty });
      await vscode.commands.executeCommand("contexo.init");
      assert.deepEqual(cli.callsOf("terminalInvocation"), [[["init", "--root", root]]]);
      assert.deepEqual(prompts.callsOf("quickPick"), [], "one candidate folder: no picker");
      assert.deepEqual(empty.refreshAllCalls, [{ remote: true }]);
    });

    it("contexo.init when every folder already has a project runs nothing", async () => {
      await vscode.commands.executeCommand("contexo.init");
      assert.deepEqual(cli.callsOf("terminalInvocation"), []);
      assert.ok(prompts.messages("info").includes("Contexo: every workspace folder already has a Contexo project."));
    });
  });
});
