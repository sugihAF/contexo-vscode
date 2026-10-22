// The vendored WP-2.2 golden contract fixtures (test/fixtures/golden, a byte-for-byte copy of
// Contexo internal/e2e/testdata/contract made by `node scripts/real-ctx-env.mjs vendor-golden`;
// WP-3.1). Files are selected by the manifest's stream and schema, never by file extension
// (E32): stdout entries are whole-file documents, stderr entries use their last non-empty line,
// and ctx.repair.v1, raw and data entries are skipped. Each validated document is checked
// against contract/schemas (ajv, as contract/validate.mjs), parsed by src/contract/types.ts and,
// for envelopes, against the E2(1) exit table. Read only; plain mocha, no vscode.
import * as assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import Ajv2020 from "ajv/dist/2020";
import type { ValidateFunction } from "ajv";
import {
  PAGE_STATES, SCHEMAS, groupFor, parseDoc, parseEnvelope,
  type Doc, type ErrorCode, type ErrorEnvelope, type PageState, type PullDoc, type PushDoc,
  type SchemaId, type StatusDoc,
} from "../../../src/contract/types";
import { BASELINE_SCENARIOS, REPO_ROOT, scenarioPayloads } from "../../helpers/fixtures";

type Json = Record<string, unknown>;

const DIR = path.join(REPO_ROOT, "test", "fixtures", "golden");
/** Excluded from the hash set (E32): the vendoring note and the manifest itself. */
const UNHASHED = new Set(["SOURCE.md", "manifest.json"]);
/** Files that may sit next to the goldens without a manifest entry. */
const UNLISTED_OK = new Set(["SOURCE.md", "manifest.json", ".gitattributes"]);

type Stream = "stdout" | "stderr" | "raw" | "data";
interface Entry {
  file: string;
  schema: string | null;
  command: string[] | string | null;
  stream: Stream;
  exit_code: number | null;
  sha256: string;
}
interface Manifest { contract_version: number; fixtures: Entry[]; }

const MANIFEST = JSON.parse(fs.readFileSync(path.join(DIR, "manifest.json"), "utf8")) as Manifest;

/** Errata E2(1): the exit code of every v1 error code. */
const E2_EXIT: Readonly<Record<ErrorCode, number>> = {
  internal: 1,
  usage: 3, invalid_path: 3,
  not_authenticated: 4, auth_rejected: 4, forbidden: 4,
  not_initialized: 5, repo_not_configured: 5, server_unresolved: 5,
  conflict: 6, stale: 6,
  network: 7, server_error: 7, rate_limited: 7,
  repo_not_found: 8, page_not_found: 8, base_unavailable: 8, sha_not_found: 8,
  distill_required: 9, not_resolvable: 9,
  server_unsupported: 10, not_implemented: 10,
  quota_exceeded: 11,
  busy: 12,
};
/** Errata E2(1): retryable codes (exit 7 and 12). */
const E2_RETRYABLE = new Set<string>(["network", "server_error", "rate_limited", "busy"]);

/** The codes WP-2.2's goldens must cover (WP-3.1 Acceptance); a missing one is a GFR. */
const REQUIRED_CODES: readonly ErrorCode[] = [
  "not_authenticated", "auth_rejected", "repo_not_configured", "usage", "invalid_path", "stale", "network",
  "repo_not_found", "page_not_found", "base_unavailable", "sha_not_found", "not_resolvable", "not_initialized",
  "conflict", "distill_required", "busy",
];

/** page_states SCM GROUP MAPPING (unchanged by E29). */
const GROUP_OF: Readonly<Record<PageState, string | undefined>> = {
  conflict: "conflicts", modified: "changes", deleted_local: "changes", new: "new",
  incoming: "incoming", incoming_new: "incoming", invalid: "invalid", unchanged: undefined, unverified: undefined,
};

const E16_TIME = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/;
const SHA40 = /^[0-9a-f]{40}$/;
const SHA_KEYS = new Set(["sha", "head", "new_head", "base_sha", "server_sha", "last_pull_sha", "expected_sha"]);
const TIME_KEYS = new Set(["generated_at", "fetched_at", "synced_at", "updated_at", "time", "updated", "detected_at", "started_at"]);

const SCHEMA_FILES: Record<SchemaId, string> = {
  "ctx.version.v1": "version.schema.json",
  "ctx.status.v1": "status.schema.json",
  "ctx.push.v1": "push.schema.json",
  "ctx.pull.v1": "pull.schema.json",
  "ctx.resolve.v1": "resolve.schema.json",
  "ctx.error.v1": "error.schema.json",
};

let compiled: Map<string, ValidateFunction> | undefined;
/** The 6 schemas, compiled like contract/validate.mjs (strictRequired off: it misreports `not: {required}`). */
function validators(): Map<string, ValidateFunction> {
  if (compiled) { return compiled; }
  const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
  const m = new Map<string, ValidateFunction>();
  for (const id of SCHEMAS) {
    m.set(id, ajv.compile(JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "contract", "schemas", SCHEMA_FILES[id]), "utf8")) as Json));
  }
  compiled = m;
  return m;
}

function schemaErrors(id: string, doc: unknown): string[] {
  const v = validators().get(id);
  if (!v) { return [`no schema for ${id}`]; }
  return v(doc) ? [] : (v.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message ?? ""}`);
}

function read(file: string): Buffer {
  return fs.readFileSync(path.join(DIR, file));
}

function lastNonEmptyLine(text: string): string {
  return text.split(/\r?\n/).filter((l) => l.trim() !== "").pop() ?? "";
}

/** Every file under dir, '/'-separated and relative to dir (recursive). */
function walk(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { out.push(...walk(full, base)); } else { out.push(path.relative(base, full).split(path.sep).join("/")); }
  }
  return out;
}

function isV1Schema(s: string | null): s is SchemaId {
  return s !== null && (SCHEMAS as readonly string[]).includes(s);
}

/** E32 selection: by stream and schema only. */
function select(entries: readonly Entry[]): { stdout: Entry[]; stderr: Entry[]; skipped: Entry[] } {
  const out = { stdout: [] as Entry[], stderr: [] as Entry[], skipped: [] as Entry[] };
  for (const e of entries) {
    if (e.stream === "stdout" && isV1Schema(e.schema) && e.schema !== "ctx.error.v1") {
      out.stdout.push(e);
    } else if (e.stream === "stderr" && e.schema === "ctx.error.v1") {
      out.stderr.push(e);
    } else {
      out.skipped.push(e);
    }
  }
  return out;
}

const SELECTED = select(MANIFEST.fixtures);

/** The stdout documents, parsed whole-file. */
function stdoutDocs(): { e: Entry; doc: Doc }[] {
  return SELECTED.stdout.map((e) => ({ e, doc: JSON.parse(read(e.file).toString("utf8")) as Doc }));
}

/** The stderr envelopes (last non-empty line). */
function envelopes(): { e: Entry; env: ErrorEnvelope }[] {
  return SELECTED.stderr.map((e) => ({ e, env: JSON.parse(lastNonEmptyLine(read(e.file).toString("utf8"))) as ErrorEnvelope }));
}

/** [key, value, pointer] for every scalar under doc. */
function scalars(doc: unknown, ptr = "", key?: string): [string | undefined, unknown, string][] {
  if (Array.isArray(doc)) { return doc.flatMap((x, i) => scalars(x, `${ptr}/${i}`)); }
  if (typeof doc === "object" && doc !== null) { return Object.entries(doc as Json).flatMap(([k, v]) => scalars(v, `${ptr}/${k}`, k)); }
  return [[key, doc, ptr]];
}

/** Every key path of doc, arrays generalised to '[]' (e.g. 'pages[].remote.sha'). */
function keyPaths(doc: unknown, prefix = "", out = new Set<string>()): Set<string> {
  if (Array.isArray(doc)) {
    for (const x of doc) { keyPaths(x, `${prefix}[]`, out); }
  } else if (typeof doc === "object" && doc !== null) {
    for (const [k, v] of Object.entries(doc as Json)) {
      const p = prefix === "" ? k : `${prefix}.${k}`;
      out.add(p);
      keyPaths(v, p, out);
    }
  }
  return out;
}

describe("vendored WP-2.2 goldens (test/fixtures/golden)", () => {
  it("SOURCE.md names the 40-hex Contexo commit the goldens were vendored from", () => {
    const text = read("SOURCE.md").toString("utf8");
    assert.match(text, /\b[0-9a-f]{40}\b/, "SOURCE.md contains a 40-hex commit");
    assert.match(text, /internal\/e2e\/testdata\/contract/, "SOURCE.md names the source path");
  });

  it("every manifest sha256 matches (SOURCE.md and manifest.json excluded), with no missing or unlisted files", () => {
    const listed = MANIFEST.fixtures.map((e) => e.file).sort();
    assert.equal(new Set(listed).size, listed.length, "no duplicate manifest entries");
    for (const f of listed) { assert.ok(!UNHASHED.has(f), `${f} is never a hashed entry`); }
    const onDisk = walk(DIR).sort();
    assert.deepEqual(onDisk.filter((f) => !listed.includes(f) && !UNLISTED_OK.has(f)), [], "files on disk that the manifest does not list");
    assert.deepEqual(listed.filter((f) => !onDisk.includes(f)), [], "manifest entries missing on disk");
    for (const e of MANIFEST.fixtures) {
      assert.match(e.sha256, /^[0-9a-f]{64}$/, `${e.file}: sha256 is 64 lowercase hex`);
      assert.equal(crypto.createHash("sha256").update(read(e.file)).digest("hex"), e.sha256, `${e.file}: sha256`);
    }
    assert.equal(MANIFEST.contract_version, 1);
  });

  it(`selects by stream and schema, never by extension (E32): skipped ${SELECTED.skipped.length} (ctx.repair.v1, raw, data)`, () => {
    const { stdout, stderr, skipped } = SELECTED;
    console.log(`      golden: validated ${stdout.length + stderr.length} (stdout ${stdout.length}, stderr ${stderr.length}), skipped ${skipped.length}: ${skipped.map((e) => `${e.file} [${e.stream}, ${String(e.schema)}]`).join(", ")}`);
    assert.equal(stdout.length + stderr.length + skipped.length, MANIFEST.fixtures.length);
    for (const e of skipped) {
      assert.ok(e.stream === "raw" || e.stream === "data" || !isV1Schema(e.schema), `${e.file}: skipped only for its stream or schema`);
    }
    assert.ok(skipped.some((e) => e.schema === "ctx.repair.v1" && e.file.endsWith(".json")), "a .json entry (ctx.repair.v1) is skipped by schema");
    assert.ok(stdout.length > 0 && stderr.length > 0);
    // A synthetic manifest: extensions never decide.
    const synthetic: Entry[] = [
      { file: "a.json", schema: "ctx.repair.v1", command: null, stream: "stdout", exit_code: 0, sha256: "0".repeat(64) },
      { file: "b.json", schema: null, command: null, stream: "raw", exit_code: 0, sha256: "0".repeat(64) },
      { file: "c.json", schema: null, command: null, stream: "data", exit_code: null, sha256: "0".repeat(64) },
      { file: "d.md", schema: "ctx.status.v1", command: null, stream: "stdout", exit_code: 0, sha256: "0".repeat(64) },
      { file: "e.txt", schema: "ctx.error.v1", command: null, stream: "stderr", exit_code: 4, sha256: "0".repeat(64) },
    ];
    const s = select(synthetic);
    assert.deepEqual([s.stdout.map((e) => e.file), s.stderr.map((e) => e.file), s.skipped.map((e) => e.file)], [["d.md"], ["e.txt"], ["a.json", "b.json", "c.json"]]);
  });

  it("every stdout entry validates as a whole file against contract/schemas and parses with parseDoc", () => {
    for (const schema of ["ctx.version.v1", "ctx.status.v1", "ctx.push.v1", "ctx.pull.v1", "ctx.resolve.v1"]) {
      assert.ok(SELECTED.stdout.some((e) => e.schema === schema), `at least one ${schema} golden`);
    }
    for (const e of SELECTED.stdout) {
      const text = read(e.file).toString("utf8");
      let doc: unknown;
      assert.doesNotThrow(() => { doc = JSON.parse(text); }, `${e.file}: the whole file is one JSON document`);
      assert.deepEqual(schemaErrors(e.schema as string, doc), [], `${e.file}: validates against ${String(e.schema)}`);
      assert.equal(parseDoc<Doc>(text, e.schema as Doc["schema"]).schema, e.schema, `${e.file}: parseDoc`);
      if (e.exit_code !== 0) {
        assert.equal(e.exit_code, 6, `${e.file}: a stdout document exits 0, or 6 for a push with conflicts`);
        assert.ok(e.schema === "ctx.push.v1" && (doc as PushDoc).conflicts.length > 0, `${e.file}: exit 6 only with conflicts`);
      }
    }
  });

  it("every stderr entry: the last non-empty line validates against ctx.error.v1 and parseEnvelope round-trips it", () => {
    for (const e of SELECTED.stderr) {
      const text = read(e.file).toString("utf8");
      const line = lastNonEmptyLine(text);
      let env: unknown;
      assert.doesNotThrow(() => { env = JSON.parse(line); }, `${e.file}: the last non-empty line is JSON`);
      assert.deepEqual(schemaErrors("ctx.error.v1", env), [], `${e.file}: validates against ctx.error.v1`);
      assert.equal(typeof e.exit_code, "number", `${e.file}: exit_code`);
      const own = env as ErrorEnvelope;
      const parsed = parseEnvelope(text, e.exit_code as number);
      assert.equal(parsed.error.code, own.error.code, `${e.file}: parseEnvelope code`);
      assert.equal(parsed.exit_code, own.exit_code, `${e.file}: parseEnvelope exit_code`);
      assert.equal(parsed.error.retryable, own.error.retryable, `${e.file}: parseEnvelope retryable`);
      assert.deepEqual(parsed.error.details, own.error.details, `${e.file}: parseEnvelope details`);
    }
  });

  it("every envelope's exit_code and retryable follow the E2(1) table, and the manifest exit_code equals the envelope's", () => {
    for (const { e, env } of envelopes()) {
      const code = env.error.code;
      assert.ok(Object.hasOwn(E2_EXIT, code), `${e.file}: ${code} is a v1 error code`);
      assert.equal(env.exit_code, E2_EXIT[code], `${e.file}: ${code} exits ${E2_EXIT[code]} (E2(1))`);
      assert.equal(env.error.retryable, E2_RETRYABLE.has(code), `${e.file}: ${code} retryable ${String(E2_RETRYABLE.has(code))} (E2(1))`);
      assert.equal(e.exit_code, env.exit_code, `${e.file}: the manifest exit_code equals the envelope exit_code`);
    }
  });

  it("every PageState in status pages and push/pull skipped entries maps through groupFor", () => {
    const states: [string, PageState][] = [];
    for (const { e, doc } of stdoutDocs()) {
      if (doc.schema === "ctx.status.v1") {
        const st = doc as StatusDoc;
        for (const p of st.pages) { states.push([`${e.file} ${p.path}`, p.state]); }
        assert.equal(st.counts.ahead, st.counts.modified + st.counts.new, `${e.file}: counts.ahead`);
        assert.equal(st.counts.behind, st.counts.incoming + st.counts.incoming_new, `${e.file}: counts.behind`);
      } else if (doc.schema === "ctx.push.v1" || doc.schema === "ctx.pull.v1") {
        for (const s of (doc as PushDoc | PullDoc).skipped) {
          if (s.state !== undefined) { states.push([`${e.file} skipped ${s.path}`, s.state]); }
        }
      }
    }
    assert.ok(states.length > 0);
    for (const [where, state] of states) {
      assert.ok(PAGE_STATES.includes(state), `${where}: ${state} is a v1 PageState`);
      assert.equal(groupFor(state), GROUP_OF[state], `${where}: groupFor(${state})`);
    }
    const seen = new Set(states.map(([, s]) => s));
    console.log(`      golden: ${states.length} page states checked, covering ${[...seen].sort().join(", ")}`);
  });

  it("the error codes present cover the 16 required codes (a missing one is a GFR, never a silent pass)", () => {
    const present = new Set(envelopes().map(({ env }) => env.error.code));
    console.log(`      golden: error codes present (${present.size}): ${[...present].sort().join(", ")}`);
    assert.deepEqual(REQUIRED_CODES.filter((c) => !present.has(c)), [], "required error codes missing from the WP-2.2 goldens (file each as a GFR)");
  });

  it("redaction placeholders are already schema-valid: shas 40-hex, times whole-second UTC (no in-memory substitution)", () => {
    let shas = 0;
    let times = 0;
    const docs: [string, unknown][] = [...stdoutDocs().map(({ e, doc }) => [e.file, doc] as [string, unknown]), ...envelopes().map(({ e, env }) => [e.file, env] as [string, unknown])];
    for (const [file, doc] of docs) {
      for (const [key, value, ptr] of scalars(doc)) {
        if (key !== undefined && SHA_KEYS.has(key)) { shas++; assert.match(String(value), SHA40, `${file}${ptr}: sha`); }
        if ((key !== undefined && TIME_KEYS.has(key)) || (typeof value === "string" && /^\d{4}-\d\d-\d\dT/.test(value))) {
          times++;
          assert.match(String(value), E16_TIME, `${file}${ptr}: E16 time`);
        }
      }
    }
    console.log(`      golden: ${shas} shas and ${times} times are valid as vendored; substitution map: none`);
  });

  it("key-set parity with the fake-ctx baseline fixtures (findings only, never fails)", () => {
    const golden = new Map<string, Set<string>>();
    const baseline = new Map<string, Set<string>>();
    const add = (m: Map<string, Set<string>>, schema: string, doc: unknown): void => {
      const s = m.get(schema) ?? new Set<string>();
      keyPaths(doc, "", s);
      m.set(schema, s);
    };
    for (const { doc } of stdoutDocs()) { add(golden, doc.schema, doc); }
    for (const { env } of envelopes()) { add(golden, `ctx.error.v1 ${env.error.code}`, env); }
    for (const name of BASELINE_SCENARIOS) {
      for (const p of scenarioPayloads(name)) {
        if (p.command === "show" && p.stream === "stdout") { continue; }
        let v: unknown;
        try { v = JSON.parse(p.stream === "stdout" ? p.text : lastNonEmptyLine(p.text)); } catch { continue; }
        if (typeof v !== "object" || v === null) { continue; }
        const schema = (v as Json).schema;
        if (typeof schema !== "string" || !isV1Schema(schema)) { continue; }
        if (schema === "ctx.error.v1") {
          add(baseline, `ctx.error.v1 ${String(((v as ErrorEnvelope).error as { code?: unknown } | undefined)?.code)}`, v);
        } else {
          add(baseline, schema, v);
        }
      }
    }
    let findings = 0;
    const keys = [...new Set([...golden.keys(), ...baseline.keys()])].sort();
    const onlyIn = (m: Map<string, Set<string>>, other: Map<string, Set<string>>): string[] => keys.filter((k) => m.has(k) && !other.has(k));
    for (const [where, list] of [["the goldens", onlyIn(golden, baseline)], ["the fake-ctx baseline", onlyIn(baseline, golden)]] as const) {
      if (list.length > 0) { findings++; console.log(`      FINDING parity: documents only in ${where}: ${list.join(", ")}`); }
    }
    for (const key of keys) {
      const g = golden.get(key);
      const b = baseline.get(key);
      if (!g || !b) { continue; }
      const onlyG = [...g].filter((k) => !b.has(k)).sort();
      const onlyB = [...b].filter((k) => !g.has(k)).sort();
      if (onlyG.length > 0) { findings++; console.log(`      FINDING parity: ${key} keys only in the goldens: ${onlyG.join(", ")}`); }
      if (onlyB.length > 0) { findings++; console.log(`      FINDING parity: ${key} keys only in the fake-ctx baseline: ${onlyB.join(", ")}`); }
    }
    console.log(`      golden: key-set parity findings ${findings}`);
  });
});
