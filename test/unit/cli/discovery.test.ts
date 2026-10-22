// ctx binary discovery (src/cli/discovery.ts, E35) + the handshake it runs (E36). Plain mocha,
// no vscode: fs, env, platform and the probe are injected. Most tests use an in-memory fs and a
// scripted probe that answers like a fake-ctx scenario (scenarioOutput) and records its calls;
// the tests marked "real" start node + test/fake-ctx through a test-local child_process helper
// (never src/cli/spawn.ts, which another lane owns).
import * as assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describeBinary } from "../../../src/cli/capabilities";
import {
  REJECTED_EXT_MESSAGE, candidateKey, candidates, discover, nodeDiscoveryFs, parseTestCtxSpec,
  type CandidateOptions, type DiscoveryDeps, type DiscoveryFs, type DiscoveryResult, type Probe, type StatInfo,
} from "../../../src/cli/discovery";
import type { CliLogger, CtxInvocation, ProcessResult } from "../../../src/cli/spawn";
import { CtxError, TEST_CTX_ENV, type TestCtxSpec } from "../../../src/cli/types";
import { REQUIRED_CAPABILITIES } from "../../../src/contract/types";
import { FAKE_CTX, REPO_ROOT, builtinVersionOutput, scenarioOutput } from "../../helpers/fixtures";

// ---------- harness ----------

const JSON_ARGS = ["version", "--json"];
const SHORT_ARGS = ["version", "--short"];
const HOME = "/home/dana";
const WIN_HOME = "C:\\Users\\dana";

/** An in-memory DiscoveryFs (case-insensitive on win32, like NTFS). Every stat is recorded. */
class MemFs implements DiscoveryFs {
  readonly stats: string[] = [];
  private readonly files = new Map<string, StatInfo>();

  constructor(private readonly platform: NodeJS.Platform, files: Record<string, Partial<StatInfo>> = {}) {
    for (const [p, st] of Object.entries(files)) { this.set(p, st); }
  }

  /** Create or replace a file (default: an executable regular file). */
  set(p: string, st: Partial<StatInfo> = {}): void {
    this.files.set(this.key(p), { isFile: true, mtimeMs: 1_700_000_000_000, size: 4096, mode: 0o100755, ...st });
  }

  /** Change some stat fields of an existing file. */
  touch(p: string, patch: Partial<StatInfo>): void {
    const cur = this.files.get(this.key(p));
    if (cur === undefined) { throw new Error(`no such file ${p}`); }
    this.files.set(this.key(p), { ...cur, ...patch });
  }

  stat(p: string): Promise<StatInfo | undefined> {
    this.stats.push(p);
    const st = this.files.get(this.key(p));
    return Promise.resolve(st === undefined ? undefined : { ...st });
  }

  private key(p: string): string {
    return this.platform === "win32" ? p.toLowerCase() : p;
  }
}

/**
 * How a scripted candidate answers: a fake-ctx scenario name (answers exactly like
 * test/fake-ctx/fake-ctx.mjs would, built-in handshake included), 'builtin' (a current release
 * ctx: contract 1, every capability), or 'reject' (the probe rejects: a timeout).
 */
type Script = string;

interface ProbeCall { command: string; prefixArgs: string[]; env?: Record<string, string>; args: string[]; }

function call(inv: CtxInvocation, args: readonly string[]): ProbeCall {
  return { command: inv.command, prefixArgs: [...inv.prefixArgs], ...(inv.env ? { env: { ...inv.env } } : {}), args: [...args] };
}

function processResult(args: readonly string[], out: { stdout: string | Buffer; stderr: string | Buffer; exit: number | null; signal?: NodeJS.Signals | null }): ProcessResult {
  return {
    args: [...args],
    stdout: Buffer.isBuffer(out.stdout) ? out.stdout : Buffer.from(out.stdout, "utf8"),
    stderr: Buffer.isBuffer(out.stderr) ? out.stderr.toString("utf8") : out.stderr,
    exitCode: out.exit,
    signal: out.signal ?? null,
    durationMs: 3,
  };
}

/** A probe answering per inv.command from `scripts`; an unscripted command rejects (and is recorded). */
function scripted(scripts: Record<string, Script>): { probe: Probe; calls: ProbeCall[] } {
  const calls: ProbeCall[] = [];
  const probe: Probe = (inv, args) => {
    calls.push(call(inv, args));
    const script = scripts[inv.command];
    if (script === undefined) { return Promise.reject(new Error(`unscripted probe of ${inv.command}`)); }
    if (script === "reject") { return Promise.reject(CtxError.extension("timeout", `ctx ${JSON.stringify(args)} timed out`)); }
    const out = script === "builtin" ? builtinVersionOutput(args) : scenarioOutput(script, args);
    if (out === undefined) { return Promise.reject(new Error(`scenario ${script} has no answer for ${JSON.stringify(args)}`)); }
    return Promise.resolve(processResult(args, out));
  };
  return { probe, calls };
}

interface RecordingLog extends CliLogger { infos: string[]; warns: string[]; others: string[]; }

function recordingLog(): RecordingLog {
  const log: RecordingLog = {
    infos: [], warns: [], others: [],
    info: (m) => { log.infos.push(m); },
    warn: (m) => { log.warns.push(m); },
    error: (m) => { log.others.push(`error: ${m}`); },
    debug: (m) => { log.others.push(`debug: ${m}`); },
  };
  return log;
}

type Deps = DiscoveryDeps & { log: RecordingLog };

function deps(o: Partial<DiscoveryDeps> & Pick<DiscoveryDeps, "fs" | "probe">): Deps {
  const { log: _log, ...rest } = o;
  return {
    platform: "linux", env: {}, homedir: HOME, configPath: undefined, testMode: false, cache: new Map(),
    ...rest,
    log: recordingLog(),
  };
}

/** One discover() call; asserts the one-info-line and warnings-are-logged rules every time. */
async function run(d: Deps): Promise<DiscoveryResult> {
  const infos = d.log.infos.length;
  const warns = d.log.warns.length;
  const r = await discover(d);
  assert.deepEqual(d.log.infos.slice(infos), [describeBinary(r.state)], "exactly one info line: describeBinary(state)");
  assert.deepEqual(d.log.warns.slice(warns), r.warnings, "every warning is logged through log.warn");
  assert.equal(r.invocation !== undefined, r.state.kind !== "missing", "invocation iff not missing");
  return r;
}

function paths(o: CandidateOptions): string[] {
  return candidates(o).list.map((c) => c.path);
}

// ---- real processes (test-local; shell:false like the runner) ----

/** The inherited env without anything that would steer the fake ctx or discovery. */
function baseEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of ["FAKE_CTX_SCENARIO", "FAKE_CTX_CALLS", "FAKE_CTX_NODE", TEST_CTX_ENV]) { delete env[k]; }
  return env;
}

function runProcess(command: string, argv: readonly string[], env: NodeJS.ProcessEnv, args: readonly string[]): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...argv], { env, cwd: os.tmpdir(), shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (b: Buffer) => out.push(b));
    child.stderr.on("data", (b: Buffer) => err.push(b));
    child.on("error", (e) => reject(CtxError.extension("spawn_failed", e.message)));
    child.on("close", (code, signal) => resolve(processResult(args, { stdout: Buffer.concat(out), stderr: Buffer.concat(err), exit: code, signal })));
  });
}

/** A real probe: spawns inv.command [...prefixArgs, ...args] with {...env, ...inv.env, ...extraEnv}. */
function spawnProbe(extraEnv: Record<string, string> = {}): { probe: Probe; calls: ProbeCall[] } {
  const calls: ProbeCall[] = [];
  const probe: Probe = (inv, args) => {
    calls.push(call(inv, args));
    return runProcess(inv.command, [...inv.prefixArgs, ...args], { ...baseEnv(), ...inv.env, ...extraEnv }, args);
  };
  return { probe, calls };
}

/** A real probe for a candidate path that only exists in a MemFs: runs `node fake-ctx.mjs` with FAKE_CTX_SCENARIO. */
function fakeCtxProbe(scenario: string): { probe: Probe; calls: ProbeCall[] } {
  const calls: ProbeCall[] = [];
  const probe: Probe = (inv, args) => {
    calls.push(call(inv, args));
    return runProcess(process.execPath, [FAKE_CTX, ...args], { ...baseEnv(), FAKE_CTX_SCENARIO: scenario }, args);
  };
  return { probe, calls };
}

// ---------- tests ----------

describe("ctx binary discovery (E35) + handshake (E36)", () => {
  it("order is contexo.path, PATH, ~/.local/bin, LOCALAPPDATA\\Programs\\contexo, ~/go/bin, homebrew, /usr/local", () => {
    for (const platform of ["linux", "darwin"] as const) {
      const { list, warnings } = candidates({
        platform, homedir: HOME, configPath: "/opt/ctx/bin/ctx",
        env: { PATH: "/usr/bin:/home/dana/bin", LOCALAPPDATA: "/ignored/on/posix" },
      });
      assert.deepEqual(warnings, []);
      assert.deepEqual(list, [
        { path: "/opt/ctx/bin/ctx", source: "contexo.path" },
        { path: "/usr/bin/ctx", source: "PATH" },
        { path: "/home/dana/bin/ctx", source: "PATH" },
        { path: "/home/dana/.local/bin/ctx", source: "~/.local/bin" },
        { path: "/home/dana/go/bin/ctx", source: "~/go/bin" },
        { path: "/opt/homebrew/bin/ctx", source: "/opt/homebrew/bin" },
        { path: "/usr/local/bin/ctx", source: "/usr/local/bin" },
      ], platform);
    }
    const win = candidates({
      platform: "win32", homedir: WIN_HOME, configPath: "D:\\tools\\ctx.exe",
      env: { Path: "C:\\Windows\\system32;C:\\Users\\dana\\bin", PATHEXT: ".EXE;.COM", LOCALAPPDATA: "C:\\Users\\dana\\AppData\\Local" },
    });
    assert.deepEqual(win.warnings, []);
    assert.deepEqual(win.list, [
      { path: "D:\\tools\\ctx.exe", source: "contexo.path" },
      { path: "C:\\Windows\\system32\\ctx.EXE", source: "PATH" },
      { path: "C:\\Windows\\system32\\ctx.COM", source: "PATH" },
      { path: "C:\\Users\\dana\\bin\\ctx.EXE", source: "PATH" },
      { path: "C:\\Users\\dana\\bin\\ctx.COM", source: "PATH" },
      { path: "C:\\Users\\dana\\AppData\\Local\\Programs\\contexo\\ctx.exe", source: "LOCALAPPDATA" },
      { path: "C:\\Users\\dana\\go\\bin\\ctx.exe", source: "~/go/bin" },
    ]);
    // without contexo.path, PATH or LOCALAPPDATA only the home and fixed locations remain
    assert.deepEqual(paths({ platform: "linux", homedir: HOME, configPath: undefined, env: {} }),
      ["/home/dana/.local/bin/ctx", "/home/dana/go/bin/ctx", "/opt/homebrew/bin/ctx", "/usr/local/bin/ctx"]);
    assert.deepEqual(paths({ platform: "win32", homedir: WIN_HOME, configPath: undefined, env: {} }), ["C:\\Users\\dana\\go\\bin\\ctx.exe"]);
  });

  it("PATH: empty, relative and quoted-empty entries are skipped, quotes stripped, duplicates dropped, default PATHEXT", () => {
    assert.deepEqual(paths({ platform: "linux", homedir: HOME, configPath: "/usr/local/bin/ctx", env: { PATH: ":/usr/bin::bin:./x:~/bin:/usr/bin/:/usr/local/bin" } }), [
      "/usr/local/bin/ctx", "/usr/bin/ctx",
      "/home/dana/.local/bin/ctx", "/home/dana/go/bin/ctx", "/opt/homebrew/bin/ctx",
    ]);
    // POSIX PATH is case-sensitive: 'Path' is not PATH there
    assert.deepEqual(paths({ platform: "linux", homedir: HOME, configPath: undefined, env: { Path: "/x" } }).filter((p) => p.startsWith("/x")), []);
    const win = paths({
      platform: "win32", homedir: WIN_HOME, configPath: undefined,
      env: { path: ";\"\";C:\\A;\"C:\\Program Files\\ctx\";relative\\dir;\\rooted;C:drive-relative;c:\\a\\;\\\\server\\share\\bin" },
    });
    assert.deepEqual(win, [
      ...[".COM", ".EXE", ".BAT", ".CMD"].map((ext) => `C:\\A\\ctx${ext}`),
      ...[".COM", ".EXE", ".BAT", ".CMD"].map((ext) => `C:\\Program Files\\ctx\\ctx${ext}`),
      ...[".COM", ".EXE", ".BAT", ".CMD"].map((ext) => `\\\\server\\share\\bin\\ctx${ext}`),
      "C:\\Users\\dana\\go\\bin\\ctx.exe",
    ]);
    // a contexo.path equal (case-insensitively) to a later win32 candidate keeps its first position only
    assert.deepEqual(paths({
      platform: "win32", homedir: WIN_HOME, configPath: "c:\\users\\DANA\\go\\bin\\CTX.EXE", env: {},
    }), ["c:\\users\\DANA\\go\\bin\\CTX.EXE"]);
  });

  it("relative contexo.path is ignored", async () => {
    const fs1 = new MemFs("linux", { "bin/ctx": {}, "/usr/bin/ctx": {} });
    const { probe, calls } = scripted({ "/usr/bin/ctx": "builtin", "bin/ctx": "builtin" });
    const d = deps({ fs: fs1, probe, configPath: "bin/ctx", env: { PATH: "/usr/bin" } });
    const r = await run(d);
    assert.equal(r.state.kind, "ok");
    assert.equal(r.state.kind === "ok" ? r.state.path : "", "/usr/bin/ctx");
    assert.deepEqual(r.invocation, { command: "/usr/bin/ctx", prefixArgs: [] });
    assert.equal(r.warnings.length, 1);
    assert.match(r.warnings[0] ?? "", /contexo\.path/);
    assert.ok((r.warnings[0] ?? "").includes("bin/ctx"), "the warning names the value");
    assert.ok(!fs1.stats.includes("bin/ctx"), "a relative contexo.path is never resolved or stat'ed");
    assert.deepEqual(calls.map((c) => c.command), ["/usr/bin/ctx"]);
    assert.ok(!r.tried.includes("bin/ctx"));
    // win32: only 'X:\...' and '\\server\...' are absolute
    for (const rel of ["ctx.exe", ".\\ctx.exe", "C:ctx.exe", "\\tools\\ctx.exe", "~\\ctx.exe"]) {
      const c = candidates({ platform: "win32", homedir: WIN_HOME, configPath: rel, env: {} });
      assert.ok(!c.list.some((x) => x.source === "contexo.path"), rel);
      assert.equal(c.warnings.length, 1, rel);
      assert.ok((c.warnings[0] ?? "").includes(rel), rel);
    }
    for (const abs of ["C:\\tools\\ctx.exe", "c:/tools/ctx.exe", "\\\\server\\share\\ctx.exe"]) {
      const c = candidates({ platform: "win32", homedir: WIN_HOME, configPath: abs, env: {} });
      assert.deepEqual(c.list[0], { path: abs, source: "contexo.path" }, abs);
      assert.deepEqual(c.warnings, [], abs);
    }
    // POSIX: 'C:\...' is relative there
    const p = candidates({ platform: "darwin", homedir: HOME, configPath: "C:\\tools\\ctx.exe", env: {} });
    assert.ok(!p.list.some((x) => x.source === "contexo.path"));
    assert.equal(p.warnings.length, 1);
  });

  it("a missing contexo.path falls through with a warning (also a directory or a non-executable file)", async () => {
    const cases: [string, Partial<StatInfo> | undefined][] = [
      ["/opt/missing/ctx", undefined],
      ["/opt/dir/ctx", { isFile: false, mode: 0o040755 }],
      ["/opt/noexec/ctx", { mode: 0o100644 }],
    ];
    for (const [configPath, st] of cases) {
      const mem = new MemFs("linux", { "/usr/bin/ctx": {} });
      if (st !== undefined) { mem.set(configPath, st); }
      const { probe, calls } = scripted({ "/usr/bin/ctx": "builtin", [configPath]: "builtin" });
      const r = await run(deps({ fs: mem, probe, configPath, env: { PATH: "/usr/bin" } }));
      assert.equal(r.state.kind === "ok" ? r.state.path : r.state.kind, "/usr/bin/ctx", configPath);
      assert.equal(r.warnings.length, 1, configPath);
      assert.ok((r.warnings[0] ?? "").includes(configPath), `warning names ${configPath}`);
      assert.deepEqual(calls.map((c) => c.command), ["/usr/bin/ctx"], `${configPath} is never probed`);
      assert.deepEqual(r.tried, [configPath, "/usr/bin/ctx"]);
    }
    // win32 has no executable bit: mode is not consulted there
    const win = new MemFs("win32", { "C:\\tools\\ctx.exe": { mode: 0o100666 } });
    const { probe } = scripted({ "C:\\tools\\ctx.exe": "builtin" });
    const r = await run(deps({ platform: "win32", homedir: WIN_HOME, fs: win, probe, configPath: "C:\\tools\\ctx.exe" }));
    assert.equal(r.state.kind, "ok");
  });

  it("a fake ctx answering contract 0 gives tooOld with its version", async () => {
    const mem = new MemFs("linux", { "/opt/ctx/bin/ctx": {} });
    const { probe, calls } = fakeCtxProbe("e1-too-old");
    const r = await run(deps({ fs: mem, probe, configPath: "/opt/ctx/bin/ctx" }));
    assert.deepEqual(r.state, { kind: "tooOld", path: "/opt/ctx/bin/ctx", versionText: "0.6.9", missing: [] });
    assert.deepEqual(r.invocation, { command: "/opt/ctx/bin/ctx", prefixArgs: [] });
    assert.deepEqual(calls.map((c) => c.args), [JSON_ARGS], "a version doc is a handshake: no version --short");
    assert.deepEqual(r.tried, ["/opt/ctx/bin/ctx"]);
  });

  it("a non-ctx binary first on PATH is skipped", async () => {
    const mem = new MemFs("darwin", { "/opt/other/bin/ctx": {}, "/usr/local/bin/ctx": {} });
    const { probe, calls } = scripted({ "/opt/other/bin/ctx": "e1-not-ctx", "/usr/local/bin/ctx": "builtin" });
    const d = deps({ platform: "darwin", fs: mem, probe, env: { PATH: "/opt/other/bin:/usr/local/bin" } });
    const r = await run(d);
    assert.equal(r.state.kind, "ok");
    assert.equal(r.state.kind === "ok" ? r.state.path : "", "/usr/local/bin/ctx");
    assert.deepEqual(r.invocation, { command: "/usr/local/bin/ctx", prefixArgs: [] });
    assert.deepEqual(calls.map((c) => [c.command, c.args]), [
      ["/opt/other/bin/ctx", JSON_ARGS],
      ["/opt/other/bin/ctx", SHORT_ARGS],
      ["/usr/local/bin/ctx", JSON_ARGS],
    ]);
    assert.deepEqual(r.tried, ["/opt/other/bin/ctx", "/usr/local/bin/ctx"]);
    assert.ok(r.warnings.some((w) => w.includes("/opt/other/bin/ctx")), "the skip is reported");
    // foreign is a probe result: cached like any handshake
    const again = await run(d);
    assert.deepEqual(again.state, r.state);
    assert.equal(calls.length, 3, "nothing re-probed on the second discover()");
  });

  it("an old ctx first on PATH gives tooOld and does not fall through", async () => {
    const mem = new MemFs("linux", { "/usr/bin/ctx": {}, "/home/dana/.local/bin/ctx": {} });
    const { probe, calls } = scripted({ "/usr/bin/ctx": "e1-old-ctx-0.6.6", "/home/dana/.local/bin/ctx": "builtin" });
    const r = await run(deps({ fs: mem, probe, env: { PATH: "/usr/bin" } }));
    assert.deepEqual(r.state, { kind: "tooOld", path: "/usr/bin/ctx", versionText: "0.6.6", missing: [...REQUIRED_CAPABILITIES] });
    assert.deepEqual(r.invocation, { command: "/usr/bin/ctx", prefixArgs: [] });
    assert.deepEqual(calls.map((c) => [c.command, c.args]), [["/usr/bin/ctx", JSON_ARGS], ["/usr/bin/ctx", SHORT_ARGS]]);
    assert.ok(!calls.some((c) => c.command === "/home/dana/.local/bin/ctx"), "the newer ctx later in the order is never probed");
    assert.deepEqual(r.tried, ["/usr/bin/ctx"]);
    // the same holds for extensionTooOld (ctx-contract2) ahead of a good ctx
    const s2 = scripted({ "/usr/bin/ctx": "ctx-contract2", "/home/dana/.local/bin/ctx": "builtin" });
    const r2 = await run(deps({ fs: mem, probe: s2.probe, env: { PATH: "/usr/bin" } }));
    assert.deepEqual(r2.state, { kind: "extensionTooOld", path: "/usr/bin/ctx", contractVersion: 2 });
    assert.deepEqual(s2.calls.map((c) => c.command), ["/usr/bin/ctx"]);
  });

  it(".cmd/.bat/.ps1 are rejected with the point-at-ctx.exe message", async () => {
    const mem = new MemFs("win32", {
      "C:\\Tools\\ctx.cmd": {},
      "C:\\bat\\ctx.bat": {},
      "C:\\ps\\CTX.PS1": {},
      "C:\\good\\ctx.exe": {},
    });
    const { probe, calls } = scripted({ "C:\\good\\ctx.EXE": "builtin" });
    const r = await run(deps({
      platform: "win32", homedir: WIN_HOME, fs: mem, probe, configPath: "C:\\Tools\\ctx.cmd",
      env: { Path: "C:\\bat;C:\\ps;C:\\good", PATHEXT: ".BAT;.PS1;.EXE" },
    }));
    assert.equal(r.state.kind === "ok" ? r.state.path : r.state.kind, "C:\\good\\ctx.EXE");
    assert.deepEqual(r.invocation, { command: "C:\\good\\ctx.EXE", prefixArgs: [] });
    assert.deepEqual(calls.map((c) => c.command), ["C:\\good\\ctx.EXE"], "rejected candidates are never probed");
    const rejected = r.warnings.filter((w) => w.includes(REJECTED_EXT_MESSAGE));
    assert.equal(rejected.length, 3, r.warnings.join("\n"));
    for (const p of ["C:\\Tools\\ctx.cmd", "C:\\bat\\ctx.BAT", "C:\\ps\\ctx.PS1"]) {
      assert.ok(rejected.some((w) => w.includes(p)), `a rejection names ${p}`);
    }
    assert.ok(!r.warnings.some((w) => w.includes("C:\\good\\ctx.BAT") || w.includes("C:\\bat\\ctx.EXE")), "absent candidates are silent");
    // the extension check ignores case and the platform: a POSIX contexo.path ending in .CMD is rejected too
    const posix = new MemFs("linux", { "/opt/ctx/ctx.CMD": {}, "/usr/bin/ctx": {} });
    const s2 = scripted({ "/usr/bin/ctx": "builtin" });
    const r2 = await run(deps({ fs: posix, probe: s2.probe, configPath: "/opt/ctx/ctx.CMD", env: { PATH: "/usr/bin" } }));
    assert.equal(r2.state.kind === "ok" ? r2.state.path : r2.state.kind, "/usr/bin/ctx");
    assert.ok(r2.warnings.some((w) => w.includes("/opt/ctx/ctx.CMD") && w.includes(REJECTED_EXT_MESSAGE)));
    // a .cmd as the only candidate -> missing
    const only = new MemFs("win32", { "C:\\Tools\\ctx.cmd": {} });
    const s3 = scripted({});
    const r3 = await run(deps({ platform: "win32", homedir: WIN_HOME, fs: only, probe: s3.probe, configPath: "C:\\Tools\\ctx.cmd" }));
    assert.deepEqual(r3.state, { kind: "missing" });
    assert.deepEqual(s3.calls, []);
  });

  it("the win32 PATHEXT scan finds ctx.exe", async () => {
    const mem = new MemFs("win32", { "C:\\Users\\dana\\bin\\CTX.EXE": {} });
    const { probe, calls } = scripted({ "C:\\Users\\dana\\bin\\ctx.exe": "builtin" });
    const r = await run(deps({
      platform: "win32", homedir: WIN_HOME, fs: mem, probe,
      env: { Path: "C:\\Windows\\system32;C:\\Users\\dana\\bin", pathext: ".com;.exe" },
    }));
    assert.equal(r.state.kind === "ok" ? r.state.path : r.state.kind, "C:\\Users\\dana\\bin\\ctx.exe");
    assert.deepEqual(r.invocation, { command: "C:\\Users\\dana\\bin\\ctx.exe", prefixArgs: [] });
    assert.deepEqual(calls.map((c) => c.args), [JSON_ARGS]);
    assert.deepEqual(r.tried, [
      "C:\\Windows\\system32\\ctx.com", "C:\\Windows\\system32\\ctx.exe", "C:\\Users\\dana\\bin\\ctx.com", "C:\\Users\\dana\\bin\\ctx.exe",
    ]);
    assert.deepEqual(mem.stats, r.tried, "PATH x PATHEXT is a stat scan, never `where`");
    // the LOCALAPPDATA install location (any env key case)
    const local = new MemFs("win32", { "C:\\Users\\dana\\AppData\\Local\\Programs\\contexo\\ctx.exe": {} });
    const s2 = scripted({ "C:\\Users\\dana\\AppData\\Local\\Programs\\contexo\\ctx.exe": "builtin" });
    const r2 = await run(deps({ platform: "win32", homedir: WIN_HOME, fs: local, probe: s2.probe, env: { LocalAppData: "C:\\Users\\dana\\AppData\\Local" } }));
    assert.equal(r2.state.kind === "ok" ? r2.state.path : r2.state.kind, "C:\\Users\\dana\\AppData\\Local\\Programs\\contexo\\ctx.exe");
  });

  it("no candidate gives missing", async () => {
    const mem = new MemFs("linux");
    const { probe, calls } = scripted({});
    const d = deps({ fs: mem, probe, env: { PATH: "/usr/bin:/bin" } });
    const r = await run(d);
    assert.deepEqual(r.state, { kind: "missing" });
    assert.equal(r.invocation, undefined);
    assert.deepEqual(r.warnings, []);
    assert.deepEqual(calls, []);
    assert.deepEqual(r.tried, [
      "/usr/bin/ctx", "/bin/ctx", "/home/dana/.local/bin/ctx", "/home/dana/go/bin/ctx", "/opt/homebrew/bin/ctx", "/usr/local/bin/ctx",
    ]);
    assert.deepEqual(d.log.infos, ["ctx binary missing"]);
    assert.equal(d.cache.size, 0);
  });

  it("the cache is reused until mtime or size changes", async () => {
    const bin = "/opt/ctx/bin/ctx";
    const mem = new MemFs("linux", { [bin]: { mtimeMs: 1000, size: 2048 } });
    const { probe, calls } = scripted({ [bin]: "builtin" });
    const cache = new Map();
    const d = deps({ fs: mem, probe, cache, configPath: bin });
    const first = await run(d);
    assert.equal(first.state.kind, "ok");
    assert.equal(calls.length, 1);
    assert.deepEqual([...cache.keys()], [candidateKey(bin, { isFile: true, mtimeMs: 1000, size: 2048, mode: 0o100755 })]);
    const second = await run(d);
    assert.deepEqual(second.state, first.state);
    assert.equal(calls.length, 1, "same path + mtime + size: the cached handshake is used");
    assert.equal(d.log.infos.length, 2, "still one info line per discover()");
    mem.touch(bin, { mtimeMs: 2000 });
    await run(d);
    assert.equal(calls.length, 2, "a new mtime is probed again");
    await run(d);
    assert.equal(calls.length, 2);
    mem.touch(bin, { size: 4096 });
    await run(d);
    assert.equal(calls.length, 3, "a new size is probed again");
    assert.equal(cache.size, 3);
    // a fresh cache (rediscover) probes again
    await run(deps({ fs: mem, probe, configPath: bin }));
    assert.equal(calls.length, 4);
  });

  it("a probe rejection skips the candidate and is not cached", async () => {
    const mem = new MemFs("linux", { "/a/ctx": {}, "/b/ctx": {} });
    const { probe, calls } = scripted({ "/a/ctx": "reject", "/b/ctx": "builtin" });
    const d = deps({ fs: mem, probe, env: { PATH: "/a:/b" } });
    const r = await run(d);
    assert.equal(r.state.kind === "ok" ? r.state.path : r.state.kind, "/b/ctx");
    assert.ok(r.warnings.some((w) => w.includes("/a/ctx")), "the rejection is reported");
    assert.equal(d.cache.size, 1, "only /b/ctx's handshake is cached");
    await run(d);
    assert.deepEqual(calls.map((c) => c.command), ["/a/ctx", "/b/ctx", "/a/ctx"], "/a/ctx is probed again; /b/ctx comes from the cache");
    // a rejected `version --short` also skips without caching
    const old = new MemFs("linux", { "/c/ctx": {} });
    let shortCalls = 0;
    const flaky: Probe = (inv, args) => {
      if (args[1] === "--short") { shortCalls++; return Promise.reject(CtxError.extension("timeout", "version --short timed out")); }
      return Promise.resolve(processResult(args, { stdout: "", stderr: "✖ unknown flag: --json\n", exit: 1 }));
    };
    const d2 = deps({ fs: old, probe: flaky, configPath: "/c/ctx" });
    const r2 = await run(d2);
    assert.deepEqual(r2.state, { kind: "missing" });
    assert.equal(d2.cache.size, 0);
    await run(d2);
    assert.equal(shortCalls, 2);
  });

  it("CONTEXO_TEST_CTX is ignored outside Test mode", async () => {
    const spec: TestCtxSpec = { command: "/test/node", prefixArgs: ["/test/fake-ctx.mjs"], env: { FAKE_CTX_SCENARIO: "clean" } };
    const mem = new MemFs("linux", { "/usr/bin/ctx": {}, "/test/node": {} });
    const env = { PATH: "/usr/bin", [TEST_CTX_ENV]: JSON.stringify(spec) };

    // outside Test mode: the variable is ignored, the real ctx is found
    const outside = scripted({ "/usr/bin/ctx": "builtin", "/test/node": "builtin" });
    const r1 = await run(deps({ fs: mem, probe: outside.probe, env, testMode: false }));
    assert.equal(r1.state.kind === "ok" ? r1.state.path : r1.state.kind, "/usr/bin/ctx");
    assert.deepEqual(outside.calls.map((c) => c.command), ["/usr/bin/ctx"]);
    assert.deepEqual(r1.warnings, []);

    // Test mode: the spec is the only candidate, probed without the cache
    const inside = scripted({ "/test/node": "builtin", "/usr/bin/ctx": "builtin" });
    const stats = mem.stats.length;
    const d = deps({ fs: mem, probe: inside.probe, env, testMode: true });
    const r2 = await run(d);
    assert.equal(r2.state.kind, "ok");
    assert.equal(r2.state.kind === "ok" ? r2.state.path : "", spec.command, "state.path === spec.command");
    assert.deepEqual(r2.invocation, { command: "/test/node", prefixArgs: ["/test/fake-ctx.mjs"], env: { FAKE_CTX_SCENARIO: "clean" } });
    assert.deepEqual(inside.calls, [{ command: "/test/node", prefixArgs: ["/test/fake-ctx.mjs"], env: { FAKE_CTX_SCENARIO: "clean" }, args: JSON_ARGS }]);
    assert.deepEqual(r2.tried, ["/test/node"]);
    assert.equal(mem.stats.length, stats, "nothing is stat'ed in Test mode");
    assert.equal(d.cache.size, 0, "Test mode never caches");
    await run(d);
    assert.equal(inside.calls.length, 2, "Test mode probes on every discover()");
    // a spec without env gives an invocation without env
    const noEnv = scripted({ "/test/node": "builtin" });
    const r3 = await run(deps({ fs: mem, probe: noEnv.probe, testMode: true, env: { [TEST_CTX_ENV]: JSON.stringify({ command: "/test/node", prefixArgs: [] }) } }));
    assert.deepEqual(r3.invocation, { command: "/test/node", prefixArgs: [] });

    // a malformed spec fails closed: missing with a warning, no real candidate probed
    for (const raw of ["not json", "[]", "null", "\"/test/node\"", " ", "{}", "{\"command\":\"\",\"prefixArgs\":[]}",
      "{\"command\":\"/test/node\"}", "{\"command\":\"/test/node\",\"prefixArgs\":\"x\"}", "{\"command\":\"/test/node\",\"prefixArgs\":[1]}",
      "{\"command\":\"/test/node\",\"prefixArgs\":[],\"env\":[]}", "{\"command\":\"/test/node\",\"prefixArgs\":[],\"env\":{\"A\":1}}"]) {
      assert.ok(parseTestCtxSpec(raw) instanceof Error, raw);
      const s = scripted({ "/usr/bin/ctx": "builtin", "/test/node": "builtin" });
      const before = mem.stats.length;
      const r = await run(deps({ fs: mem, probe: s.probe, testMode: true, env: { PATH: "/usr/bin", [TEST_CTX_ENV]: raw } }));
      assert.deepEqual(r.state, { kind: "missing" }, raw);
      assert.deepEqual(s.calls, [], `${raw}: nothing probed`);
      assert.equal(mem.stats.length, before, `${raw}: nothing stat'ed`);
      assert.equal(r.warnings.length, 1, raw);
      assert.ok((r.warnings[0] ?? "").includes(TEST_CTX_ENV), raw);
    }
    // an empty value is "not set": normal discovery in Test mode
    const empty = scripted({ "/usr/bin/ctx": "builtin" });
    const r4 = await run(deps({ fs: mem, probe: empty.probe, testMode: true, env: { PATH: "/usr/bin", [TEST_CTX_ENV]: "" } }));
    assert.equal(r4.state.kind === "ok" ? r4.state.path : r4.state.kind, "/usr/bin/ctx");

    // parseTestCtxSpec keeps only the spec fields
    assert.deepEqual(parseTestCtxSpec(JSON.stringify({ ...spec, extra: 1 })), spec);
    assert.deepEqual(parseTestCtxSpec("{\"command\":\"node\",\"prefixArgs\":[\"a b\",\"c\"]}"), { command: "node", prefixArgs: ["a b", "c"] });
  });

  it("CONTEXO_TEST_CTX in Test mode runs the real fake ctx with the spec's prefixArgs and env (real)", async () => {
    const spec: TestCtxSpec = { command: process.execPath, prefixArgs: [FAKE_CTX], env: { FAKE_CTX_SCENARIO: "e1-too-old" } };
    const { probe, calls } = spawnProbe();
    const r = await run(deps({ fs: new MemFs("linux"), probe, testMode: true, env: { [TEST_CTX_ENV]: JSON.stringify(spec) } }));
    assert.deepEqual(r.state, { kind: "tooOld", path: process.execPath, versionText: "0.6.9", missing: [] });
    assert.deepEqual(calls.map((c) => c.args), [JSON_ARGS]);
    // a Test-mode command that cannot start -> missing with a warning
    const bad: TestCtxSpec = { command: path.join(os.tmpdir(), "no-such-dir-contexo", "node"), prefixArgs: [] };
    const r2 = await run(deps({ fs: new MemFs("linux"), probe: spawnProbe().probe, testMode: true, env: { [TEST_CTX_ENV]: JSON.stringify(bad) } }));
    assert.deepEqual(r2.state, { kind: "missing" });
    assert.equal(r2.warnings.length, 1);
  });

  it("exactly one info line per discover()", async () => {
    const mem = new MemFs("linux", { "/usr/bin/ctx": {}, "/old/ctx": {}, "/odd/ctx": {} });
    const log = recordingLog();
    const outcomes: string[] = [];
    const runs: Partial<DiscoveryDeps>[] = [
      { env: { PATH: "/usr/bin" } },
      { env: { PATH: "/old" } },
      { env: { PATH: "/odd:/nowhere" } },
      { env: {} },
      { testMode: true, env: { [TEST_CTX_ENV]: "{" } },
      { configPath: "relative/ctx", env: { PATH: "/usr/bin" } },
    ];
    for (const o of runs) {
      const { probe } = scripted({ "/usr/bin/ctx": "builtin", "/old/ctx": "e1-old-ctx-0.6.6", "/odd/ctx": "e1-not-ctx" });
      const before = log.infos.length;
      const r = await discover({ ...deps({ fs: mem, probe, ...o }), log });
      assert.deepEqual(log.infos.slice(before), [describeBinary(r.state)]);
      outcomes.push(r.state.kind);
    }
    assert.deepEqual(outcomes, ["ok", "tooOld", "missing", "missing", "missing", "ok"]);
    assert.equal(log.infos.length, runs.length);
    assert.deepEqual(log.others, [], "discovery logs only info and warn");
  });

  it("nodeDiscoveryFs maps fs.promises.stat and answers undefined on any error", async () => {
    const shim = path.join(REPO_ROOT, "test", "fake-ctx", "bin", "ctx");
    const real = fs.statSync(shim);
    assert.deepEqual(await nodeDiscoveryFs.stat(shim), { isFile: true, mtimeMs: real.mtimeMs, size: real.size, mode: real.mode });
    const dir = await nodeDiscoveryFs.stat(path.join(REPO_ROOT, "test"));
    assert.equal(dir?.isFile, false);
    assert.equal(await nodeDiscoveryFs.stat(path.join(REPO_ROOT, "no-such-file-for-discovery")), undefined);
    assert.equal(await nodeDiscoveryFs.stat(`${REPO_ROOT}\u0000bad`), undefined);
  });

  it("POSIX: nodeDiscoveryFs + a real probe of test/fake-ctx/bin/ctx as contexo.path gives ok (real)", async function () {
    if (process.platform === "win32") { this.skip(); }
    const shim = path.join(REPO_ROOT, "test", "fake-ctx", "bin", "ctx");
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "contexo discovery "));
    try {
      const { probe, calls } = spawnProbe({ FAKE_CTX_NODE: process.execPath });
      const d: Deps = {
        platform: process.platform, env: { PATH: "" }, homedir: home, configPath: shim, testMode: false,
        fs: nodeDiscoveryFs, probe, log: recordingLog(), cache: new Map(),
      };
      const r = await run(d);
      assert.equal(r.state.kind, "ok", JSON.stringify(r));
      if (r.state.kind !== "ok") { return; }
      assert.equal(r.state.path, shim);
      assert.equal(r.state.version.contract_version, 1);
      assert.deepEqual(r.invocation, { command: shim, prefixArgs: [] });
      assert.deepEqual(calls.map((c) => c.args), [JSON_ARGS]);
      assert.deepEqual(r.warnings, []);
      assert.equal(d.cache.size, 1);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
