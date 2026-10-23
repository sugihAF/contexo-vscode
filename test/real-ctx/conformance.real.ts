// Real ctx conformance (WP-3.1), plain node mocha (no vscode at runtime): real ctx success
// documents and the live smoke envelopes (not_initialized, conflict, distill_required, busy),
// validated against contract/schemas with ajv and parsed by src/contract/types.ts. Every case
// runs in fresh projects under $REAL_CTX_RUN/conf/<case>/ on the `${REAL_CTX_REPO}-conf` repo
// (all cases share it, so each one asserts only on its own conf-<case>-* pages). Every
// extension-shaped call goes through runCtx (the extension's E26 spawn env) with the E25 argv
// from argv.ts; only the per-case init/login/set-repo setup spawns ctx directly.
//
// Precedence for contract matters: Contract errata > contract > the WP-3.1 section. A real ctx
// that is off-contract while TS matches is a Go defect: GFR-A<n> plus it.skip with the repro.
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { classifyProbe, gate } from "../../src/cli/capabilities";
import {
  PAGE_STATES, groupFor, parseDoc, parseEnvelope,
  type Doc, type ErrorCode, type ErrorEnvelope, type PageState, type PullDoc, type PushDoc,
  type ResolveDoc, type SchemaId, type StatusDoc, type VersionDoc,
} from "../../src/contract/types";
import { ctxArgv } from "./argv";
import { EXT_VERSION, lastStderrLine, runCtx, type CtxRun } from "./ctx";
import { realCtxEnv } from "./env";
import {
  E16_TIME, E2_EXIT, E2_RETRYABLE, confCase, ownedBy, readRel, schemaErrors, setupCtx,
  slugOf, strictSchemaErrors, syncPath, syncTreeHashes, timeStrings, writePage, writeRel,
  type ConfCase, type ConfUser,
} from "./confKit";
import { startHoldingProxy } from "./holdingProxy";
import { withMcpSession } from "./mcpDriver";
import { brokenPageText, relPathOf } from "./pages";

/** E19: the 11 v1 capabilities in contract order, then 'repair' (a v0.7.0 / dev build). */
const V1_CAPABILITIES_THEN_REPAIR = [
  "status.json", "status.offline", "show.base", "show.server", "show.sha",
  "pull.json", "push.json", "push.paths", "push.distill_guard", "resolve", "errors.envelope",
  "repair",
];
/** E13: what a v1 server advertises (pages.etag is reserved and never required). */
const SERVER_CAPS = ["pages.at", "push.expect_absent", "write.path_sha"];
/** E9/E31(c): the only states status --offline can report without a sidecar. */
const OFFLINE_NO_SIDECAR_STATES: readonly PageState[] = ["new", "modified", "unchanged", "invalid", "deleted_local", "unverified"];
const SHA40 = /^[0-9a-f]{40}$/;
/** The contract SCM group of every PageState (page_states SCM GROUP MAPPING, E29). */
const GROUP_OF: Readonly<Record<PageState, string | undefined>> = {
  conflict: "conflicts", modified: "changes", deleted_local: "changes", new: "new",
  incoming: "incoming", incoming_new: "incoming", invalid: "invalid", unchanged: undefined, unverified: undefined,
};

/** Every validated document, for the strict pass at the end. */
const collected: { label: string; schema: SchemaId; doc: unknown }[] = [];

function byteSorted(paths: readonly string[]): string[] {
  return [...paths].sort((x, y) => Buffer.compare(Buffer.from(x), Buffer.from(y)));
}

function assertTimes(doc: unknown, label: string): void {
  for (const [ptr, v] of timeStrings(doc)) {
    assert.ok(typeof v === "string" && E16_TIME.test(v), `${label}: ${ptr} = ${JSON.stringify(v)} is not an E16 time`);
  }
}

/**
 * A success document on stdout: exit code, stderr (empty unless allowed), exactly one JSON
 * document, valid against the schema, parseDoc, E16 times. Collected for the strict pass.
 */
function expectDoc<T extends Doc>(r: CtxRun, schema: T["schema"], label: string, o: { exit?: number; stderr?: "empty" | "any" } = {}): T {
  assert.equal(r.code, o.exit ?? 0, `${label}: exit code (argv ${JSON.stringify(r.args)})\nstderr: ${r.stderr}\nstdout: ${r.stdout}`);
  if ((o.stderr ?? "empty") === "empty") { assert.equal(r.stderr, "", `${label}: stderr is empty`); }
  let raw: unknown;
  assert.doesNotThrow(() => { raw = JSON.parse(r.stdout); }, `${label}: stdout is exactly one JSON document:\n${r.stdout}`);
  assert.deepEqual(schemaErrors(schema, raw), [], `${label}: validates against ${schema}`);
  const doc = parseDoc<T>(r.stdout, schema);
  assert.equal(doc.schema, schema);
  assertTimes(raw, label);
  collected.push({ label, schema, doc: raw });
  return doc;
}

/**
 * A live error envelope: the last non-empty stderr line validates against ctx.error.v1, its
 * exit_code equals the process exit code and E2(1), retryable follows E2(1), and parseEnvelope
 * round-trips it to the same code. Collected for the strict pass.
 */
function expectEnvelope(r: CtxRun, code: ErrorCode, label: string): ErrorEnvelope {
  assert.equal(r.code, E2_EXIT[code], `${label}: exit ${E2_EXIT[code]} for ${code} (E2(1)); argv ${JSON.stringify(r.args)}\nstderr: ${r.stderr}`);
  const line = lastStderrLine(r.stderr);
  let raw: unknown;
  assert.doesNotThrow(() => { raw = JSON.parse(line); }, `${label}: the last non-empty stderr line is JSON:\n${r.stderr}`);
  assert.deepEqual(schemaErrors("ctx.error.v1", raw), [], `${label}: validates against ctx.error.v1`);
  const own = raw as ErrorEnvelope;
  assert.equal(own.exit_code, r.code, `${label}: envelope exit_code == process exit code`);
  assert.equal(own.error.code, code, `${label}: code`);
  assert.equal(own.error.retryable, E2_RETRYABLE.has(code), `${label}: retryable per E2(1)`);
  assertTimes(raw, label);
  const env = parseEnvelope(r.stderr, r.code);
  assert.equal(env.error.code, code, `${label}: parseEnvelope code`);
  assert.equal(env.exit_code, r.code, `${label}: parseEnvelope exit_code`);
  assert.equal(env.error.retryable, own.error.retryable, `${label}: parseEnvelope retryable`);
  collected.push({ label, schema: "ctx.error.v1", doc: raw });
  return env;
}

// ---------- extension-shaped calls (E25 argv through runCtx) ----------

function status(u: ConfUser, offline: boolean): Promise<CtxRun> {
  return runCtx(u.home, ctxArgv.status(u.root, offline));
}
function push(u: ConfUser, o: { message?: string; paths?: string[] } = {}): Promise<CtxRun> {
  return runCtx(u.home, ctxArgv.push(u.root, o));
}
function pull(u: ConfUser): Promise<CtxRun> {
  return runCtx(u.home, ctxArgv.pull(u.root));
}
function show(u: ConfUser, rel: string, ref: string): Promise<CtxRun> {
  return runCtx(u.home, ctxArgv.show(u.root, rel, ref));
}

async function pushOk(u: ConfUser, label: string, paths?: string[]): Promise<PushDoc> {
  const doc = expectDoc<PushDoc>(await push(u, paths ? { paths } : {}), "ctx.push.v1", label);
  assert.deepEqual(doc.conflicts, [], `${label}: no conflicts`);
  return doc;
}
async function pullOk(u: ConfUser, label: string): Promise<PullDoc> {
  return expectDoc<PullDoc>(await pull(u), "ctx.pull.v1", label);
}
async function statusOk(u: ConfUser, offline: boolean, label: string): Promise<StatusDoc> {
  return expectDoc<StatusDoc>(await status(u, offline), "ctx.status.v1", label);
}

function shaOf(doc: PushDoc, rel: string): string {
  const p = doc.pushed.find((x) => x.path === rel);
  assert.ok(p?.sha !== undefined && SHA40.test(p.sha), `pushed ${rel} with a 40-hex sha: ${JSON.stringify(doc.pushed)}`);
  return p.sha;
}

function pageOf(doc: StatusDoc, rel: string) {
  const p = doc.pages.find((x) => x.path === rel);
  assert.ok(p, `status lists ${rel}`);
  return p;
}

/** The project's .sync/conflicts.json records, or {} when it does not exist. */
function sidecars(u: ConfUser): Record<string, Record<string, unknown>> {
  const f = syncPath(u, "conflicts.json");
  if (!fs.existsSync(f)) { return {}; }
  const j = JSON.parse(fs.readFileSync(f, "utf8")) as { schema: string; conflicts: Record<string, Record<string, unknown>> };
  assert.equal(j.schema, "ctx.conflicts.v1", "conflicts.json schema (E8)");
  return j.conflicts;
}

/**
 * WP-2.2's after-listing race: alice (behind a holding proxy) and bob edit P; alice also edits
 * Q; bob's push lands after alice's push listed the server and before it sent, so alice's push
 * gets a real 409 for P while Q is committed (exit 6). Returns alice's push run.
 */
async function race(caseName: string): Promise<{ c: ConfCase; p: string; q: string; baseP: string; bobSha: string; r: CtxRun }> {
  const e = realCtxEnv();
  const proxy = await startHoldingProxy(e.server);
  try {
    const c = await confCase(caseName, { serverA: proxy.url });
    const p = writePage(c.a, { type: "concept", slug: slugOf(c.name, "p"), body: "Nightly batch." });
    const q = writePage(c.a, { type: "entity", slug: slugOf(c.name, "q"), body: "Owns the ledger." });
    const seed = await pushOk(c.a, `${caseName}: alice seeds P and Q`, [p, q]);
    const baseP = shaOf(seed, p);
    await pullOk(c.b, `${caseName}: bob pulls`);
    writePage(c.b, { type: "concept", slug: slugOf(c.name, "p"), author: "alice", body: "Bob: batch at 02:00." });
    writePage(c.a, { type: "concept", slug: slugOf(c.name, "p"), body: "Alice: batch at 03:00." });
    writePage(c.a, { type: "entity", slug: slugOf(c.name, "q"), body: "Alice: also owns refunds." });
    const inHook: { bob?: CtxRun } = {};
    proxy.setAfterList(async () => { inHook.bob = await push(c.b, { paths: [p] }); });
    const r = await push(c.a);
    const hook = proxy.hookRuns();
    assert.equal(hook.count, 1, "the race hook ran once (alice's push listed through the proxy)");
    assert.equal(hook.error, undefined, `the race hook did not throw: ${String(hook.error)}`);
    assert.ok(inHook.bob, "bob pushed inside the race hook");
    const bobSha = shaOf(expectDoc<PushDoc>(inHook.bob, "ctx.push.v1", `${caseName}: bob's push inside the race`), p);
    return { c, p, q, baseP, bobSha, r };
  } finally {
    await proxy.close();
  }
}

function writeBuffer(u: ConfUser, sessionId: string): string {
  const file = path.join(u.hub, "raw", "sessions", "_pending", `${sessionId}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const ts = new Date(Math.floor(Date.now() / 1000) * 1000).toISOString().replace(".000Z", "Z");
  fs.writeFileSync(file, `${JSON.stringify({ ts, turn: 1, user: "Why retry three times?", assistant: "Because the ledger is idempotent." })}\n`);
  return file;
}

describe("real ctx conformance (WP-3.1)", function () {
  this.timeout(120000);

  // ---------- version ----------

  it("version --json: dev build and the 0.7.0-rc.1 stamp validate and pass the WP-1.7 handshake (E19, E25, E36)", async () => {
    const e = realCtxEnv();
    const home = path.join(e.run, "conf", "version", "home");
    fs.mkdirSync(home, { recursive: true });
    const argv = ctxArgv.version();
    assert.deepEqual(argv, ["version", "--json"], "E25: version argv, no --root");
    for (const [bin, version, dev] of [[e.ctxBin, "dev", true], [e.ctxBinRc, "0.7.0-rc.1", false]] as const) {
      const r = await runCtx(home, argv, { bin });
      const doc = expectDoc<VersionDoc>(r, "ctx.version.v1", `version --json (${version})`);
      assert.equal(doc.contract_version, 1);
      assert.equal(doc.version, version);
      assert.equal(doc.dev_build, dev);
      assert.deepEqual(doc.capabilities, V1_CAPABILITIES_THEN_REPAIR, "E19: contract order, then repair");
      const state = gate(bin, classifyProbe({ args: r.args, stdout: r.stdoutBytes, stderr: r.stderr, exitCode: r.code, signal: null, durationMs: 0 }));
      assert.equal(state.kind, "ok", `E36 handshake for ${version}: ${JSON.stringify(state)}`);
      if (state.kind === "ok") {
        assert.equal(state.path, bin);
        assert.equal(state.version.version, version);
      }
    }
  });

  // ---------- status ----------

  it("status --json online: one valid document, sorted pages, counts, server capabilities, E16 times, E41 .sync/.gitignore", async () => {
    const c = await confCase("status-online");
    const name = c.name;
    const mine = ownedBy(name);
    assert.ok(!fs.existsSync(syncPath(c.a, ".gitignore")), "no .sync before the first write");
    const unchanged = writePage(c.a, { type: "concept", slug: slugOf(name, 1), body: "Pushed and untouched." });
    const modified = writePage(c.a, { type: "entity", slug: slugOf(name, 2), body: "Pushed, then edited by alice." });
    const incoming = writePage(c.a, { type: "concept", slug: slugOf(name, 5), body: "Pushed, then edited by bob." });
    await pushOk(c.a, `${name}: alice seeds`, [unchanged, modified, incoming]);
    const ignore = fs.readFileSync(syncPath(c.a, ".gitignore"), "utf8");
    assert.ok(ignore.split(/\r?\n/).includes("*"), `E41: .sync/.gitignore contains '*' after the first write: ${JSON.stringify(ignore)}`);
    await pullOk(c.b, `${name}: bob pulls`);
    writePage(c.b, { type: "concept", slug: slugOf(name, 5), author: "alice", body: "Bob changed this." });
    const incomingNew = writePage(c.b, { type: "analysis", slug: slugOf(name, 4), body: "Bob's new page." });
    await pushOk(c.b, `${name}: bob pushes`, [incoming, incomingNew]);
    writePage(c.a, { type: "entity", slug: slugOf(name, 2), body: "Alice changed this." });
    const fresh = writePage(c.a, { type: "concept", slug: slugOf(name, 3), body: "Alice's new page." });

    const r = await status(c.a, false);
    assert.deepEqual(r.args, ["status", "--json", "--root", c.a.root], "E25 status argv");
    const doc = expectDoc<StatusDoc>(r, "ctx.status.v1", `${name}: status --json`);
    assert.equal(doc.offline, false);
    assert.equal(doc.remote.source, "live");
    assert.ok(doc.remote.fetched_at !== undefined, "live remote has fetched_at");
    const paths = doc.pages.map((p) => p.path);
    assert.deepEqual(paths, byteSorted(paths), "pages sorted by path (byte order)");
    assert.equal(doc.counts.ahead, doc.counts.modified + doc.counts.new, "counts.ahead == modified + new");
    assert.equal(doc.counts.behind, doc.counts.incoming + doc.counts.incoming_new, "counts.behind == incoming + incoming_new");
    for (const s of PAGE_STATES) {
      assert.equal(doc.counts[s], doc.pages.filter((p) => p.state === s).length, `counts.${s} == pages in state ${s}`);
    }
    assert.equal(doc.project.dashboard_url, "", "E23: a self-hosted server without a dashboard reports dashboard_url \"\"");
    assert.equal(doc.project.dashboard_page_url_template, undefined, "E23: no page URL template when dashboard_url is \"\"");
    assert.equal(doc.server.capabilities_known, true);
    assert.deepEqual([...doc.server.capabilities].sort(), [...SERVER_CAPS].sort(), "E13: exactly pages.at, push.expect_absent, write.path_sha");
    const states = Object.fromEntries(doc.pages.filter(mine).map((p) => [p.path, p.state]));
    assert.deepEqual(states, {
      [unchanged]: "unchanged", [modified]: "modified", [fresh]: "new", [incomingNew]: "incoming_new", [incoming]: "incoming",
    });
    for (const p of doc.pages) {
      assert.ok(PAGE_STATES.includes(p.state), `${p.path}: a v1 PageState`);
      assert.equal(groupFor(p.state), GROUP_OF[p.state], `${p.path}: groupFor(${p.state})`);
    }
  });

  it("status --json --offline without a sidecar: remote.source none, auth unchecked, only offline states (E8, E9, E31)", async () => {
    const c = await confCase("offline-plain");
    const name = c.name;
    const mine = ownedBy(name);
    const u = writePage(c.a, { type: "concept", slug: slugOf(name, "unchanged"), body: "Same." });
    const m = writePage(c.a, { type: "concept", slug: slugOf(name, "modified"), body: "Before." });
    const d = writePage(c.a, { type: "entity", slug: slugOf(name, "deleted"), body: "Soon gone locally." });
    const rc = writePage(c.a, { type: "concept", slug: slugOf(name, "remote-changed"), body: "Bob edits this." });
    await pushOk(c.a, `${name}: alice seeds`, [u, m, d, rc]);
    await pullOk(c.b, `${name}: bob pulls`);
    writePage(c.b, { type: "concept", slug: slugOf(name, "remote-changed"), author: "alice", body: "Bob's edit." });
    const bobNew = writePage(c.b, { type: "concept", slug: slugOf(name, "bob-new"), body: "Only on the server." });
    await pushOk(c.b, `${name}: bob pushes`, [rc, bobNew]);
    writePage(c.a, { type: "concept", slug: slugOf(name, "modified"), body: "After." });
    fs.rmSync(path.join(c.a.hub, ...d.split("/")));
    const n = writePage(c.a, { type: "analysis", slug: slugOf(name, "new"), body: "Local only." });
    const inv = relPathOf("concept", slugOf(name, "invalid"));
    writeRel(c.a, inv, brokenPageText(slugOf(name, "invalid")));

    const r = await status(c.a, true);
    assert.deepEqual(r.args, ["status", "--json", "--root", c.a.root, "--offline"], "E25 status --offline argv");
    const doc = expectDoc<StatusDoc>(r, "ctx.status.v1", `${name}: status --json --offline`);
    assert.equal(doc.offline, true);
    assert.equal(doc.remote.source, "none", "E8/E31: offline remote.source is none");
    assert.ok(!("fetched_at" in doc.remote), "no fetched_at offline");
    assert.equal(doc.auth.state, "unchecked");
    for (const p of doc.pages) {
      assert.ok(OFFLINE_NO_SIDECAR_STATES.includes(p.state), `${p.path}: ${p.state} is not an offline no-sidecar state (E31(c))`);
    }
    const states = Object.fromEntries(doc.pages.filter(mine).map((p) => [p.path, p.state]));
    assert.deepEqual(states, {
      [u]: "unchanged", [m]: "modified", [d]: "deleted_local", [rc]: "unchanged", [n]: "new", [inv]: "invalid",
    }, `offline states (bob's ${bobNew} is unknown offline)`);
    assert.deepEqual(Object.keys(sidecars(c.a)).filter((p) => mine({ path: p })), [], "no sidecar in this project");
  });

  it("status --json --offline after a push 409: the page is a conflict whose remote side is only the 409 server sha (E9, E10)", async () => {
    const name = "offline-sidecar";
    const { c, p, q, baseP, bobSha, r } = await race(name);
    const pushed = expectDoc<PushDoc>(r, "ctx.push.v1", `${name}: alice's raced push`, { exit: 6, stderr: "any" });
    const conflict = pushed.conflicts.find((x) => x.path === p);
    assert.ok(conflict, `the 409 conflict for ${p}`);
    assert.equal(conflict.server_sha, bobSha, "the 409 server sha is bob's commit");
    const rec = sidecars(c.a)[p];
    assert.ok(rec, `.sync/conflicts.json records ${p}`);
    assert.equal(rec.source, "push", "a push-sourced sidecar (E10)");
    assert.equal(rec.server_sha, conflict.server_sha);
    assert.equal(rec.base_sha, baseP);
    assert.equal(rec.kind, "both_modified");
    assert.equal(rec.has_content, true);
    assert.ok(typeof rec.detected_at === "string" && E16_TIME.test(rec.detected_at), "detected_at is an E16 time");
    assert.deepEqual(fs.readFileSync(syncPath(c.a, "conflicts", p)), readRel(c.b, p), ".sync/conflicts/<p> holds the server content");

    const doc = await statusOk(c.a, true, `${name}: status --json --offline`);
    assert.equal(doc.remote.source, "none");
    assert.ok(!("fetched_at" in doc.remote));
    assert.equal(doc.auth.state, "unchecked");
    const e = pageOf(doc, p);
    assert.equal(e.state, "conflict", "the sidecar makes P a conflict offline (E9)");
    assert.equal(e.conflict_kind, "both_modified");
    assert.deepEqual(e.remote, { sha: conflict.server_sha }, "the sidecar remote side is {sha} only, the 409 server sha");
    assert.equal(pageOf(doc, q).state, "unchanged", "Q was committed in the same push");
  });

  // ---------- show ----------

  it("show --at base | server | <sha>: exact bytes, exit 0, empty stderr (E20, E25)", async () => {
    const c = await confCase("show");
    const name = c.name;
    const rel = writePage(c.a, { type: "concept", slug: slugOf(name, 1), body: "Version one." });
    await pushOk(c.a, `${name}: alice pushes v1`, [rel]);
    writePage(c.a, { type: "concept", slug: slugOf(name, 1), body: "Version two." });
    await pushOk(c.a, `${name}: alice pushes v2`, [rel]);
    const pulled = await pullOk(c.b, `${name}: bob pulls`);
    assert.ok(pulled.written.some((w) => w.path === rel), "bob receives the page");
    writePage(c.a, { type: "concept", slug: slugOf(name, 1), body: "Version three, local only." });
    const st = await statusOk(c.a, false, `${name}: status`);
    const entry = pageOf(st, rel);
    assert.equal(entry.state, "modified");
    assert.ok(entry.remote?.sha !== undefined && SHA40.test(entry.remote.sha), "remote.sha");

    const base = await show(c.a, rel, "base");
    assert.deepEqual(base.args, ["show", rel, "--at", "base", "--root", c.a.root], "E25: show argv has no --json");
    const server = await show(c.a, rel, "server");
    const atSha = await show(c.a, rel, entry.remote.sha);
    for (const [label, r] of [["base", base], ["server", server], ["sha", atSha]] as const) {
      assert.equal(r.code, 0, `show --at ${label}: exit 0\n${r.stderr}`);
      assert.equal(r.stderr, "", `show --at ${label}: empty stderr`);
    }
    assert.deepEqual(base.stdoutBytes, fs.readFileSync(syncPath(c.a, "base", rel)), "--at base == .sync/base/<p>");
    assert.deepEqual(server.stdoutBytes, readRel(c.b, rel), "--at server == the file bob received from ctx pull");
    assert.deepEqual(atSha.stdoutBytes, server.stdoutBytes, "--at <remote.sha> == --at server");
    assert.notDeepEqual(base.stdoutBytes, readRel(c.a, rel), "the working file moved on (not the base)");
  });

  // ---------- push ----------

  it("push: ok (E25 argv with -m and --)", async () => {
    const e = realCtxEnv();
    const c = await confCase("push-ok");
    const name = c.name;
    const p1 = writePage(c.a, { type: "concept", slug: slugOf(name, 1), body: "One." });
    const p2 = writePage(c.a, { type: "entity", slug: slugOf(name, 2), body: "Two." });
    const r = await push(c.a, { message: "conformance push ok", paths: [p1, p2] });
    assert.deepEqual(r.args, ["push", "--json", "--yes", "--root", c.a.root, "-m", "conformance push ok", "--", p1, p2], "E25 push argv");
    const doc = expectDoc<PushDoc>(r, "ctx.push.v1", `${name}: push`);
    assert.equal(doc.dry_run, false);
    assert.equal(doc.message, "conformance push ok");
    assert.equal(doc.server_url, e.server);
    assert.equal(doc.repo_id, c.repo);
    assert.ok(doc.new_head !== undefined && SHA40.test(doc.new_head), "new_head");
    assert.deepEqual(doc.pushed.map((p) => [p.path, p.kind]), [[p1, "create"], [p2, "create"]]);
    for (const p of doc.pushed) { assert.ok(p.sha !== undefined && SHA40.test(p.sha), `${p.path}: sha`); }
    assert.deepEqual(doc.conflicts, []);
    assert.deepEqual(doc.skipped, []);
    assert.deepEqual(doc.distill, { required: false, bypassed: false });

    // E15 attribution: recorded as a NOTE only (the legacy key records no activity rows).
    try {
      const res = await fetch(`${e.server}/v1/repos/${encodeURIComponent(c.repo)}/activity`, { headers: { Authorization: `Bearer ${e.key}` } });
      const body = await res.text();
      const want = `contexo-vscode/${EXT_VERSION}`;
      console.log(`NOTE E15: GET /v1/repos/${c.repo}/activity -> ${res.status}; client ${want} ${body.includes(want) ? "present" : "absent"} (${body.length} bytes: ${body.slice(0, 160)})`);
    } catch (err) {
      console.log(`NOTE E15: activity request failed: ${String(err)}`);
    }
  });

  it("push --dry-run: no sha, no new_head, and .sync is byte-identical before and after (E8, E31(h))", async () => {
    const c = await confCase("push-dry-run");
    const name = c.name;
    const p1 = writePage(c.a, { type: "concept", slug: slugOf(name, 1), body: "One." });
    await pushOk(c.a, `${name}: seed`, [p1]);
    writePage(c.a, { type: "concept", slug: slugOf(name, 1), body: "One, edited." });
    const p3 = writePage(c.a, { type: "entity", slug: slugOf(name, 3), body: "New." });
    const inv = relPathOf("concept", slugOf(name, "invalid"));
    writeRel(c.a, inv, brokenPageText(slugOf(name, "invalid")));
    const before = syncTreeHashes(c.a);
    assert.ok(Object.keys(before).length > 0, ".sync exists");

    // '--dry-run' is appended to the E25 argv; without named paths, since anything after '--' is a path.
    const argv = [...ctxArgv.push(c.a.root, { message: "conformance dry run" }), "--dry-run"];
    const doc = expectDoc<PushDoc>(await runCtx(c.a.home, argv), "ctx.push.v1", `${name}: push --dry-run`);
    assert.equal(doc.dry_run, true);
    assert.ok(!("new_head" in doc), "no new_head on a dry run");
    assert.deepEqual(doc.pushed.map((p) => [p.path, p.kind]), [[p1, "update"], [p3, "create"]]);
    for (const p of doc.pushed) { assert.ok(!("sha" in p), `${p.path}: no sha on a dry run`); }
    assert.deepEqual(doc.conflicts, []);
    assert.deepEqual(doc.skipped.filter(ownedBy(name)), [{ path: inv, state: "invalid", reason: "invalid" }]);
    assert.deepEqual(syncTreeHashes(c.a), before, "E8: a dry run writes nothing under .sync");
  });

  it("push nothing: a named unchanged path is skipped with reason unchanged", async () => {
    const c = await confCase("push-nothing");
    const name = c.name;
    const p1 = writePage(c.a, { type: "concept", slug: slugOf(name, 1), body: "Pushed once." });
    await pushOk(c.a, `${name}: seed`, [p1]);
    const doc = expectDoc<PushDoc>(await push(c.a, { paths: [p1] }), "ctx.push.v1", `${name}: push -- <unchanged>`);
    assert.deepEqual(doc.pushed, []);
    assert.deepEqual(doc.conflicts, []);
    assert.deepEqual(doc.skipped, [{ path: p1, state: "unchanged", reason: "unchanged" }]);
    assert.ok(!("new_head" in doc), "nothing was sent: no new_head");
  });

  it("push partial-conflict (409): exit 6 with the PushDoc on stdout AND a conflict envelope with details.paths", async () => {
    const name = "push-partial-conflict";
    const { p, q, baseP, bobSha, r } = await race(name);
    const doc = expectDoc<PushDoc>(r, "ctx.push.v1", `${name}: push`, { exit: 6, stderr: "any" });
    assert.equal(doc.pushed.length, 1, `Q pushed: ${JSON.stringify(doc.pushed)}`);
    assert.equal(doc.pushed[0]?.path, q);
    assert.equal(doc.pushed[0]?.kind, "update");
    assert.ok(SHA40.test(doc.pushed[0]?.sha ?? ""), "Q's new sha");
    assert.deepEqual(doc.conflicts, [{ path: p, kind: "both_modified", base_sha: baseP, server_sha: bobSha }]);
    const env = expectEnvelope(r, "conflict", `${name}: envelope`);
    assert.deepEqual(env.error.details, { paths: [p] });
    assert.equal(env.error.http_status, 409);
  });

  it("push: a conflict found from the listing (no 409) is skipped with reason conflict and the live server sha", async () => {
    const c = await confCase("push-listing-conflict");
    const name = c.name;
    const p = writePage(c.a, { type: "concept", slug: slugOf(name, "p"), body: "Base." });
    await pushOk(c.a, `${name}: seed`, [p]);
    await pullOk(c.b, `${name}: bob pulls`);
    writePage(c.b, { type: "concept", slug: slugOf(name, "p"), author: "alice", body: "Bob's edit." });
    const bobSha = shaOf(await pushOk(c.b, `${name}: bob pushes`, [p]), p);
    writePage(c.a, { type: "concept", slug: slugOf(name, "p"), body: "Alice's edit." });
    const doc = expectDoc<PushDoc>(await push(c.a), "ctx.push.v1", `${name}: alice pushes`);
    assert.deepEqual(doc.pushed, []);
    assert.deepEqual(doc.conflicts, [], "no 409: the listing already showed bob's commit");
    assert.deepEqual(doc.skipped.filter(ownedBy(name)), [{ path: p, state: "conflict", reason: "conflict", server_sha: bobSha }]);
  });

  // GFR-1 (= WP-2.I D2, WP-2.1 REQ-1; E10 is a contract matter, errata first). Repro:
  //   alice and bob share P (pushed by alice, pulled by bob); bob edits and pushes P; alice edits P;
  //   `ctx push --json --yes --root <alice>` -> exit 0, skipped [{P, conflict, server_sha}];
  //   `ctx status --json --offline --root <alice>` -> P is "modified" and .sync/conflicts.json has
  //   no record for P. Wanted after WP-4.1: a push-sourced sidecar for a listing conflict skip
  //   (listing sha + fetched content), so offline status keeps P a conflict and MCP `resolved`
  //   survives an agent restart. Suspected Go: internal/syncops/push.go (pushBatchAll/pushSkip
  //   write no sidecar), internal/mcp/merge.go (briefSHAs only in memory).
  //   Fixed by WP-4.1 (E10 as extended by L28); un-skipped by WP-4.I (L34).
  it("GFR-1 D2: a push conflict found from the listing writes a push sidecar, so offline status keeps it a conflict", async () => {
    const c = await confCase("gfr-1-d2");
    const name = c.name;
    const p = writePage(c.a, { type: "concept", slug: slugOf(name, "p"), body: "Base." });
    await pushOk(c.a, `${name}: seed`, [p]);
    await pullOk(c.b, `${name}: bob pulls`);
    writePage(c.b, { type: "concept", slug: slugOf(name, "p"), author: "alice", body: "Bob's edit." });
    const bobSha = shaOf(await pushOk(c.b, `${name}: bob pushes`, [p]), p);
    writePage(c.a, { type: "concept", slug: slugOf(name, "p"), body: "Alice's edit." });
    expectDoc<PushDoc>(await push(c.a), "ctx.push.v1", `${name}: alice pushes`);
    assert.equal(sidecars(c.a)[p]?.server_sha, bobSha, "a sidecar records the listing conflict");
    const e = pageOf(await statusOk(c.a, true, `${name}: status --offline`), p);
    assert.equal(e.state, "conflict");
    assert.deepEqual(e.remote, { sha: bobSha });
  });

  // ---------- pull ----------

  it("pull: ok (written), then a second pull is up-to-date", async () => {
    const c = await confCase("pull-ok");
    const name = c.name;
    const p1 = writePage(c.a, { type: "concept", slug: slugOf(name, 1), body: "One." });
    const p2 = writePage(c.a, { type: "entity", slug: slugOf(name, 2), body: "Two." });
    const pushed = await pushOk(c.a, `${name}: alice pushes`, [p1, p2]);
    const r = await pull(c.b);
    assert.deepEqual(r.args, ["pull", "--json", "--root", c.b.root], "E25 pull argv");
    const doc = expectDoc<PullDoc>(r, "ctx.pull.v1", `${name}: bob pulls`);
    assert.ok(doc.head !== undefined && SHA40.test(doc.head), "head");
    assert.deepEqual(doc.written.filter(ownedBy(name)), [
      { path: p1, sha: shaOf(pushed, p1), kind: "create" },
      { path: p2, sha: shaOf(pushed, p2), kind: "create" },
    ]);
    assert.deepEqual(doc.adopted.filter(ownedBy(name)), []);
    assert.deepEqual(doc.skipped.filter(ownedBy(name)), []);
    assert.deepEqual(readRel(c.b, p1), readRel(c.a, p1));
    assert.deepEqual(readRel(c.b, p2), readRel(c.a, p2));

    const again = expectDoc<PullDoc>(await pull(c.b), "ctx.pull.v1", `${name}: bob pulls again`);
    assert.deepEqual([again.written, again.adopted, again.skipped], [[], [], []], "up-to-date");
    assert.equal(again.head, doc.head);
  });

  it("pull: skipped (modified, conflict) and adopted (both_added and both_modified with equal content)", async () => {
    const c = await confCase("pull-skipped-adopted");
    const name = c.name;
    const spec = (slug: string, body: string) => ({ type: "concept" as const, slug: slugOf(name, slug), author: "alice", body });
    const w = writePage(c.a, spec("w", "W base."));
    const m = writePage(c.a, spec("m", "M base."));
    const k = writePage(c.a, spec("c", "C base."));
    const x = writePage(c.a, spec("x", "X base."));
    await pushOk(c.a, `${name}: alice seeds`, [w, m, k, x]);
    await pullOk(c.b, `${name}: bob pulls`);
    writePage(c.b, spec("w", "W by bob."));
    writePage(c.b, spec("c", "C by bob."));
    writePage(c.b, spec("x", "X, the same edit on both sides."));
    const n = writePage(c.b, spec("n", "N, created identically on both sides."));
    const bob = await pushOk(c.b, `${name}: bob pushes`, [w, k, x, n]);
    writePage(c.a, spec("m", "M by alice."));
    writePage(c.a, spec("c", "C by alice."));
    writePage(c.a, spec("x", "X, the same edit on both sides."));
    writePage(c.a, spec("n", "N, created identically on both sides."));
    const aliceC = readRel(c.a, k);

    const doc = expectDoc<PullDoc>(await pull(c.a), "ctx.pull.v1", `${name}: alice pulls`);
    assert.deepEqual(doc.written.filter(ownedBy(name)), [{ path: w, sha: shaOf(bob, w), kind: "update" }]);
    assert.deepEqual(doc.adopted.filter(ownedBy(name)).map((a) => [a.path, a.sha]), [[n, shaOf(bob, n)], [x, shaOf(bob, x)]], "adopted: content-equal both_added and both_modified");
    assert.deepEqual(doc.skipped.filter(ownedBy(name)), [
      { path: k, state: "conflict", reason: "conflict", server_sha: shaOf(bob, k) },
      { path: m, state: "modified", reason: "modified" },
    ]);
    assert.deepEqual(readRel(c.a, w), readRel(c.b, w), "W written with bob's content");
    assert.deepEqual(readRel(c.a, k), aliceC, "a conflict is never overwritten");
    assert.equal(sidecars(c.a)[k]?.source, "pull", "a pull conflict skip writes a pull sidecar (E10)");

    const st = await statusOk(c.a, false, `${name}: status after pull`);
    assert.deepEqual(Object.fromEntries(st.pages.filter(ownedBy(name)).map((p) => [p.path, p.state])), {
      [w]: "unchanged", [m]: "modified", [k]: "conflict", [x]: "unchanged", [n]: "unchanged",
    });

    const again = expectDoc<PullDoc>(await pull(c.a), "ctx.pull.v1", `${name}: alice pulls again`);
    assert.deepEqual([again.written.filter(ownedBy(name)), again.adopted.filter(ownedBy(name))], [[], []], "nothing new to write or adopt");
    assert.deepEqual(again.skipped.filter(ownedBy(name)).map((s) => [s.path, s.reason]), [[k, "conflict"], [m, "modified"]], "local edits stay skipped");
  });

  // ---------- resolve ----------

  async function conflicted(name: string): Promise<{ c: ConfCase; p: string; serverSha: string }> {
    const c = await confCase(name);
    const p = writePage(c.a, { type: "concept", slug: slugOf(c.name, "p"), body: "Base." });
    await pushOk(c.a, `${name}: seed`, [p]);
    await pullOk(c.b, `${name}: bob pulls`);
    writePage(c.b, { type: "concept", slug: slugOf(c.name, "p"), author: "alice", body: "Bob's version." });
    const bobSha = shaOf(await pushOk(c.b, `${name}: bob pushes`, [p]), p);
    writePage(c.a, { type: "concept", slug: slugOf(c.name, "p"), body: "Alice's version." });
    const e = pageOf(await statusOk(c.a, false, `${name}: status`), p);
    assert.equal(e.state, "conflict");
    assert.equal(e.remote?.sha, bobSha);
    return { c, p, serverSha: bobSha };
  }

  it("resolve --ours: state modified, file_written false, no backup (E25 argv with --if-server-sha)", async () => {
    const name = "resolve-ours";
    const { c, p, serverSha } = await conflicted(name);
    const mineBefore = readRel(c.a, p);
    const r = await runCtx(c.a.home, ctxArgv.resolve(c.a.root, p, "ours", { ifServerSha: serverSha }));
    assert.deepEqual(r.args, ["resolve", p, "--ours", "--json", "--root", c.a.root, "--if-server-sha", serverSha], "E25 resolve argv");
    const doc = expectDoc<ResolveDoc>(r, "ctx.resolve.v1", `${name}: resolve --ours`);
    assert.equal(doc.path, p);
    assert.equal(doc.strategy, "ours");
    assert.equal(doc.previous_state, "conflict");
    assert.equal(doc.state, "modified");
    assert.equal(doc.base_sha, serverSha);
    assert.equal(doc.file_written, false);
    assert.ok(!("backup_file" in doc), "ours never writes a backup");
    assert.deepEqual(readRel(c.a, p), mineBefore, "the working file is untouched");
  });

  it("resolve --theirs: state unchanged and backup_file exists on disk", async () => {
    const name = "resolve-theirs";
    const { c, p, serverSha } = await conflicted(name);
    const mineBefore = readRel(c.a, p);
    const doc = expectDoc<ResolveDoc>(await runCtx(c.a.home, ctxArgv.resolve(c.a.root, p, "theirs", { ifServerSha: serverSha })), "ctx.resolve.v1", `${name}: resolve --theirs`);
    assert.equal(doc.strategy, "theirs");
    assert.equal(doc.previous_state, "conflict");
    assert.equal(doc.state, "unchanged");
    assert.equal(doc.base_sha, serverSha);
    assert.equal(doc.file_written, true);
    assert.ok(doc.backup_file !== undefined, "backup_file");
    assert.match(doc.backup_file, new RegExp(`^\\.sync/backup/${p.replace(/[.]/g, "\\.")}\\.\\d{8}T\\d{6}Z$`), "backup_file is relative to the hub");
    const backup = path.join(c.a.hub, ...doc.backup_file.split("/"));
    assert.ok(fs.existsSync(backup), `${backup} exists`);
    assert.deepEqual(fs.readFileSync(backup), mineBefore, "the backup holds alice's version");
    assert.deepEqual(readRel(c.a, p), readRel(c.b, p), "the working file is the server version");
  });

  // ---------- live smoke envelopes ----------

  it("smoke not_initialized: status --json in an empty dir exits 5 with a valid envelope", async () => {
    const e = realCtxEnv();
    const dir = path.join(e.run, "conf", "smoke-not-initialized");
    const home = path.join(dir, "home");
    const empty = path.join(dir, "empty");
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(empty, { recursive: true });
    const r = await runCtx(home, ctxArgv.status(empty, false));
    expectEnvelope(r, "not_initialized", "not_initialized");
    assert.equal(r.stdout, "", "no document on stdout");
  });

  it("smoke conflict: a raced push exits 6 with a valid conflict envelope", async () => {
    const name = "smoke-conflict";
    const { p, r } = await race(name);
    const env = expectEnvelope(r, "conflict", "conflict");
    assert.deepEqual(env.error.details, { paths: [p] });
  });

  it("smoke distill_required: refused although CONTEXO_DISTILL_DISABLE=1 is set in this process (E24, E26); bob's listing unchanged", async () => {
    const c = await confCase("smoke-distill");
    const name = c.name;
    const p = writePage(c.a, { type: "concept", slug: slugOf(name, "p"), body: "Knowledge with reasoning." });
    const sessionId = slugOf(name, "session");
    const buffer = writeBuffer(c.a, sessionId);
    try {
      const bobBefore = await statusOk(c.b, false, `${name}: bob before`);

      // Control: the variable is effective when it reaches ctx (a dry run writes nothing;
      // no named paths, since anything after '--' is a path).
      const control = await setupCtx(c.a.home, [...ctxArgv.push(c.a.root, {}), "--dry-run"], c.a.root, { CONTEXO_DISTILL_DISABLE: "1" });
      assert.equal(control.code, 0, `control: dry run with CONTEXO_DISTILL_DISABLE=1\n${control.stderr}`);
      const controlDoc = parseDoc<PushDoc>(control.stdout, "ctx.push.v1");
      assert.deepEqual(controlDoc.distill, { required: true, bypassed: true }, "control: the guard fires and the env var bypasses it");

      const prev = process.env.CONTEXO_DISTILL_DISABLE;
      process.env.CONTEXO_DISTILL_DISABLE = "1";
      let r: CtxRun;
      try {
        r = await push(c.a, { paths: [p] });
      } finally {
        if (prev === undefined) { delete process.env.CONTEXO_DISTILL_DISABLE; } else { process.env.CONTEXO_DISTILL_DISABLE = prev; }
      }
      const env = expectEnvelope(r, "distill_required", "distill_required");
      assert.equal(r.stdout, "", "no document on stdout");
      const details = env.error.details as { pages: string[]; sessions: { session_id: string; turns: number; fresh: boolean }[]; agent_prompt: string };
      assert.deepEqual(details.pages, [p]);
      assert.deepEqual(details.sessions.map((s) => [s.session_id, s.turns, s.fresh]), [[sessionId, 1, true]]);
      assert.ok(typeof details.agent_prompt === "string" && details.agent_prompt.includes(p), "agent_prompt names the page");
      const bobAfter = await statusOk(c.b, false, `${name}: bob after`);
      assert.equal(bobAfter.remote.head, bobBefore.remote.head, "the server head did not move");
      assert.ok(!bobAfter.pages.some((x) => x.path === p), "the page never reached the server");
    } finally {
      fs.rmSync(buffer, { force: true });
    }
  });

  it("smoke busy: a live .sync/lock makes push exit 12 with the holder as details", async function () {
    this.timeout(60000);
    const c = await confCase("smoke-busy");
    const name = c.name;
    const p = writePage(c.a, { type: "concept", slug: slugOf(name, "p"), body: "Locked out." });
    await pushOk(c.a, `${name}: seed (creates .sync)`, [p]);
    writePage(c.a, { type: "concept", slug: slugOf(name, "p"), body: "Locked out, edited." });
    const holder = {
      pid: process.pid,
      host: os.hostname(),
      command: "conformance",
      started_at: new Date(Math.floor(Date.now() / 1000) * 1000).toISOString().replace(".000Z", "Z"),
    };
    const lock = syncPath(c.a, "lock");
    fs.writeFileSync(lock, `${JSON.stringify(holder)}\n`, { flag: "wx" });
    let r: CtxRun;
    try {
      r = await push(c.a, { paths: [p] });
    } finally {
      fs.rmSync(lock, { force: true });
    }
    assert.ok(!fs.existsSync(lock), "the lock is removed");
    const env = expectEnvelope(r, "busy", "busy");
    assert.equal(r.stdout, "", "no document on stdout");
    assert.deepEqual(env.error.details, holder, "busy details are the lock holder");
  });

  // ---------- strict pass ----------

  it("strict pass self-check: the closed schemas report an unknown key (top level and inside error details)", () => {
    const doc = {
      schema: "ctx.push.v1", dry_run: false, message: "m", server_url: "http://127.0.0.1:1", repo_id: "r",
      pushed: [], conflicts: [], skipped: [], distill: { required: false, bypassed: false }, warnings: [],
    };
    assert.deepEqual(strictSchemaErrors("ctx.push.v1", doc), [], "a minimal push document is clean");
    const extra = { ...doc, conformance_unknown: 1 };
    assert.ok(strictSchemaErrors("ctx.push.v1", extra).some((e) => e.includes("conformance_unknown")), "unknown top-level key reported");
    assert.deepEqual(schemaErrors("ctx.push.v1", extra), [], "the normal schema stays open (forward compatible)");
    const busy = {
      schema: "ctx.error.v1", exit_code: 12,
      error: { code: "busy", message: "m", advice: [], retryable: true, details: { pid: 1, host: "h", command: "c", started_at: "2026-10-23T00:00:00Z", conformance_unknown: true } },
    };
    assert.deepEqual(schemaErrors("ctx.error.v1", busy), []);
    assert.ok(strictSchemaErrors("ctx.error.v1", busy).some((e) => e.includes("conformance_unknown")), "unknown details key reported");
  });

  it("strict pass: every collected document against closed schemas (findings only, never fails)", () => {
    let findings = 0;
    for (const d of collected) {
      const errs = strictSchemaErrors(d.schema, d.doc);
      for (const err of errs) {
        findings++;
        console.log(`FINDING strict: ${d.label} (${d.schema}): ${err}`);
      }
    }
    console.log(`strict pass: ${collected.length} documents, ${findings} findings`);
  });
});

// ---------- Go fix requests carried from WP-2.I (re-verified against this binary) ----------
// WP-2.I's 'for WP-4.1' Go items, re-run live by WP-3.1 (2026-10-23, build 67e6bae) and kept as
// executable expectations: each case FAILED against this binary before it was skipped, and
// passes once WP-4.1 fixes the item. Setup for all: alice pushes P (sections Context, Rationale,
// Notes); bob pulls, edits Notes and pushes; alice edits Context (P is a conflict found from the
// listing); the agent is `ctx mcp --root <alice>` (clientInfo real-ctx-mcp, HOME = alice's).
const AGENT = "real-ctx-mcp";
const MERGE_BODY = "## Context\n\nOriginal context.\n\n## Rationale\n\nShared rationale.\n\n## Notes\n\nOriginal notes.";

async function mergeCase(caseName: string, o: { aliceNotes?: string } = {}): Promise<{ c: ConfCase; p: string; slug: string; merged: string }> {
  const c = await confCase(caseName);
  const slug = slugOf(c.name, "p");
  const p = writePage(c.a, { type: "concept", slug, body: MERGE_BODY });
  await pushOk(c.a, `${c.name}: seed`, [p]);
  await pullOk(c.b, `${c.name}: bob pulls`);
  writePage(c.b, { type: "concept", slug, author: "alice", body: MERGE_BODY.replace("Original notes.", "Bob's notes.") });
  await pushOk(c.b, `${c.name}: bob edits Notes`, [p]);
  const alice = MERGE_BODY.replace("Original context.", "Alice's context.");
  writePage(c.a, { type: "concept", slug, body: o.aliceNotes === undefined ? alice : alice.replace("Original notes.", o.aliceNotes) });
  return { c, p, slug, merged: alice.replace("Original notes.", "Bob's notes.") };
}

function agentOf(u: ConfUser): { bin: string; root: string; home: string } {
  return { bin: realCtxEnv().ctxBin, root: u.root, home: u.home };
}

async function firstBrief(u: ConfUser): Promise<string> {
  return withMcpSession(agentOf(u), async (s) => {
    await s.initialize(AGENT);
    const r = await s.callTool("ctx_push", { no_distill: true });
    assert.ok(r.text.includes("<MERGE_REQUIRED"), `the first ctx_push asks for a merge: ${r.text}`);
    return r.text;
  });
}

// GFR-2..6 were fixed by WP-4.1 and un-skipped by WP-4.I (L34); the Repro notes record the old defect.
describe("Go fix requests fixed by WP-4.1 (re-verified WP-2.I deviations)", function () {
  this.timeout(120000);

  // GFR-2 (= WP-2.I D2 MCP side + D3 'server moved again' wording; lead re-test (a)). Repro: the
  // setup; MCP session 1 ctx_push {no_distill} -> MERGE_REQUIRED; write the merge; END the session
  // (agent restart); session 2 ctx_push {resolved:[P], no_distill} -> a fresh MERGE_REQUIRED whose
  // 'server now' sha is unchanged and whose STEPS say 'If the server moved again meanwhile';
  // only a second resolved call pushes. Clause: D13 (resolved=[paths] has --ours semantics),
  // E10. Suspected Go: internal/mcp/merge.go briefSHAs (in-process only), internal/mcp/tools.go.
  it("GFR-2 D2: ctx_push resolved=[P] after an agent restart pushes at once when the server did not move", async () => {
    const { c, p, merged } = await mergeCase("gfr-2-restart");
    await firstBrief(c.a);
    writePage(c.a, { type: "concept", slug: slugOf(c.name, "p"), body: merged });
    const second = await withMcpSession(agentOf(c.a), async (s) => {
      await s.initialize(AGENT);
      return (await s.callTool("ctx_push", { resolved: [p], no_distill: true })).text;
    });
    assert.ok(!second.includes("<MERGE_REQUIRED"), `the first resolved push after a restart pushes: ${second}`);
    assert.ok(second.includes(`Resolved ${p}`), second);
  });

  // GFR-3 (WP-2.I D3 / lead re-test (c)). Repro: the setup; ctx_push {no_distill} -> the reply
  // starts 'Pushed 0 page(s)' above <MERGE_REQUIRED> although nothing was pushed. Suspected Go:
  // internal/mcp/tools.go (the 'Pushed %d page(s)' head line is added before the brief).
  it("GFR-3 D3: a ctx_push that only returns a merge brief does not print 'Pushed 0 page(s)' above it", async () => {
    const { c } = await mergeCase("gfr-3-pushed0");
    const brief = await firstBrief(c.a);
    assert.doesNotMatch(brief, /^Pushed 0 page\(s\)/m, brief.split("<MERGE_REQUIRED")[0]);
  });

  // GFR-4 (WP-2.I D3). Repro: the setup; one MCP session: ctx_push {no_distill}, write the merge,
  // ctx_push {resolved:[P], no_distill} -> 'Pushed 1 page(s); HEAD=<7>' is printed BEFORE
  // 'Resolved P: kept your version, re-based on server <7>' (the resolve happens first).
  // Suspected Go: internal/mcp/tools.go (lines = head, then notes).
  it("GFR-4 D3: the 'Resolved P' note comes before the 'Pushed N page(s)' line it led to", async () => {
    const { c, p, merged } = await mergeCase("gfr-4-order");
    const done = await withMcpSession(agentOf(c.a), async (s) => {
      await s.initialize(AGENT);
      assert.ok((await s.callTool("ctx_push", { no_distill: true })).text.includes("<MERGE_REQUIRED"));
      writePage(c.a, { type: "concept", slug: slugOf(c.name, "p"), body: merged });
      return (await s.callTool("ctx_push", { resolved: [p], no_distill: true })).text;
    });
    const resolvedAt = done.indexOf(`Resolved ${p}`);
    const pushedAt = done.search(/Pushed [1-9]\d* page\(s\)/);
    assert.ok(resolvedAt >= 0 && pushedAt >= 0, done);
    assert.ok(resolvedAt < pushedAt, `'Resolved' before 'Pushed': ${done}`);
  });

  // GFR-5 (WP-2.I D3). Repro: the setup; ctx_push {no_distill} -> 'ancestor (both diverged from):'
  // shows a 7-hex sha while 'server now:' shows 40-hex (and the resolve note's 're-based on server'
  // is 7-hex). Suspected Go: internal/mcp/merge.go shortMergeSHA, tools.go resolve note.
  it("GFR-5 D3: the merge brief prints the ancestor and server shas at the same (full) length", async () => {
    const { c } = await mergeCase("gfr-5-sha");
    const brief = await firstBrief(c.a);
    const ancestor = /ancestor \(both diverged from\):\s+(\S+)/.exec(brief)?.[1];
    const server = /server now:\s+(\S+)/.exec(brief)?.[1];
    assert.ok(ancestor && server, brief);
    assert.match(server, SHA40);
    assert.match(ancestor, SHA40, `ancestor ${ancestor} vs server now ${server}`);
  });

  // GFR-6 (lead re-test (b)). Repro: the setup, but alice ALSO makes bob's exact Notes edit;
  // ctx_push {no_distill} -> the brief lists '## Notes' under 'CONFLICTING regions (both sides
  // changed)' although both sides wrote identical text. Suspected Go: internal/mcp/merge.go
  // (sections are compared with the ancestor only, not with each other).
  it("GFR-6 (b): a section both sides changed to identical text is not reported as conflicting", async () => {
    const { c } = await mergeCase("gfr-6-identical", { aliceNotes: "Bob's notes." });
    const brief = await firstBrief(c.a);
    const conflicting = brief.split("CONFLICTING regions")[1]?.split("---")[0] ?? "";
    assert.ok(!conflicting.includes("## Notes"), `identical Notes edits reported as conflicting: ${brief.split("--- ANCESTOR")[0]}`);
  });
});
