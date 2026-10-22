// Gutter quick diff (src/scm/quickDiff.ts): the pure quickDiffSpec predicate and
// originalResource over a FakeRepository (test/helpers, loaded over the vscode stub that
// test:unit preloads). File URIs come from vscode-uri; no vscode import.
import * as assert from "node:assert/strict";
import { URI } from "vscode-uri";
import type { PageEntry, StatusDoc } from "../../../src/contract/types";
import { fromContexoUri, toContexoUri } from "../../../src/fs/contexoUri";
import { isSyncPath, originalResource, quickDiffSpec, type QuickDiffRepository } from "../../../src/scm/quickDiff";
import { fakeRepository } from "../../helpers/fakeRepository";
import { loadStatusDoc } from "../../helpers/fixtures";

type VsUri = Parameters<typeof originalResource>[1];
const asVs = (u: URI): VsUri => u as unknown as VsUri;

const ROOT = "/ws/basic";
const P = {
  loginDebug: "raw/sessions/2026-10-01-login-debug.md",
  syncModel: "wiki/analyses/sync-model.md",
  authFlow: "wiki/concepts/auth-flow.md",
  broken: "wiki/concepts/broken.md",
  legacySync: "wiki/concepts/legacy-sync.md",
  oldName: "wiki/concepts/old-name.md",
  rateLimits: "wiki/concepts/rate-limits.md",
  retryPolicy: "wiki/concepts/retry-policy.md",
  billing: "wiki/entities/billing.md",
  gitstore: "wiki/entities/gitstore.md",
} as const;

/** The working file <ROOT>/.contexo/<rel>. */
const fileOf = (rel: string): VsUri => asVs(URI.file(`${ROOT}/.contexo/${rel}`));

function pageOf(doc: StatusDoc, relPath: string): PageEntry {
  const p = doc.pages.find((e) => e.path === relPath);
  if (!p) { throw new Error(`no page ${relPath}`); }
  return p;
}

/** A repository over 'mixed' with the page at relPath edited by `edit`. */
function repoWith(relPath: string, edit: (p: PageEntry) => void): ReturnType<typeof fakeRepository> {
  const doc = loadStatusDoc("mixed");
  edit(pageOf(doc, relPath));
  return fakeRepository({ root: ROOT, status: doc });
}

describe("scm quickDiff", () => {
  const repo = fakeRepository({ root: ROOT, status: "mixed" });

  it("base spec for auth-flow, retry-policy and rate-limits (and unchanged gitstore); originalResource is the contexo base URI of the file", () => {
    const doc = loadStatusDoc("mixed");
    for (const rel of [P.authFlow, P.retryPolicy, P.rateLimits, P.gitstore, P.loginDebug]) {
      assert.deepEqual(quickDiffSpec(rel, pageOf(doc, rel)), { kind: "contexo", ref: "base", relPath: rel }, rel);

      const uri = fileOf(rel);
      const original = originalResource(repo, uri);
      assert.ok(original, `${rel}: an original`);
      assert.equal(original.scheme, "contexo", `${rel}: scheme`);
      assert.equal(original.path, uri.path, `${rel}: path equals the file's path`);
      const parsed = fromContexoUri(original);
      assert.equal(parsed.ref, "base", `${rel}: ref`);
      assert.equal(parsed.root, repo.root.fsPath, `${rel}: root`);
      assert.equal(parsed.relPath, rel, `${rel}: relPath`);
      assert.equal(original.toString(), toContexoUri(repo.fileUri(rel), "base", repo.root.fsPath, rel).toString(), `${rel}: built with toContexoUri`);
    }
  });

  it("undefined for new, invalid, unverified, both_added, a stale base, incoming_new and deleted_local", () => {
    const doc = loadStatusDoc("mixed");
    for (const rel of [P.syncModel, P.broken, P.legacySync, P.billing, P.oldName]) {
      assert.equal(quickDiffSpec(rel, pageOf(doc, rel)), undefined, `${rel} (${pageOf(doc, rel).state}): spec`);
      assert.equal(originalResource(repo, fileOf(rel)), undefined, `${rel}: originalResource`);
    }

    const bothAdded = repoWith(P.rateLimits, (p) => { p.conflict_kind = "both_added"; delete p.base; });
    assert.equal(originalResource(bothAdded, fileOf(P.rateLimits)), undefined, "both_added conflict");
    const bothAddedWithBase = repoWith(P.rateLimits, (p) => { p.conflict_kind = "both_added"; });
    assert.equal(originalResource(bothAddedWithBase, fileOf(P.rateLimits)), undefined, "both_added, even with a base");

    const stale = repoWith(P.authFlow, (p) => { p.base = { sha: p.base?.sha ?? "", stale: true }; });
    assert.equal(originalResource(stale, fileOf(P.authFlow)), undefined, "modified with base.stale=true");
    const noBase = repoWith(P.retryPolicy, (p) => { delete p.base; });
    assert.equal(originalResource(noBase, fileOf(P.retryPolicy)), undefined, "incoming without a base");
  });

  it("undefined for files outside .contexo, under .contexo/.sync (any case) and for non-file schemes", () => {
    for (const p of ["/ws/basic/README.md", "/elsewhere/x.md", "/ws/basic/.contexo", "/ws/basic/wiki/concepts/auth-flow.md"]) {
      assert.equal(originalResource(repo, asVs(URI.file(p))), undefined, p);
    }
    for (const p of [
      "/ws/basic/.contexo/.sync/base/wiki/concepts/auth-flow.md",
      "/ws/basic/.contexo/.SYNC/base/wiki/concepts/auth-flow.md",
    ]) {
      assert.equal(originalResource(repo, asVs(URI.file(p))), undefined, p);
    }

    // Even a repository that maps every file to a valid page refuses a .sync path.
    const authFlow = pageOf(loadStatusDoc("mixed"), P.authFlow);
    const permissive: QuickDiffRepository = {
      root: repo.root,
      fileUri: (rel) => repo.fileUri(rel),
      relPathOf: (uri) => repo.relPathOf(uri),
      pageAt: () => authFlow,
    };
    assert.ok(originalResource(permissive, fileOf(P.authFlow)), "control: the permissive repo answers a page path");
    for (const rel of [".sync/base/wiki/concepts/auth-flow.md", ".SYNC/base/wiki/concepts/auth-flow.md", ".Sync/x.md"]) {
      assert.equal(originalResource(permissive, fileOf(rel)), undefined, rel);
      assert.equal(quickDiffSpec(rel, authFlow), undefined, `${rel}: spec`);
    }

    const contexoUri = toContexoUri(repo.fileUri(P.authFlow), "base", repo.root.fsPath, P.authFlow);
    assert.equal(repo.relPathOf(contexoUri), P.authFlow, "control: the repository resolves the contexo: URI");
    assert.equal(originalResource(repo, contexoUri), undefined, "the contexo: URI of auth-flow itself");
    assert.equal(originalResource(repo, asVs(URI.parse("untitled:Untitled-1"))), undefined, "untitled:");
    assert.equal(originalResource(repo, asVs(URI.file(`${ROOT}/.contexo/${P.authFlow}`).with({ scheme: "vscode-userdata" }))),
      undefined, "another scheme with a page path");
  });

  it("quickDiffSpec(undefined, page) and quickDiffSpec(rel, undefined) are undefined; isSyncPath matches the first segment only", () => {
    const authFlow = pageOf(loadStatusDoc("mixed"), P.authFlow);
    assert.equal(quickDiffSpec(undefined, authFlow), undefined);
    assert.equal(quickDiffSpec(P.authFlow, undefined), undefined);
    assert.equal(isSyncPath(".sync/x.md"), true);
    assert.equal(isSyncPath(".Sync/x"), true);
    assert.equal(isSyncPath(".SYNC/base/wiki/a.md"), true);
    assert.equal(isSyncPath("wiki/.sync.md"), false);
    assert.equal(isSyncPath("wiki/.sync/a.md"), false);
    assert.equal(isSyncPath(".syncx/a.md"), false);
    assert.equal(isSyncPath("wiki/concepts/a.md"), false);
  });
});
