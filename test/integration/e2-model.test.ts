// e2 (WP-1.8): the real model (createModel over the VS Code host) in the basic workspace,
// driven through hooks.overrideServices({cli: FakeCtxCli}). Assertions use the FakeCtxCli
// method-call log only; real argv and calls.jsonl belong to WP-2.3's e8-wiring.
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { CtxError } from "../../src/cli/types";
import type { PullDoc, PushDoc, StatusDoc } from "../../src/contract/types";
import type { ExtensionState, IModel, IRepository } from "../../src/model/types";
import type { TestApi } from "../../src/testApi";
import { activateExtension } from "../helpers/activate";
import { FakeCtxCli } from "../helpers/fakeCtxCli";
import { REPO_ROOT, loadStatusDoc } from "../helpers/fixtures";
import { waitFor } from "../helpers/waitFor";

function contractDoc<T>(file: string): T {
  return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "test", "fixtures", "contract", "v1", file), "utf8")) as T;
}

/** The method-call log as push / pull / status:online / status:offline, from index `from`. */
function opLog(fake: FakeCtxCli, from = 0): string[] {
  return fake.calls.slice(from).flatMap((c) => {
    if (c.method === "status") { return [(c.args[1] as { offline: boolean }).offline ? "status:offline" : "status:online"]; }
    return c.method === "push" || c.method === "pull" ? [c.method] : [];
  });
}

describe("e2 model (WP-1.8)", () => {
  let api: TestApi;

  beforeEach(async () => {
    api = await activateExtension();
    await api.hooks.resetServices();
  });

  afterEach(async () => {
    await api.hooks.resetServices();
  });

  /** Override the cli (the seam rebuilds the real model over it) and wait for the first status. */
  async function readyRepo(fake: FakeCtxCli): Promise<{ model: IModel; repo: IRepository }> {
    await api.hooks.overrideServices({ cli: fake });
    const model = api.services.model;
    const repo = await waitFor(() => model.repositories.length === 1 && model.repositories[0]?.status ? model.repositories[0] : undefined, { timeoutMs: 10000 });
    return { model, repo };
  }

  it("one repository whose counts equal the mixed fixture", async () => {
    const fake = new FakeCtxCli();
    const { model, repo } = await readyRepo(fake);
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder);
    assert.equal(repo.root.toString(), folder.uri.toString());
    assert.equal(repo.contexoDir.toString(), vscode.Uri.joinPath(folder.uri, ".contexo").toString());
    assert.deepEqual(repo.status?.counts, loadStatusDoc("mixed").counts);
    assert.equal(model.getRepository(repo.fileUri("wiki/concepts/auth-flow.md")), repo);
    assert.equal(repo.pageAt(repo.fileUri("wiki/concepts/auth-flow.md"))?.state, "modified");
    assert.equal(fake.calls[0]?.method, "getBinary", "the handshake comes before any status");
    assert.deepEqual(fake.callsOf("status")[0]?.slice(0, 2), [folder.uri.fsPath, { offline: false }], "activation refresh is online");
  });

  it("an identical refresh does not fire onDidChangeStatus", async () => {
    const fake = new FakeCtxCli();
    const { repo } = await readyRepo(fake);
    let fired = 0;
    const sub = repo.onDidChangeStatus(() => { fired++; });
    try {
      const before = fake.callsOf("status").length;
      await repo.refresh({ remote: true });
      await repo.refresh({ remote: true });
      assert.equal(fake.callsOf("status").length, before + 2);
      assert.equal(fired, 0);

      const changed: StatusDoc = loadStatusDoc("mixed");
      changed.pages[0]!.state = "modified";
      fake.setResult("status", changed);
      await repo.refresh({ remote: true });
      assert.equal(fired, 1);
    } finally {
      sub.dispose();
    }
  });

  it("state goes loading then ready; ctxMissing when the binary is missing; notLoggedIn for the not-authenticated fixture", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const fake = new FakeCtxCli();
    fake.setHandler("getBinary", async () => { await gate; return fake.binary; });
    await api.hooks.overrideServices({ cli: fake });
    const model = api.services.model;
    const seen: ExtensionState[] = [];
    const sub = model.onDidChangeState((s) => seen.push(s));
    try {
      assert.equal(model.state, "loading");
      assert.equal(fake.callsOf("status").length, 0, "no status before the handshake");
      release();
      await waitFor(() => model.state === "ready", { timeoutMs: 10000 });
      assert.deepEqual(seen, ["ready"]);
    } finally {
      sub.dispose();
    }

    const missing = new FakeCtxCli({ binary: { kind: "missing" } });
    await api.hooks.overrideServices({ cli: missing });
    await waitFor(() => api.services.model.state === "ctxMissing", { timeoutMs: 10000 });
    await api.services.model.refreshAll({ remote: true });
    assert.equal(missing.callsOf("status").length, 0, "no status call for a missing ctx");

    const notAuth = new FakeCtxCli({ scenario: "not-authenticated" });
    await api.hooks.overrideServices({ cli: notAuth });
    await waitFor(() => api.services.model.state === "notLoggedIn", { timeoutMs: 10000 });
  });

  it("repo.run serializes push then pull", async () => {
    const fake = new FakeCtxCli();
    const { repo } = await readyRepo(fake);
    const root = repo.root.fsPath;
    let releasePush!: () => void;
    const pushGate = new Promise<void>((resolve) => { releasePush = resolve; });
    fake.setHandler("push", async () => { await pushGate; return { doc: contractDoc<PushDoc>("push.ok.json") }; });
    fake.setResult("pull", contractDoc<PullDoc>("pull.ok.json"));
    const from = fake.calls.length;

    const pushed = repo.run("push", () => fake.push(root, { message: "e2" }));
    const pulled = repo.run("pull", () => fake.pull(root));
    await waitFor(() => repo.operation === "push");
    assert.deepEqual(opLog(fake, from), ["push"], "pull waits for the push");
    releasePush();
    const [p, q] = await Promise.all([pushed, pulled]);
    assert.equal(p.doc.schema, "ctx.push.v1");
    assert.equal(q.schema, "ctx.pull.v1");
    assert.deepEqual(opLog(fake, from), ["push", "status:online", "pull", "status:online"]);
    assert.equal(repo.operation, undefined);
  });

  it("not_initialized closes the repository", async () => {
    const fake = new FakeCtxCli();
    const { model, repo } = await readyRepo(fake);
    const closed = new Promise<IRepository>((resolve) => {
      const sub = model.onDidCloseRepository((r) => { sub.dispose(); resolve(r); });
    });
    const stderr = fs.readFileSync(path.join(REPO_ROOT, "test", "fixtures", "ctx", "scenarios", "not-initialized", "not_initialized.stderr"), "utf8");
    fake.setError("status", CtxError.fromProcess(stderr, 5));
    await repo.refresh();
    assert.equal(await closed, repo);
    assert.equal(model.repositories.length, 0);
    await waitFor(() => model.state === "noRepositories");
  });
});
