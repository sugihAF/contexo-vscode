#!/usr/bin/env node
// Real-ctx test environment (WP-3.1): an isolated loopback contexo-server plus two ctx users
// (alice for the Extension Host, bob for the CLI), all built from a git-archive copy of Contexo.
// Node built-ins only. Logs go to stderr; `up` prints only `export K='v'` lines on stdout.
//
//   node scripts/real-ctx-env.mjs up (--src <dir> | --bin <dir>) [--gui]
//   node scripts/real-ctx-env.mjs test [--no-vscode]
//   node scripts/real-ctx-env.mjs run (--src <dir> | --bin <dir>) [--no-vscode]   up, test, then down (always)
//   node scripts/real-ctx-env.mjs down
//   node scripts/real-ctx-env.mjs build --src <dir> --out <dir> [--goos <os>] [--goarch <arch>]
//   node scripts/real-ctx-env.mjs vendor-golden --src <dir> [--commit <40-hex>]
//   node scripts/real-ctx-env.mjs ide
//
// --bin <dir> (or env REAL_CTX_BIN_DIR) uses binaries that `build` made, e.g. Linux binaries
// cross-compiled on a Mac for a headless container run (lead ruling L24); `build` refuses the
// same sources `up --src` refuses and records the source commit in <dir>/BUILD-INFO.json.
// --no-vscode skips the Extension Host scenarios (vscode-test --label real-ctx) and says so on
// stderr; it is never implied. The isolation rules are in test/real-ctx/README.md.
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync,
  writeFileSync, openSync, closeSync, chmodSync,
} from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOST = "127.0.0.1";
const PORT = 18080;
const SERVER_URL = `http://${HOST}:${PORT}`;
/** The capabilities a v1 server advertises (errata E13); pages.etag is reserved and never required. */
const SERVER_CAPS = ["pages.at", "push.expect_absent", "write.path_sha"];
const RC_VERSION = "0.7.0-rc.1";
const VERSION_PKG = "github.com/sugihAF/contexo/internal/version";
/** Only git-archive copies are built: never a checkout under here. */
const CODES_DIR = "/Users/sugih/Codes";
const CONTEXO_REPO = "/Users/sugih/Codes/Contexo";
const CONTEXO_REF = "mvp/integration";
const EXE = process.platform === "win32" ? ".exe" : "";
const ENV_KEYS = [
  "CTX_BIN", "CTX_BIN_RC", "CONTEXO_TEST_SERVER", "REAL_CTX_RUN", "REAL_CTX_ALICE", "REAL_CTX_BOB",
  "REAL_CTX_HOME_ALICE", "REAL_CTX_HOME_BOB", "REAL_CTX_KEY", "REAL_CTX_REPO", "REAL_CTX_SOURCE_COMMIT",
];

const log = (msg) => process.stderr.write(`real-ctx-env: ${msg}\n`);

class Fail extends Error {
  constructor(message, code = 1) {
    super(message);
    this.exitCode = code;
  }
}

/** os.tmpdir() through realpath (macOS /var/folders -> /private/var/folders), so every path agrees. */
function tmpBase() {
  return path.join(realpathSync(os.tmpdir()), "contexo-real-ctx");
}
function pointerFile() {
  return path.join(tmpBase(), "current");
}

// ---------- argv ----------

function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const flags = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--") { continue; }
    if (!a.startsWith("--")) { throw new Fail(`unexpected argument ${JSON.stringify(a)}`, 2); }
    const name = a.slice(2);
    if (["gui", "no-vscode"].includes(name)) { flags[name] = true; continue; }
    const v = rest[i + 1];
    if (v === undefined || v.startsWith("--")) { throw new Fail(`--${name} needs a value`, 2); }
    flags[name] = v;
    i++;
  }
  return { cmd, flags };
}

// ---------- processes ----------

/** A copy of process.env without CONTEXO_* keys (nothing from the caller's shell leaks into ctx). */
function cleanEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!/^CONTEXO_/i.test(k) && k !== "GOOGLE_OAUTH_CLIENT_ID") { env[k] = v; }
  }
  return { ...env, ...extra };
}

/** Env for a ctx call as one isolated user: HOME and USERPROFILE point at that user's home. */
function userEnv(home) {
  return cleanEnv({ HOME: home, USERPROFILE: home, NO_COLOR: "1", CONTEXO_NO_UPDATE_CHECK: "1" });
}

function run(cmd, args, o = {}) {
  const r = spawnSync(cmd, args, {
    cwd: o.cwd, env: o.env ?? process.env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], shell: false,
    timeout: o.timeoutMs ?? 300000, maxBuffer: 64 << 20,
  });
  if (r.error) { throw new Fail(`${cmd} ${args.join(" ")}: ${r.error.message}`); }
  if (r.status !== 0 && !o.allowFail) {
    throw new Fail(`${path.basename(cmd)} ${args.join(" ")} exited ${r.status}\n${r.stdout}${r.stderr}`);
  }
  return r;
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) { return false; }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** True when something accepts or holds 127.0.0.1:18080. */
function portTaken() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once("error", () => resolve(true));
    s.once("listening", () => s.close(() => resolve(false)));
    s.listen(PORT, HOST);
  });
}

// ---------- sources and builds ----------

/** (a) A --src that is a git checkout or lies under /Users/sugih/Codes is refused. */
function checkSrc(src) {
  if (!src) { throw new Fail("--src <dir> is required (a git-archive copy of Contexo)", 2); }
  const abs = realpathSync(path.resolve(src));
  if (existsSync(path.join(abs, ".git"))) { throw new Fail(`${abs} contains .git: build only from a git-archive copy`, 2); }
  const codes = existsSync(CODES_DIR) ? realpathSync(CODES_DIR) : CODES_DIR;
  if (abs === codes || abs.startsWith(codes + path.sep)) {
    throw new Fail(`${abs} lies under ${CODES_DIR}: build only from a git-archive copy (e.g. $TMPDIR/wp-3.1/contexo-src)`, 2);
  }
  for (const rel of ["cmd/ctx", "cmd/contexo-server", "go.mod"]) {
    if (!existsSync(path.join(abs, rel))) { throw new Fail(`${abs} is not a Contexo source tree (no ${rel})`, 2); }
  }
  return abs;
}

/** The commit the archive came from: a read-only rev-parse of Contexo mvp/integration. */
function sourceCommit(override) {
  if (override) {
    if (!/^[0-9a-f]{40}$/.test(override)) { throw new Fail(`--commit must be 40 hex digits, got ${override}`, 2); }
    return override;
  }
  const r = run("git", ["-C", CONTEXO_REPO, "rev-parse", CONTEXO_REF], { allowFail: true });
  const sha = r.stdout.trim();
  if (r.status !== 0 || !/^[0-9a-f]{40}$/.test(sha)) {
    throw new Fail(`git -C ${CONTEXO_REPO} rev-parse ${CONTEXO_REF} failed; pass --commit <40-hex>\n${r.stderr}`);
  }
  return sha;
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/**
 * (c) go build ctx (dev), ctx stamped 0.7.0-rc.1 and contexo-server into out/{bin,bin-rc}, with
 * cwd=src, the real HOME (GOCACHE/GOMODCACHE live there) and CGO_ENABLED=0.
 */
function goBuild(src, out, o = {}) {
  const goos = o.goos ?? process.env.GOOS ?? process.platform.replace("win32", "windows");
  const goarch = o.goarch ?? process.env.GOARCH ?? { x64: "amd64", arm64: "arm64" }[process.arch] ?? process.arch;
  const exe = goos === "windows" ? ".exe" : "";
  const env = { ...process.env, CGO_ENABLED: "0", GOOS: goos, GOARCH: goarch };
  const files = {
    ctx: path.join(out, "bin", `ctx${exe}`),
    ctxRc: path.join(out, "bin-rc", `ctx${exe}`),
    server: path.join(out, "bin", `contexo-server${exe}`),
  };
  log(`go build (${goos}/${goarch}) from ${src}`);
  run("go", ["build", "-o", files.ctx, "./cmd/ctx"], { cwd: src, env, timeoutMs: 900000 });
  run("go", ["build", "-ldflags", `-X ${VERSION_PKG}.Version=${RC_VERSION}`, "-o", files.ctxRc, "./cmd/ctx"], { cwd: src, env, timeoutMs: 900000 });
  run("go", ["build", "-o", files.server, "./cmd/contexo-server"], { cwd: src, env, timeoutMs: 900000 });
  return { goos, goarch, files };
}

function cmdBuild(flags) {
  const src = checkSrc(flags.src);
  if (!flags.out) { throw new Fail("build needs --out <dir>", 2); }
  const out = path.resolve(flags.out);
  const commit = sourceCommit(flags.commit);
  rmSync(out, { recursive: true, force: true });
  const b = goBuild(src, out, { goos: flags.goos, goarch: flags.goarch });
  const info = {
    source_commit: commit, src, goos: b.goos, goarch: b.goarch, built_at: new Date().toISOString(),
    files: Object.fromEntries(Object.values(b.files).map((f) => [path.relative(out, f).split(path.sep).join("/"), sha256(f)])),
  };
  writeFileSync(path.join(out, "BUILD-INFO.json"), `${JSON.stringify(info, null, 2)}\n`);
  log(`built ${Object.keys(info.files).join(", ")} into ${out} (source ${commit})`);
}

/** Copies prebuilt binaries (a `build` output) into RUN; checks the recorded sha256s. */
function usePrebuilt(dir, runDir) {
  const abs = path.resolve(dir);
  const infoFile = path.join(abs, "BUILD-INFO.json");
  if (!existsSync(infoFile)) { throw new Fail(`${abs} has no BUILD-INFO.json: make it with \`real-ctx-env.mjs build\``, 2); }
  const info = JSON.parse(readFileSync(infoFile, "utf8"));
  for (const [rel, want] of Object.entries(info.files)) {
    const from = path.join(abs, ...rel.split("/"));
    if (sha256(from) !== want) { throw new Fail(`${from}: sha256 differs from BUILD-INFO.json`); }
    const to = path.join(runDir, ...rel.split("/"));
    mkdirSync(path.dirname(to), { recursive: true });
    copyFileSync(from, to);
    chmodSync(to, 0o755);
  }
  return info.source_commit;
}

// ---------- the run directory ----------

function readPointer() {
  try {
    return readFileSync(pointerFile(), "utf8").trim();
  } catch {
    return undefined;
  }
}

function serverPid(runDir) {
  try {
    return Number.parseInt(readFileSync(path.join(runDir, "server.pid"), "utf8").trim(), 10);
  } catch {
    return undefined;
  }
}

/** The env of the current run: process.env when it carries REAL_CTX_RUN, else the pointer's env.json. */
function loadEnv() {
  if (process.env.REAL_CTX_RUN) {
    const missing = ENV_KEYS.filter((k) => !process.env[k]);
    if (missing.length > 0) { throw new Fail(`REAL_CTX_RUN is set but ${missing.join(", ")} are not`, 2); }
    return Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  }
  const runDir = readPointer();
  const file = runDir ? path.join(runDir, "env.json") : undefined;
  if (!file || !existsSync(file)) {
    throw new Fail("no real-ctx environment: run `eval \"$(node scripts/real-ctx-env.mjs up --src <dir>)\"` first (or use `run`); nothing is skipped", 2);
  }
  return JSON.parse(readFileSync(file, "utf8"));
}

function shellQuote(v) {
  return `'${String(v).replace(/'/g, "'\\''")}'`;
}

async function waitForHealth(runDir) {
  const deadline = Date.now() + 30000;
  let last = "no answer";
  while (Date.now() < deadline) {
    const pid = serverPid(runDir);
    if (pid !== undefined && !pidAlive(pid)) {
      throw new Fail(`contexo-server exited during start-up; see ${path.join(runDir, "server.log")}\n${tail(path.join(runDir, "server.log"))}`);
    }
    try {
      const res = await fetch(`${SERVER_URL}/health`);
      const body = await res.json();
      return { body, header: res.headers.get("x-contexo-capabilities") };
    } catch (err) {
      last = err.message;
    }
    await sleep(200);
  }
  throw new Fail(`GET ${SERVER_URL}/health did not answer within 30 s (${last})`);
}

function tail(file, lines = 20) {
  try {
    return readFileSync(file, "utf8").split("\n").slice(-lines).join("\n");
  } catch {
    return "";
  }
}

/** (e) {status:'ok', api:1} and the X-Contexo-Capabilities set == body.capabilities == SERVER_CAPS. */
function assertHealth({ body, header }) {
  const sorted = (a) => [...a].sort();
  if (body?.status !== "ok" || body?.api !== 1 || !Array.isArray(body?.capabilities)) {
    throw new Fail(`GET /health returned ${JSON.stringify(body)}: this server lacks WP-0.2's {status, api, version, capabilities} (file a GFR naming WP-0.2)`);
  }
  const fromHeader = (header ?? "").split(",").map((s) => s.trim()).filter((s) => s !== "");
  const want = JSON.stringify(sorted(SERVER_CAPS));
  if (JSON.stringify(sorted(fromHeader)) !== want || new Set(fromHeader).size !== fromHeader.length) {
    throw new Fail(`X-Contexo-Capabilities is ${JSON.stringify(header)}; want exactly ${SERVER_CAPS.join(",")} (E13)`);
  }
  if (JSON.stringify(sorted(body.capabilities)) !== want) {
    throw new Fail(`/health capabilities ${JSON.stringify(body.capabilities)} differ from the header set ${want} (E13)`);
  }
}

function ctxAs(env, home, root, args) {
  return run(env.CTX_BIN, [...args, "--root", root], { env: userEnv(home), cwd: root });
}

function pageText(type, slug, title, body) {
  const dir = { concept: "wiki/concepts", entity: "wiki/entities", analysis: "wiki/analyses", source: "raw/sessions" }[type];
  return {
    rel: `${dir}/${slug}.md`,
    text: [
      "---", "schema: ctx.page.v1", `slug: ${slug}`, `type: ${type}`, "author: alice", "created: 2026-10-23T00:00:00Z",
      "updated: 2026-10-23T00:00:00Z", "parent_sha: \"\"", "---", "", `# ${title}`, "", body, "",
    ].join("\n"),
  };
}

/** --gui: a few demo pages pushed by alice and pulled by bob, so the human pass starts non-empty. */
function seedDemo(env) {
  const pages = [
    pageText("concept", "demo-retry-policy", "Retry policy", "Retries back off exponentially up to 5 attempts."),
    pageText("entity", "demo-ledger-service", "Ledger service", "Owns double-entry postings."),
    pageText("analysis", "demo-q3-chargebacks", "Q3 chargebacks", "Chargebacks fell 12% after 3DS."),
  ];
  for (const p of pages) {
    const file = path.join(env.REAL_CTX_ALICE, ".contexo", ...p.rel.split("/"));
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, p.text);
  }
  ctxAs(env, env.REAL_CTX_HOME_ALICE, env.REAL_CTX_ALICE, ["push", "--json", "--yes", "-m", "demo pages"]);
  ctxAs(env, env.REAL_CTX_HOME_BOB, env.REAL_CTX_BOB, ["pull", "--json"]);
  log(`seeded ${pages.length} demo pages (alice pushed, bob pulled)`);
}

async function cmdUp(flags) {
  const binDir = flags.bin ?? process.env.REAL_CTX_BIN_DIR;
  if (!flags.src && !binDir) { throw new Fail("up needs --src <dir> (a git-archive copy) or --bin <dir> (a `build` output)", 2); }
  const src = flags.src ? checkSrc(flags.src) : undefined;

  // (b) one live run at a time, on a free port.
  mkdirSync(tmpBase(), { recursive: true });
  const previous = readPointer();
  if (previous && existsSync(previous)) {
    const pid = serverPid(previous);
    if (pid !== undefined && pidAlive(pid)) { throw new Fail(`a real-ctx run is live at ${previous} (server pid ${pid}): run \`down\` first`); }
    log(`removing the stale run ${previous}`);
    rmSync(previous, { recursive: true, force: true });
  }
  if (await portTaken()) { throw new Fail(`${HOST}:${PORT} is taken; refusing to start (WP-3.1 owns this port)`); }
  const runDir = realpathSync(mkdtempSync(path.join(tmpBase(), "run-")));
  writeFileSync(pointerFile(), `${runDir}\n`);
  log(`run directory ${runDir}`);

  try {
    // (c) binaries.
    let commit;
    if (src) {
      commit = sourceCommit(flags.commit);
      goBuild(src, runDir, { goos: process.platform.replace("win32", "windows") });
    } else {
      commit = usePrebuilt(binDir, runDir);
    }
    const env = {
      CTX_BIN: path.join(runDir, "bin", `ctx${EXE}`),
      CTX_BIN_RC: path.join(runDir, "bin-rc", `ctx${EXE}`),
      CONTEXO_TEST_SERVER: SERVER_URL,
      REAL_CTX_RUN: runDir,
      REAL_CTX_ALICE: path.join(runDir, "alice"),
      REAL_CTX_BOB: path.join(runDir, "bob"),
      REAL_CTX_HOME_ALICE: path.join(runDir, "home-alice"),
      REAL_CTX_HOME_BOB: path.join(runDir, "home-bob"),
      REAL_CTX_KEY: randomBytes(16).toString("hex"),
      REAL_CTX_REPO: `real-ctx-${new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").toLowerCase()}`,
      REAL_CTX_SOURCE_COMMIT: commit,
    };
    // Written first, so `down` can stop the server even if a later step fails.
    writeFileSync(path.join(runDir, "env.json"), `${JSON.stringify(env, null, 2)}\n`, { mode: 0o600 });

    // (d) the server, detached, loopback only, its own HOME and data root.
    const homeServer = path.join(runDir, "home-server");
    for (const d of [homeServer, env.REAL_CTX_HOME_ALICE, env.REAL_CTX_HOME_BOB, env.REAL_CTX_ALICE, env.REAL_CTX_BOB]) {
      mkdirSync(d, { recursive: true });
    }
    const logFd = openSync(path.join(runDir, "server.log"), "a");
    const server = spawn(path.join(runDir, "bin", `contexo-server${EXE}`), [], {
      cwd: runDir,
      env: cleanEnv({
        PORT: String(PORT), CONTEXO_LISTEN_ADDR: `${HOST}:${PORT}`, CONTEXO_DATA_ROOT: path.join(runDir, "server-data"),
        CONTEXO_API_KEY: env.REAL_CTX_KEY, CONTEXO_SESSION_SECRET: randomBytes(32).toString("hex"),
        CONTEXO_RATELIMIT_DISABLE: "1", HOME: homeServer, USERPROFILE: homeServer,
      }),
      detached: true, stdio: ["ignore", logFd, logFd], shell: false,
    });
    closeSync(logFd);
    if (server.pid === undefined) { throw new Fail("contexo-server did not start"); }
    writeFileSync(path.join(runDir, "server.pid"), `${server.pid}\n`);
    server.unref();
    log(`contexo-server pid ${server.pid} on ${SERVER_URL}`);

    // (e) health + capabilities.
    assertHealth(await waitForHealth(runDir));
    log(`/health ok: capabilities ${SERVER_CAPS.join(",")}`);

    // (f) alice and bob: init, login (legacy key, no browser: stdin is ignored), one shared repo.
    const initHelp = run(env.CTX_BIN, ["init", "--help"], { env: userEnv(env.REAL_CTX_HOME_ALICE), cwd: runDir }).stdout;
    const initArgs = ["init", "--no-mcp", "--no-hooks", "--no-gitignore", ...(initHelp.includes("--no-vscode") ? ["--no-vscode"] : [])];
    for (const [name, root, home] of [["alice", env.REAL_CTX_ALICE, env.REAL_CTX_HOME_ALICE], ["bob", env.REAL_CTX_BOB, env.REAL_CTX_HOME_BOB]]) {
      ctxAs(env, home, root, initArgs);
      ctxAs(env, home, root, ["login", "--server", SERVER_URL, "--api-key", env.REAL_CTX_KEY, "--name", name, "--email", `${name}@example.test`]);
      ctxAs(env, home, root, ["remote", "set-repo", env.REAL_CTX_REPO]);
      log(`${name}: ${root} (HOME=${home})`);
    }
    if (flags.gui) { seedDemo(env); }

    // (g) exports.
    for (const k of ENV_KEYS) { process.stdout.write(`export ${k}=${shellQuote(env[k])}\n`); }
    return env;
  } catch (err) {
    log("up failed; tearing the run down");
    await cmdDown({ quiet: true, runDir });
    throw err;
  }
}

async function cmdDown(o = {}) {
  const runDir = o.runDir ?? process.env.REAL_CTX_RUN ?? readPointer();
  if (runDir && existsSync(runDir)) {
    const pid = serverPid(runDir);
    if (pid !== undefined && pidAlive(pid)) {
      process.kill(pid, "SIGTERM");
      const deadline = Date.now() + 3000;
      while (pidAlive(pid) && Date.now() < deadline) { await sleep(100); }
      if (pidAlive(pid)) {
        log(`server pid ${pid} ignored SIGTERM; SIGKILL`);
        process.kill(pid, "SIGKILL");
        const hard = Date.now() + 3000;
        while (pidAlive(pid) && Date.now() < hard) { await sleep(100); }
      }
    }
    rmSync(runDir, { recursive: true, force: true });
    if (!o.quiet) { log(`removed ${runDir}`); }
  } else if (!o.quiet) {
    log("no run to tear down");
  }
  if (readPointer() === runDir || !runDir) { rmSync(pointerFile(), { force: true }); }
  if (await portTaken()) { throw new Fail(`${HOST}:${PORT} is still taken after down`); }
}

// ---------- test ----------

function npmRun(script, env) {
  const npm = process.env.npm_execpath;
  const r = npm
    ? spawnSync(process.execPath, [npm, "run", script], { cwd: ROOT, env, stdio: ["ignore", "inherit", "inherit"], shell: false })
    : spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["run", script], { cwd: ROOT, env, stdio: ["ignore", "inherit", "inherit"], shell: false });
  if (r.status !== 0) { throw new Fail(`npm run ${script} failed (${r.status ?? r.signal ?? r.error?.message})`); }
}

function nodeTool(rel, args, env) {
  const r = spawnSync(process.execPath, [path.join(ROOT, ...rel), ...args], { cwd: ROOT, env, stdio: ["ignore", "inherit", "inherit"], shell: false });
  return r.status ?? 1;
}

async function cmdTest(flags) {
  const env = loadEnv();
  const childEnv = { ...process.env, ...env };
  log(`testing against ${env.CONTEXO_TEST_SERVER} (run ${env.REAL_CTX_RUN}, source ${env.REAL_CTX_SOURCE_COMMIT})`);
  // REAL_CTX_OUT (default out) lets a container lane compile next to, never over, the host's out/.
  const outDir = process.env.REAL_CTX_OUT ?? "out";
  npmRun("compile", childEnv);
  if (outDir === "out") {
    npmRun("compile-tests", childEnv);
  } else if (nodeTool(["node_modules", "typescript", "bin", "tsc"], ["-p", "tsconfig.test.json", "--outDir", outDir], childEnv) !== 0) {
    throw new Fail(`tsc -p tsconfig.test.json --outDir ${outDir} failed`);
  }
  let failed = 0;

  const conformance = `${outDir}/test/real-ctx/conformance.real.js`;
  log(`conformance: node mocha ${conformance}`);
  if (nodeTool(["node_modules", "mocha", "bin", "mocha.js"], ["--ui", "bdd", "--timeout", "120000", conformance], childEnv) !== 0) {
    log("conformance FAILED");
    failed++;
  }

  if (flags["no-vscode"]) {
    log("SKIPPED by --no-vscode: the Extension Host scenarios (vscode-test --label real-ctx) did not run");
  } else {
    const userDir = path.join(env.REAL_CTX_RUN, "vscode-user-data", "User");
    mkdirSync(userDir, { recursive: true });
    writeFileSync(path.join(userDir, "settings.json"), `${JSON.stringify({ "contexo.path": env.CTX_BIN }, null, 2)}\n`);
    log("scenarios: vscode-test --label real-ctx");
    if (nodeTool(["node_modules", "@vscode", "test-cli", "out", "bin.mjs"], ["--label", "real-ctx"], childEnv) !== 0) {
      log("scenarios FAILED");
      failed++;
    }
  }
  if (failed > 0) { throw new Fail(`${failed} real-ctx suite(s) failed`); }
  log("all real-ctx suites passed");
}

async function cmdRun(flags) {
  let downDone = false;
  const teardown = async () => {
    if (downDone) { return; }
    downDone = true;
    await cmdDown({ quiet: false });
  };
  const onSignal = (sig) => {
    log(`${sig}: tearing down`);
    teardown().finally(() => process.exit(sig === "SIGINT" ? 130 : 143));
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    const env = await cmdUp(flags);
    for (const [k, v] of Object.entries(env)) { process.env[k] = v; }
    await cmdTest(flags);
  } finally {
    await teardown();
  }
}

// ---------- goldens ----------

function copyTree(src, dest) {
  mkdirSync(dest, { recursive: true });
  for (const e of readdirSync(src, { withFileTypes: true })) {
    if (e.isDirectory()) { copyTree(path.join(src, e.name), path.join(dest, e.name)); } else if (e.isFile()) { copyFileSync(path.join(src, e.name), path.join(dest, e.name)); }
  }
}

function cmdVendorGolden(flags) {
  const src = checkSrc(flags.src);
  const from = path.join(src, "internal", "e2e", "testdata", "contract");
  const manifestFile = path.join(from, "manifest.json");
  if (!existsSync(manifestFile)) { throw new Fail(`${from} has no manifest.json (WP-2.2 goldens)`); }
  const commit = sourceCommit(flags.commit);
  const out = path.join(ROOT, "test", "fixtures", "golden");
  rmSync(out, { recursive: true, force: true });
  copyTree(from, out);
  const manifest = JSON.parse(readFileSync(path.join(out, "manifest.json"), "utf8"));
  let checked = 0;
  for (const f of manifest.fixtures) {
    const got = sha256(path.join(out, f.file));
    if (got !== f.sha256) { throw new Fail(`${f.file}: sha256 ${got} != manifest ${f.sha256}`); }
    checked++;
  }
  const listed = new Set(manifest.fixtures.map((f) => f.file));
  const extra = readdirSync(out).filter((n) => !listed.has(n) && n !== "manifest.json" && n !== ".gitattributes");
  if (extra.length > 0) { throw new Fail(`files not in the manifest: ${extra.join(", ")}`); }
  const cmdline = `node scripts/real-ctx-env.mjs vendor-golden --src ${src}${flags.commit ? ` --commit ${flags.commit}` : ""}`;
  writeFileSync(path.join(out, "SOURCE.md"), [
    "# Vendored WP-2.2 golden contract fixtures",
    "",
    `- Source commit: ${commit} (Contexo ${CONTEXO_REF})`,
    `- Source path: internal/e2e/testdata/contract/ (git-archive copy at ${src})`,
    `- Vendored: ${new Date().toISOString().slice(0, 10)}`,
    `- Command: \`${cmdline}\``,
    "",
    "Byte-for-byte copy; every manifest sha256 was re-verified. Refresh only with the command above",
    "(WP-4.1 / WP-4.I when a shape legitimately changes). test/unit/contract/golden.test.ts validates them.",
    "",
  ].join("\n"));
  log(`vendored ${checked} goldens (+ manifest.json) from ${commit} into ${out}`);
}

// ---------- ide ----------

function cmdIde() {
  const env = loadEnv();
  const vsixDir = path.join(ROOT, "dist");
  const vsix = existsSync(vsixDir) ? readdirSync(vsixDir).filter((n) => n.endsWith(".vsix")).map((n) => path.join(vsixDir, n)) : [];
  const vsixPath = vsix.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0] ?? "<run npm run package first>";
  const binDir = path.dirname(env.CTX_BIN);
  const ideDir = path.join(env.REAL_CTX_RUN, "ide");
  const lines = [];
  for (const editor of ["code", "cursor"]) {
    if (editor === "cursor" && spawnSync("cursor", ["--version"], { stdio: "ignore", shell: false }).error) { continue; }
    const pre = `HOME=${shellQuote(env.REAL_CTX_HOME_ALICE)} USERPROFILE=${shellQuote(env.REAL_CTX_HOME_ALICE)} PATH=${shellQuote(binDir)}:"$PATH"`;
    const flagsFor = `--user-data-dir ${shellQuote(path.join(ideDir, `${editor}-user-data`))} --extensions-dir ${shellQuote(path.join(ideDir, `${editor}-ext`))}`;
    lines.push(`# ${editor}`);
    lines.push(`${pre} ${editor} ${flagsFor} --install-extension ${shellQuote(vsixPath)}`);
    lines.push(`${pre} ${editor} ${flagsFor} ${shellQuote(env.REAL_CTX_ALICE)}`);
  }
  lines.push(`# bob's terminal: HOME=${shellQuote(env.REAL_CTX_HOME_BOB)} ${shellQuote(env.CTX_BIN)} <command> --root ${shellQuote(env.REAL_CTX_BOB)}`);
  process.stdout.write(`${lines.join("\n")}\n`);
}

// ---------- main ----------

async function main() {
  const { cmd, flags } = parseArgs(process.argv.slice(2));
  switch (cmd) {
    case "up": await cmdUp(flags); break;
    case "test": await cmdTest(flags); break;
    case "run": await cmdRun(flags); break;
    case "down": await cmdDown(); break;
    case "build": cmdBuild(flags); break;
    case "vendor-golden": cmdVendorGolden(flags); break;
    case "ide": cmdIde(); break;
    default:
      throw new Fail("usage: real-ctx-env.mjs up|test|run|down|build|vendor-golden|ide (see the header of this file)", 2);
  }
}

main().catch((err) => {
  log(err instanceof Fail ? err.message : (err?.stack ?? String(err)));
  process.exit(err instanceof Fail ? err.exitCode : 1);
});
