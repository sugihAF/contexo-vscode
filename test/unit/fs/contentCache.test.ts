// The contexo: content cache (src/fs/contentCache.ts) in plain mocha: plain {id} objects
// stand in for vscode.Uri, and the StatusDoc is the 'mixed' scenario's (no vscode import).
import * as assert from "node:assert/strict";
import type { PageEntry, StatusDoc } from "../../../src/contract/types";
import {
  CONTENT_CACHE_CAPACITY,
  ContentCache,
  isContractRelPath,
  keyInputs,
  refKind,
  sameInputs,
  type ContentCacheOptions,
} from "../../../src/fs/contentCache";
import { loadStatusDoc } from "../../helpers/fixtures";
import { waitFor } from "../../helpers/waitFor";

interface FakeUri { id: string; }

const ROOT = "/work/space";
const OTHER_ROOT = "/other/space";
const AUTH = "wiki/concepts/auth-flow.md";
const RETRY = "wiki/concepts/retry-policy.md";
const LEGACY = "wiki/concepts/legacy-sync.md";
const BILLING = "wiki/entities/billing.md";
const SYNC_MODEL = "wiki/analyses/sync-model.md";
const SHA_A = "0123456789abcdef0123456789abcdef01234567";
const SHA_B = "89abcdef0123456789abcdef0123456789abcdef";
const HASH_X = "sha256:" + "a".repeat(64);

const uri = (relPath: string, ref: string, root = ROOT): FakeUri => ({ id: `contexo:${root}/.contexo/${relPath}?${ref}` });
const bytesOf = (s: string): Uint8Array => new TextEncoder().encode(s);
const text = (b: Uint8Array): string => new TextDecoder().decode(b);
const ids = (us: readonly FakeUri[]): string[] => us.map((u) => u.id).sort();

function need<T>(v: T | undefined, what = "value"): T {
  if (v === undefined) { throw new Error(`missing ${what}`); }
  return v;
}

function pageIn(doc: StatusDoc, path: string): PageEntry {
  return need(doc.pages.find((p) => p.path === path), `page ${path}`);
}

interface Deferred<T> { promise: Promise<T>; resolve(v: T): void; reject(e: unknown): void; }
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

type Fetcher = (root: string, relPath: string, ref: string, n: number) => Promise<Uint8Array>;
const DEFAULT_FETCHER: Fetcher = async (_root, relPath, ref, n) => bytesOf(`${relPath}@${ref}#${n}`);

/**
 * A cache over a mutable StatusDoc (page() reads `doc` at call time, for every root) and a
 * logging fetcher whose default answer names the call number, so a refetch is visible.
 */
class Harness {
  doc: StatusDoc = loadStatusDoc("mixed");
  readonly calls: [string, string, string][] = [];
  fetcher: Fetcher = DEFAULT_FETCHER;
  readonly cache: ContentCache<FakeUri>;

  constructor(o: Pick<ContentCacheOptions<FakeUri>, "capacity" | "recordCapacity"> = {}) {
    this.cache = new ContentCache<FakeUri>({
      ...o,
      fetch: (root, relPath, ref) => {
        this.calls.push([root, relPath, ref]);
        return this.fetcher(root, relPath, ref, this.calls.length);
      },
      page: (_root, relPath) => this.doc.pages.find((p) => p.path === relPath),
      uriKey: (u) => u.id,
    });
  }

  read(relPath: string, ref: string, root = ROOT, u = uri(relPath, ref, root)): Promise<Uint8Array> {
    return this.cache.read(root, relPath, ref, u);
  }

  /** Edit a deep copy of the current doc's `path` entry, make it current, then invalidate(root). */
  change(path: string, edit: (p: PageEntry) => void, root = ROOT): FakeUri[] {
    const next = structuredClone(this.doc);
    edit(pageIn(next, path));
    this.doc = next;
    return this.cache.invalidate(root);
  }
}

const newBaseSha = (sha: string) => (p: PageEntry): void => { p.base = { ...need(p.base, "base"), sha }; };

describe("contentCache", () => {
  it("a second read of the same key does not fetch", async () => {
    const h = new Harness();
    const first = await h.read(AUTH, "base");
    const second = await h.read(AUTH, "base");
    assert.deepEqual(h.calls, [[ROOT, AUTH, "base"]]);
    assert.equal(text(second), `${AUTH}@base#1`);
    assert.notEqual(first, second, "every read returns its own copy");
    first.fill(0);
    assert.equal(text(await h.read(AUTH, "base", ROOT, { id: "another editor's uri" })), `${AUTH}@base#1`, "a caller cannot corrupt the cached bytes");
    assert.equal(h.calls.length, 1);
    assert.equal(h.cache.entryCount, 1);
    assert.equal(h.cache.sizeOf(ROOT, AUTH, "base"), second.length);
    assert.equal(h.cache.sizeOf(ROOT, AUTH, "server"), 0, "nothing cached for another ref");
  });

  it("concurrent reads of one key fetch once", async () => {
    const h = new Harness();
    const d = deferred<Uint8Array>();
    h.fetcher = () => d.promise;
    const u1 = uri(AUTH, "base");
    const u2 = { id: `${u1.id}#second-editor` };
    const p1 = h.read(AUTH, "base", ROOT, u1);
    const p2 = h.read(AUTH, "base", ROOT, u2);
    await waitFor(() => h.calls.length === 1);
    d.resolve(bytesOf("shared"));
    const [b1, b2] = await Promise.all([p1, p2]);
    assert.equal(text(b1), "shared");
    assert.equal(text(b2), "shared");
    assert.notEqual(b1, b2, "each waiter gets its own copy");
    await h.read(AUTH, "base");
    assert.equal(h.calls.length, 1, "one fetch for both waiters and the later read");
    assert.deepEqual(ids(h.change(AUTH, newBaseSha(SHA_B))), ids([u1, u2]), "both waiters' URIs were remembered as served");
  });

  it("a base.sha change for auth-flow evicts only that base entry and reports exactly its served URI", async () => {
    const h = new Harness();
    const keys: [string, string][] = [[AUTH, "base"], [AUTH, "server"], [AUTH, SHA_A], [RETRY, "base"], [RETRY, "server"]];
    for (const [p, r] of keys) { await h.read(p, r); }
    assert.equal(h.cache.entryCount, 5);
    assert.equal(h.calls.length, 5);

    const fired = h.change(AUTH, newBaseSha(SHA_B));

    assert.deepEqual(fired, [uri(AUTH, "base")]);
    assert.equal(h.cache.entryCount, 4);
    assert.ok(h.cache.version(uri(AUTH, "base")) > 0, "the evicted URI's version moved (stat mtime)");
    for (const [p, r] of keys.slice(1)) { assert.equal(h.cache.version(uri(p, r)), 0, `${p}@${r} keeps version 0`); }
    for (const [p, r] of keys) { await h.read(p, r); }
    assert.deepEqual(h.calls.slice(5), [[ROOT, AUTH, "base"]], "only the evicted entry is fetched again");
    assert.deepEqual(h.cache.invalidate(ROOT), [], "no input changed since: nothing to report");
  });

  it("a base.hash change with the same sha also evicts", async () => {
    const h = new Harness();
    await h.read(AUTH, "base");
    await h.read(AUTH, "server");

    assert.deepEqual(h.change(AUTH, (p) => { p.base = { ...need(p.base), hash: HASH_X }; }), [uri(AUTH, "base")]);
    const v1 = h.cache.version(uri(AUTH, "base"));
    assert.ok(v1 > 0);
    await h.read(AUTH, "base");
    assert.equal(h.calls.length, 3, "the base is fetched again");

    // A verified base that turns stale (known -> unknown) evicts as well.
    assert.deepEqual(h.change(AUTH, (p) => { p.base = { ...need(p.base), stale: true }; }), [uri(AUTH, "base")]);
    assert.ok(h.cache.version(uri(AUTH, "base")) > v1, "every eviction moves the version again");
    assert.equal(h.cache.entryCount, 1, "the server entry stays");
  });

  it("a remote.sha change evicts server entries only", async () => {
    const h = new Harness();
    for (const [p, r] of [[AUTH, "base"], [AUTH, "server"], [AUTH, SHA_A], [RETRY, "server"]] as const) { await h.read(p, r); }

    const fired = h.change(AUTH, (p) => { p.remote = { ...need(p.remote), sha: SHA_B }; });

    assert.deepEqual(fired, [uri(AUTH, "server")]);
    assert.equal(h.cache.entryCount, 3);
    await h.read(AUTH, "base");
    await h.read(AUTH, SHA_A);
    await h.read(RETRY, "server");
    assert.equal(h.calls.length, 4, "base, explicit-sha and other pages' entries stay cached");

    // remote disappearing (known -> unknown) evicts the server entry too.
    await h.read(AUTH, "server");
    assert.deepEqual(h.change(AUTH, (p) => { delete p.remote; }), [uri(AUTH, "server")]);
  });

  it("an unknown sha is never cached", async () => {
    const h = new Harness();
    // legacy-sync: stale base without a hash; billing: no base; sync-model: no remote; and a page not in the status.
    const unknown: [string, string][] = [[LEGACY, "base"], [BILLING, "base"], [SYNC_MODEL, "server"], ["wiki/concepts/not-listed.md", "base"]];
    for (const [p, r] of unknown) {
      await h.read(p, r);
      await h.read(p, r);
    }
    assert.equal(h.calls.length, 8, "every read of an unknown version fetches");
    assert.equal(h.cache.entryCount, 0);
    assert.equal(h.cache.sizeOf(ROOT, LEGACY, "base"), 0);

    assert.deepEqual(h.change(BILLING, (p) => { p.title = "Billing"; }), [], "unknown -> unknown is no change");

    // The URI that was served is still reported once the version becomes known.
    const fired = h.change(LEGACY, (p) => { p.base = { sha: need(p.base).sha, hash: HASH_X, stale: false }; });
    assert.deepEqual(fired, [uri(LEGACY, "base")]);
    assert.ok(h.cache.version(uri(LEGACY, "base")) > 0);
    await h.read(LEGACY, "base");
    await h.read(LEGACY, "base");
    assert.equal(h.calls.length, 9, "a known version is cached");
    assert.equal(h.cache.entryCount, 1);
  });

  it("a fetch error is not cached", async () => {
    const h = new Harness();
    const d = deferred<Uint8Array>();
    h.fetcher = () => d.promise;
    const boom = new Error("ctx show failed");
    const failed = [h.read(AUTH, "base", ROOT, { id: "failed-1" }), h.read(AUTH, "base", ROOT, { id: "failed-2" })];
    await waitFor(() => h.calls.length === 1);
    d.reject(boom);
    const settled = await Promise.allSettled(failed);
    assert.deepEqual(settled.map((s) => s.status), ["rejected", "rejected"], "every waiter rejects");
    for (const s of settled) { assert.equal((s as PromiseRejectedResult).reason, boom); }
    assert.equal(h.calls.length, 1);
    assert.equal(h.cache.entryCount, 0);

    // A fetcher that throws synchronously leaves nothing behind either.
    h.fetcher = () => { throw new Error("sync throw"); };
    await assert.rejects(h.read(AUTH, "base", ROOT, { id: "failed-3" }), /sync throw/);
    assert.equal(h.calls.length, 2);

    h.fetcher = DEFAULT_FETCHER;
    const ok = uri(AUTH, "base");
    assert.equal(text(await h.read(AUTH, "base", ROOT, ok)), `${AUTH}@base#3`, "the next read fetches again");
    assert.equal(h.calls.length, 3);
    assert.deepEqual(h.change(AUTH, newBaseSha(SHA_B)), [ok], "failed reads are never reported");
  });

  it("the LRU never exceeds 200 entries", async () => {
    assert.equal(CONTENT_CACHE_CAPACITY, 200);
    const h = new Harness();
    const shas = Array.from({ length: 250 }, (_, i) => i.toString(16).padStart(40, "0"));
    for (const sha of shas.slice(0, 200)) { await h.read(AUTH, sha); }
    assert.equal(h.cache.entryCount, 200);
    await h.read(AUTH, need(shas[0]));
    assert.equal(h.calls.length, 200, "a hit (and it becomes the most recently used)");
    for (const sha of shas.slice(200)) {
      await h.read(AUTH, sha);
      assert.ok(h.cache.entryCount <= 200, `entryCount ${h.cache.entryCount}`);
    }
    assert.equal(h.cache.entryCount, 200);
    assert.equal(h.cache.version(uri(AUTH, need(shas[0]))), 0, "the touched entry survived");
    for (const sha of shas.slice(1, 51)) { assert.ok(h.cache.version(uri(AUTH, sha)) > 0, `${sha} was evicted`); }
    for (const sha of shas.slice(51)) { assert.equal(h.cache.version(uri(AUTH, sha)), 0, `${sha} stays`); }
    assert.equal(h.cache.sizeOf(ROOT, AUTH, need(shas[1])), 0);

    const before = h.calls.length;
    await h.read(AUTH, need(shas[0]));
    await h.read(AUTH, need(shas[249]));
    assert.equal(h.calls.length, before, "cached entries are hits");
    await h.read(AUTH, need(shas[1]));
    assert.equal(h.calls.length, before + 1, "an evicted entry is fetched again");
    assert.equal(h.cache.entryCount, 200);
  });

  it("an entry the LRU dropped still reports its URI when its version changes; served records are bounded too", async () => {
    const h = new Harness({ capacity: 1 });
    await h.read(AUTH, "base");
    await h.read(RETRY, "base");
    assert.equal(h.cache.entryCount, 1);
    assert.ok(h.cache.version(uri(AUTH, "base")) > 0, "the LRU eviction moved the version");
    assert.equal(h.cache.sizeOf(ROOT, AUTH, "base"), 0);
    assert.deepEqual(h.change(AUTH, newBaseSha(SHA_B)), [uri(AUTH, "base")]);

    const tiny = new Harness({ capacity: 1, recordCapacity: 1 });
    await tiny.read(AUTH, "base");
    await tiny.read(RETRY, "base"); // AUTH base -> served record
    await tiny.read(AUTH, "server"); // RETRY base -> served record; the AUTH base record is the oldest and goes
    assert.deepEqual(tiny.change(AUTH, newBaseSha(SHA_B)), [], "the oldest served record was dropped");
    assert.deepEqual(tiny.change(RETRY, newBaseSha(SHA_B)), [uri(RETRY, "base")]);
  });

  it("a status change while a fetch is in flight refetches, so a stale version is never cached or returned", async () => {
    const h = new Harness();
    const pending: Deferred<Uint8Array>[] = [];
    h.fetcher = () => { const d = deferred<Uint8Array>(); pending.push(d); return d.promise; };
    const u = uri(AUTH, "base");
    const read = h.read(AUTH, "base", ROOT, u);
    await waitFor(() => pending.length === 1);
    assert.deepEqual(h.change(AUTH, newBaseSha(SHA_B)), [], "nothing was served yet");
    need(pending[0]).resolve(bytesOf("old"));
    await waitFor(() => pending.length === 2);
    need(pending[1]).resolve(bytesOf("new"));
    assert.equal(text(await read), "new");
    assert.equal(text(await h.read(AUTH, "base")), "new", "cached under the new base");
    assert.equal(h.calls.length, 2);

    // A version that keeps moving: at most 3 attempts, returned but never cached, and its
    // URI is still reported by the next change.
    const churn = new Harness();
    const waiting: Deferred<Uint8Array>[] = [];
    churn.fetcher = () => { const d = deferred<Uint8Array>(); waiting.push(d); return d.promise; };
    const r = uri(RETRY, "base");
    const moving = churn.read(RETRY, "base", ROOT, r);
    for (let i = 0; i < 3; i++) {
      await waitFor(() => waiting.length === i + 1);
      churn.change(RETRY, newBaseSha(String(i).repeat(40)));
      need(waiting[i]).resolve(bytesOf(`v${i}`));
    }
    assert.equal(text(await moving), "v2");
    assert.equal(churn.calls.length, 3, "at most 3 attempts");
    assert.equal(churn.cache.entryCount, 0, "a version that never settled is not cached");
    assert.deepEqual(churn.change(RETRY, (p) => { p.base = { ...need(p.base), hash: HASH_X }; }), [r]);
  });

  it("invalidate is per root and prefers the lookup; dropRoot forgets a root, in-flight reads included", async () => {
    const h = new Harness();
    await h.read(AUTH, "base");
    await h.read(AUTH, "base", OTHER_ROOT);
    assert.equal(h.cache.entryCount, 2);
    assert.deepEqual(h.change(AUTH, newBaseSha(SHA_B)), [uri(AUTH, "base")], "only ROOT's entry");
    assert.deepEqual(h.cache.invalidate(OTHER_ROOT), [uri(AUTH, "base", OTHER_ROOT)]);

    // The lookup wins over page(): page() still says SHA_B, the lookup says SHA_A.
    await h.read(AUTH, "base");
    const changed = { ...pageIn(h.doc, AUTH), base: { ...need(pageIn(h.doc, AUTH).base), sha: SHA_A } };
    assert.deepEqual(h.cache.invalidate(ROOT, (rel) => (rel === AUTH ? changed : h.doc.pages.find((p) => p.path === rel))), [uri(AUTH, "base")]);
    assert.deepEqual(h.cache.invalidate(ROOT, (rel) => h.doc.pages.find((p) => p.path === rel)), [], "no entry left to evict");

    await h.read(AUTH, "base");
    await h.read(AUTH, "base", OTHER_ROOT);
    const d = deferred<Uint8Array>();
    h.fetcher = () => d.promise;
    const inFlight = h.read(RETRY, "base");
    await waitFor(() => h.calls.some(([, rel]) => rel === RETRY));
    h.cache.dropRoot(ROOT);
    assert.equal(h.cache.entryCount, 1, "OTHER_ROOT's entry stays");
    d.resolve(bytesOf("late"));
    assert.equal(text(await inFlight), "late", "an in-flight read still resolves");
    assert.equal(h.cache.entryCount, 1, "but a dropped root is never stored again by it");
    assert.deepEqual(h.change(AUTH, newBaseSha(SHA_A)), [], "nothing of ROOT is left to report");
    h.fetcher = DEFAULT_FETCHER;
    const n = h.calls.length;
    await h.read(AUTH, "base");
    assert.equal(h.calls.length, n + 1, "ROOT's entry is fetched again");
  });

  it("invalidate reports each URI once (by uriKey)", async () => {
    const h = new Harness();
    await h.read(AUTH, "base", ROOT, { id: "shared" });
    await h.read(AUTH, "server", ROOT, { id: "shared" });
    const fired = h.change(AUTH, (p) => {
      p.base = { ...need(p.base), sha: SHA_A };
      p.remote = { ...need(p.remote), sha: SHA_B };
    });
    assert.deepEqual(fired, [{ id: "shared" }]);
    assert.equal(h.cache.entryCount, 0);
  });

  it("refKind accepts base, server and a 7-64 hex sha only", () => {
    assert.equal(refKind("base"), "base");
    assert.equal(refKind("server"), "server");
    for (const sha of ["abcdef1", "ABCDEF0123", SHA_A, "f".repeat(64)]) { assert.equal(refKind(sha), "sha", sha); }
    for (const bad of ["empty", "", "HEAD", "main", "abcdef", "f".repeat(65), "g123456", "base ", "abcdef1\n", " abcdef1", "Base", undefined, 42]) {
      assert.equal(refKind(bad), undefined, JSON.stringify(bad));
    }
  });

  it("isContractRelPath mirrors ctx's ValidateRelPath", () => {
    const good = [
      AUTH,
      "raw/sessions/2026-10-01-login-debug.md",
      "a.md",
      "index.md",
      "wiki/concepts/naïve café.md",
      `wiki/entities/smile-${String.fromCodePoint(0x1f600)}.md`,
      "wiki/concepts/x&y=z#1.md",
    ];
    for (const p of good) { assert.equal(isContractRelPath(p), true, p); }
    const ctl = (c: number): string => `wiki/a${String.fromCharCode(c)}b.md`;
    const bad: unknown[] = [
      "", "/wiki/a.md", "../a.md", "../../etc/passwd.md", "wiki/../a.md", "wiki/../../a.md", "./a.md", "wiki/./a.md",
      "wiki//a.md", "wiki/a.md/", "-rf.md", "wiki/-x.md", ".sync/base/wiki/concepts/auth-flow.md", "wiki/.hidden.md",
      ".md", "wiki\\a.md", "..\\a.md", "C:/a.md", "wiki/a:b.md", "wiki/a.txt", "wiki/a", "wiki/a.MD", "wiki/a.md.bak",
      ctl(0), ctl(0x0a), ctl(0x09), ctl(0x1f), ctl(0x7f),
      `wiki/${String.fromCharCode(0xd800)}.md`, `wiki/${String.fromCharCode(0xdc00)}.md`,
      `wiki/a${String.fromCharCode(0xdbff)}`, `wiki/${String.fromCharCode(0xdc00, 0xd800)}.md`,
      undefined, null, 42,
    ];
    for (const p of bad) { assert.equal(isContractRelPath(p), false, JSON.stringify(p)); }
  });

  it("keyInputs: base needs a verified base with a hash, server needs remote.sha, a sha ref keys itself", () => {
    const doc = loadStatusDoc("mixed");
    const auth = pageIn(doc, AUTH);
    assert.deepEqual(keyInputs(auth, "base"), { sha: need(auth.base).sha, hash: need(need(auth.base).hash) });
    assert.deepEqual(keyInputs(auth, "server"), { sha: need(auth.remote).sha });
    assert.deepEqual(keyInputs(auth, SHA_A), { sha: SHA_A });
    assert.deepEqual(keyInputs(undefined, SHA_A), { sha: SHA_A }, "an explicit sha is always known");
    assert.equal(keyInputs(pageIn(doc, LEGACY), "base"), undefined, "stale base without a hash");
    assert.equal(keyInputs({ ...auth, base: { ...need(auth.base), stale: true } }, "base"), undefined, "stale base");
    assert.equal(keyInputs({ ...auth, base: { sha: need(auth.base).sha, stale: false } }, "base"), undefined, "base without a hash");
    assert.equal(keyInputs(pageIn(doc, BILLING), "base"), undefined, "incoming_new has no base");
    assert.deepEqual(keyInputs(pageIn(doc, BILLING), "server"), { sha: need(pageIn(doc, BILLING).remote).sha });
    assert.equal(keyInputs(pageIn(doc, SYNC_MODEL), "server"), undefined, "new page: no remote");
    assert.equal(keyInputs(undefined, "base"), undefined);
    assert.equal(keyInputs(auth, "empty"), undefined);
    assert.equal(keyInputs(auth, "HEAD"), undefined);

    assert.equal(sameInputs(undefined, undefined), true);
    assert.equal(sameInputs({ sha: SHA_A }, { sha: SHA_A }), true);
    assert.equal(sameInputs({ sha: SHA_A, hash: HASH_X }, { sha: SHA_A, hash: HASH_X }), true);
    assert.equal(sameInputs({ sha: SHA_A, hash: HASH_X }, { sha: SHA_A }), false);
    assert.equal(sameInputs({ sha: SHA_A }, { sha: SHA_B }), false);
    assert.equal(sameInputs({ sha: SHA_A }, undefined), false);
    assert.equal(sameInputs(undefined, { sha: SHA_A }), false);
  });
});
