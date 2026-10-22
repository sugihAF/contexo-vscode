// The vendored contract v1 fixtures (test/fixtures/contract/v1, vendored by WP-0.I from
// Contexo internal/syncops/contract/testdata/v1; E31, E32): the manifest hashes, and the
// frozen parseDoc/parseEnvelope plus parse.ts over every stdout and stderr entry. Read only:
// this file never writes under test/fixtures/contract. Plain mocha, no vscode.
import * as assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { decodeStdout, errorFromExit } from "../../../src/cli/parse";
import {
  ERROR_CODES, SCHEMAS, SUPPORTED_CONTRACT_VERSION, parseDoc, parseEnvelope,
  type Doc, type ErrorEnvelope, type SchemaId,
} from "../../../src/contract/types";
import { REPO_ROOT } from "../../helpers/fixtures";

const DIR = path.join(REPO_ROOT, "test", "fixtures", "contract", "v1");
/** Files the hash check ignores (E32): the vendoring note and the manifest itself. */
const UNHASHED = new Set(["SOURCE", "manifest.json"]);

type Stream = "stdout" | "stderr" | "raw" | "data";
interface Entry {
  file: string;
  schema: string | null;
  command: string | null;
  stream: Stream;
  exit_code: number | null;
  sha256: string;
}
interface Manifest { contract_version: number; fixtures: Entry[]; }

const MANIFEST = JSON.parse(fs.readFileSync(path.join(DIR, "manifest.json"), "utf8")) as Manifest;

/** A non-envelope line ahead of the envelope (a log line a real ctx may print first). */
const NOISE = "2026/11/03 09:14:07 sync: retrying GET /v1/repos/acme-payments/pages (attempt 2)";

/** A Go runtime panic: exit 2, no envelope on stderr. */
const GO_PANIC = [
  "panic: runtime error: invalid memory address or nil pointer dereference",
  "[signal SIGSEGV: segmentation violation code=0x1 addr=0x0 pc=0x1029c4f30]",
  "",
  "goroutine 1 [running]:",
  "github.com/sugihAF/contexo/internal/syncops.(*Env).Status(0x0, {0x102d8a0e8, 0x14000126000})",
  "\t/src/internal/syncops/status.go:88 +0x30",
  "main.main()",
  "\t/src/cmd/ctx/main.go:14 +0x1c",
  "",
].join("\n");

function read(file: string): Buffer {
  return fs.readFileSync(path.join(DIR, file));
}

function sha256(bytes: Buffer): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

/** Every file under dir, as '/'-separated paths relative to dir (recursive, raw/ included). */
function walk(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { out.push(...walk(full, base)); } else { out.push(path.relative(base, full).split(path.sep).join("/")); }
  }
  return out;
}

function isSchemaId(s: string | null): s is SchemaId {
  return s !== null && (SCHEMAS as readonly string[]).includes(s);
}

/**
 * The entries the TS checks decode, chosen by stream and schema, never by file extension
 * (E32, like contract/validate.mjs): stdout/stderr entries whose schema is one of the six.
 * raw and data streams, and schemas outside the six (null, ctx.repair.v1, ...), are skipped.
 */
function decodable(entries: readonly Entry[]): { stdout: Entry[]; stderr: Entry[]; skipped: Entry[] } {
  const out = { stdout: [] as Entry[], stderr: [] as Entry[], skipped: [] as Entry[] };
  for (const e of entries) {
    if (e.stream === "stdout" && isSchemaId(e.schema) && e.schema !== "ctx.error.v1") {
      out.stdout.push(e);
    } else if (e.stream === "stderr" && e.schema === "ctx.error.v1") {
      out.stderr.push(e);
    } else {
      out.skipped.push(e);
    }
  }
  return out;
}

describe("vendored contract v1 fixtures (test/fixtures/contract/v1)", () => {
  it("manifest sha256 matches for every entry (ignoring SOURCE and manifest.json), with no missing or extra files", () => {
    assert.ok(fs.existsSync(path.join(DIR, "SOURCE")), "SOURCE is vendored next to the manifest");
    const onDisk = walk(DIR).filter((f) => !UNHASHED.has(f)).sort();
    const listed = MANIFEST.fixtures.map((e) => e.file).sort();
    assert.equal(new Set(listed).size, listed.length, "no duplicate manifest entries");
    assert.deepEqual(onDisk.filter((f) => !listed.includes(f)), [], "files on disk that the manifest does not list");
    assert.deepEqual(listed.filter((f) => !onDisk.includes(f)), [], "manifest entries missing on disk");
    assert.ok(onDisk.some((f) => f.startsWith("raw/")), "raw/ is walked");
    for (const e of MANIFEST.fixtures) {
      assert.match(e.sha256, /^[0-9a-f]{64}$/, `${e.file}: sha256 is 64 lowercase hex`);
      assert.equal(sha256(read(e.file)), e.sha256, `${e.file}: sha256`);
    }
  });

  it("contract_version === SUPPORTED_CONTRACT_VERSION", () => {
    assert.equal(MANIFEST.contract_version, SUPPORTED_CONTRACT_VERSION);
    assert.equal(SUPPORTED_CONTRACT_VERSION, 1);
  });

  it("parseDoc succeeds on every stdout entry, selected by the manifest's schema", () => {
    const { stdout } = decodable(MANIFEST.fixtures);
    for (const schema of ["ctx.version.v1", "ctx.status.v1", "ctx.push.v1", "ctx.pull.v1", "ctx.resolve.v1"]) {
      assert.ok(stdout.some((e) => e.schema === schema), `at least one ${schema} entry`);
    }
    for (const e of stdout) {
      const schema = e.schema as Doc["schema"];
      const text = read(e.file).toString("utf8");
      const doc = parseDoc<Doc>(text, schema);
      assert.equal(doc.schema, schema, e.file);
      const decoded = decodeStdout<Doc>(read(e.file), schema, { exitCode: e.exit_code ?? 0 });
      assert.deepEqual(decoded, JSON.parse(text), `${e.file}: decodeStdout`);
      assert.ok(e.exit_code === 0 || (e.file === "push.partial-conflict.json" && e.exit_code === 6), `${e.file}: exit ${String(e.exit_code)}`);
    }
  });

  it("parseEnvelope on every stderr entry with a leading noise line gives the fixture's code and exit_code", () => {
    const { stderr } = decodable(MANIFEST.fixtures);
    assert.equal(stderr.length, ERROR_CODES.length + 1, "24 error.<code>.json + push.partial-conflict.stderr.json");
    for (const e of stderr) {
      assert.equal(typeof e.exit_code, "number", `${e.file}: exit_code`);
      const exit = e.exit_code as number;
      const text = read(e.file).toString("utf8");
      const own = JSON.parse(text) as ErrorEnvelope;
      const named = /^error\.([a-z_]+)\.json$/.exec(e.file)?.[1];
      if (named !== undefined) { assert.equal(own.error.code, named, `${e.file}: the file name is its code`); }
      assert.equal(own.exit_code, exit, `${e.file}: the envelope exit_code equals the manifest's`);

      const stderrText = `${NOISE}\n${text}`;
      const env = parseEnvelope(stderrText, exit);
      assert.equal(env.error.code, own.error.code, `${e.file}: code`);
      assert.equal(env.exit_code, exit, `${e.file}: exit_code`);
      assert.equal(env.error.message, own.error.message, `${e.file}: message`);
      assert.deepEqual(env.error.advice, own.error.advice, `${e.file}: advice`);
      assert.equal(env.error.retryable, own.error.retryable, `${e.file}: retryable`);

      const err = errorFromExit(stderrText, exit);
      assert.equal(err.code, own.error.code, `${e.file}: CtxError.code`);
      assert.equal(err.exitCode, exit, `${e.file}: CtxError.exitCode`);
      assert.equal(err.retryable, own.error.retryable, `${e.file}: CtxError.retryable`);
      assert.deepEqual(err.details, own.error.details, `${e.file}: CtxError.details`);
      assert.equal(err.stderr, stderrText, `${e.file}: CtxError.stderr`);
    }
  });

  it("there are exactly 24 error fixtures, including not_implemented", () => {
    const codes = MANIFEST.fixtures.map((e) => /^error\.([a-z_]+)\.json$/.exec(e.file)?.[1]).filter((c): c is string => c !== undefined);
    assert.equal(codes.length, 24);
    assert.equal(ERROR_CODES.length, 24);
    assert.deepEqual([...codes].sort(), [...ERROR_CODES].sort(), "the error fixtures are exactly ERROR_CODES");
    assert.ok(codes.includes("not_implemented"));
    for (const code of codes) {
      const e = MANIFEST.fixtures.find((x) => x.file === `error.${code}.json`);
      assert.equal(e?.stream, "stderr", `error.${code}.json is a stderr entry`);
      assert.equal(e?.schema, "ctx.error.v1", `error.${code}.json schema`);
    }
  });

  it("raw, data and ctx.repair.v1 entries are skipped (E32)", () => {
    const { stdout, stderr, skipped } = decodable(MANIFEST.fixtures);
    assert.equal(stdout.length + stderr.length + skipped.length, MANIFEST.fixtures.length);
    assert.deepEqual(skipped.map((e) => e.file).sort(), ["classify.cases.json", "raw/retry-policy.base.md", "raw/retry-policy.server.md"]);
    for (const e of skipped) {
      assert.ok(e.stream === "raw" || e.stream === "data", `${e.file}: stream ${e.stream}`);
      assert.equal(e.schema, null, `${e.file}: schema null`);
    }
    const data = MANIFEST.fixtures.find((e) => e.file === "classify.cases.json");
    assert.deepEqual([data?.stream, data?.command, data?.exit_code], ["data", null, null]);
    const raw = MANIFEST.fixtures.filter((e) => e.stream === "raw");
    assert.ok(raw.length === 2 && raw.every((e) => e.file.startsWith("raw/") && e.command === "show"));

    // Selection is by stream + schema, never by extension: a repair document (no schema here,
    // never parsed by the extension) and a .json raw entry are skipped too.
    const synthetic: Entry[] = [
      { file: "repair.ok.json", schema: "ctx.repair.v1", command: "repair", stream: "stdout", exit_code: 0, sha256: "0".repeat(64) },
      { file: "raw/page.json", schema: null, command: "show", stream: "raw", exit_code: 0, sha256: "0".repeat(64) },
      { file: "status.future.json", schema: "ctx.status.v2", command: "status", stream: "stdout", exit_code: 0, sha256: "0".repeat(64) },
    ];
    assert.deepEqual(decodable(synthetic).skipped.map((e) => e.file), synthetic.map((e) => e.file));
  });

  it("the exit-2 panic -> internal case", () => {
    for (const stderr of [GO_PANIC, `${NOISE}\n${GO_PANIC}`]) {
      const env = parseEnvelope(stderr, 2);
      assert.equal(env.schema, "ctx.error.v1");
      assert.equal(env.error.code, "internal");
      assert.equal(env.exit_code, 2);
      assert.equal(env.error.retryable, false);
      assert.deepEqual(env.error.advice, []);
      assert.ok(env.error.message.includes("panic: runtime error"), "the raw stderr is the message");
      const err = errorFromExit(stderr, 2);
      assert.equal(err.code, "internal");
      assert.equal(err.exitCode, 2);
      assert.equal(err.stderr, stderr);
    }
    // A truncated envelope (the process died mid-write) also falls back by exit code.
    const truncated = read("error.busy.json").toString("utf8").slice(0, 60);
    const err = errorFromExit(`${NOISE}\n${truncated}`, 12);
    assert.equal(err.code, "busy");
    assert.equal(err.retryable, true);
  });
});
