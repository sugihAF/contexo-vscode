#!/usr/bin/env node
// Fake ctx (contract errata E33): replays scenario files so the extension can be tested
// without Go, a real ctx or a server. Run as `node fake-ctx.mjs <ctx args...>`; in Test
// mode the extension spawns it through CONTEXO_TEST_CTX={command: <node>, prefixArgs:
// [<abs path of this file>]}.
//
// Protocol (WP-0.6; additions must stay backward compatible):
// - root = the argv value after `--root` (absent for `version`).
// - Logging comes FIRST: one JSON line
//     {"argv":[...],"cwd":"...","env":{"NO_COLOR":v|null,"CONTEXO_NO_UPDATE_CHECK":v|null,
//      "CONTEXO_CLIENT":v|null[,"CONTEXO_DISTILL_DISABLE":v]}}
//   (CONTEXO_DISTILL_DISABLE only when present) is appended to <root>/.fake-ctx/calls.jsonl
//   when root is an existing directory (.fake-ctx is created if needed; a missing root is
//   never created), otherwise to the file named by env FAKE_CTX_CALLS, otherwise nowhere.
// - Timestamps (WP-2.3; opt-in, so the default line keeps exactly argv, cwd, env): when env
//   FAKE_CTX_TIMESTAMPS is set and not "0", the call line also carries "id" (unique per
//   process) and "start" (Date.now() ms), and when the process exits a second line
//   {"id":<same>,"end":<Date.now() ms>,"exit":<code>} is appended to the same file.
//   test/helpers/e2e.ts readCalls() pairs them.
// - Scenario name = <root>/.fake-ctx/current (trimmed) when a root is given and that file
//   exists, else env FAKE_CTX_SCENARIO, else the built-in handshake (which answers only
//   `version --json`: contract 1 with the 11 v1 capabilities followed by 'repair'; and
//   `version --short`: its version line).
// - Scenario file = <dir of this file>/../fixtures/ctx/scenarios/<name>/scenario.json:
//     {"rules":[{"match":[tokens], "unless"?:[tokens], "stdout"?|"stdoutFile"?,
//       "stderr"?|"stderrFile"?, "exit"?, "delayMs"?, "then"?}], "default"?: {...}}
//   The first rule whose match tokens are ALL in argv and whose unless tokens are NOT
//   wins; else `default`; else exit 1 with an `internal` envelope naming the argv.
//   The value after `-m` (the free-text push message) never counts as a token.
//   `version` never uses `default`: without an explicit version rule it gets the
//   built-in handshake (`version --json` doc, `version --short` line), as real ctx
//   answers version in any project state.
//   The interactive terminal commands `auth login`, `init` and `update` (WP-2.3) do not use
//   `default` either: without an explicit rule they print one line and exit 0.
//   (test/helpers/fixtures.ts selectRule mirrors this; fakeCtx.test pins the agreement.)
// - Answer: sleep delayMs, write stdout (inline or stdoutFile) and stderr (inline or
//   stderrFile) as raw bytes, then exit with `exit` (default 0). Files are relative to the
//   scenario dir ('..' allowed). `then` rewrites <root>/.fake-ctx/current to that scenario
//   before the process exits (only when a root is given).
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCENARIOS_DIR = resolve(HERE, "..", "fixtures", "ctx", "scenarios");
const RECORDED_ENV = ["NO_COLOR", "CONTEXO_NO_UPDATE_CHECK", "CONTEXO_CLIENT"];
const TIMESTAMPS = process.env.FAKE_CTX_TIMESTAMPS !== undefined && process.env.FAKE_CTX_TIMESTAMPS !== "" && process.env.FAKE_CTX_TIMESTAMPS !== "0";

/** `ctx version --json` of a current release build: test/fake-ctx/builtin-version.json (also read by
 *  test/helpers/fixtures.ts as BUILTIN_VERSION_DOC and by FakeCtxCli as FAKE_VERSION_DOC). */
function builtinVersionDoc() {
  // Read lazily: only the built-in handshake needs it (a private copy of this file in a
  // test without builtin-version.json still serves every scenario rule).
  return JSON.parse(readFileSync(join(HERE, "builtin-version.json"), "utf8"));
}

const argv = process.argv.slice(2);
const rootIdx = argv.indexOf("--root");
const root = rootIdx >= 0 && rootIdx + 1 < argv.length ? argv[rootIdx + 1] : undefined;

function isDir(p) {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

function logCall() {
  const env = {};
  for (const k of RECORDED_ENV) { env[k] = process.env[k] ?? null; }
  if (process.env.CONTEXO_DISTILL_DISABLE !== undefined) { env.CONTEXO_DISTILL_DISABLE = process.env.CONTEXO_DISTILL_DISABLE; }
  const record = { argv, cwd: process.cwd(), env };
  let file;
  if (root !== undefined && isDir(root)) {
    mkdirSync(join(root, ".fake-ctx"), { recursive: true });
    file = join(root, ".fake-ctx", "calls.jsonl");
  } else if (process.env.FAKE_CTX_CALLS) {
    file = process.env.FAKE_CTX_CALLS;
    mkdirSync(dirname(file), { recursive: true });
  }
  if (file === undefined) { return; }
  if (TIMESTAMPS) {
    const start = Date.now();
    const id = `${process.pid}-${start}-${process.hrtime.bigint()}`;
    Object.assign(record, { id, start });
    // 'exit' listeners run synchronously after the answer is written (or after a crash).
    process.on("exit", (code) => {
      appendFileSync(file, `${JSON.stringify({ id, end: Date.now(), exit: code })}\n`);
    });
  }
  appendFileSync(file, `${JSON.stringify(record)}\n`);
}

function envelope(code, exitCode, message) {
  return `${JSON.stringify({ schema: "ctx.error.v1", exit_code: exitCode, error: { code, message, advice: [], retryable: false } })}\n`;
}

function fail(message) {
  process.stderr.write(envelope("internal", 1, `fake-ctx: ${message}`));
  process.exitCode = 1;
}

function currentScenario() {
  if (root !== undefined) {
    const file = join(root, ".fake-ctx", "current");
    if (existsSync(file)) {
      const name = readFileSync(file, "utf8").trim();
      if (name !== "") { return name; }
    }
  }
  const fromEnv = process.env.FAKE_CTX_SCENARIO;
  return fromEnv !== undefined && fromEnv.trim() !== "" ? fromEnv.trim() : undefined;
}

/** argv without the value of `-m` (a commit message is free text, never a rule token). */
function matchTokens(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    out.push(args[i]);
    if (args[i] === "-m") { i++; }
  }
  return out;
}

/** The commands that never use a scenario `default` (they have built-in answers). */
function hasBuiltin() {
  return argv[0] === "version" || interactiveBuiltin() !== undefined;
}

function selectRule(scenario) {
  const tokens = matchTokens(argv);
  for (const rule of scenario.rules ?? []) {
    const unless = rule.unless ?? [];
    if (rule.match.every((t) => tokens.includes(t)) && !unless.some((t) => tokens.includes(t))) { return rule; }
  }
  return hasBuiltin() ? undefined : scenario.default;
}

/** The stdout line of a built-in `auth login`, `init` or `update`, or undefined for any other argv. */
function interactiveBuiltin() {
  if (argv[0] === "auth" && argv[1] === "login") { return "fake-ctx: logged in\n"; }
  if (argv[0] === "init") { return "fake-ctx: initialized\n"; }
  if (argv[0] === "update") { return "fake-ctx: ctx is up to date\n"; }
  return undefined;
}

/** The built-in answer (handshake or interactive command); true when it answered argv. */
function builtin() {
  if (builtinVersion()) { return true; }
  const line = interactiveBuiltin();
  if (line === undefined) { return false; }
  process.stdout.write(line);
  return true;
}

/** The built-in handshake; true when it answered argv. */
function builtinVersion() {
  if (argv[0] !== "version") { return false; }
  if (argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify(builtinVersionDoc(), null, 2)}\n`);
    return true;
  }
  if (argv.includes("--short")) {
    process.stdout.write(`${builtinVersionDoc().version}\n`);
    return true;
  }
  return false;
}

function payload(dir, inline, file) {
  if (file !== undefined) { return readFileSync(resolve(dir, file)); }
  return inline === undefined ? undefined : Buffer.from(inline, "utf8");
}

function write(stream, bytes) {
  return new Promise((done) => {
    if (bytes === undefined || bytes.length === 0) { done(); return; }
    stream.write(bytes, () => done());
  });
}

async function main() {
  logCall();
  const name = currentScenario();
  if (name === undefined) {
    if (builtin()) { return; }
    fail(`no scenario (no <root>/.fake-ctx/current, no FAKE_CTX_SCENARIO); the built-in answers only 'version --json', 'version --short', 'auth login', 'init' and 'update', not ${JSON.stringify(argv)}`);
    return;
  }
  const dir = join(SCENARIOS_DIR, name);
  const file = join(dir, "scenario.json");
  if (!existsSync(file)) {
    fail(`unknown scenario '${name}' (${file} does not exist)`);
    return;
  }
  let scenario;
  try {
    scenario = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    fail(`scenario '${name}' is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  const rule = selectRule(scenario);
  if (rule === undefined && builtin()) { return; }
  if (rule === undefined) {
    fail(`scenario '${name}' has no rule for argv ${JSON.stringify(argv)}`);
    return;
  }
  const stdout = payload(dir, rule.stdout, rule.stdoutFile);
  const stderr = payload(dir, rule.stderr, rule.stderrFile);
  if (rule.delayMs !== undefined && rule.delayMs > 0) {
    await new Promise((done) => setTimeout(done, rule.delayMs));
  }
  await write(process.stdout, stdout);
  await write(process.stderr, stderr);
  if (rule.then !== undefined && root !== undefined && isDir(root)) {
    mkdirSync(join(root, ".fake-ctx"), { recursive: true });
    writeFileSync(join(root, ".fake-ctx", "current"), `${rule.then}\n`);
  }
  process.exitCode = rule.exit ?? 0;
}

main().catch((err) => {
  fail(err instanceof Error ? err.stack ?? err.message : String(err));
});
