// The handshake gate (src/cli/capabilities.ts, E36, D11): the `ctx version --json` run (and the
// old-ctx `version --short` fallback) -> Handshake -> the frozen BinaryState. It decides on
// contract_version and capabilities, never on the version string. Plain mocha, no vscode:
// ProcessResult objects are built directly (no process is started here).
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  classifyProbe, describeBinary, gate, hasCapability, isHandshake, missingCapabilities, parseShortVersion,
  type Handshake,
} from "../../../src/cli/capabilities";
import type { ProcessResult } from "../../../src/cli/spawn";
import type { BinaryState } from "../../../src/cli/types";
import { CAPABILITIES, REQUIRED_CAPABILITIES, type VersionDoc } from "../../../src/contract/types";
import { BUILTIN_VERSION_DOC, REPO_ROOT } from "../../helpers/fixtures";

const CONTRACT_DIR = path.join(REPO_ROOT, "test", "fixtures", "contract", "v1");
const JSON_ARGS = ["version", "--json"] as const;
const SHORT_ARGS = ["version", "--short"] as const;
const BIN = "/usr/local/bin/ctx";
/** What ctx 0.6.6 prints for `ctx version --json` (test/fixtures/ctx/scenarios/ctx-too-old/unknown_flag.stderr). */
const UNKNOWN_FLAG = "✖ unknown flag: --json\n";

// ---------- helpers ----------

function result(args: readonly string[], o: { stdout?: string | Buffer; stderr?: string; exit?: number | null; signal?: NodeJS.Signals | null } = {}): ProcessResult {
  return {
    args,
    stdout: Buffer.isBuffer(o.stdout) ? o.stdout : Buffer.from(o.stdout ?? "", "utf8"),
    stderr: o.stderr ?? "",
    exitCode: o.exit === undefined ? 0 : o.exit,
    signal: o.signal ?? null,
    durationMs: 7,
  };
}

/** A `version --json` run that printed `doc` (pretty, like ctx) and exited 0. */
function versionRun(doc: unknown): ProcessResult {
  return result(JSON_ARGS, { stdout: `${JSON.stringify(doc, null, 2)}\n` });
}

/** The vendored Go contract fixture bytes (test/fixtures/contract/v1). */
function vendored(file: string): Buffer {
  return fs.readFileSync(path.join(CONTRACT_DIR, file));
}

/** A release VersionDoc (the fake's built-in handshake) with `over` applied. */
function versionDoc(over: Record<string, unknown> = {}): VersionDoc {
  return { ...(JSON.parse(JSON.stringify(BUILTIN_VERSION_DOC)) as VersionDoc), ...over } as VersionDoc;
}

/** classifyProbe + gate exactly as discovery runs them: the short probe only when json is not a handshake. */
function handshake(json: ProcessResult, short?: ProcessResult): BinaryState {
  return gate(BIN, classifyProbe(json, isHandshake(json) ? undefined : short));
}

function okState(doc: VersionDoc): BinaryState {
  return { kind: "ok", path: BIN, version: doc };
}

// ---------- tests ----------

describe("gates on contract and capabilities, not semver", () => {
  it("v0.6.6 unknown flag -> tooOld with versionText 0.6.6", () => {
    const json = result(JSON_ARGS, { exit: 1, stderr: UNKNOWN_FLAG });
    const short = result(SHORT_ARGS, { stdout: "0.6.6\n" });
    assert.equal(isHandshake(json), false, "an unknown --json flag is no handshake");
    assert.deepEqual(classifyProbe(json, short), { kind: "old", versionText: "0.6.6" });
    const state = handshake(json, short);
    assert.deepEqual(state, { kind: "tooOld", path: BIN, versionText: "0.6.6", missing: [...REQUIRED_CAPABILITIES] });
    assert.equal(state.kind === "tooOld" ? state.missing.length : -1, 10);
    // the scenario file says the same thing
    const stderr = fs.readFileSync(path.join(REPO_ROOT, "test", "fixtures", "ctx", "scenarios", "ctx-too-old", "unknown_flag.stderr"), "utf8");
    assert.equal(stderr, UNKNOWN_FLAG);
  });

  it("contract 0 -> tooOld", () => {
    const json = versionRun(versionDoc({ contract_version: 0, version: "0.6.9" }));
    assert.equal(isHandshake(json), true);
    assert.equal(classifyProbe(json).kind, "doc");
    assert.deepEqual(handshake(json), { kind: "tooOld", path: BIN, versionText: "0.6.9", missing: [] });
    // a non-integer or absent contract_version counts as < 1 (the schema forbids them; be defensive)
    for (const cv of [-1, 0.5, 1.5, "1", null, true]) {
      const s = handshake(versionRun(versionDoc({ contract_version: cv })));
      assert.equal(s.kind, "tooOld", `contract_version ${JSON.stringify(cv)}`);
    }
    const noCv = versionDoc();
    delete (noCv as Partial<VersionDoc>).contract_version;
    assert.equal(handshake(versionRun(noCv)).kind, "tooOld", "contract_version absent");
  });

  it("contract 2 -> extensionTooOld", () => {
    const json = result(JSON_ARGS, { stdout: vendored("version.contract2.json") });
    assert.equal(isHandshake(json), true);
    assert.deepEqual(handshake(json), { kind: "extensionTooOld", path: BIN, contractVersion: 2 });
    // decided before capabilities: a contract 3 doc without any capability is still extensionTooOld
    assert.deepEqual(handshake(versionRun(versionDoc({ contract_version: 3, capabilities: [] }))), { kind: "extensionTooOld", path: BIN, contractVersion: 3 });
  });

  it("version.missing-caps -> tooOld with missing [resolve, push.distill_guard]", () => {
    const state = handshake(result(JSON_ARGS, { stdout: vendored("version.missing-caps.json") }));
    assert.equal(state.kind, "tooOld");
    if (state.kind !== "tooOld") { return; }
    assert.equal(state.path, BIN);
    assert.equal(state.versionText, "0.6.9");
    assert.deepEqual(new Set(state.missing), new Set(["resolve", "push.distill_guard"]));
    assert.deepEqual(state.missing, REQUIRED_CAPABILITIES.filter((c) => state.missing.includes(c)), "REQUIRED_CAPABILITIES order");
    assert.deepEqual(state.missing, ["push.distill_guard", "resolve"]);
  });

  it("'0.7.0-rc.1' with the full capabilities -> ok", () => {
    const doc = versionDoc({ version: "0.7.0-rc.1", capabilities: [...CAPABILITIES] });
    assert.deepEqual(handshake(versionRun(doc)), okState(doc));
  });

  it("'dev' (version.dev.json) -> ok", () => {
    const bytes = vendored("version.dev.json");
    const state = handshake(result(JSON_ARGS, { stdout: bytes }));
    assert.deepEqual(state, okState(JSON.parse(bytes.toString("utf8")) as VersionDoc));
    assert.equal(state.kind === "ok" ? state.version.version : "", "dev");
  });

  it("a wave-0 ctx (only errors.envelope) -> tooOld listing the 9 missing capabilities", () => {
    const doc = versionDoc({ version: "dev", dev_build: true, capabilities: ["errors.envelope"] });
    const state = handshake(versionRun(doc));
    const nine = REQUIRED_CAPABILITIES.filter((c) => c !== "errors.envelope");
    assert.equal(nine.length, 9);
    assert.deepEqual(state, { kind: "tooOld", path: BIN, versionText: "dev", missing: nine });
  });

  it("the version string is never compared: any version with contract 1 + the required capabilities is ok", () => {
    for (const version of ["0.0.1", "0.6.6", "99.0.0", "v0.7.0", "not-a-version", ""]) {
      const doc = versionDoc({ version, capabilities: [...REQUIRED_CAPABILITIES] });
      assert.deepEqual(handshake(versionRun(doc)), okState(doc), `version ${JSON.stringify(version)}`);
    }
    // ...and a high version does not rescue a contract 0 doc
    assert.equal(handshake(versionRun(versionDoc({ version: "99.0.0", contract_version: 0 }))).kind, "tooOld");
  });

  it("malformed docs: capabilities not a string array counts as []; a non-string version gives no versionText", () => {
    for (const caps of [null, "status.json", { 0: "status.json" }, 7]) {
      const s = handshake(versionRun(versionDoc({ capabilities: caps })));
      assert.deepEqual(s, { kind: "tooOld", path: BIN, versionText: "0.7.0", missing: [...REQUIRED_CAPABILITIES] }, `capabilities ${JSON.stringify(caps)}`);
    }
    const noVersion = handshake(versionRun(versionDoc({ version: 7, capabilities: ["errors.envelope"] })));
    assert.deepEqual(noVersion, { kind: "tooOld", path: BIN, missing: REQUIRED_CAPABILITIES.filter((c) => c !== "errors.envelope") });
    // unknown future capabilities and non-string entries are ignored
    const extra = versionDoc({ capabilities: [...REQUIRED_CAPABILITIES, "future.thing", 42] });
    assert.equal(handshake(versionRun(extra)).kind, "ok");
  });

  it("missingCapabilities: REQUIRED_CAPABILITIES order, non-arrays count as []", () => {
    assert.deepEqual(missingCapabilities([...REQUIRED_CAPABILITIES]), []);
    assert.deepEqual(missingCapabilities([...REQUIRED_CAPABILITIES].reverse()), []);
    assert.deepEqual(missingCapabilities(undefined), [...REQUIRED_CAPABILITIES]);
    assert.deepEqual(missingCapabilities("resolve"), [...REQUIRED_CAPABILITIES]);
    assert.deepEqual(missingCapabilities(["resolve", "status.json", "show.sha", "repair"]),
      REQUIRED_CAPABILITIES.filter((c) => c !== "resolve" && c !== "status.json"));
    assert.deepEqual(missingCapabilities(["errors.envelope", 1, null]), REQUIRED_CAPABILITIES.filter((c) => c !== "errors.envelope"));
  });

  it("parseShortVersion: one [v]MAJOR.MINOR.PATCH[-pre][+build] or 'dev' line, else undefined", () => {
    assert.equal(parseShortVersion("0.6.6\n"), "0.6.6");
    assert.equal(parseShortVersion("0.6.6"), "0.6.6");
    assert.equal(parseShortVersion("  v0.7.0-rc.1\r\n"), "0.7.0-rc.1");
    assert.equal(parseShortVersion("1.2.3+build.5\n"), "1.2.3+build.5");
    assert.equal(parseShortVersion("10.20.30-alpha.1+sha.9f3c2ab\n"), "10.20.30-alpha.1+sha.9f3c2ab");
    assert.equal(parseShortVersion("dev\n"), "dev");
    for (const bad of [
      "", "\n", "   ", "0.6", "0.6.6.1", "version 0.6.6", "ctx 0.6.6\n", "0.6.6 (darwin)", "vdev", "DEV", "0.6.x",
      "0.6.6\n0.6.7\n", "usage: ctx [-v] <file>\n", "ctx (context switcher) build 2019\n",
      "Usage:\n  ctx version [flags]\n\nFlags:\n  -h, --help\n",
    ]) {
      assert.equal(parseShortVersion(bad), undefined, JSON.stringify(bad));
    }
  });

  it("classifyProbe: non-ctx output is foreign (and gates to missing)", () => {
    // test/fixtures/ctx/scenarios/e1-not-ctx: both probes exit 2 with usage text
    const json = result(JSON_ARGS, { exit: 2, stderr: "ctx: unknown option --json\nusage: ctx [-v] <file>\n" });
    const short = result(SHORT_ARGS, { exit: 2, stderr: "ctx: unknown option --short\nusage: ctx [-v] <file>\n" });
    const h = classifyProbe(json, short);
    assert.equal(h.kind, "foreign");
    assert.ok(h.kind === "foreign" && h.reason.length > 0, "foreign carries a reason");
    assert.deepEqual(gate(BIN, h), { kind: "missing" });
    // no short run (not made / failed to start)
    assert.equal(classifyProbe(json).kind, "foreign");
    // exit 0 but not a version document, and a short run that is not one version line
    const cases: [ProcessResult, ProcessResult | undefined][] = [
      [result(JSON_ARGS, { stdout: "ctx (context switcher) build 2019\n" }), result(SHORT_ARGS, { stdout: "ctx (context switcher) build 2019\n" })],
      [result(JSON_ARGS, { stdout: "" }), result(SHORT_ARGS, { stdout: "" })],
      [result(JSON_ARGS, { stdout: "null\n" }), undefined],
      [result(JSON_ARGS, { stdout: "[1,2]\n" }), undefined],
      [result(JSON_ARGS, { stdout: "{\"schema\":\"ctx.status.v1\"}\n" }), result(SHORT_ARGS, { exit: 1, stdout: "0.6.6\n" })],
      [result(JSON_ARGS, { stdout: "{\"schema\":\"ctx.version.v0\"}\n" }), undefined],
      [result(JSON_ARGS, { stdout: "{\"schema\":\"ctx.version.vX\"}\n" }), undefined],
      [result(JSON_ARGS, { exit: null, signal: "SIGKILL" }), result(SHORT_ARGS, { exit: null, signal: "SIGKILL" })],
    ];
    for (const [j, s] of cases) {
      assert.equal(isHandshake(j), false, `${j.stdout.toString("utf8")} is no handshake`);
      assert.equal(classifyProbe(j, s).kind, "foreign", j.stdout.toString("utf8"));
    }
    // a version --json doc printed with a non-zero exit is not a handshake either
    assert.equal(isHandshake(result(JSON_ARGS, { exit: 1, stdout: JSON.stringify(BUILTIN_VERSION_DOC) })), false);
  });

  it("classifyProbe: schema ctx.version.v2 is future -> extensionTooOld", () => {
    const cases: [unknown, number][] = [
      [{ schema: "ctx.version.v2" }, 2],
      [{ schema: "ctx.version.v2", contract_version: 3, renamed: true }, 3],
      [{ schema: "ctx.version.v2", contract_version: 1 }, 2],
      [{ schema: "ctx.version.v2", contract_version: 2.5 }, 2],
      [{ schema: "ctx.version.v10", contract_version: "11" }, 10],
    ];
    for (const [doc, cv] of cases) {
      const json = versionRun(doc);
      assert.equal(isHandshake(json), true, JSON.stringify(doc));
      const h: Handshake = classifyProbe(json);
      assert.deepEqual(h, { kind: "future", contractVersion: cv }, JSON.stringify(doc));
      assert.deepEqual(gate(BIN, h), { kind: "extensionTooOld", path: BIN, contractVersion: cv });
    }
  });

  it("hasCapability: true only for an ok binary that advertises it", () => {
    const full = handshake(result(JSON_ARGS, { stdout: vendored("version.release.json") }));
    assert.equal(full.kind, "ok");
    assert.equal(hasCapability(full, "show.sha"), true);
    assert.equal(hasCapability(full, "repair"), true);
    assert.equal(hasCapability(full, "resolve"), true);
    const bare = handshake(versionRun(versionDoc({ capabilities: [...REQUIRED_CAPABILITIES] })));
    assert.equal(bare.kind, "ok");
    assert.equal(hasCapability(bare, "show.sha"), false);
    assert.equal(hasCapability(bare, "repair"), false);
    assert.equal(hasCapability(bare, "status.json"), true);
    const others: BinaryState[] = [
      { kind: "missing" },
      { kind: "tooOld", path: BIN, versionText: "0.6.9", missing: ["resolve"] },
      { kind: "extensionTooOld", path: BIN, contractVersion: 2 },
    ];
    for (const s of others) {
      assert.equal(hasCapability(s, "show.sha"), false, s.kind);
      assert.equal(hasCapability(s, "status.json"), false, s.kind);
    }
  });

  it("describeBinary: one line per kind", () => {
    const doc = versionDoc({ capabilities: ["status.json", "show.sha", "repair"] });
    assert.equal(describeBinary({ kind: "ok", path: BIN, version: doc }),
      "ctx binary ok: /usr/local/bin/ctx version 0.7.0 contract 1 capabilities [status.json, show.sha, repair]");
    assert.equal(describeBinary({ kind: "tooOld", path: BIN, versionText: "0.6.6", missing: ["status.json", "resolve"] }),
      "ctx binary tooOld: /usr/local/bin/ctx version 0.6.6 missing [status.json, resolve]");
    assert.equal(describeBinary({ kind: "tooOld", path: BIN, missing: [] }),
      "ctx binary tooOld: /usr/local/bin/ctx version unknown missing []");
    assert.equal(describeBinary({ kind: "extensionTooOld", path: "/x/ctx", contractVersion: 2 }), "ctx binary extensionTooOld: /x/ctx contract 2");
    assert.equal(describeBinary({ kind: "missing" }), "ctx binary missing");
    // the full release doc lists every capability it advertises
    const release = handshake(result(JSON_ARGS, { stdout: vendored("version.release.json") }));
    assert.equal(describeBinary(release),
      `ctx binary ok: ${BIN} version 0.7.0 contract 1 capabilities [${[...CAPABILITIES, "repair"].join(", ")}]`);
  });
});
