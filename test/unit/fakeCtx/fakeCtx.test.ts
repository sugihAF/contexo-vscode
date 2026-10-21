// The fake ctx (test/fake-ctx/fake-ctx.mjs, E33), its baseline scenarios and workspaces,
// scripts/prepare-test-workspaces.mjs, the FakeCtxCli helper, the TestApi seam
// (src/testApi.ts) and the unit-test vscode stub (test/helpers/vscodeStub.ts). Plain mocha,
// no vscode: the fake runs as a real child process (`node fake-ctx.mjs <args>`), with temp
// roots whose paths contain a space.
import * as assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { URI } from "vscode-uri";
import * as cliTypes from "../../../src/cli/types";
import { CtxError, type BinaryState, type PushOutcome } from "../../../src/cli/types";
import type * as syncModule from "../../../src/commands/sync";
import {
  CAPABILITIES, REQUIRED_CAPABILITIES, SUPPORTED_CONTRACT_VERSION, parseEnvelope,
  type ErrorEnvelope, type PullDoc, type StatusDoc, type VersionDoc,
} from "../../../src/contract/types";
import { toContexoUri } from "../../../src/fs/contexoUri";
import type { Services } from "../../../src/services";
import type * as statusBarModule from "../../../src/statusBar";
import { createTestApi, testHooks, type ServiceSeam, type SnapshotHooks } from "../../../src/testApi";
import type { Prompts } from "../../../src/ui/prompts";
import { FAKE_VERSION_DOC, FakeCtxCli } from "../../helpers/fakeCtxCli";
import {
  BASELINE_SCENARIOS, FAKE_CTX, REPO_ROOT, WORKSPACES_DIR, loadScenario, loadStatusDoc, scenarioDir, scenarioOutput,
} from "../../helpers/fixtures";
import { vscodeStub } from "../../helpers/vscodeStub";
import { waitFor } from "../../helpers/waitFor";

// ---------- harness ----------

/** The 4 env keys the fake records; stripped from the inherited env so each test sets them explicitly. */
const RECORDED_ENV = ["NO_COLOR", "CONTEXO_NO_UPDATE_CHECK", "CONTEXO_CLIENT", "CONTEXO_DISTILL_DISABLE"] as const;
const FAKE_ENV = ["FAKE_CTX_SCENARIO", "FAKE_CTX_CALLS"] as const;

function baseEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of [...RECORDED_ENV, ...FAKE_ENV]) { delete env[k]; }
  return { ...env, ...extra };
}

interface Run { code: number | null; stdout: Buffer; stderr: Buffer; ms: number; }

/** Spawn `node <fake> ...args` (shell:false) and collect raw stdout/stderr bytes. */
function runFake(args: readonly string[], o: { env?: NodeJS.ProcessEnv; cwd?: string; fake?: string } = {}): Promise<Run> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(process.execPath, [o.fake ?? FAKE_CTX, ...args], {
      env: o.env ?? baseEnv(), cwd: o.cwd ?? os.tmpdir(), shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (b: Buffer) => out.push(b));
    child.stderr.on("data", (b: Buffer) => err.push(b));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout: Buffer.concat(out), stderr: Buffer.concat(err), ms: Date.now() - started }));
  });
}

/** Run fn over items with at most `limit` in flight. */
async function pool<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

const temps: string[] = [];
/** A fresh temp dir whose path contains a space (and a non-ASCII character). */
function tempDir(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `contexo ${label} é-`));
  temps.push(dir);
  return dir;
}

/** A workspace root (with a space) whose .fake-ctx/current selects `scenario`. */
function rootWith(scenario: string | undefined): string {
  const root = path.join(tempDir("fake root"), "my project");
  fs.mkdirSync(path.join(root, ".fake-ctx"), { recursive: true });
  if (scenario !== undefined) { fs.writeFileSync(path.join(root, ".fake-ctx", "current"), `${scenario}\n`); }
  return root;
}

function callsOf(root: string): { argv: string[]; cwd: string; env: Record<string, string | null> }[] {
  const file = path.join(root, ".fake-ctx", "calls.jsonl");
  if (!fs.existsSync(file)) { return []; }
  const text = fs.readFileSync(file, "utf8");
  assert.ok(text.endsWith("\n"), "calls.jsonl lines end with \\n");
  return text.split("\n").filter((l) => l !== "").map((l) => JSON.parse(l) as { argv: string[]; cwd: string; env: Record<string, string | null> });
}

function scenarioFile(name: string, rel: string): Buffer {
  return fs.readFileSync(path.join(scenarioDir(name), rel));
}

/**
 * Text with CRLF folded to LF. Byte-exact replays compare against the same checked-out
 * file, but structural checks must survive a CRLF checkout (core.autocrlf on Windows).
 */
function lf(text: string | Buffer): string {
  return text.toString().replace(/\r\n/g, "\n");
}

/** Both sides through realpath: macOS /var -> /private/var, Windows 8.3 short names. */
function samePath(a: string | undefined, b: string): boolean {
  return a !== undefined && fs.realpathSync.native(a) === fs.realpathSync.native(b);
}

function envelopeOf(stderr: Buffer, exit: number): ErrorEnvelope {
  return parseEnvelope(stderr.toString("utf8"), exit);
}

/** Top-level `key: value` scalars of a page's YAML frontmatter (enough for slug/type/author/updated). */
function frontmatter(text: string): Record<string, string> {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  assert.ok(m, "page starts with a --- frontmatter block");
  const out: Record<string, string> = {};
  for (const line of (m[1] ?? "").split("\n")) {
    const kv = /^([a-z_]+): (.*)$/.exec(line);
    if (kv) { out[kv[1] ?? ""] = (kv[2] ?? "").replace(/^"(.*)"$/, "$1"); }
  }
  return out;
}

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { out.push(...filesUnder(full)); } else { out.push(full); }
  }
  return out;
}

/** '/'-separated *.md pages under <root>/.contexo, excluding the root index.md/tags.md and dot-dirs (ctx's page walk). */
function pageFiles(workspace: string): string[] {
  const hub = path.join(workspace, ".contexo");
  return filesUnder(hub)
    .map((f) => path.relative(hub, f).split(path.sep).join("/"))
    .filter((rel) => rel.endsWith(".md") && rel !== "index.md" && rel !== "tags.md" && !rel.split("/").some((s) => s.startsWith(".")))
    .sort();
}

after(() => {
  for (const d of temps) { fs.rmSync(d, { recursive: true, force: true }); }
});

// ---------- tests ----------

describe("fake ctx", function () {
  this.timeout(60_000);

  it("replays mixed for status --json --root R", async () => {
    const root = rootWith("mixed");
    const online = await runFake(["status", "--json", "--root", root]);
    assert.equal(online.code, 0, online.stderr.toString());
    assert.equal(online.stderr.length, 0, "stderr is empty on success");
    assert.deepEqual(online.stdout, scenarioFile("mixed", "status.json"), "byte-exact replay");
    const doc = JSON.parse(online.stdout.toString("utf8")) as StatusDoc;
    assert.equal(doc.schema, "ctx.status.v1");
    assert.equal(doc.pages.length, 10);
    assert.deepEqual(doc, loadStatusDoc("mixed"));

    const offline = await runFake(["status", "--json", "--root", root, "--offline"]);
    assert.equal(offline.code, 0);
    assert.deepEqual(offline.stdout, scenarioFile("mixed-offline", "status.json"), "--offline -> mixed-offline");
    assert.equal((JSON.parse(offline.stdout.toString("utf8")) as StatusDoc).offline, true);

    const show = await runFake(["show", "wiki/concepts/retry-policy.md", "--at", "server", "--root", root]);
    assert.equal(show.code, 0);
    assert.deepEqual(show.stdout, scenarioFile("mixed", "show/retry-policy.server.md"), "show replays raw bytes");

    const base = await runFake(["show", "wiki/entities/gitstore.md", "--at", "base", "--root", root]);
    assert.equal(base.code, 8);
    assert.equal(base.stdout.length, 0);
    assert.equal(envelopeOf(base.stderr, 8).error.code, "base_unavailable");

    assert.deepEqual(callsOf(root).map((c) => c.argv[0]), ["status", "status", "show", "show"]);
  });

  it("records argv (spaces intact) and the 4 env keys to calls.jsonl", async () => {
    const root = rootWith("mixed");
    const cwd = tempDir("cwd");
    const weird = 'wiki/concepts/naïve café; rm -rf ~ $(x) "q" `y` \\ * ?.md';
    const argv1 = ["show", weird, "--at", "base", "--root", root];
    const env1 = baseEnv({
      NO_COLOR: "1", CONTEXO_NO_UPDATE_CHECK: "1", CONTEXO_CLIENT: "contexo-vscode/0.0.1", CONTEXO_DISTILL_DISABLE: "1",
    });
    await runFake(argv1, { env: env1, cwd });
    const argv2 = ["status", "--json", "--root", root, "--offline"];
    await runFake(argv2, { env: baseEnv({ CONTEXO_NO_UPDATE_CHECK: "1", CONTEXO_CLIENT: "" }), cwd: root });

    const calls = callsOf(root);
    assert.equal(calls.length, 2);
    const [c1, c2] = calls;
    assert.deepEqual(Object.keys(c1 ?? {}), ["argv", "cwd", "env"]);
    assert.deepEqual(c1?.argv, argv1, "argv elements arrive verbatim (spaces, quotes, $(), unicode)");
    assert.ok(samePath(c1?.cwd, cwd), `cwd ${String(c1?.cwd)}`);
    assert.deepEqual(c1?.env, {
      NO_COLOR: "1", CONTEXO_NO_UPDATE_CHECK: "1", CONTEXO_CLIENT: "contexo-vscode/0.0.1", CONTEXO_DISTILL_DISABLE: "1",
    });
    assert.deepEqual(Object.keys(c1?.env ?? {}), [...RECORDED_ENV], "env keys in protocol order");
    assert.deepEqual(c2?.argv, argv2);
    assert.ok(samePath(c2?.cwd, root), `cwd ${String(c2?.cwd)}`);
    assert.deepEqual(c2?.env, { NO_COLOR: null, CONTEXO_NO_UPDATE_CHECK: "1", CONTEXO_CLIENT: "" },
      "absent keys are null, CONTEXO_DISTILL_DISABLE only when present");
    assert.ok(!Object.prototype.hasOwnProperty.call(c2?.env, "CONTEXO_DISTILL_DISABLE"));

    // No --root: logged to FAKE_CTX_CALLS when set, else nowhere.
    const callsFile = path.join(tempDir("calls"), "nested dir", "calls.jsonl");
    await runFake(["version", "--json"], { env: baseEnv({ FAKE_CTX_CALLS: callsFile, NO_COLOR: "1" }), cwd });
    const lines = fs.readFileSync(callsFile, "utf8").split("\n").filter((l) => l !== "");
    assert.equal(lines.length, 1);
    const logged = JSON.parse(lines[0] ?? "") as { argv: string[]; cwd: string; env: Record<string, string | null> };
    assert.deepEqual({ argv: logged.argv, env: logged.env },
      { argv: ["version", "--json"], env: { NO_COLOR: "1", CONTEXO_NO_UPDATE_CHECK: null, CONTEXO_CLIENT: null } });
    assert.ok(samePath(logged.cwd, cwd));
    await runFake(["version", "--json"], { cwd });
    assert.deepEqual(fs.readdirSync(cwd), [], "no log file anywhere without --root or FAKE_CTX_CALLS");

    // A --root that does not exist is never created; the call goes to FAKE_CTX_CALLS instead.
    const ghost = path.join(tempDir("ghost"), "no such root");
    await runFake(["status", "--json", "--root", ghost], { env: baseEnv({ FAKE_CTX_CALLS: callsFile }) });
    assert.equal(fs.existsSync(ghost), false, "the fake never creates a missing root");
    assert.equal(fs.readFileSync(callsFile, "utf8").split("\n").filter((l) => l !== "").length, 2);
  });

  it("honours exit, stderrFile, delayMs", async () => {
    // A private copy of the fake resolves scenarios next to itself, so this test can use
    // scenarios that are not baseline fixtures without touching the repo.
    const world = tempDir("fake world");
    const fake = path.join(world, "test", "fake-ctx", "fake-ctx.mjs");
    fs.mkdirSync(path.dirname(fake), { recursive: true });
    fs.copyFileSync(FAKE_CTX, fake);
    const scenarios = path.join(world, "test", "fixtures", "ctx", "scenarios");
    const noise = 'noise line\n{"schema":"ctx.error.v1","exit_code":3,"error":{"code":"usage","message":"bad","advice":[],"retryable":false}}\n';
    fs.mkdirSync(path.join(scenarios, "shared"), { recursive: true });
    fs.writeFileSync(path.join(scenarios, "shared", "usage.stderr"), noise);
    fs.mkdirSync(path.join(scenarios, "t timing"), { recursive: true });
    fs.writeFileSync(path.join(scenarios, "t timing", "out.txt"), "default out\n");
    fs.writeFileSync(path.join(scenarios, "t timing", "scenario.json"), JSON.stringify({
      rules: [
        { match: ["slow"], unless: ["--fast"], delayMs: 1200, stdout: "late\n", stderrFile: "../shared/usage.stderr", exit: 3 },
        { match: ["slow"], stderr: "inline err\n", exit: 4 },
      ],
      default: { stdoutFile: "out.txt" },
    }));
    const root = rootWith("t timing");

    const child = runFake(["slow", "--root", root], { fake });
    let exitedAt = 0;
    void child.then(() => { exitedAt = Date.now(); });
    // Logging happens FIRST: the call is on disk while the rule's 1200 ms delay is still
    // running, so the process lives on for most of the delay after the line appears.
    await waitFor(() => callsOf(root).length === 1, { timeoutMs: 10_000, intervalMs: 10 });
    const loggedAt = Date.now();
    const slow = await child;
    assert.ok(exitedAt - loggedAt >= 800, `calls.jsonl written before the delay (${exitedAt - loggedAt} ms before exit)`);
    assert.equal(slow.code, 3);
    assert.ok(slow.ms >= 1200, `delayMs honoured (${slow.ms} ms)`);
    assert.equal(slow.stdout.toString(), "late\n");
    assert.equal(slow.stderr.toString(), noise, "stderrFile resolved relative to the scenario dir ('..' allowed), bytes verbatim");

    const fast = await runFake(["slow", "--fast", "--root", root], { fake });
    assert.equal(fast.code, 4, "unless skips the first rule");
    assert.equal(fast.stderr.toString(), "inline err\n");
    assert.ok(fast.ms < 1200);

    const dflt = await runFake(["anything", "--root", root], { fake });
    assert.equal(dflt.code, 0, "default exit is 0");
    assert.equal(dflt.stdout.toString(), "default out\n");

    // baseline: busy -> exit 12 with a noise line before the envelope
    const busy = await runFake(["push", "--json", "--yes", "--root", rootWith("busy")]);
    assert.equal(busy.code, 12);
    assert.equal(busy.stdout.length, 0);
    assert.deepEqual(busy.stderr, scenarioFile("busy", "busy.stderr"));
    assert.equal(busy.stderr.toString().split("\n").filter((l) => l.trim() !== "").length, 2, "noise line + envelope");
    const env = envelopeOf(busy.stderr, 12);
    assert.equal(env.error.code, "busy");
    assert.equal(env.error.retryable, true);
    assert.equal(env.exit_code, 12);

    // no matching rule and no default -> exit 1 internal envelope naming the argv
    const none = await runFake(["frobnicate", "--json", "--root", rootWith("mixed")]);
    assert.equal(none.code, 1);
    const e1 = envelopeOf(none.stderr, 1);
    assert.equal(e1.error.code, "internal");
    assert.match(e1.error.message, /frobnicate/);
    assert.match(e1.error.message, /mixed/);

    // an unknown scenario -> exit 1 internal envelope naming it
    const missing = await runFake(["status", "--json", "--root", rootWith("no-such-scenario")]);
    assert.equal(missing.code, 1);
    assert.match(envelopeOf(missing.stderr, 1).error.message, /no-such-scenario/);
  });

  it("push-success then-switches current to clean", async () => {
    const root = rootWith("push-success");
    const before = await runFake(["status", "--json", "--root", root]);
    assert.deepEqual(before.stdout, scenarioFile("mixed", "status.json"));

    const push = await runFake(["push", "--json", "--yes", "--root", root, "-m", "ship it", "--", "wiki/concepts/auth-flow.md"]);
    assert.equal(push.code, 0, push.stderr.toString());
    assert.deepEqual(push.stdout, scenarioFile("push-success", "push.json"));
    assert.equal(fs.readFileSync(path.join(root, ".fake-ctx", "current"), "utf8").trim(), "clean");

    const after = await runFake(["status", "--json", "--root", root]);
    assert.deepEqual(after.stdout, scenarioFile("clean", "status.json"));
    assert.equal(loadStatusDoc("clean").counts.unchanged, 7);
    assert.deepEqual(callsOf(root).map((c) => c.argv[0]), ["status", "push", "status"]);

    // without --root nothing is rewritten (and nothing fails)
    const cwd = tempDir("no root");
    const noRoot = await runFake(["push", "--json", "--yes"], { env: baseEnv({ FAKE_CTX_SCENARIO: "push-success" }), cwd });
    assert.equal(noRoot.code, 0);
    assert.deepEqual(fs.readdirSync(cwd), []);
  });

  it("version without --root uses FAKE_CTX_SCENARIO, else built-in 11+repair", async () => {
    const builtIn = await runFake(["version", "--json"]);
    assert.equal(builtIn.code, 0, builtIn.stderr.toString());
    const doc = JSON.parse(builtIn.stdout.toString("utf8")) as VersionDoc;
    assert.equal(doc.contract_version, SUPPORTED_CONTRACT_VERSION);
    assert.deepEqual(doc.capabilities, [...CAPABILITIES, "repair"]);
    assert.deepEqual(doc, FAKE_VERSION_DOC, "the fake's built-in doc equals FakeCtxCli's default");

    const builtInOther = await runFake(["status", "--json"]);
    assert.equal(builtInOther.code, 1, "the built-in answers only version --json");
    assert.equal(envelopeOf(builtInOther.stderr, 1).error.code, "internal");

    const v2 = await runFake(["version", "--json"], { env: baseEnv({ FAKE_CTX_SCENARIO: "ctx-contract2" }) });
    assert.equal(v2.code, 0);
    assert.equal((JSON.parse(v2.stdout.toString("utf8")) as VersionDoc).contract_version, 2);

    const caps = await runFake(["version", "--json"], { env: baseEnv({ FAKE_CTX_SCENARIO: "ctx-missing-caps" }) });
    const capsDoc = JSON.parse(caps.stdout.toString("utf8")) as VersionDoc;
    assert.equal(capsDoc.contract_version, 1);
    assert.deepEqual(REQUIRED_CAPABILITIES.filter((c) => !capsDoc.capabilities.includes(c)), ["push.distill_guard", "resolve"]);

    // --root without .fake-ctx/current falls back to FAKE_CTX_SCENARIO
    const fallback = await runFake(["status", "--json", "--root", rootWith(undefined)], { env: baseEnv({ FAKE_CTX_SCENARIO: "clean" }) });
    assert.equal(fallback.code, 0);
    assert.deepEqual(fallback.stdout, scenarioFile("clean", "status.json"));
  });

  it("ctx-too-old: version --json exit 1, --short 0.6.6", async () => {
    const env = baseEnv({ FAKE_CTX_SCENARIO: "ctx-too-old" });
    const json = await runFake(["version", "--json"], { env });
    assert.equal(json.code, 1);
    assert.equal(json.stdout.length, 0);
    assert.deepEqual(json.stderr, scenarioFile("ctx-too-old", "unknown_flag.stderr"), "byte-exact replay");
    assert.equal(lf(json.stderr), "✖ unknown flag: --json\n", "the real ctx v0.6.6 text (plain text, no envelope)");
    assert.equal(envelopeOf(json.stderr, 1).error.code, "internal", "no envelope: falls back by exit code");

    const short = await runFake(["version", "--short"], { env });
    assert.equal(short.code, 0);
    assert.equal(short.stdout.toString("utf8"), "0.6.6\n");
    assert.equal(short.stderr.length, 0);

    const status = await runFake(["status", "--json", "--root", rootWith("ctx-too-old")]);
    assert.equal(status.code, 1, "every --json call fails the same way");
    assert.equal(lf(status.stderr), "✖ unknown flag: --json\n");
  });

  it("fixtures.selectRule agrees with fake-ctx for every baseline rule", async () => {
    const cases: { name: string; argv: string[] }[] = [];
    for (const name of BASELINE_SCENARIOS) {
      for (const rule of loadScenario(name).rules) { cases.push({ name, argv: [...rule.match] }); }
      cases.push({ name, argv: ["__no_such_command__"] });
    }
    const cwd = tempDir("select");
    const failures: string[] = [];
    await pool(cases, 6, async ({ name, argv }) => {
      const run = await runFake(argv, { env: baseEnv({ FAKE_CTX_SCENARIO: name }), cwd });
      const expected = scenarioOutput(name, argv);
      const where = `${name} [${argv.join(" ")}]`;
      if (!expected) {
        if (run.code !== 1 || envelopeOf(run.stderr, 1).error.code !== "internal") { failures.push(`${where}: expected the internal no-rule envelope`); }
        return;
      }
      if (run.code !== expected.exit) { failures.push(`${where}: exit ${String(run.code)} != ${expected.exit}`); }
      if (run.stdout.toString("utf8") !== expected.stdout) { failures.push(`${where}: stdout differs`); }
      if (run.stderr.toString("utf8") !== expected.stderr) { failures.push(`${where}: stderr differs`); }
    });
    assert.deepEqual(failures, []);
    assert.ok(cases.length > BASELINE_SCENARIOS.length * 2);
  });

  it("baseline scenario rules point at existing files and keep envelope exit codes and retryable flags per the code table", () => {
    const RETRYABLE = new Set(["network", "server_error", "rate_limited", "busy"]);
    const failures: string[] = [];
    for (const name of BASELINE_SCENARIOS) {
      const sc = loadScenario(name);
      for (const [i, r] of [...sc.rules.entries(), ...(sc.default ? [["default", sc.default] as const] : [])]) {
        for (const f of [r.stdoutFile, r.stderrFile]) {
          if (f !== undefined && !fs.existsSync(path.resolve(scenarioDir(name), f))) { failures.push(`${name} rule ${String(i)}: missing ${f}`); }
        }
        if (r.then !== undefined && !(BASELINE_SCENARIOS as readonly string[]).includes(r.then)) {
          failures.push(`${name} rule ${String(i)}: then '${r.then}' is not a baseline scenario`);
        }
        const out = scenarioOutput(name, "match" in r ? r.match : ["__default__"]);
        if (!out || out.exit === 0 || !out.stderr.trim().split("\n").pop()?.startsWith("{")) { continue; }
        const env = envelopeOf(Buffer.from(out.stderr), out.exit);
        if (env.exit_code !== out.exit) { failures.push(`${name} rule ${String(i)}: exit_code ${env.exit_code} != exit ${out.exit}`); }
        if (env.error.retryable !== RETRYABLE.has(env.error.code)) { failures.push(`${name} rule ${String(i)}: retryable for ${env.error.code}`); }
        if (!lf(out.stderr).endsWith("}\n")) { failures.push(`${name} rule ${String(i)}: stderr must end with the envelope line + \\n`); }
      }
    }
    assert.deepEqual(failures, []);
  });
});

describe("baseline workspaces", () => {
  const basic = path.join(WORKSPACES_DIR, "basic");
  const multi = path.join(WORKSPACES_DIR, "multi");

  it("basic holds config.json, current=mixed and exactly the 8 local files of mixed with real ctx.page.v1 frontmatter", () => {
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(basic, ".contexo", "config.json"), "utf8")),
      { version: 1, repo_id: "fixture-repo", server_url: "http://127.0.0.1:9" });
    assert.equal(fs.readFileSync(path.join(basic, ".fake-ctx", "current"), "utf8").trim(), "mixed");
    for (const f of ["index.md", "tags.md"]) { assert.ok(fs.existsSync(path.join(basic, ".contexo", f)), f); }

    const mixed = loadStatusDoc("mixed");
    const local = mixed.pages.filter((p) => p.local !== undefined);
    assert.equal(local.length, 8);
    assert.deepEqual(pageFiles(basic), local.map((p) => p.path));
    for (const p of local) {
      assert.equal(p.local?.file, p.path, `${p.path}: local.file == path`);
      const text = lf(fs.readFileSync(path.join(basic, ".contexo", ...p.path.split("/"))));
      const fm = frontmatter(text);
      if (p.state === "invalid") {
        assert.equal(p.type, undefined, `${p.path}: no frontmatter-derived fields when invalid`);
        continue;
      }
      const keys = text.split("\n---\n")[0]?.split("\n").map((l) => /^([a-z_]+):/.exec(l)?.[1]).filter((k) => k !== undefined);
      const ORDER = ["schema", "slug", "type", "author", "agent", "created", "updated", "parent_sha", "sources", "related", "tags", "reasoning_summary"];
      assert.deepEqual(keys, ORDER.filter((k) => keys?.includes(k)), `${p.path}: yaml.v3 field order`);
      for (const k of ["schema", "slug", "type", "author", "created", "updated", "parent_sha"]) { assert.ok(keys?.includes(k), `${p.path}: ${k}`); }
      assert.equal(fm.schema, "ctx.page.v1", p.path);
      assert.equal(fm.slug, p.slug, `${p.path}: slug`);
      assert.equal(fm.type, p.type, `${p.path}: type`);
      assert.equal(fm.author, p.author, `${p.path}: author`);
      assert.equal(fm.agent, p.agent, `${p.path}: agent`);
      assert.equal(fm.updated, p.updated, `${p.path}: updated`);
      const dir = { source: "raw/sessions", concept: "wiki/concepts", entity: "wiki/entities", analysis: "wiki/analyses" }[fm.type ?? ""];
      assert.equal(`${String(dir)}/${String(fm.slug)}.md`, p.path, `${p.path}: RelPath()`);
      const body = text.slice(text.indexOf("\n---\n") + 5);
      assert.equal(/^# (.+)$/m.exec(body)?.[1], p.title, `${p.path}: title is the first '# ' line`);
    }
  });

  it("multi mirrors it: alpha (mixed), beta (clean, the 7 valid pages), plain (no .contexo); no credentials anywhere", () => {
    const ws = JSON.parse(fs.readFileSync(path.join(multi, "multi.code-workspace"), "utf8")) as { folders: { path: string }[] };
    assert.deepEqual(ws.folders.map((f) => f.path), ["alpha", "beta", "plain"]);

    const alpha = path.join(multi, "alpha");
    const beta = path.join(multi, "beta");
    const plain = path.join(multi, "plain");
    assert.equal(fs.readFileSync(path.join(alpha, ".fake-ctx", "current"), "utf8").trim(), "mixed");
    assert.equal(fs.readFileSync(path.join(beta, ".fake-ctx", "current"), "utf8").trim(), "clean");
    const rel = (root: string): string[] => filesUnder(path.join(root, ".contexo")).map((f) => path.relative(path.join(root, ".contexo"), f)).sort();
    assert.deepEqual(rel(alpha), rel(basic));
    for (const f of rel(basic)) {
      assert.deepEqual(fs.readFileSync(path.join(alpha, ".contexo", f)), fs.readFileSync(path.join(basic, ".contexo", f)), `alpha/${f}`);
    }

    const clean = loadStatusDoc("clean");
    const valid = loadStatusDoc("mixed").pages.filter((p) => p.local !== undefined && p.state !== "invalid").map((p) => p.path);
    assert.deepEqual(clean.pages.map((p) => p.path), valid, "clean = the 7 valid local pages of basic");
    assert.ok(clean.pages.every((p) => p.state === "unchanged" && p.base?.hash === p.local?.hash));
    assert.deepEqual(pageFiles(beta), valid);
    for (const p of valid) {
      const parts = p.split("/");
      assert.deepEqual(fs.readFileSync(path.join(beta, ".contexo", ...parts)), fs.readFileSync(path.join(basic, ".contexo", ...parts)), `beta/${p}`);
    }
    const mixedHash = new Map(loadStatusDoc("mixed").pages.map((p) => [p.path, p.local?.hash]));
    for (const p of clean.pages) { assert.equal(p.local?.hash, mixedHash.get(p.path), `${p.path}: same working file, same hash`); }

    assert.ok(fs.existsSync(path.join(plain, "README.md")));
    assert.equal(fs.existsSync(path.join(plain, ".contexo")), false);

    // Built at runtime so the acceptance check `! grep -rn <token prefix> src test contract` stays clean.
    const TOKEN_PREFIX = ["ctxp", "_"].join("");
    for (const f of filesUnder(WORKSPACES_DIR)) {
      assert.notEqual(path.basename(f), "credentials.json", f);
      assert.notEqual(path.basename(f), "calls.jsonl", `${f}: no committed calls.jsonl`);
      assert.ok(!fs.readFileSync(f, "utf8").includes(TOKEN_PREFIX), `${f}: no token`);
    }
  });

  it("prepare-test-workspaces copies the workspaces, replaces the previous copy and drops calls.jsonl", () => {
    const from = tempDir("ws src");
    fs.cpSync(WORKSPACES_DIR, from, { recursive: true });
    fs.writeFileSync(path.join(from, "basic", ".fake-ctx", "calls.jsonl"), '{"argv":[]}\n');
    const out = path.join(tempDir("ws out"), "workspaces");
    fs.mkdirSync(path.join(out, "stale"), { recursive: true });
    const script = path.join(REPO_ROOT, "scripts", "prepare-test-workspaces.mjs");
    const r = spawnSync(process.execPath, [script, "--from", from, "--out", out], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(fs.readdirSync(out).sort(), ["basic", "multi"]);
    assert.equal(fs.existsSync(path.join(out, "basic", ".fake-ctx", "calls.jsonl")), false);
    assert.equal(fs.readFileSync(path.join(out, "basic", ".fake-ctx", "current"), "utf8").trim(), "mixed");
    assert.ok(fs.existsSync(path.join(out, "multi", "multi.code-workspace")));
    assert.deepEqual(pageFiles(path.join(out, "basic")), pageFiles(basic));
    assert.ok(fs.existsSync(path.join(from, "basic", ".fake-ctx", "calls.jsonl")), "the source is never mutated");
  });
});

describe("FakeCtxCli", () => {
  it("FakeCtxCli logs method calls in order and returns scripted results", async () => {
    const cli = new FakeCtxCli();
    const fired: BinaryState[] = [];
    const sub = cli.onDidChangeBinary((s) => fired.push(s));

    const bin = await cli.getBinary();
    assert.equal(bin.kind, "ok");
    assert.deepEqual(bin.kind === "ok" ? bin.version : undefined, FAKE_VERSION_DOC);
    assert.deepEqual(await cli.version(), FAKE_VERSION_DOC);
    assert.deepEqual(await cli.status("/ws/a", { offline: false }), loadStatusDoc("mixed"));
    assert.deepEqual(await cli.status("/ws/a", { offline: true }), loadStatusDoc("mixed", { offline: true }));

    // defaults for the mutating/content calls reject with contract_mismatch
    await assert.rejects(cli.pull("/ws/a"), (e: unknown) => e instanceof CtxError && e.code === "contract_mismatch" && /pull/.test(e.message));

    const pullDoc: PullDoc = {
      schema: "ctx.pull.v1", server_url: "http://127.0.0.1:9", repo_id: "fixture-repo",
      written: [], adopted: [], skipped: [], reindexed: false, warnings: [],
    };
    cli.setResult("pull", pullDoc);
    assert.equal(await cli.pull("/ws/a"), pullDoc);

    const o1 = { doc: { schema: "ctx.push.v1" } } as unknown as PushOutcome;
    const o2 = { doc: { schema: "ctx.push.v1", message: "persistent" } } as unknown as PushOutcome;
    cli.setResult("push", o2);
    cli.enqueue("push", o1, new Error("boom"));
    assert.equal(await cli.push("/ws/a", { message: "m" }), o1, "one-shot values first");
    await assert.rejects(cli.push("/ws/a", {}), /boom/, "an enqueued Error rejects");
    assert.equal(await cli.push("/ws/a", {}), o2, "then the persistent result");
    assert.equal(await cli.push("/ws/a", { paths: ["x.md"] }), o2);

    const busy = CtxError.fromProcess('noise\n{"schema":"ctx.error.v1","exit_code":12,"error":{"code":"busy","message":"x","advice":[],"retryable":true}}\n', 12);
    cli.setError("resolve", busy);
    await assert.rejects(cli.resolve("/ws/a", "wiki/concepts/rate-limits.md", "theirs", { ifServerSha: "a".repeat(40) }), (e: unknown) => e === busy);

    let seenInHandler = -1;
    cli.setHandler("show", (root, relPath, ref) => {
      seenInHandler = cli.calls.length;
      return Promise.resolve(new TextEncoder().encode(`${root}|${relPath}|${ref}`));
    });
    assert.equal(new TextDecoder().decode(await cli.show("/ws/a", "wiki/concepts/auth-flow.md", "base")), "/ws/a|wiki/concepts/auth-flow.md|base");

    assert.deepEqual(cli.terminalInvocation(["auth", "login", "--root", "/ws/a"]),
      { shellPath: process.execPath, shellArgs: ["-e", "process.exit(0)"], env: { ELECTRON_RUN_AS_NODE: "1" } });
    cli.setError("terminalInvocation", new Error("no binary"));
    assert.throws(() => cli.terminalInvocation(["update"]), /no binary/, "sync methods throw");

    cli.fireBinary({ kind: "missing" });
    assert.deepEqual(fired, [{ kind: "missing" }]);
    assert.deepEqual(await cli.getBinary(), { kind: "missing" });
    cli.setResult("rediscover", { kind: "tooOld", path: "/x/ctx", versionText: "0.6.6", missing: ["resolve"] });
    assert.equal((await cli.rediscover()).kind, "tooOld");
    sub.dispose();
    cli.fireBinary({ kind: "missing" });
    assert.equal(fired.length, 1, "a disposed listener is not called");
    cli.dispose();

    assert.deepEqual(cli.calls.map((c) => c.method), [
      "getBinary", "version", "status", "status", "pull", "pull", "push", "push", "push", "push", "resolve", "show",
      "terminalInvocation", "terminalInvocation", "getBinary", "rediscover", "dispose",
    ]);
    assert.equal(seenInHandler, 12, "a call is logged before it runs");
    assert.deepEqual(cli.calls[2]?.args, ["/ws/a", { offline: false }]);
    assert.deepEqual(cli.calls[6]?.args, ["/ws/a", { message: "m" }]);
    assert.deepEqual(cli.calls[10]?.args, ["/ws/a", "wiki/concepts/rate-limits.md", "theirs", { ifServerSha: "a".repeat(40) }]);
    assert.deepEqual(cli.calls[12]?.args, [["auth", "login", "--root", "/ws/a"]]);
    assert.deepEqual(cli.calls[16]?.args, []);
  });

  it("FakeCtxCli options pick the binary and the status scenario; handlers replace results", async () => {
    const cli = new FakeCtxCli({ binary: { kind: "extensionTooOld", path: "/x/ctx", contractVersion: 2 }, scenario: "clean" });
    assert.deepEqual(await cli.getBinary(), { kind: "extensionTooOld", path: "/x/ctx", contractVersion: 2 });
    assert.deepEqual(await cli.status("/r", { offline: false }), loadStatusDoc("clean"));
    cli.setHandler("status", (_root, o) => Promise.resolve(loadStatusDoc(o.offline ? "mixed-offline" : "not-authenticated", o)));
    assert.equal((await cli.status("/r", { offline: false })).auth.state, "not_authenticated");
    cli.setResult("status", loadStatusDoc("mixed"));
    assert.equal((await cli.status("/r", { offline: true })).offline, false, "setResult replaces the handler");
    cli.enqueue("status", loadStatusDoc("clean", { offline: true }));
    assert.equal((await cli.status("/r", { offline: true })).offline, true);
  });

  it("CtxError instanceof works across module copies", () => {
    const load = createRequire(__filename);
    const file = load.resolve("../../../src/cli/types");
    const original = load.cache[file];
    delete load.cache[file];
    try {
      const copy = load(file) as typeof cliTypes;
      assert.notEqual(copy.CtxError, cliTypes.CtxError, "two distinct class objects");
      const fromCopy = copy.CtxError.extension("timeout", "took too long", { retryable: true });
      const fromHere = cliTypes.CtxError.fromProcess("garbage", 7);
      assert.ok(fromCopy instanceof cliTypes.CtxError);
      assert.ok(fromHere instanceof copy.CtxError);
      assert.ok(fromCopy instanceof Error);
      assert.equal(fromCopy.code, "timeout");
      assert.equal(fromHere.code, "network");
      assert.equal(fromHere.retryable, true);
      assert.ok(!(new Error("plain") instanceof copy.CtxError));
      assert.ok(!(({ code: "busy" } as unknown) instanceof cliTypes.CtxError));
      assert.ok(!((null as unknown) instanceof cliTypes.CtxError));
    } finally {
      if (original) { load.cache[file] = original; }
    }
  });

  it("waitFor polls until the predicate is truthy and fails after timeoutMs", async () => {
    let n = 0;
    assert.equal(await waitFor(() => (++n >= 3 ? n : 0), { timeoutMs: 1000, intervalMs: 1 }), 3);
    assert.equal(await waitFor(() => Promise.resolve("ok")), "ok");
    const t0 = Date.now();
    await assert.rejects(waitFor(() => false, { timeoutMs: 60, intervalMs: 5, message: "never true" }), /timed out after 60 ms: never true/);
    assert.ok(Date.now() - t0 >= 60);
    await assert.rejects(waitFor(() => { throw new Error("inner"); }, { timeoutMs: 30, intervalMs: 5 }), /inner/);
  });
});

describe("TestApi seam (src/testApi.ts)", () => {
  type HookUri = Parameters<SnapshotHooks["quickDiffOriginal"]>[0];
  const asHookUri = (u: URI): HookUri => u as unknown as HookUri;

  it("createTestApi exposes every SnapshotHooks member live through api.hooks (quickDiffOriginal, resource commands, acceptInputCommand and tree ids included)", async () => {
    const seamCalls: string[] = [];
    const seam: ServiceSeam = {
      overrideServices: () => { seamCalls.push("overrideServices"); return Promise.resolve(); },
      resetServices: () => { seamCalls.push("resetServices"); return Promise.resolve(); },
      setPrompts: () => { seamCalls.push("setPrompts"); },
    };
    const services = {} as Services;
    const api = createTestApi(services, seam);
    assert.equal(api.services, services);

    const root = "/ws/basic";
    const relPath = "wiki/concepts/auth-flow.md";
    const file = asHookUri(URI.file(`${root}/.contexo/${relPath}`));
    const base = toContexoUri(file, "base", root, relPath);
    // In the host, acceptInputCommand.arguments[0] is the SourceControl object itself.
    const sourceControl = { id: "contexo", rootUri: URI.file(root) };
    // A full SnapshotHooks object: the compiler fails this test when a member is added
    // to SnapshotHooks without being added here.
    const hooks: SnapshotHooks = {
      scmSnapshot: () => ({
        repos: [{
          root, count: 3, inputPlaceholder: "Message", statusBarCommands: ["contexo.refresh"],
          acceptInputCommand: { command: "contexo.push", title: "Push", arguments: [sourceControl] },
          groups: [{
            id: "changes", label: "Changes", hideWhenEmpty: true,
            resources: [{
              relPath, contextValue: "modified",
              command: { command: "vscode.diff", title: "Open Changes", arguments: [base.toString(), file.toString(), "auth-flow.md (Base ↔ Local)"] },
            }],
          }],
        }],
      }),
      treeSnapshot: () => ({ roots: [{ label: "basic", id: `${root}|#concepts`, children: [] }] }),
      decorationFor: () => ({ badge: "M" }),
      statusBarSnapshot: () => ({ items: [{ id: "contexo.status", text: "$(cloud) Contexo" }] }),
      quickDiffOriginal: (uri) => (uri.toString() === file.toString() ? base : undefined),
    };
    const keys = Object.keys(hooks) as (keyof SnapshotHooks)[];
    try {
      for (const k of keys) { assert.equal(api.hooks[k], undefined, `hooks.${k} is unset until a module assigns it`); }
      // Modules assign their hooks after activation (in wire()); the getters see them.
      Object.assign(testHooks, hooks);
      for (const k of keys) {
        assert.equal(api.hooks[k], hooks[k], `hooks.${k} is the live testHooks.${k}`);
        assert.ok(Object.keys(api.hooks).includes(k), `hooks.${k} is enumerable`);
      }
      const repo = api.hooks.scmSnapshot?.().repos[0];
      assert.equal(repo?.acceptInputCommand?.command, "contexo.push");
      assert.equal(repo?.acceptInputCommand?.arguments?.[0], sourceControl);
      assert.deepEqual(repo?.groups[0]?.resources[0]?.command?.arguments?.slice(0, 2), [base.toString(), file.toString()]);
      assert.equal(api.hooks.treeSnapshot?.().roots[0]?.id, `${root}|#concepts`);
      assert.equal(await api.hooks.quickDiffOriginal?.(file), base);
      assert.equal(await api.hooks.quickDiffOriginal?.(asHookUri(URI.file("/elsewhere/notes.md"))), undefined);

      await api.hooks.overrideServices({});
      await api.hooks.resetServices();
      api.hooks.setPrompts({} as Prompts);
      assert.deepEqual(seamCalls, ["overrideServices", "resetServices", "setPrompts"]);
    } finally {
      for (const k of keys) { delete testHooks[k]; }
    }
  });
});

describe("unit-test vscode stub (test/helpers/vscodeStub.ts)", () => {
  const load = createRequire(__filename);

  it("test:unit installs it before any spec file loads (mocha --require), so a spec may import vscode-dependent src modules at top level", () => {
    // require.cache keys are in load-start order: the stub must precede every spec file
    // (with a per-file import instead, the alphabetically earlier specs would load first).
    const keys = Object.keys(require.cache);
    const stubAt = keys.indexOf(load.resolve("../../helpers/vscodeStub"));
    const firstSpecAt = keys.findIndex((k) => /[\\/]out[\\/]test[\\/]unit[\\/].+\.test\.js$/.test(k));
    assert.ok(stubAt >= 0 && firstSpecAt >= 0, `stub ${stubAt}, first spec ${firstSpecAt}`);
    assert.ok(stubAt < firstSpecAt, `the stub loaded after ${String(keys[firstSpecAt])}: is --require out/test/helpers/vscodeStub.js missing from test:unit?`);
    assert.equal(load("vscode"), vscodeStub, "require('vscode') is the stub");
  });

  it("src modules that import vscode at runtime load in plain mocha, and their pure exports run", () => {
    const statusBar = load("../../../src/statusBar") as typeof statusBarModule;
    assert.deepEqual(statusBar.statusBarCommandsFor(undefined), [], "WP-1.12: undefined gives []");
    const sync = load("../../../src/commands/sync") as typeof syncModule;
    for (const handler of [sync.push, sync.pushSelected, sync.pull]) { assert.equal(typeof handler, "function"); }
  });

  it("Disposable, EventEmitter, Uri (vscode-uri), ThemeColor, ThemeIcon and the enums behave like vscode's; any other API throws a clear error", () => {
    const disposed: string[] = [];
    const all = vscodeStub.Disposable.from(new vscodeStub.Disposable(() => disposed.push("a")), { dispose: () => disposed.push("b") });
    all.dispose();
    all.dispose();
    assert.deepEqual(disposed, ["a", "b"], "Disposable.from disposes every member, once");

    const emitter = new vscodeStub.EventEmitter<number>();
    const got: number[] = [];
    const bag: { dispose(): unknown }[] = [];
    const sub = emitter.event((n) => got.push(n), undefined, bag);
    assert.equal(bag[0], sub, "the subscription is pushed to the disposables array");
    emitter.fire(1);
    sub.dispose();
    emitter.fire(2);
    emitter.event((n) => got.push(n * 10));
    emitter.dispose();
    emitter.fire(3);
    assert.deepEqual(got, [1], "a disposed subscription or emitter delivers nothing");

    const uri = vscodeStub.Uri.file("/My Projects/.contexo/wiki/a b.md");
    assert.equal(uri.toString(), URI.file("/My Projects/.contexo/wiki/a b.md").toString());
    assert.ok(URI.file("/x") instanceof vscodeStub.Uri, "vscode-uri URIs are instances of the stub Uri");
    assert.equal(vscodeStub.Uri.joinPath(uri, "..", "c.md").path, "/My Projects/.contexo/wiki/c.md");
    assert.equal(vscodeStub.Uri.parse("contexo:/a.md?q").query, "q");

    const color = new vscodeStub.ThemeColor("statusBarItem.warningBackground");
    assert.equal(color.id, "statusBarItem.warningBackground");
    const icon = new vscodeStub.ThemeIcon("warning", color);
    assert.equal(icon.id, "warning");
    assert.equal(icon.color, color);
    assert.equal(vscodeStub.ThemeIcon.File.id, "file");
    assert.equal(vscodeStub.ThemeIcon.Folder.id, "folder");
    assert.equal(vscodeStub.StatusBarAlignment.Left, 1);
    assert.equal(vscodeStub.StatusBarAlignment.Right, 2);
    assert.deepEqual([vscodeStub.TreeItemCollapsibleState.None, vscodeStub.TreeItemCollapsibleState.Collapsed, vscodeStub.TreeItemCollapsibleState.Expanded], [0, 1, 2]);

    const anyApi = vscodeStub as unknown as Record<string, unknown>;
    assert.throws(() => anyApi.window, /vscode\.window is not available in unit tests/);
    assert.throws(() => anyApi.commands, /vscode\.commands is not available in unit tests/);
    assert.equal(anyApi.then, undefined, "probing for a thenable is not an error");
    assert.equal(anyApi.__esModule, true);
  });

  it("the frozen type-only modules never require vscode at runtime", () => {
    // The stub would hide a runtime vscode import in these files; the compiled output must
    // not contain one (src/contract/types.ts imports nothing at all).
    for (const rel of [
      "../../../src/contract/types", "../../../src/cli/types", "../../../src/fs/contexoUri",
      "../../helpers/fakeCtxCli", "../../helpers/fixtures",
    ]) {
      const js = fs.readFileSync(load.resolve(rel), "utf8");
      assert.doesNotMatch(js, /require\(["']vscode["']\)/, `${rel}: type-only vscode imports`);
    }
    assert.doesNotMatch(fs.readFileSync(load.resolve("../../../src/contract/types"), "utf8"), /require\(/, "contract/types imports nothing");
  });
});

describe("FakeRepository (test/helpers/fakeRepository.ts, loaded over the vscode stub)", () => {
  const load = createRequire(__filename);

  it("refresh() records a CtxError from onRefresh in lastError and clears it on the next successful refresh (IRepository.lastError contract)", async () => {
    const { fakeRepository } = load("../../helpers/fakeRepository") as typeof import("../../helpers/fakeRepository");
    const repo = fakeRepository({ root: "/work/alpha" });
    let fail = true;
    repo.onRefresh = () => { if (fail) { throw CtxError.fromProcess("", 7); } };

    await repo.refresh({ remote: true });
    assert.equal(repo.lastError?.code, "network");

    fail = false;
    await repo.refresh();
    assert.equal(repo.lastError, undefined, "the next success clears lastError");
    assert.deepEqual(repo.refreshCalls, [{ remote: true }, { remote: false }]);
  });
});

describe("code-review regressions (WP-0.6 /code-review high)", () => {
  const load = createRequire(__filename);

  it("parseEnvelope falls back when the last line carries the error schema but no valid error body; CtxError.fromProcess never throws", () => {
    for (const line of [
      '{"schema":"ctx.error.v1","exit_code":1,"message":"x"}',
      '{"schema":"ctx.error.v1","exit_code":4,"error":null}',
      '{"schema":"ctx.error.v1","exit_code":4,"error":{"message":"no code"}}',
      '{"schema":"ctx.error.v1","error":{"code":"busy","message":"m","advice":[],"retryable":true}}',
    ]) {
      const env = parseEnvelope(`${line}\n`, 4);
      assert.equal(env.error.code, "not_authenticated", `fallback by exit code for ${line}`);
      assert.equal(env.exit_code, 4);
      const err = CtxError.fromProcess(`${line}\n`, 4);
      assert.ok(err instanceof CtxError);
      assert.deepEqual(err.advice, []);
    }
    const ok = parseEnvelope('{"schema":"ctx.error.v1","exit_code":12,"error":{"code":"busy","message":"m","advice":[],"retryable":true}}', 12);
    assert.equal(ok.error.code, "busy", "a well-formed envelope still wins");
    const noAdvice = CtxError.fromProcess('{"schema":"ctx.error.v1","exit_code":3,"error":{"code":"usage","message":"m","retryable":false}}', 3);
    assert.deepEqual(noAdvice.advice, [], "a missing advice array becomes []");
  });

  it("prepare-test-workspaces refuses an --out that is --from, inside it, or an ancestor of it, and never deletes the source", () => {
    const base = tempDir("prepare guard");
    const from = path.join(base, "fixtures", "workspaces");
    fs.mkdirSync(path.join(from, "basic"), { recursive: true });
    fs.writeFileSync(path.join(from, "basic", "keep.txt"), "x");
    const script = path.join(REPO_ROOT, "scripts", "prepare-test-workspaces.mjs");
    for (const out of [from, path.join(from, "copy"), path.join(base, "fixtures"), base]) {
      const r = spawnSync(process.execPath, [script, "--from", from, "--out", out], { encoding: "utf8" });
      assert.notEqual(r.status, 0, `--out ${out} must be refused`);
      assert.ok(fs.existsSync(path.join(from, "basic", "keep.txt")), `--out ${out} deleted the source`);
    }
  });

  it("fake ctx answers version --json with the built-in doc when the selected scenario has no version rule (its default never applies to version)", async () => {
    for (const scenario of ["mixed", "not-initialized", "clean"]) {
      const r = await runFake(["version", "--json"], { env: baseEnv({ FAKE_CTX_SCENARIO: scenario }) });
      assert.equal(r.code, 0, `${scenario}: ${r.stderr.toString()}`);
      const doc = JSON.parse(r.stdout.toString()) as { schema: string; contract_version: number; capabilities: string[] };
      assert.equal(doc.schema, "ctx.version.v1");
      assert.equal(doc.capabilities.at(-1), "repair");
    }
    const tooOld = await runFake(["version", "--json"], { env: baseEnv({ FAKE_CTX_SCENARIO: "ctx-too-old" }) });
    assert.equal(tooOld.code, 1, "an explicit version rule still wins");
  });

  it("fake ctx and fixtures.selectRule ignore the -m commit message when matching rule tokens", async () => {
    for (const message of ["pull", "status", "--offline"]) {
      const root = rootWith("clean");
      const argv = ["push", "--json", "--yes", "--root", root, "-m", message];
      const r = await runFake(argv);
      assert.equal(r.code, 0, r.stderr.toString());
      assert.equal((JSON.parse(r.stdout.toString()) as { schema: string }).schema, "ctx.push.v1", `-m ${message} must not select another rule`);
      assert.equal(lf(scenarioOutput("clean", argv)?.stdout ?? ""), lf(r.stdout), "fixtures.selectRule agrees");
    }
  });

  it("FakeRepository.refresh never throws and clears lastError on every successful refresh", async () => {
    const { fakeRepository } = load("../../helpers/fakeRepository") as typeof import("../../helpers/fakeRepository");
    const repo = fakeRepository({ root: "/work/beta" });
    repo.lastError = CtxError.extension("timeout", "slow");
    await repo.refresh();
    assert.equal(repo.lastError, undefined, "no hook: the refresh succeeds and clears lastError");

    repo.onRefresh = () => { throw new Error("hook bug"); };
    await repo.refresh();
    const afterHook = (repo as { lastError: CtxError | undefined }).lastError;
    assert.ok(afterHook instanceof CtxError, "a non-CtxError from the hook lands in lastError");
    assert.match(afterHook.message, /hook bug/);

    const result = await repo.run("push", async () => "pushed");
    assert.equal(result, "pushed", "a throwing refresh hook never replaces fn's result");
  });

  it("the vscode stub's EventEmitter.fire never throws: a throwing listener is reported and the others still run", () => {
    const emitter = new vscodeStub.EventEmitter<number>();
    const got: number[] = [];
    emitter.event(() => { throw new Error("listener bug"); });
    emitter.event((n) => got.push(n));
    const original = console.error;
    const reported: unknown[] = [];
    console.error = (...a: unknown[]) => { reported.push(a); };
    try {
      assert.doesNotThrow(() => emitter.fire(7));
    } finally {
      console.error = original;
    }
    assert.deepEqual(got, [7]);
    assert.equal(reported.length, 1, "the listener error is reported once");
  });
});
