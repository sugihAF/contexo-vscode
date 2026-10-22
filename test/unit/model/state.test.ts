// WP-1.8: ExtensionState, the trust gate, the handshake-first rule and root discovery,
// through createModelWithHost with an injected trust/binary/folder host (no VS Code).
import * as assert from "node:assert/strict";
import { CtxError, type BinaryState } from "../../../src/cli/types";
import type { StatusDoc } from "../../../src/contract/types";
import { CONFIG_GLOB, createModelWithHost } from "../../../src/model/model";
import type { ExtensionState, IModel } from "../../../src/model/types";
import { FAKE_BINARY_PATH, FAKE_VERSION_DOC, FakeCtxCli } from "../../helpers/fakeCtxCli";
import { loadStatusDoc } from "../../helpers/fixtures";
import { waitFor } from "../../helpers/waitFor";
import { FakeHost, Uri, flush, modelDeps } from "./fakeHost";

const ROOT = "/ws/repo";

function envelope(code: string, exit: number): string {
  return JSON.stringify({ schema: "ctx.error.v1", exit_code: exit, error: { code, message: `${code} (test)`, advice: [], retryable: false } });
}

function withRemoteError(code: string, auth: StatusDoc["auth"]["state"] = "unchecked"): StatusDoc {
  const doc = loadStatusDoc("mixed");
  doc.remote = { source: "none", page_count: 0, error: { code: code as never, message: code, advice: [], retryable: false } };
  doc.auth = { state: auth };
  return doc;
}

describe("model/state", () => {
  let model: IModel | undefined;
  let host: FakeHost;
  let cli: FakeCtxCli;

  function build(o: { binary?: BinaryState; trusted?: boolean; withConfig?: boolean } = {}): IModel {
    host = new FakeHost();
    host.trusted = o.trusted ?? true;
    host.addFolder(ROOT, { withConfig: o.withConfig ?? true });
    cli = new FakeCtxCli(o.binary ? { binary: o.binary } : {});
    model = createModelWithHost(modelDeps(cli), host);
    return model;
  }

  function states(m: IModel): ExtensionState[] {
    const seen: ExtensionState[] = [];
    m.onDidChangeState((s) => seen.push(s));
    return seen;
  }

  afterEach(() => {
    model?.dispose();
    model = undefined;
  });

  it("no cli call while isTrusted is false; granting trust starts discovery", async () => {
    const m = build({ trusted: false });
    await m.initialize();
    await m.refreshAll({ remote: true });
    await flush();
    assert.equal(cli.calls.length, 0, `no ctx call of any kind while untrusted: ${JSON.stringify(cli.calls)}`);
    assert.equal(m.repositories.length, 0, "discovery waits for trust");
    assert.equal(m.state, "loading", "never 'untrusted' (E38)");

    host.trusted = true;
    host.trust.fire();
    await waitFor(() => m.state === "ready");
    assert.equal(m.repositories.length, 1);
    assert.equal(cli.calls[0]?.method, "getBinary", "the handshake comes before any status");
    assert.deepEqual(cli.callsOf("status").map((a) => [a[0], a[1]]), [[Uri.file(ROOT).fsPath, { offline: false }]]);
  });

  it("missing -> ctxMissing, tooOld -> ctxTooOld, extensionTooOld -> extensionTooOld, and zero status calls for any non-ok binary", async () => {
    const cases: [BinaryState, ExtensionState][] = [
      [{ kind: "missing" }, "ctxMissing"],
      [{ kind: "tooOld", path: FAKE_BINARY_PATH, missing: ["resolve"] }, "ctxTooOld"],
      [{ kind: "extensionTooOld", path: FAKE_BINARY_PATH, contractVersion: 2 }, "extensionTooOld"],
    ];
    for (const [binary, expected] of cases) {
      const m = build({ binary });
      await m.initialize();
      assert.equal(m.state, expected, binary.kind);
      await m.refreshAll({ remote: true }); // an explicit Refresh re-runs the handshake (rediscover) only
      await m.refreshAll();
      await flush();
      assert.equal(m.state, expected, `${binary.kind} after refreshAll`);
      assert.equal(cli.callsOf("status").length, 0, `no status call for ${binary.kind}`);
      assert.equal(cli.callsOf("rediscover").length, 2);
      m.dispose();
    }
  });

  it("server_unresolved remote.error -> notLoggedIn", async () => {
    const m = build();
    cli.setResult("status", withRemoteError("server_unresolved"));
    await m.initialize();
    await waitFor(() => m.state === "notLoggedIn");
  });

  it("not_authenticated and rejected auth -> notLoggedIn; an authenticated status -> ready", async () => {
    for (const scenario of ["not-authenticated"] as const) {
      const m = build();
      cli.scenario = scenario;
      await m.initialize();
      await waitFor(() => m.state === "notLoggedIn");
      m.dispose();
    }
    const m = build();
    cli.setResult("status", withRemoteError("auth_rejected", "rejected"));
    await m.initialize();
    await waitFor(() => m.state === "notLoggedIn");
    cli.reset();
    await m.refreshAll({ remote: true });
    await waitFor(() => m.state === "ready");
  });

  it("loading until the first status result, then ready; noRepositories without a root", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const m = build();
    cli.setHandler("status", async () => { await gate; return loadStatusDoc("mixed"); });
    const seen = states(m);
    await m.initialize();
    assert.equal(m.state, "loading");
    assert.equal(m.repositories.length, 1);
    release();
    await waitFor(() => m.state === "ready");
    assert.deepEqual(seen, ["ready"]);
    m.dispose();

    const empty = build({ withConfig: false });
    await empty.initialize();
    assert.equal(empty.state, "noRepositories");
    assert.equal(cli.callsOf("status").length, 0);
  });

  it("a status error with code not_implemented -> ctxTooOld; the next success clears it", async () => {
    const m = build();
    cli.enqueue("status", CtxError.fromProcess(envelope("not_implemented", 10), 10));
    await m.initialize();
    await waitFor(() => m.state === "ctxTooOld");
    assert.equal(m.repositories[0]?.lastError?.code, "not_implemented");
    await m.refreshAll({ remote: true });
    await waitFor(() => m.state === "ready");
    assert.equal(m.repositories[0]?.lastError, undefined);
  });

  it("onDidChangeBinary re-evaluates the state; ok runs an online refresh of every repository", async () => {
    const m = build({ binary: { kind: "missing" } });
    await m.initialize();
    assert.equal(m.state, "ctxMissing");
    cli.fireBinary({ kind: "tooOld", path: FAKE_BINARY_PATH, missing: [] });
    assert.equal(m.state, "ctxTooOld");
    assert.equal(cli.callsOf("status").length, 0);
    cli.fireBinary({ kind: "ok", path: FAKE_BINARY_PATH, version: FAKE_VERSION_DOC });
    await waitFor(() => m.state === "ready");
    assert.deepEqual(cli.callsOf("status").map((a) => a[1]), [{ offline: false }]);
  });

  it("only folder roots count: non-file folders and folders without config.json open nothing; creating config.json opens one", async () => {
    host = new FakeHost();
    const plain = host.addFolder("/ws/plain");
    host.folders.push({ uri: Uri.parse("vscode-vfs://github/acme/repo"), name: "virtual", index: 1 });
    host.files.add(Uri.parse("vscode-vfs://github/acme/repo/.contexo/config.json").toString());
    cli = new FakeCtxCli();
    const m = model = createModelWithHost(modelDeps(cli), host);
    const opened: string[] = [];
    m.onDidOpenRepository((r) => opened.push(r.root.path));
    await m.initialize();
    assert.equal(m.state, "noRepositories");
    assert.equal(m.repositories.length, 0);

    const [watcher] = host.watchersOf(plain, CONFIG_GLOB);
    assert.ok(watcher, "a plain folder is watched for .contexo/config.json");
    host.addConfig(plain);
    watcher.create.fire(Uri.joinPath(plain, ".contexo", "config.json"));
    await waitFor(() => m.state === "ready");
    assert.deepEqual(opened, ["/ws/plain"]);
    assert.equal(host.watchersOf(plain, CONFIG_GLOB).length, 0, "the plain watcher is disposed once the repository opens");
  });

  it("removing a folder closes and disposes its repository; adding one with config.json opens it", async () => {
    const m = build();
    const closed: string[] = [];
    m.onDidCloseRepository((r) => closed.push(r.root.path));
    await m.initialize();
    await waitFor(() => m.state === "ready");
    const repo = m.repositories[0];
    const removed = host.folders.splice(0, 1);
    host.folderChanges.fire({ added: [], removed });
    await waitFor(() => m.repositories.length === 0);
    assert.deepEqual(closed, [ROOT]);
    assert.equal((repo as { isDisposed?: boolean }).isDisposed, true);
    assert.equal(m.state, "noRepositories");

    const other = host.addFolder("/ws/other", { withConfig: true });
    host.folderChanges.fire({ added: [host.folders[0]!], removed: [] });
    await waitFor(() => m.repositories.length === 1 && m.state === "ready");
    assert.equal(m.repositories[0]?.root.toString(), other.toString());
  });

  it("not_initialized closes the repository and watches for config.json to reopen it", async () => {
    const m = build();
    await m.initialize();
    await waitFor(() => m.state === "ready");
    cli.enqueue("status", CtxError.fromProcess(envelope("not_initialized", 5), 5));
    await m.repositories[0]?.refresh();
    await waitFor(() => m.repositories.length === 0);
    assert.equal(m.state, "noRepositories");
    const root = Uri.file(ROOT);
    const [watcher] = host.watchersOf(root, CONFIG_GLOB);
    assert.ok(watcher, "the folder is watched again");
    watcher.create.fire(Uri.joinPath(root, ".contexo", "config.json"));
    await waitFor(() => m.repositories.length === 1 && m.state === "ready");
  });

  it("getRepository picks the deepest containing root; resolveTarget maps undefined, Uri, resourceUri, rootUri and a repository", async () => {
    host = new FakeHost();
    const outer = host.addFolder("/ws", { withConfig: true });
    const inner = host.addFolder("/ws/sub", { withConfig: true });
    cli = new FakeCtxCli();
    const m = model = createModelWithHost(modelDeps(cli), host);
    await m.initialize();
    await waitFor(() => m.state === "ready" && m.repositories.every((r) => r.status));
    const page = Uri.joinPath(inner, ".contexo", "wiki", "concepts", "auth-flow.md");
    assert.equal(m.getRepository(page)?.root.toString(), inner.toString());
    assert.equal(m.getRepository(Uri.joinPath(outer, "README.md"))?.root.toString(), outer.toString());
    assert.equal(m.getRepository(Uri.file("/elsewhere/x.md")), undefined);

    assert.equal(m.resolveTarget(undefined), undefined, "two repositories and no active editor");
    host.activeUri = page;
    assert.deepEqual(m.resolveTarget(undefined)?.relPath, "wiki/concepts/auth-flow.md");
    assert.equal(m.resolveTarget(page)?.repository.root.toString(), inner.toString());
    assert.equal(m.resolveTarget({ resourceUri: page })?.relPath, "wiki/concepts/auth-flow.md");
    assert.equal(m.resolveTarget({ rootUri: outer })?.repository.root.toString(), outer.toString());
    const repo = m.repositories[0]!;
    assert.equal(m.resolveTarget(repo)?.repository, repo);
    assert.equal(m.resolveTarget(42), undefined);
  });

  it("dispose disposes the repositories, the watchers and the host, and stops all calls", async () => {
    const m = build();
    await m.initialize();
    await waitFor(() => m.state === "ready");
    const before = cli.calls.length;
    m.dispose();
    model = undefined;
    assert.equal(host.disposed, true);
    assert.ok(host.watchers.every((w) => w.disposed), "every watcher is disposed");
    await m.refreshAll({ remote: true });
    await flush();
    assert.equal(cli.calls.length, before);
  });
});
