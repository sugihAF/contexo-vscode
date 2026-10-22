// WP-1.8: src/model/repository.ts over an injected host (no VS Code): the status signature,
// the stateMerge wiring, pageAt case rules, the ctx gate and the watcher set.
import * as assert from "node:assert/strict";
import { CtxError } from "../../../src/cli/types";
import type { StatusDoc } from "../../../src/contract/types";
import { WATCH_GLOBS } from "../../../src/model/refreshScheduler";
import { Repository, statusSignature } from "../../../src/model/repository";
import { FakeCtxCli } from "../../helpers/fakeCtxCli";
import { loadStatusDoc } from "../../helpers/fixtures";
import { FakeHost, Uri, fakeConfig, fakeLog } from "./fakeHost";

const ROOT = Uri.file("/ws/repo");

describe("model/repository", () => {
  let repo: Repository | undefined;
  let cli: FakeCtxCli;
  let host: FakeHost;
  let gate: boolean;
  let settled: number;
  let notInitialized: number;

  function build(platform: NodeJS.Platform = "linux"): Repository {
    cli = new FakeCtxCli();
    host = new FakeHost(platform);
    gate = true;
    settled = 0;
    notInitialized = 0;
    repo = new Repository({
      root: ROOT,
      cli,
      log: fakeLog(),
      config: fakeConfig(),
      host,
      canRunCtx: () => gate,
      onNotInitialized: () => { notInitialized++; },
      onDidSettle: () => { settled++; },
    });
    repo.start();
    return repo;
  }

  afterEach(() => {
    repo?.dispose();
    repo = undefined;
  });

  it("statusSignature ignores generated_at and fetched_at and changes with each listed field", () => {
    const base = loadStatusDoc("mixed");
    const sig = statusSignature(base);
    const same = structuredClone(base);
    same.generated_at = "2030-01-01T00:00:00Z";
    same.remote.fetched_at = "2030-01-01T00:00:00Z";
    assert.equal(statusSignature(same), sig);

    const edits: [string, (d: StatusDoc) => void][] = [
      ["page state", (d) => { d.pages[0]!.state = "modified"; }],
      ["conflict_kind", (d) => { d.pages.find((p) => p.state === "conflict")!.conflict_kind = "both_added"; }],
      ["base.sha", (d) => { d.pages[0]!.base!.sha = "f".repeat(40); }],
      ["base.hash", (d) => { d.pages[0]!.base!.hash = `sha256:${"0".repeat(64)}`; }],
      ["base.stale", (d) => { d.pages[0]!.base!.stale = true; }],
      ["remote.sha", (d) => { d.pages[0]!.remote!.sha = "e".repeat(40); }],
      ["invalid.message", (d) => { d.pages.find((p) => p.state === "invalid")!.invalid!.message = "other"; }],
      ["counts", (d) => { d.counts.ahead++; }],
      ["auth.state", (d) => { d.auth.state = "rejected"; }],
      ["captures.pending", (d) => { d.captures.pending++; }],
      ["captures.fresh", (d) => { d.captures.fresh++; }],
      ["captures.blocks_push", (d) => { d.captures.blocks_push = true; }],
      ["remote.source", (d) => { d.remote.source = "none"; }],
      ["remote.error.code", (d) => { d.remote.error = { code: "network", message: "x", advice: [], retryable: true }; }],
      ["title", (d) => { d.pages[0]!.title = "Renamed"; }],
      ["type", (d) => { d.pages[0]!.type = "entity"; }],
      ["tags", (d) => { d.pages[0]!.tags = ["x"]; }],
      ["a new path", (d) => { d.pages.push({ ...structuredClone(d.pages[0]!), path: "wiki/zz.md" }); }],
    ];
    for (const [name, edit] of edits) {
      const d = structuredClone(base);
      edit(d);
      assert.notEqual(statusSignature(d), sig, name);
    }
  });

  it("an identical refresh does not fire onDidChangeStatus; a changed one fires {previous, current}", async () => {
    const r = build();
    const events: { previous: StatusDoc | undefined; current: StatusDoc }[] = [];
    r.onDidChangeStatus((e) => events.push(e));
    await r.refresh({ remote: true });
    assert.equal(events.length, 1);
    assert.equal(events[0]?.previous, undefined);
    assert.equal(events[0]?.current, r.status);

    const next = loadStatusDoc("mixed");
    next.generated_at = "2030-01-01T00:00:00Z";
    cli.setResult("status", next);
    await r.refresh({ remote: true });
    assert.equal(events.length, 1, "only timestamps differ");
    assert.equal(r.status?.generated_at, "2030-01-01T00:00:00Z", "the latest doc is still kept");

    const changed = loadStatusDoc("mixed");
    changed.pages[0]!.state = "modified";
    cli.setResult("status", changed);
    await r.refresh({ remote: true });
    assert.equal(events.length, 2);
    assert.equal(events[1]?.previous?.generated_at, "2030-01-01T00:00:00Z");
    assert.equal(events[1]?.current.pages[0]?.state, "modified");
    assert.ok(settled >= 3);
  });

  it("an offline refresh after an online one carries the online incoming (stateMerge) and keeps remote.source none", async () => {
    const r = build();
    await r.refresh({ remote: true });
    assert.equal(r.status?.remote.source, "live");
    await r.refresh({ remote: false });
    assert.deepEqual(cli.callsOf("status").map((a) => a[1]), [{ offline: false }, { offline: true }]);
    assert.equal(r.status?.remote.source, "none");
    const retry = r.status?.pages.find((p) => p.path === "wiki/concepts/retry-policy.md");
    assert.equal(retry?.state, "incoming", "the online incoming survives the offline refresh");
    assert.equal(r.status?.pages.some((p) => p.path === "wiki/entities/billing.md" && p.state === "incoming_new"), true);
  });

  it("an offline refresh without a previous online result is shown as ctx reported it", async () => {
    const r = build();
    await r.refresh({ remote: false });
    assert.deepEqual(r.status, loadStatusDoc("mixed", { offline: true }));
  });

  it("pageAt matches case-insensitively on darwin, exactly on linux; fileUri and relPathOf round-trip", async () => {
    for (const platform of ["darwin", "linux"] as const) {
      const r = build(platform);
      await r.refresh({ remote: true });
      const exact = r.fileUri("wiki/concepts/auth-flow.md");
      assert.equal(exact.toString(), Uri.joinPath(ROOT, ".contexo", "wiki", "concepts", "auth-flow.md").toString());
      assert.equal(r.relPathOf(exact), "wiki/concepts/auth-flow.md");
      assert.equal(r.pageAt(exact)?.path, "wiki/concepts/auth-flow.md");
      const upper = Uri.file("/ws/repo/.contexo/WIKI/Concepts/Auth-Flow.md");
      assert.equal(r.pageAt(upper)?.path, platform === "darwin" ? "wiki/concepts/auth-flow.md" : undefined, platform);
      assert.equal(r.pageAt(Uri.file("/ws/repo/README.md")), undefined);
      assert.equal(r.relPathOf(Uri.file("/ws/repo/.contexo")), undefined);
      r.dispose();
    }
  });

  it("no ctx status runs while canRunCtx() is false", async () => {
    const r = build();
    gate = false;
    await r.refresh({ remote: true });
    await r.refresh({ remote: false });
    assert.equal(cli.callsOf("status").length, 0);
    assert.equal(r.status, undefined);
  });

  it("a failed status lands in lastError (a non-CtxError as spawn_failed) and the next success clears it; not_initialized is reported", async () => {
    const r = build();
    cli.enqueue("status", new Error("boom"));
    await r.refresh({ remote: true });
    assert.equal(r.lastError?.code, "spawn_failed");
    assert.match(r.lastError?.message ?? "", /boom/);
    await r.refresh({ remote: true });
    assert.equal(r.lastError === undefined, true, "a success clears lastError");
    const env = JSON.stringify({ schema: "ctx.error.v1", exit_code: 5, error: { code: "not_initialized", message: "no .contexo", advice: ["ctx init"], retryable: false } });
    cli.enqueue("status", CtxError.fromProcess(env, 5));
    await r.refresh({ remote: false });
    assert.equal(notInitialized, 1);
    assert.equal(r.lastError?.code, "not_initialized");
  });

  it("creates the three watchers on the folder; the pending watcher ignores change events", () => {
    build();
    const globs = host.watchers.map((w) => [w.folder.toString(), w.glob, w.ignoreChangeEvents]);
    assert.deepEqual(globs, [
      [ROOT.toString(), WATCH_GLOBS.md, false],
      [ROOT.toString(), WATCH_GLOBS.json, false],
      [ROOT.toString(), WATCH_GLOBS.pending, true],
    ]);
    assert.equal(WATCH_GLOBS.json, ".contexo/*.json", "E28: the glob, never the credentials literal");
    repo?.dispose();
    assert.ok(host.watchers.every((w) => w.disposed));
  });

  it("run(push) sets operation while fn runs, then refreshes online before it settles", async () => {
    const r = build();
    const ops: (string | undefined)[] = [];
    r.onDidChangeOperation((k) => ops.push(k));
    let during: string | undefined;
    const result = await r.run("push", async () => { during = r.operation; return 7; });
    assert.equal(result, 7);
    assert.equal(during, "push");
    assert.equal(r.operation, undefined);
    assert.deepEqual(ops, ["push", undefined]);
    assert.deepEqual(cli.callsOf("status").map((a) => a[1]), [{ offline: false }]);
    assert.ok(r.status, "the caller reads the post-operation status");
  });
});
