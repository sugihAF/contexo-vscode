// e2 (WP-1.8): root discovery in multi.code-workspace (alpha and beta have
// .contexo/config.json, plain has none), driven through hooks.overrideServices({cli:
// FakeCtxCli}). It mutates the workspace copy under .vscode-test/ (a config.json in plain, a
// folder removed and re-added) and restores it afterwards; e0-multiroot reads the committed
// fixture definition instead, so it does not depend on the order.
import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import type { IModel, IRepository } from "../../src/model/types";
import type { TestApi } from "../../src/testApi";
import { activateExtension } from "../helpers/activate";
import { FakeCtxCli } from "../helpers/fakeCtxCli";
import { waitFor } from "../helpers/waitFor";

function folderNamed(name: string): vscode.WorkspaceFolder {
  const f = vscode.workspace.workspaceFolders?.find((w) => path.basename(w.uri.fsPath) === name);
  assert.ok(f, `workspace folder ${name}`);
  return f;
}

function names(model: IModel): string[] {
  return model.repositories.map((r) => path.basename(r.root.fsPath));
}

describe("e2 multi-root (WP-1.8)", () => {
  let api: TestApi;
  let plainContexo: string | undefined;

  beforeEach(async () => {
    api = await activateExtension();
    await api.hooks.resetServices();
  });

  afterEach(async () => {
    await api.hooks.resetServices();
  });

  after(async () => {
    if (plainContexo) { await fs.rm(plainContexo, { recursive: true, force: true }); }
  });

  async function overridden(): Promise<{ model: IModel; fake: FakeCtxCli }> {
    const fake = new FakeCtxCli();
    await api.hooks.overrideServices({ cli: fake });
    return { model: api.services.model, fake };
  }

  it("two repositories for two .contexo folders and none for the plain folder", async () => {
    const { model, fake } = await overridden();
    await waitFor(() => model.state === "ready" && model.repositories.length === 2 && model.repositories.every((r) => r.status), { timeoutMs: 10000 });
    assert.deepEqual(names(model), ["alpha", "beta"]);
    assert.equal(model.getRepository(folderNamed("plain").uri), undefined);
    const roots = fake.callsOf("status").map((a) => path.basename(a[0])).sort();
    assert.deepEqual(roots, ["alpha", "beta"], "one online status per repository, none for plain");
  });

  it("creating .contexo/config.json in the plain folder opens a third", async () => {
    const { model } = await overridden();
    await waitFor(() => model.repositories.length === 2, { timeoutMs: 10000 });
    const opened = new Promise<IRepository>((resolve) => {
      const sub = model.onDidOpenRepository((r) => { sub.dispose(); resolve(r); });
    });
    const plain = folderNamed("plain").uri.fsPath;
    const config = await fs.readFile(path.join(folderNamed("alpha").uri.fsPath, ".contexo", "config.json"), "utf8");
    plainContexo = path.join(plain, ".contexo");
    await fs.mkdir(plainContexo, { recursive: true });
    await fs.writeFile(path.join(plainContexo, "config.json"), config);

    const repo = await opened;
    assert.equal(path.basename(repo.root.fsPath), "plain");
    await waitFor(() => model.repositories.length === 3 && repo.status !== undefined, { timeoutMs: 10000 });
    assert.deepEqual(names(model), ["alpha", "beta", "plain"]);
  });

  it("removing a folder disposes its repository", async () => {
    const { model, fake } = await overridden();
    await waitFor(() => model.repositories.some((r) => path.basename(r.root.fsPath) === "beta" && r.status), { timeoutMs: 10000 });
    const beta = model.repositories.find((r) => path.basename(r.root.fsPath) === "beta");
    assert.ok(beta);
    const betaFolder = folderNamed("beta");
    const closed = new Promise<IRepository>((resolve) => {
      const sub = model.onDidCloseRepository((r) => { sub.dispose(); resolve(r); });
    });
    assert.equal(vscode.workspace.updateWorkspaceFolders(betaFolder.index, 1), true);
    try {
      assert.equal(await closed, beta);
      assert.equal((beta as { isDisposed?: boolean }).isDisposed, true);
      assert.ok(!names(model).includes("beta"));
      const calls = fake.callsOf("status").length;
      await beta.refresh({ remote: true });
      assert.equal(fake.callsOf("status").length, calls, "a disposed repository never calls ctx");
    } finally {
      const back = new Promise<void>((resolve) => {
        const sub = vscode.workspace.onDidChangeWorkspaceFolders(() => { sub.dispose(); resolve(); });
      });
      assert.equal(vscode.workspace.updateWorkspaceFolders(betaFolder.index, 0, { uri: betaFolder.uri, name: betaFolder.name }), true);
      await back;
    }
  });
});
