// e4 (WP-1.10): the read-only contexo: file system. The REGISTERED provider is driven through
// vscode.workspace.fs over a FakeCtxCli and a fake model of the basic workspace; events are
// observed on a provider constructed over the same services (not registered with VS Code).
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { CtxError } from "../../src/cli/types";
import type { PageEntry, StatusDoc } from "../../src/contract/types";
import { ContexoFileSystemProvider } from "../../src/fs/contexoFs";
import { toContexoUri } from "../../src/fs/contexoUri";
import type { Services } from "../../src/services";
import type { TestApi } from "../../src/testApi";
import { activateExtension } from "../helpers/activate";
import { FakeCtxCli } from "../helpers/fakeCtxCli";
import { fakeModel, type FakeModel } from "../helpers/fakeModel";
import { fakeRepository, type FakeRepository } from "../helpers/fakeRepository";
import { REPO_ROOT, scenarioDir } from "../helpers/fixtures";

const AUTH = "wiki/concepts/auth-flow.md";
const RETRY = "wiki/concepts/retry-policy.md";
const CRLF_BOM = "wiki/concepts/crlf-bom.md";
const SYNC_MODEL = "wiki/analyses/sync-model.md";
const SHA = "94b52c8f9ade15c44e6750dfa93ff59529f19ec5";
const NEW_SHA_1 = "1111111111111111111111111111111111111111";
const NEW_SHA_2 = "2222222222222222222222222222222222222222";

const CONTRACT = path.join(REPO_ROOT, "test", "fixtures", "contract", "v1");
const read = (...p: string[]): Buffer => fs.readFileSync(path.join(...p));

/** What the scripted `ctx show` serves, by '<relPath>@<ref>'. */
const SHOW_BYTES: Readonly<Record<string, Buffer>> = {
  [`${AUTH}@base`]: read(scenarioDir("mixed"), "show", "auth-flow.base.md"),
  [`${AUTH}@server`]: read(scenarioDir("mixed"), "show", "auth-flow.server.md"),
  [`${CRLF_BOM}@base`]: read(scenarioDir("e4-fs"), "show", "crlf-bom.base.md"),
  [`${RETRY}@base`]: read(CONTRACT, "raw", "retry-policy.base.md"),
  [`${RETRY}@server`]: read(CONTRACT, "raw", "retry-policy.server.md"),
  [`${RETRY}@${SHA}`]: read(CONTRACT, "raw", "retry-policy.server.md"),
};

const BASE_UNAVAILABLE = fs.readFileSync(path.join(scenarioDir("mixed"), "base_unavailable.stderr"), "utf8");
const PAGE_NOT_FOUND = fs.readFileSync(path.join(scenarioDir("mixed"), "page_not_found.stderr"), "utf8");
const SERVER_UNSUPPORTED = fs.readFileSync(path.join(CONTRACT, "error.server_unsupported.json"), "utf8");

/** A ctx.error.v1 envelope line for code. */
function envelope(code: string, exit: number): string {
  return JSON.stringify({ schema: "ctx.error.v1", exit_code: exit, error: { code, message: `show: ${code} (test)`, advice: [], retryable: false } });
}

function serveFixtures(_root: string, relPath: string, ref: string): Uint8Array {
  const bytes = SHOW_BYTES[`${relPath}@${ref}`];
  if (!bytes) { throw CtxError.fromProcess(PAGE_NOT_FOUND, 8); }
  return new Uint8Array(bytes);
}

const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");

function need<T>(v: T | undefined | null, what: string): T {
  if (v === undefined || v === null) { throw new Error(`missing ${what}`); }
  return v;
}

/** An assert.rejects/throws validator: a FileSystemError with this code. */
function fsError(code: string, label = ""): (err: unknown) => true {
  return (err: unknown) => {
    assert.ok(err instanceof vscode.FileSystemError, `${label}: a FileSystemError, got ${String(err)}`);
    assert.equal(err.code, code, `${label}: ${err.message}`);
    return true;
  };
}

/** A deep copy of doc with `path`'s entry edited. */
function edited(doc: StatusDoc | undefined, path: string, edit: (p: PageEntry) => void): StatusDoc {
  const next = structuredClone(need(doc, "status"));
  edit(need(next.pages.find((p) => p.path === path), path));
  return next;
}
const baseSha = (sha: string) => (p: PageEntry): void => { p.base = { ...need(p.base, "base"), sha }; };

describe("e4 fs", () => {
  let api: TestApi;
  let repo: FakeRepository;
  let model: FakeModel;
  let cli: FakeCtxCli;
  const disposables: vscode.Disposable[] = [];

  /** The contexo: URI of relPath at ref, built like WP-1.9 does (root defaults to the repository's). */
  const contexoUri = (relPath: string, ref: string, root = repo.root.fsPath): vscode.Uri =>
    toContexoUri(repo.fileUri(relPath), ref, root, relPath);

  /** A provider over the current services (not registered), disposed after the test. */
  const constructed = (): ContexoFileSystemProvider => {
    const s: Services = { ...api.services, cli, model };
    const p = new ContexoFileSystemProvider(s);
    disposables.push(p);
    return p;
  };

  beforeEach(async () => {
    api = await activateExtension();
    const root = need(vscode.workspace.workspaceFolders?.[0], "workspace folder").uri;
    repo = fakeRepository({ root, status: "mixed" });
    model = fakeModel({ repositories: [repo] });
    cli = new FakeCtxCli();
    cli.setHandler("show", serveFixtures);
    await api.hooks.overrideServices({ cli, model });
  });

  afterEach(async () => {
    for (const d of disposables.splice(0).reverse()) { d.dispose(); }
    await api.hooks.resetServices();
    model.dispose();
    repo.dispose();
  });

  it("workspace.fs.readFile on the contexo base URI of auth-flow equals the fixture bytes byte for byte (CRLF/BOM case included)", async () => {
    const crlfBom = need(SHOW_BYTES[`${CRLF_BOM}@base`], "crlf-bom fixture");
    assert.equal(crlfBom.subarray(0, 3).toString("hex"), "efbbbf", "the fixture starts with a UTF-8 BOM");
    assert.ok(crlfBom.includes(Buffer.from("\r\n")), "the fixture has CRLF line endings");

    const cases: [string, string][] = [[AUTH, "base"], [CRLF_BOM, "base"], [RETRY, "base"], [RETRY, "server"], [AUTH, "server"], [RETRY, SHA]];
    for (const [relPath, ref] of cases) {
      const expected = need(SHOW_BYTES[`${relPath}@${ref}`], `${relPath}@${ref}`);
      const got = await vscode.workspace.fs.readFile(contexoUri(relPath, ref));
      assert.equal(hex(got), hex(expected), `${relPath}@${ref}: byte for byte`);
    }
    // crlf-bom is not in the status (its base sha is unknown): never cached, still untouched on a second read.
    assert.equal(hex(await vscode.workspace.fs.readFile(contexoUri(CRLF_BOM, "base"))), hex(crlfBom));
    assert.equal(cli.callsOf("show").filter(([, rel]) => rel === CRLF_BOM).length, 2);
  });

  it("two reads make one FakeCtxCli show(root, <auth-flow relPath>, base) call", async () => {
    const uri = contexoUri(AUTH, "base");
    const first = await vscode.workspace.fs.readFile(uri);
    const second = await vscode.workspace.fs.readFile(uri);
    assert.deepEqual(cli.callsOf("show"), [[repo.root.fsPath, "wiki/concepts/auth-flow.md", "base"]]);
    assert.equal(hex(second), hex(first));

    const st = await vscode.workspace.fs.stat(uri);
    assert.equal(st.type, vscode.FileType.File);
    assert.equal(st.size, first.byteLength, "stat reports the cached size");

    // A case variant of the root is the same repository on case-insensitive platforms, and
    // ctx always gets the canonical root.
    const variant = contexoUri(AUTH, "server", repo.root.fsPath.toUpperCase());
    if (process.platform === "darwin" || process.platform === "win32") {
      await vscode.workspace.fs.readFile(variant);
      assert.deepEqual(cli.callsOf("show")[1], [repo.root.fsPath, AUTH, "server"]);
    } else {
      await assert.rejects(async () => vscode.workspace.fs.readFile(variant), fsError("FileNotFound", "root case variant"));
    }
  });

  it("the empty ref returns 0 bytes with no call", async () => {
    const uri = contexoUri(SYNC_MODEL, "empty");
    const got = await vscode.workspace.fs.readFile(uri);
    assert.equal(got.byteLength, 0);
    const st = await vscode.workspace.fs.stat(uri);
    assert.equal(st.type, vscode.FileType.File);
    assert.equal(st.size, 0);
    // The root and path are still validated first.
    await assert.rejects(async () => vscode.workspace.fs.readFile(contexoUri(SYNC_MODEL, "empty", "/not/a/contexo/root")), fsError("FileNotFound", "empty @ unknown root"));
    await assert.rejects(async () => vscode.workspace.fs.readFile(contexoUri("../outside.md", "empty")), fsError("FileNotFound", "empty @ ../"));
    assert.deepEqual(cli.callsOf("show"), []);
  });

  it("writeFile, delete and rename reject with NoPermissions", async () => {
    const uri = contexoUri(AUTH, "base");
    const other = contexoUri(AUTH, "server");
    await assert.rejects(async () => vscode.workspace.fs.writeFile(uri, new Uint8Array([0x78])), fsError("NoPermissions", "workspace.fs.writeFile"));
    await assert.rejects(async () => vscode.workspace.fs.delete(uri), fsError("NoPermissions", "workspace.fs.delete"));
    await assert.rejects(async () => vscode.workspace.fs.rename(uri, other), fsError("NoPermissions", "workspace.fs.rename"));
    await assert.rejects(async () => vscode.workspace.fs.createDirectory(contexoUri("wiki/new-folder.md", "base")), fsError("NoPermissions", "workspace.fs.createDirectory"));

    const p = constructed();
    assert.throws(() => p.writeFile(uri, new Uint8Array([0x78]), { create: true, overwrite: true }), fsError("NoPermissions", "provider.writeFile"));
    assert.throws(() => p.delete(uri, { recursive: false }), fsError("NoPermissions", "provider.delete"));
    assert.throws(() => p.rename(uri, other, { overwrite: true }), fsError("NoPermissions", "provider.rename"));
    assert.throws(() => p.createDirectory(uri), fsError("NoPermissions", "provider.createDirectory"));
    assert.deepEqual(p.readDirectory(uri), []);
    const watch = p.watch(uri, { recursive: false, excludes: [] });
    assert.equal(typeof watch.dispose, "function");
    watch.dispose();
    assert.deepEqual(cli.callsOf("show"), [], "nothing reaches ctx");
  });

  it("base_unavailable gives FileNotFound", async () => {
    cli.setError("show", CtxError.fromProcess(BASE_UNAVAILABLE, 8));
    const uri = contexoUri(AUTH, "base");
    await assert.rejects(async () => vscode.workspace.fs.readFile(uri), fsError("FileNotFound", "base_unavailable"));
    await assert.rejects(async () => vscode.workspace.fs.readFile(uri), fsError("FileNotFound", "base_unavailable again"));
    assert.equal(cli.callsOf("show").length, 2, "an error is never cached");

    for (const [code, exit] of [["page_not_found", 8], ["sha_not_found", 8], ["repo_not_found", 8], ["invalid_path", 3]] as const) {
      cli.setError("show", CtxError.fromProcess(envelope(code, exit), exit));
      await assert.rejects(async () => vscode.workspace.fs.readFile(contexoUri(RETRY, SHA)), fsError("FileNotFound", code));
    }
    cli.setHandler("show", serveFixtures);
    assert.equal(hex(await vscode.workspace.fs.readFile(uri)), hex(need(SHOW_BYTES[`${AUTH}@base`], "auth base")), "a later success is served");
  });

  it("server_unsupported gives Unavailable", async () => {
    const log = api.services.log as unknown as { warn: (...a: unknown[]) => void };
    const originalWarn = log.warn;
    const warned: string[] = [];
    log.warn = (...a: unknown[]) => { warned.push(a.map(String).join(" ")); originalWarn.apply(api.services.log, a); };
    try {
      cli.setError("show", CtxError.fromProcess(SERVER_UNSUPPORTED, 10));
      const uri = contexoUri(RETRY, SHA);
      await assert.rejects(async () => vscode.workspace.fs.readFile(uri), (err: unknown) => {
        fsError("Unavailable", "server_unsupported")(err);
        assert.match((err as Error).message, /server_unsupported/, "the message names the ctx code");
        return true;
      });
      assert.ok(
        warned.some((l) => l.includes("server_unsupported") && l.includes(SHA) && l.includes(uri.toString())),
        `logged with s.log.warn: ${JSON.stringify(warned)}`,
      );

      const unavailable: [string, Error][] = [
        ["not_implemented", CtxError.fromProcess(envelope("not_implemented", 10), 10)],
        ["network", CtxError.fromProcess(envelope("network", 7), 7)],
        ["not_authenticated", CtxError.fromProcess(envelope("not_authenticated", 4), 4)],
        ["auth_rejected", CtxError.fromProcess(envelope("auth_rejected", 4), 4)],
        ["forbidden", CtxError.fromProcess(envelope("forbidden", 4), 4)],
        ["timeout", CtxError.extension("timeout", "ctx show timed out after 30000 ms")],
        ["internal", CtxError.fromProcess("panic: runtime error\ngoroutine 1 [running]:", 2)],
        ["plain Error", new Error("not a CtxError")],
      ];
      for (const [label, err] of unavailable) {
        cli.setError("show", err);
        await assert.rejects(async () => vscode.workspace.fs.readFile(contexoUri(AUTH, "server")), fsError("Unavailable", label));
      }
      assert.equal(cli.callsOf("show").length, 1 + unavailable.length, "every read reached ctx (nothing cached)");
    } finally {
      log.warn = originalWarn;
    }
  });

  it("an unknown root or a ../ path is rejected with no call", async () => {
    const root = repo.root.fsPath;
    const cases: [label: string, root: string, relPath: string, ref: string][] = [
      ["unknown root", "/definitely/not/a/contexo/root", AUTH, "base"],
      ["sub-folder of the root", path.join(root, ".contexo"), AUTH, "base"],
      ["sub-folder of the root (wiki)", path.join(root, ".contexo", "wiki"), "concepts/auth-flow.md", "base"],
      ["root spelled through ..", `${root}/../${path.basename(root)}`, AUTH, "base"],
      ["empty root", "", AUTH, "base"],
      ["relative root", path.basename(root), AUTH, "base"],
      ["../ path", root, "../outside.md", "base"],
      ["nested ../ path", root, "wiki/../../outside.md", "base"],
      ["./ segment", root, "wiki/./concepts/auth-flow.md", "base"],
      ["absolute path", root, "/etc/passwd.md", "base"],
      ["leading '-' segment", root, "-rf.md", "base"],
      ["inner '-' segment", root, "wiki/concepts/--help.md", "base"],
      [".sync path", root, ".sync/base/wiki/concepts/auth-flow.md", "base"],
      ["dot file", root, "wiki/concepts/.hidden.md", "base"],
      ["backslashes", root, "wiki\\concepts\\auth-flow.md", "base"],
      ["colon", root, "C:/auth-flow.md", "base"],
      ["not a page", root, "config.json", "base"],
      ["control character", root, `wiki/concepts/a${String.fromCharCode(0x0a)}b.md`, "base"],
      ["empty path", root, "", "base"],
      ["ref HEAD", root, AUTH, "HEAD"],
      ["ref main", root, AUTH, "main"],
      ["short sha", root, AUTH, "abc123"],
      ["ref flag", root, AUTH, "--help"],
      ["empty ref", root, AUTH, ""],
    ];
    for (const [label, r, relPath, ref] of cases) {
      const uri = toContexoUri(repo.fileUri("wiki/concepts/auth-flow.md"), ref, r, relPath);
      await assert.rejects(async () => vscode.workspace.fs.readFile(uri), fsError("FileNotFound", label));
      const st = await vscode.workspace.fs.stat(uri);
      assert.equal(st.type, vscode.FileType.File, `${label}: stat never throws`);
      assert.equal(st.size, 0, `${label}: stat size`);
    }
    // Malformed queries (not built by toContexoUri on purpose).
    const file = repo.fileUri(AUTH);
    for (const query of ["not json", JSON.stringify({ ref: "base", path: AUTH }), JSON.stringify({ ref: "base", root: 42, path: AUTH }), "null"]) {
      await assert.rejects(async () => vscode.workspace.fs.readFile(file.with({ scheme: "contexo", query })), fsError("FileNotFound", `query ${query}`));
    }
    assert.deepEqual(cli.callsOf("show"), [], "nothing reached ctx");
  });

  it("a status change of base.sha fires onDidChangeFile for the read URI, and the next read refetches", async () => {
    // The registered provider, through workspace.fs.
    const uri = contexoUri(AUTH, "base");
    const length = need(SHOW_BYTES[`${AUTH}@base`], "auth base").length;
    await vscode.workspace.fs.readFile(uri);
    await vscode.workspace.fs.readFile(uri);
    assert.equal(cli.callsOf("show").length, 1);
    const before = await vscode.workspace.fs.stat(uri);
    assert.equal(before.size, length);

    repo.setStatus(edited(repo.status, AUTH, baseSha(NEW_SHA_1)));

    const evicted = await vscode.workspace.fs.stat(uri);
    assert.ok(evicted.mtime > before.mtime, `stat mtime moves on eviction (${before.mtime} -> ${evicted.mtime})`);
    await vscode.workspace.fs.readFile(uri);
    assert.equal(cli.callsOf("show").length, 2, "the next read refetches");
    assert.equal((await vscode.workspace.fs.stat(uri)).size, length);

    // The event, on a provider constructed over the same services.
    const p = constructed();
    await p.readFile(uri);
    const events: vscode.FileChangeEvent[][] = [];
    disposables.push(p.onDidChangeFile((e) => events.push(e)));

    repo.setStatus(edited(repo.status, AUTH, baseSha(NEW_SHA_2)));

    assert.equal(events.length, 1, "exactly one event");
    assert.deepEqual(
      need(events[0], "event").map((e) => ({ type: e.type, uri: e.uri.toString() })),
      [{ type: vscode.FileChangeType.Changed, uri: uri.toString() }],
    );

    repo.setStatus(edited(repo.status, RETRY, (e) => { e.remote = { ...need(e.remote, "remote"), sha: NEW_SHA_1 }; }));
    repo.setStatus(edited(repo.status, AUTH, (e) => { e.title = "Auth flow (renamed)"; }));
    assert.equal(events.length, 1, "a status change that does not touch auth-flow's base fires nothing");
  });

  it("a repository opened later is tracked; a closed one is forgotten", async () => {
    const p = constructed();
    const events: vscode.FileChangeEvent[][] = [];
    disposables.push(p.onDidChangeFile((e) => events.push(e)));
    const later = fakeRepository({ root: vscode.Uri.file(path.join(os.tmpdir(), "contexo-e4-fs-later")), status: "mixed" });
    disposables.push(later);
    model.addRepository(later);
    const uri = toContexoUri(later.fileUri(AUTH), "server", later.root.fsPath, AUTH);

    await p.readFile(uri);
    assert.deepEqual(cli.callsOf("show"), [[later.root.fsPath, AUTH, "server"]]);
    later.setStatus(edited(later.status, AUTH, (e) => { e.remote = { ...need(e.remote, "remote"), sha: NEW_SHA_1 }; }));
    assert.deepEqual(events.map((batch) => batch.map((e) => e.uri.toString())), [[uri.toString()]]);

    await p.readFile(uri);
    model.removeRepository(later);
    await assert.rejects(p.readFile(uri), fsError("FileNotFound", "closed repository"));
    later.setStatus(edited(later.status, AUTH, (e) => { e.remote = { ...need(e.remote, "remote"), sha: NEW_SHA_2 }; }));
    assert.equal(events.length, 1, "a closed repository's status changes are no longer followed");
    assert.equal(cli.callsOf("show").length, 2);
  });
});
