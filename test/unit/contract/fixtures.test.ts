// Contract v1: JSON Schemas (contract/schemas), the validator CLI (contract/validate.mjs),
// the frozen pure helpers of src/contract/types.ts, and the baseline fake-ctx fixtures.
// Plain mocha: no vscode import. Scenario NAMES always come from BASELINE_SCENARIOS
// (never readdir); test/fixtures/contract/v1 is WP-1.7's and is never read here.
import * as assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Ajv2020 from "ajv/dist/2020";
import type { ValidateFunction } from "ajv";
import {
  CAPABILITIES, PAGE_STATES, SCHEMAS, groupFor, listedInTree, parseEnvelope, scmCount,
  type PageEntry, type PageState, type SchemaId, type ScmGroup, type StateCounts, type StatusDoc,
} from "../../../src/contract/types";
import {
  BASELINE_SCENARIOS, REPO_ROOT, loadScenario, loadStatusDoc, scenarioDir, scenarioOutput, scenarioPayloads,
} from "../../helpers/fixtures";

type Json = Record<string, unknown>;

const SCHEMA_DIR = path.join(REPO_ROOT, "contract", "schemas");
const VALIDATE_MJS = path.join(REPO_ROOT, "contract", "validate.mjs");
const SCHEMA_FILES: Record<SchemaId, string> = {
  "ctx.version.v1": "version.schema.json",
  "ctx.status.v1": "status.schema.json",
  "ctx.push.v1": "push.schema.json",
  "ctx.pull.v1": "pull.schema.json",
  "ctx.resolve.v1": "resolve.schema.json",
  "ctx.error.v1": "error.schema.json",
};
/** Server capabilities a v1 server advertises (E13); pages.etag is reserved and never appears. */
const SERVER_CAPS_V1 = ["pages.at", "push.expect_absent", "write.path_sha"];
/**
 * The Contexo API-token prefix, assembled at runtime so this file never contains it: the
 * WP-0.6 acceptance greps src, test and contract for the literal.
 */
const TOKEN_PREFIX = ["ctx", "p_"].join("");
/** Scenarios that only answer `version` (the handshake fails before any status call). */
const VERSION_ONLY = new Set<string>(["ctx-too-old", "ctx-missing-caps", "ctx-contract2"]);

// ---------- helpers ----------

function readJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function lastNonEmptyLine(text: string): string {
  return text.split(/\r?\n/).filter((l) => l.trim() !== "").pop() ?? "";
}

let compiled: Map<string, ValidateFunction> | undefined;
/**
 * The 6 schemas, compiled once with the same options as contract/validate.mjs. strictRequired
 * is off only because it misreports `not: {required: [...]}` (the "must be absent" rules).
 */
function validators(): Map<string, ValidateFunction> {
  if (compiled) { return compiled; }
  const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
  const m = new Map<string, ValidateFunction>();
  for (const id of SCHEMAS) {
    m.set(id, ajv.compile(readJson(path.join(SCHEMA_DIR, SCHEMA_FILES[id])) as Json));
  }
  compiled = m;
  return m;
}

function schemaErrors(id: string, doc: unknown): string[] {
  const v = validators().get(id);
  if (!v) { return [`no schema for ${id}`]; }
  return v(doc) ? [] : (v.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message ?? ""}`);
}

function assertValid(id: string, doc: unknown, label: string): void {
  assert.deepEqual(schemaErrors(id, doc), [], `${label} must validate against ${id}`);
}

function assertInvalid(id: string, doc: unknown, label: string): void {
  assert.notDeepEqual(schemaErrors(id, doc), [], `${label} must NOT validate against ${id}`);
}

const DELETE = Symbol("delete");
/** Deep clone of doc with each [slash/separated/pointer, value] applied (DELETE removes the key). */
function patched(doc: unknown, ...ops: [string, unknown][]): unknown {
  const d = clone(doc);
  for (const [ptr, value] of ops) {
    const keys = ptr.split("/");
    const last = keys.pop() ?? "";
    let cur = d as Json;
    for (const k of keys) { cur = cur[k] as Json; }
    if (value === DELETE) { delete cur[last]; } else { cur[last] = value; }
  }
  return d;
}

/** Every StatusDoc any baseline scenario prints on stdout. */
function baselineStatusDocs(): { where: string; doc: StatusDoc }[] {
  const out: { where: string; doc: StatusDoc }[] = [];
  for (const name of BASELINE_SCENARIOS) {
    for (const p of scenarioPayloads(name)) {
      if (p.stream !== "stdout" || p.command === "show") { continue; }
      let v: unknown;
      try { v = JSON.parse(p.text); } catch { continue; }
      if (typeof v === "object" && v !== null && (v as Json).schema === "ctx.status.v1") {
        out.push({ where: `${name} rule ${String(p.rule)}`, doc: v as StatusDoc });
      }
    }
  }
  return out;
}

function tally(pages: readonly PageEntry[]): Record<PageState, number> {
  const t = Object.fromEntries(PAGE_STATES.map((s) => [s, 0])) as Record<PageState, number>;
  for (const p of pages) { t[p.state] = (t[p.state] ?? 0) + 1; }
  return t;
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { out.push(...walk(full)); } else { out.push(full); }
  }
  return out;
}

// ---------- hand-made documents (independent of the scenario fixtures) ----------

const SHA1 = "0123456789abcdef0123456789abcdef01234567";
const SHA2 = "89abcdef0123456789abcdef0123456789abcdef";
const HASH1 = "sha256:" + "1".repeat(64);
const HASH2 = "sha256:" + "2".repeat(64);
const T0 = "2026-10-20T08:00:00Z";

const MIN_VERSION: Json = {
  schema: "ctx.version.v1", contract_version: 1, version: "0.7.0", commit: "abc1234", date: "2026-10-20",
  dev_build: false, os: "linux", arch: "amd64", capabilities: [...CAPABILITIES, "repair"],
};

const MIN_STATUS: Json = {
  schema: "ctx.status.v1", generated_at: T0, offline: false, root: "/tmp/proj", contexo_dir: "/tmp/proj/.contexo",
  project: {
    repo_id: "demo", config_server_url: "https://api.example.test", dashboard_url: "https://app.example.test",
    dashboard_page_url_template: "https://app.example.test/repos/demo/page/{path}", last_pull_sha: SHA1,
  },
  server: { url: "https://api.example.test", url_source: "credentials", version: "0.7.0", capabilities_known: true, capabilities: SERVER_CAPS_V1 },
  auth: { state: "authenticated", credentials_source: "global", token_kind: "pat", user_name: "Dana", user_email: "dana@example.test" },
  remote: { source: "live", fetched_at: T0, repo_exists: true, head: SHA2, page_count: 2 },
  counts: {
    unchanged: 0, modified: 0, new: 0, incoming: 0, incoming_new: 1, conflict: 1, deleted_local: 0, invalid: 1, unverified: 0,
    ahead: 0, behind: 1,
  },
  pages: [
    {
      path: "wiki/concepts/a.md", state: "conflict", conflict_kind: "both_modified", type: "concept", slug: "a", title: "A", tags: [],
      local: { file: "wiki/concepts/a.md", hash: HASH1 }, base: { sha: SHA1, hash: HASH2, synced_at: T0, stale: false },
      remote: { sha: SHA2, author: "Eve", time: T0, message: "edit" }, notes: [],
    },
    {
      path: "wiki/concepts/b.md", state: "invalid", tags: [], local: { file: "wiki/concepts/b.md" },
      invalid: { stage: "parse", message: "yaml: line 2: did not find expected key" }, notes: [],
    },
    { path: "wiki/entities/c.md", state: "incoming_new", tags: [], remote: { sha: SHA2 }, notes: [] },
  ],
  captures: { pending: 1, fresh: 1, blocks_push: false, sessions: [{ session_id: "s-1", turns: 3, updated_at: T0, fresh: true }] },
  warnings: [{ code: "base_repair_skipped", message: "1 page left unverified", paths: ["wiki/concepts/a.md"] }],
};

const MIN_PUSH: Json = {
  schema: "ctx.push.v1", dry_run: false, message: "ctx push (1 pages)", server_url: "https://api.example.test", repo_id: "demo",
  new_head: SHA2, pushed: [{ path: "wiki/concepts/a.md", kind: "update", sha: SHA2 }],
  conflicts: [{ path: "wiki/concepts/d.md", kind: "both_added", server_sha: SHA1 }],
  skipped: [{ path: "wiki/concepts/b.md", state: "invalid", reason: "invalid" }],
  distill: { required: false, bypassed: false }, warnings: [],
};

const MIN_PULL: Json = {
  schema: "ctx.pull.v1", server_url: "https://api.example.test", repo_id: "demo", head: SHA2,
  written: [{ path: "wiki/entities/c.md", sha: SHA2, kind: "create" }], adopted: [{ path: "wiki/concepts/e.md", sha: SHA1 }],
  skipped: [{ path: "wiki/concepts/a.md", state: "modified", reason: "modified" }], reindexed: true, warnings: [],
};

const MIN_RESOLVE: Json = {
  schema: "ctx.resolve.v1", path: "wiki/concepts/a.md", strategy: "theirs", previous_state: "conflict", state: "unchanged",
  base_sha: SHA2, file_written: true, backup_file: ".sync/backup/wiki/concepts/a.md.20261020T080000Z", warnings: [],
};

function envelope(code: string, exit: number, retryable: boolean, extra: Json = {}): Json {
  return { schema: "ctx.error.v1", exit_code: exit, error: { code, message: `${code} happened`, advice: [], retryable, ...extra } };
}

// ---------- tests ----------

describe("contract v1: schemas, validator and baseline fixtures", () => {
  it("schemas: all 6 compile in ajv strict mode, carry 2020-12 + a stable $id, and shared $defs are identical across files", () => {
    const defs = new Map<string, { file: string; json: string }>();
    const ids = new Set<string>();
    for (const id of SCHEMAS) {
      const file = SCHEMA_FILES[id];
      const s = readJson(path.join(SCHEMA_DIR, file)) as Json;
      assert.equal(s.$schema, "https://json-schema.org/draft/2020-12/schema", file);
      assert.equal(typeof s.$id, "string", `${file} $id`);
      assert.ok((s.$id as string).endsWith(`/${file}`), `${file} $id ends with its file name`);
      assert.ok(!ids.has(s.$id as string), `${file} $id unique`);
      ids.add(s.$id as string);
      assert.equal(((s.properties as Json).schema as Json).const, id, `${file} pins schema ${id}`);
      for (const [name, def] of Object.entries((s.$defs ?? {}) as Json)) {
        const json = JSON.stringify(def);
        const seen = defs.get(name);
        if (seen) { assert.equal(json, seen.json, `$defs/${name} differs between ${seen.file} and ${file}`); } else { defs.set(name, { file, json }); }
      }
    }
    assert.equal(validators().size, 6);
    assertValid("ctx.version.v1", MIN_VERSION, "MIN_VERSION");
    assertValid("ctx.status.v1", MIN_STATUS, "MIN_STATUS");
    assertValid("ctx.push.v1", MIN_PUSH, "MIN_PUSH");
    assertValid("ctx.pull.v1", MIN_PULL, "MIN_PULL");
    assertValid("ctx.resolve.v1", MIN_RESOLVE, "MIN_RESOLVE");
    assertValid("ctx.error.v1", envelope("not_initialized", 5, false, { advice: ["ctx init"] }), "not_initialized envelope");
  });

  it("every payload of every BASELINE_SCENARIOS scenario validates against contract/schemas (ajv 2020)", () => {
    const failures: string[] = [];
    let validated = 0;
    for (const name of BASELINE_SCENARIOS) {
      const sc = loadScenario(name);
      const outputs = [...sc.rules.map((r, i) => ({ where: `rule ${i}`, out: r as { exit?: number; stderr?: string; stderrFile?: string } })),
        ...(sc.default ? [{ where: "default", out: sc.default }] : [])];
      for (const { where, out } of outputs) {
        if ((out.exit ?? 0) !== 0 && out.stderr === undefined && out.stderrFile === undefined) {
          failures.push(`${name} ${where}: exit ${String(out.exit)} without a stderr payload`);
        }
      }
      for (const p of scenarioPayloads(name)) {
        const where = `${name} rule ${String(p.rule)} ${p.stream} (${p.source === "inline" ? "inline" : path.relative(REPO_ROOT, p.source)})`;
        if (p.stream === "stdout") {
          if (p.command === "show") { continue; } // raw page bytes, no JSON
          if (p.text.trim() === "") {
            if (p.exit === 0) { failures.push(`${where}: exit 0 with an empty stdout (a --json success prints one document)`); }
            continue;
          }
          let doc: unknown;
          try {
            doc = JSON.parse(p.text);
          } catch {
            // the only non-JSON stdout: an old ctx answering `version --short` with a bare version line
            if (!(name === "ctx-too-old" && /^\d+\.\d+\.\d+\S*\r?\n?$/.test(p.text))) { failures.push(`${where}: stdout is not one JSON document`); }
            continue;
          }
          const id = (doc as Json | null)?.schema;
          if (typeof id !== "string" || !(SCHEMAS as readonly string[]).includes(id) || id === "ctx.error.v1") {
            failures.push(`${where}: stdout schema ${String(id)} is not one of the 5 document schemas`);
            continue;
          }
          if (p.exit !== 0 && !(id === "ctx.push.v1" && p.exit === 6)) {
            failures.push(`${where}: a stdout document with exit ${p.exit} (only push exit 6 has both)`);
          }
          failures.push(...schemaErrors(id, doc).map((e) => `${where}: ${e}`));
          validated++;
        } else {
          const last = lastNonEmptyLine(p.text);
          if (last === "") {
            if (p.exit !== 0) { failures.push(`${where}: exit ${p.exit} with an empty stderr`); }
            continue;
          }
          if (!last.trimStart().startsWith("{")) {
            if (name !== "ctx-too-old") { failures.push(`${where}: non-JSON stderr outside ctx-too-old`); }
            continue;
          }
          let env: unknown;
          try { env = JSON.parse(last); } catch { failures.push(`${where}: last stderr line is not JSON`); continue; }
          failures.push(...schemaErrors("ctx.error.v1", env).map((e) => `${where}: ${e}`));
          const exitCode = (env as Json | null)?.exit_code;
          if (exitCode !== p.exit) { failures.push(`${where}: envelope exit_code ${String(exitCode)} != rule exit ${p.exit}`); }
          validated++;
        }
      }
    }
    assert.deepEqual(failures, []);
    assert.ok(validated >= BASELINE_SCENARIOS.length, `validated ${validated} payloads`);
  });

  it("invalid payloads fail: pages null, unknown PageState, fractional-second time, short sha", () => {
    const mixed = loadStatusDoc("mixed");
    assertValid("ctx.status.v1", mixed, "mixed");
    const withBase = mixed.pages.findIndex((p) => p.base !== undefined);
    assert.ok(withBase >= 0, "mixed has a page with a base");
    const sha = mixed.pages[withBase]?.base?.sha ?? "";
    assertInvalid("ctx.status.v1", patched(mixed, ["pages", null]), "pages null");
    assertInvalid("ctx.status.v1", patched(mixed, ["pages/0/state", "renamed"]), "unknown PageState");
    assertInvalid("ctx.status.v1", patched(mixed, ["generated_at", mixed.generated_at.replace(/Z$/, ".123Z")]), "fractional-second generated_at");
    assertInvalid("ctx.status.v1", patched(mixed, [`pages/${withBase}/base/sha`, sha.slice(0, 7)]), "short base.sha");
  });

  it("schema strictness: required fields, closed enums, patterns, if/then rules and typed details", () => {
    const S = "ctx.status.v1";
    // arrays are required and never null
    for (const k of ["pages", "warnings"]) { assertInvalid(S, patched(MIN_STATUS, [k, DELETE]), `status without ${k}`); }
    assertInvalid(S, patched(MIN_STATUS, ["pages/0/tags", null]), "tags null");
    assertInvalid(S, patched(MIN_STATUS, ["pages/0/notes", DELETE]), "notes missing");
    assertInvalid(S, patched(MIN_STATUS, ["server/capabilities", null]), "server.capabilities null");
    assertInvalid(S, patched(MIN_STATUS, ["captures/sessions", null]), "captures.sessions null");
    // non-omitempty scalars are required
    assertInvalid(S, patched(MIN_STATUS, ["remote/page_count", DELETE]), "remote.page_count missing");
    assertInvalid(S, patched(MIN_STATUS, ["server/capabilities_known", DELETE]), "capabilities_known missing");
    assertInvalid(S, patched(MIN_STATUS, ["counts/unverified", DELETE]), "counts.unverified missing");
    assertInvalid(S, patched(MIN_STATUS, ["pages/0/base/stale", DELETE]), "base.stale missing");
    // E23: dashboard_url is a required string that may be ''; then the template is absent
    assertInvalid(S, patched(MIN_STATUS, ["project/dashboard_url", DELETE]), "dashboard_url missing");
    assertValid(S, patched(MIN_STATUS, ["project/dashboard_url", ""], ["project/dashboard_page_url_template", DELETE]), "dashboard_url ''");
    assertInvalid(S, patched(MIN_STATUS, ["project/dashboard_url", ""]), "dashboard_url '' with a template");
    // conflict_kind iff conflict; invalid iff invalid
    assertInvalid(S, patched(MIN_STATUS, ["pages/0/conflict_kind", DELETE]), "conflict without conflict_kind");
    assertInvalid(S, patched(MIN_STATUS, ["pages/0/state", "modified"]), "modified with conflict_kind");
    assertValid(S, patched(MIN_STATUS, ["pages/0/state", "modified"], ["pages/0/conflict_kind", DELETE]), "modified without conflict_kind");
    assertInvalid(S, patched(MIN_STATUS, ["pages/1/invalid", DELETE]), "invalid without invalid info");
    assertInvalid(S, patched(MIN_STATUS, ["pages/2/invalid", { stage: "parse", message: "x" }]), "incoming_new with invalid info");
    // closed enums (reserved values still validate)
    assertInvalid(S, patched(MIN_STATUS, ["pages/0/conflict_kind", "both_deleted"]), "unknown ConflictKind");
    assertInvalid(S, patched(MIN_STATUS, ["pages/1/invalid/stage", "lint"]), "unknown InvalidStage");
    assertInvalid(S, patched(MIN_STATUS, ["auth/state", "logged_in"]), "unknown AuthState");
    assertInvalid(S, patched(MIN_STATUS, ["remote/source", "cached"]), "unknown RemoteSource");
    assertValid(S, patched(MIN_STATUS, ["remote/source", "cache"]), "reserved RemoteSource cache");
    assertInvalid(S, patched(MIN_STATUS, ["server/url_source", "env"]), "unknown UrlSource");
    // open code sets are patterns
    assertValid(S, patched(MIN_STATUS, ["warnings/0/code", "future_warning"], ["pages/0/notes", ["future_note"]]), "unknown warning/note codes");
    assertInvalid(S, patched(MIN_STATUS, ["warnings/0/code", "Bad-Code"]), "malformed warning code");
    assertValid(S, patched(MIN_STATUS, ["server/capabilities", ["pages.at", "pages.etag", "future.cap_x"]]), "reserved/unknown server capabilities");
    assertInvalid(S, patched(MIN_STATUS, ["server/capabilities", ["Pages.At"]]), "malformed server capability");
    // patterns: times, shas, hashes
    assertInvalid(S, patched(MIN_STATUS, ["pages/0/remote/time", "2026-10-20T08:00:00+07:00"]), "non-UTC time");
    assertInvalid(S, patched(MIN_STATUS, ["remote/head", SHA1.toUpperCase()]), "upper-case sha");
    assertInvalid(S, patched(MIN_STATUS, ["project/last_pull_sha", "abc1234"]), "short last_pull_sha");
    assertValid(S, patched(MIN_STATUS, ["pages/0/local/hash", "raw-sha256:" + "a".repeat(64)]), "raw-sha256 hash");
    assertInvalid(S, patched(MIN_STATUS, ["pages/0/local/hash", "sha1:" + "a".repeat(40)]), "sha1 hash");
    assertInvalid(S, patched(MIN_STATUS, ["captures/sessions/0/updated_at", "2026-10-20 08:00:00Z"]), "space-separated time");
    // remote.error is an ErrorBody (retryable pinned for known codes)
    assertValid(S, patched(MIN_STATUS, ["remote/error", { code: "network", message: "dial tcp", advice: [], retryable: true }]), "remote.error network");
    assertInvalid(S, patched(MIN_STATUS, ["remote/error", { code: "network", message: "dial tcp", advice: [], retryable: false }]), "network not retryable");

    const P = "ctx.push.v1";
    assertInvalid(P, patched(MIN_PUSH, ["conflicts/0/base_sha", SHA2]), "both_added conflict with base_sha");
    assertValid(P, patched(MIN_PUSH, ["conflicts/0/kind", "both_modified"], ["conflicts/0/base_sha", SHA2]), "both_modified conflict with base_sha");
    assertInvalid(P, patched(MIN_PUSH, ["dry_run", true]), "dry run with new_head, sha and conflicts");
    assertValid(P, patched(MIN_PUSH, ["dry_run", true], ["new_head", DELETE], ["pushed/0/sha", DELETE], ["conflicts", []]), "dry run");
    assertInvalid(P, patched(MIN_PUSH, ["distill/bypassed", DELETE]), "distill.bypassed missing");
    assertInvalid(P, patched(MIN_PUSH, ["pushed/0/kind", "delete"]), "unknown WriteKind");
    assertInvalid(P, patched(MIN_PUSH, ["skipped/0/state", "gone"]), "unknown skipped state");
    assertValid(P, patched(MIN_PUSH, ["skipped/0/reason", "future_reason"], ["skipped/0/state", DELETE]), "unknown skip reason, no state");

    const L = "ctx.pull.v1";
    assertInvalid(L, patched(MIN_PULL, ["written/0/kind", DELETE]), "written without kind");
    assertInvalid(L, patched(MIN_PULL, ["adopted/0/sha", DELETE]), "adopted without sha");
    assertInvalid(L, patched(MIN_PULL, ["reindexed", DELETE]), "reindexed missing");

    const R = "ctx.resolve.v1";
    assertInvalid(R, patched(MIN_RESOLVE, ["strategy", "mine"]), "unknown ResolveStrategy");
    assertInvalid(R, patched(MIN_RESOLVE, ["state", "modified"]), "theirs ending modified");
    assertInvalid(R, patched(MIN_RESOLVE, ["strategy", "ours"], ["state", "modified"], ["file_written", false]), "ours with backup_file");
    assertValid(R, patched(MIN_RESOLVE, ["strategy", "ours"], ["state", "modified"], ["file_written", false], ["backup_file", DELETE]), "ours");
    assertInvalid(R, patched(MIN_RESOLVE, ["base_sha", DELETE]), "base_sha missing");

    const E = "ctx.error.v1";
    assertInvalid(E, envelope("busy", 7, true), "busy with exit 7");
    assertInvalid(E, envelope("conflict", 6, true), "conflict retryable");
    assertInvalid(E, envelope("internal", 0, false), "exit_code 0");
    assertInvalid(E, patched(envelope("usage", 3, false), ["error/advice", null]), "advice null");
    assertInvalid(E, envelope("auth_rejected", 4, false, { http_status: 99 }), "http_status 99");
    assertValid(E, envelope("auth_rejected", 4, false, { http_status: 401, advice: ["ctx auth login"] }), "auth_rejected 401");
    assertValid(E, envelope("stale", 6, false, { details: { path: "wiki/a.md", expected_sha: SHA1, server_sha: SHA2 } }), "stale details");
    assertInvalid(E, envelope("stale", 6, false, { details: { path: "wiki/a.md", expected_sha: "abc", server_sha: SHA2 } }), "stale short sha");
    assertInvalid(E, envelope("distill_required", 9, false, { details: { pages: [], sessions: [] } }), "distill_required without agent_prompt");
    assertInvalid(E, envelope("conflict", 6, false, { details: { paths: null } }), "conflict paths null");
    assertInvalid(E, envelope("not_resolvable", 9, false, { details: { path: "a.md", state: "incoming", strategy: "both" } }), "not_resolvable strategy");
    assertInvalid(E, envelope("server_unsupported", 10, false, { details: { missing: "pages.at" } }), "missing not an array");
    assertInvalid(E, envelope("busy", 12, true, { details: { pid: 1, host: "h", command: "push", started_at: "2026-10-20T08:00:00.1Z" } }), "busy fractional started_at");
    assertInvalid(E, envelope("quota_exceeded", 11, false, { details: { limit: 3 } }), "quota without quota_code");
    assertValid(E, envelope("busy", 12, true, { details: { pid: 4242, host: "mac", command: "pull", started_at: T0 } }), "busy details");
  });

  it("version schema accepts contract_version 2 and an unknown capability", () => {
    const V = "ctx.version.v1";
    assertValid(V, patched(MIN_VERSION, ["contract_version", 2], ["capabilities", ["status.json", "future.thing", "errors.envelope"]]), "contract 2 + unknown capability");
    assertValid(V, patched(MIN_VERSION, ["version", "dev"], ["dev_build", true], ["capabilities", ["errors.envelope"]]), "wave-0 dev build");
    assertInvalid(V, patched(MIN_VERSION, ["contract_version", 0]), "contract_version 0");
    assertInvalid(V, patched(MIN_VERSION, ["contract_version", 1.5]), "contract_version 1.5");
    assertInvalid(V, patched(MIN_VERSION, ["contract_version", "1"]), "contract_version '1'");
    assertInvalid(V, patched(MIN_VERSION, ["capabilities", null]), "capabilities null");
    assertInvalid(V, patched(MIN_VERSION, ["capabilities", ["Status JSON"]]), "malformed capability");
    assertInvalid(V, patched(MIN_VERSION, ["dev_build", DELETE]), "dev_build missing");
    assertInvalid(V, patched(MIN_VERSION, ["schema", "ctx.version.v2"]), "other schema id");
  });

  it("error schema accepts not_implemented and an unknown future code", () => {
    const E = "ctx.error.v1";
    assertValid(E, envelope("not_implemented", 10, false, { advice: ["ctx update"] }), "not_implemented");
    assertInvalid(E, envelope("not_implemented", 1, false), "not_implemented with exit 1");
    assertValid(E, envelope("page_moved", 8, false, { details: { to: "wiki/b.md" } }), "unknown future code with details");
    assertValid(E, envelope("future_code", 1, true), "unknown future code, retryable");
    assertInvalid(E, envelope("Not-A-Code", 1, false), "malformed code");
    assertInvalid(E, patched(envelope("internal", 1, false), ["schema", "ctx.err.v1"]), "wrong schema id");
  });

  it("parseEnvelope uses the last non-empty stderr line; garbage+exit 2 -> internal; exit 7/12 -> retryable; exit 10 -> server_unsupported", () => {
    const busy = envelope("busy", 12, true, { details: { pid: 7, host: "mac", command: "push", started_at: T0 } });
    const usage = envelope("usage", 3, false);
    assert.deepEqual(parseEnvelope(`warning: noise\n${JSON.stringify(busy)}\n\n  \n`, 12), busy);
    assert.deepEqual(parseEnvelope(`${JSON.stringify(usage)}\r\n${JSON.stringify(busy)}\r\n`, 12), busy, "last line wins");
    const notLast = parseEnvelope(`${JSON.stringify(busy)}\ntrailing text\n`, 12);
    assert.equal(notLast.error.code, "busy", "fallback by exit, not the earlier envelope line");
    assert.equal(notLast.error.message, `${JSON.stringify(busy)}\ntrailing text`);

    const panic = parseEnvelope("panic: runtime error: index out of range\n\ngoroutine 1 [running]:\nmain.main()\n", 2);
    assert.equal(panic.schema, "ctx.error.v1");
    assert.equal(panic.exit_code, 2);
    assert.equal(panic.error.code, "internal");
    assert.equal(panic.error.retryable, false);
    assert.deepEqual(panic.error.advice, []);
    assert.match(panic.error.message, /^panic: runtime error/);

    for (const [exit, code, retryable] of [
      [7, "network", true], [12, "busy", true], [10, "server_unsupported", false], [4, "not_authenticated", false],
      [8, "page_not_found", false], [1, "internal", false], [143, "internal", false],
    ] as const) {
      const e = parseEnvelope("garbage", exit);
      assert.equal(e.error.code, code, `exit ${exit} code`);
      assert.equal(e.error.retryable, retryable, `exit ${exit} retryable`);
      assert.equal(e.exit_code, exit);
    }
    assert.equal(parseEnvelope("", 3).error.message, "ctx exited 3");
    assert.equal(parseEnvelope("Error: unknown flag: --json\n", 1).error.code, "internal");
    assert.equal(parseEnvelope('{"schema":"ctx.version.v1"}', 5).error.code, "not_initialized", "a non-envelope JSON line falls back");
  });

  it("groupFor matches the SCM table for all 9 states", () => {
    const table: Record<PageState, ScmGroup | undefined> = {
      conflict: "conflicts", modified: "changes", deleted_local: "changes", new: "new",
      incoming: "incoming", incoming_new: "incoming", invalid: "invalid", unchanged: undefined, unverified: undefined,
    };
    assert.equal(PAGE_STATES.length, 9);
    assert.deepEqual([...PAGE_STATES].sort(), Object.keys(table).sort());
    for (const s of PAGE_STATES) { assert.equal(groupFor(s), table[s], s); }
  });

  it("mixed: per-state tally equals counts, ahead 2, behind 2, scmCount 3/5, listedInTree gives Concepts 4", () => {
    const doc = loadStatusDoc("mixed");
    const byPath: Record<string, PageState> = {
      "raw/sessions/2026-10-01-login-debug.md": "unchanged",
      "wiki/analyses/sync-model.md": "new",
      "wiki/concepts/auth-flow.md": "modified",
      "wiki/concepts/broken.md": "invalid",
      "wiki/concepts/legacy-sync.md": "unverified",
      "wiki/concepts/old-name.md": "deleted_local",
      "wiki/concepts/rate-limits.md": "conflict",
      "wiki/concepts/retry-policy.md": "incoming",
      "wiki/entities/billing.md": "incoming_new",
      "wiki/entities/gitstore.md": "unchanged",
    };
    assert.deepEqual(Object.fromEntries(doc.pages.map((p) => [p.path, p.state])), byPath);
    const page = (p: string): PageEntry | undefined => doc.pages.find((e) => e.path === p);
    assert.equal(page("wiki/concepts/rate-limits.md")?.conflict_kind, "both_modified");
    assert.equal(page("wiki/concepts/broken.md")?.invalid?.stage, "parse");
    assert.equal(page("wiki/concepts/legacy-sync.md")?.base?.stale, true);
    assert.equal(page("wiki/entities/billing.md")?.local, undefined);

    const t = tally(doc.pages);
    const expected: StateCounts = {
      unchanged: 2, modified: 1, new: 1, incoming: 1, incoming_new: 1, conflict: 1, deleted_local: 1, invalid: 1, unverified: 1,
      ahead: 2, behind: 2,
    };
    assert.deepEqual(doc.counts, expected);
    for (const s of PAGE_STATES) { assert.equal(t[s], doc.counts[s], `tally ${s}`); }

    const groups: Record<string, number> = {};
    for (const p of doc.pages) { const g = groupFor(p.state); if (g) { groups[g] = (groups[g] ?? 0) + 1; } }
    assert.deepEqual(groups, { conflicts: 1, changes: 2, new: 1, incoming: 2, invalid: 1 });
    assert.equal(scmCount(doc.counts, false), 3);
    assert.equal(scmCount(doc.counts, true), 5);

    const TREE: Record<string, string> = { concept: "Concepts", entity: "Entities", analysis: "Analyses", source: "Sources" };
    const tree: Record<string, string[]> = {};
    for (const p of doc.pages.filter(listedInTree)) {
      const node = p.state === "invalid" ? "Invalid" : (TREE[p.type ?? ""] ?? `?${String(p.type)}`);
      (tree[node] ??= []).push(path.posix.basename(p.path, ".md"));
    }
    assert.deepEqual(tree.Concepts?.sort(), ["auth-flow", "legacy-sync", "rate-limits", "retry-policy"]);
    assert.deepEqual(Object.fromEntries(Object.entries(tree).map(([k, v]) => [k, v.length])),
      { Concepts: 4, Entities: 1, Analyses: 1, Sources: 1, Invalid: 1 });

    assert.deepEqual(
      { pending: doc.captures.pending, fresh: doc.captures.fresh, blocks_push: doc.captures.blocks_push },
      { pending: 2, fresh: 0, blocks_push: false });
    assert.equal(doc.project.dashboard_url, "https://app.contexo.live");
    assert.equal(typeof doc.project.dashboard_page_url_template, "string");
    assert.deepEqual(doc.server.capabilities, SERVER_CAPS_V1);
    assert.equal(doc.offline, false);
    assert.equal(doc.remote.source, "live");
  });

  it("mixed-offline (and mixed --offline): remote.source none and no sidecars, so rate-limits is modified, retry-policy unchanged, billing absent", () => {
    for (const [label, doc] of [
      ["mixed-offline", loadStatusDoc("mixed-offline", { offline: true })],
      ["mixed --offline", loadStatusDoc("mixed", { offline: true })],
    ] as const) {
      assert.equal(doc.offline, true, label);
      assert.equal(doc.remote.source, "none", label);
      assert.equal(doc.remote.fetched_at, undefined, label);
      const state = (p: string): PageState | undefined => doc.pages.find((e) => e.path === p)?.state;
      assert.equal(state("wiki/concepts/rate-limits.md"), "modified", label);
      assert.equal(state("wiki/concepts/retry-policy.md"), "unchanged", label);
      assert.equal(state("wiki/entities/billing.md"), undefined, label);
      assert.equal(state("wiki/concepts/auth-flow.md"), "modified", label);
      assert.equal(state("wiki/concepts/legacy-sync.md"), "unverified", label);
      assert.ok(doc.pages.every((p) => p.remote === undefined), `${label}: no remote side without a listing or sidecar`);
      assert.ok(["unchecked", "not_authenticated"].includes(doc.auth.state), `${label}: offline auth.state ${doc.auth.state}`);
    }
  });

  it("every baseline StatusDoc: per-state tally equals counts and ahead/behind sums", () => {
    const docs = baselineStatusDocs();
    assert.ok(docs.length >= BASELINE_SCENARIOS.length - VERSION_ONLY.size - 1, `found ${docs.length} StatusDocs`);
    const failures: string[] = [];
    for (const { where, doc } of docs) {
      const t = tally(doc.pages);
      for (const s of PAGE_STATES) {
        if (t[s] !== doc.counts[s]) { failures.push(`${where}: ${s} tally ${t[s]} != counts ${doc.counts[s]}`); }
      }
      if (doc.counts.ahead !== doc.counts.modified + doc.counts.new) { failures.push(`${where}: ahead != modified + new`); }
      if (doc.counts.behind !== doc.counts.incoming + doc.counts.incoming_new) { failures.push(`${where}: behind != incoming + incoming_new`); }
      const paths = doc.pages.map((p) => p.path);
      const sorted = [...paths].sort((a, b) => (Buffer.from(a) < Buffer.from(b) ? -1 : a === b ? 0 : 1));
      if (JSON.stringify(paths) !== JSON.stringify(sorted)) { failures.push(`${where}: pages not sorted by path`); }
      if (new Set(paths).size !== paths.length) { failures.push(`${where}: duplicate page paths`); }
      for (const p of doc.pages) {
        const noLocal = p.state === "incoming_new" || p.state === "deleted_local";
        if (noLocal === (p.local !== undefined)) { failures.push(`${where}: ${p.path} (${p.state}) local presence`); }
        if (p.local && (p.state === "invalid") === (p.local.hash !== undefined)) { failures.push(`${where}: ${p.path} local.hash iff valid`); }
        if (p.base && p.base.stale === (p.base.hash !== undefined || p.base.synced_at !== undefined)) {
          failures.push(`${where}: ${p.path} base hash/synced_at iff not stale`);
        }
        if (p.state === "unverified" && p.base?.stale !== true) { failures.push(`${where}: ${p.path} unverified without a stale base`); }
        if ((p.state === "incoming" || p.state === "incoming_new") && !p.remote) { failures.push(`${where}: ${p.path} ${p.state} without remote`); }
        if (p.state === "incoming_new" && p.base) { failures.push(`${where}: ${p.path} incoming_new with a base`); }
      }
      const caps = doc.server.capabilities;
      if (caps.length > 0 ? JSON.stringify(caps) !== JSON.stringify(SERVER_CAPS_V1) : doc.server.capabilities_known) {
        failures.push(`${where}: server.capabilities ${JSON.stringify(caps)} (known=${String(doc.server.capabilities_known)})`);
      }
      if (doc.remote.source === "live" && doc.remote.page_count !== doc.pages.filter((p) => p.remote).length) {
        failures.push(`${where}: live page_count ${doc.remote.page_count} != pages with a remote side`);
      }
      if (doc.remote.source === "none" && doc.remote.fetched_at !== undefined) { failures.push(`${where}: fetched_at without a listing`); }
      if (doc.offline && doc.remote.source !== "none") { failures.push(`${where}: offline with remote.source ${doc.remote.source}`); }
      if (doc.captures.fresh > doc.captures.pending) { failures.push(`${where}: captures.fresh > pending`); }
    }
    assert.deepEqual(failures, []);
  });

  it("every non-version-only baseline scenario answers status --json and status --json --offline", () => {
    const failures: string[] = [];
    for (const name of BASELINE_SCENARIOS) {
      if (VERSION_ONLY.has(name)) { continue; }
      for (const offline of [false, true]) {
        const argv = ["status", "--json", ...(offline ? ["--offline"] : []), "--root", "/fixture-root"];
        const out = scenarioOutput(name, argv);
        if (!out) { failures.push(`${name}: no answer to ${argv.join(" ")}`); continue; }
        if (out.exit === 0) {
          let doc: unknown;
          try { doc = JSON.parse(out.stdout); } catch { failures.push(`${name}: ${argv.join(" ")} stdout is not JSON`); continue; }
          if ((doc as Json | null)?.schema !== "ctx.status.v1") { failures.push(`${name}: ${argv.join(" ")} is not a StatusDoc`); }
          if ((doc as Json | null)?.offline !== offline) { failures.push(`${name}: ${argv.join(" ")} has offline != ${String(offline)}`); }
        } else if (!lastNonEmptyLine(out.stderr).startsWith("{")) {
          failures.push(`${name}: ${argv.join(" ")} exit ${out.exit} without an envelope`);
        }
      }
    }
    assert.deepEqual(failures, []);
  });

  it(`no baseline fixture contains pages.etag or ${TOKEN_PREFIX}`, () => {
    const failures: string[] = [];
    let files = 0;
    for (const name of BASELINE_SCENARIOS) {
      const dir = scenarioDir(name);
      assert.ok(fs.existsSync(path.join(dir, "scenario.json")), `${name}/scenario.json exists`);
      for (const file of walk(dir)) {
        files++;
        const rel = path.relative(REPO_ROOT, file);
        if (path.basename(file) === "credentials.json") { failures.push(`${rel}: credentials.json`); }
        const text = fs.readFileSync(file, "utf8");
        if (text.includes("pages.etag")) { failures.push(`${rel}: pages.etag`); }
        if (text.includes(TOKEN_PREFIX)) { failures.push(`${rel}: ${TOKEN_PREFIX}`); }
      }
      // payload files may live outside the scenario dir ('..' is allowed)
      for (const p of scenarioPayloads(name)) {
        if (p.text.includes("pages.etag") || p.text.includes(TOKEN_PREFIX)) { failures.push(`${name} rule ${String(p.rule)} ${p.stream}: forbidden text`); }
      }
    }
    assert.ok(files >= BASELINE_SCENARIOS.length);
    assert.deepEqual(failures, []);
  });

  it("validate.mjs CLI: validates a doc, a stderr file (last line), fails on a bad doc, --manifest validates stdout/stderr entries and SKIPs raw/data/null/ctx.repair.v1", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "contexo validate-"));
    const run = (...args: string[]): { code: number | null; out: string } => {
      const r = spawnSync(process.execPath, [VALIDATE_MJS, ...args], { encoding: "utf8", cwd: tmp });
      return { code: r.status, out: `${r.stdout}${r.stderr}` };
    };
    const write = (name: string, text: string): string => {
      const file = path.join(tmp, name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
      return file;
    };
    try {
      const usage = run();
      assert.notEqual(usage.code, 0, "no args is a usage error");
      assert.match(usage.out, /Usage: node contract\/validate\.mjs/);

      const version = write("version.json", JSON.stringify(MIN_VERSION, null, 2) + "\n");
      const stderr = write("busy.stderr", `warning: noise\n${JSON.stringify(envelope("busy", 12, true))}\n\n`);
      const status = write("status ok.json", JSON.stringify(MIN_STATUS, null, 2) + "\n");
      const ok = run(version, stderr, status);
      assert.equal(ok.code, 0, ok.out);
      assert.ok(ok.out.includes(`OK ${version} ctx.version.v1`), ok.out);
      assert.ok(ok.out.includes(`OK ${stderr} ctx.error.v1`), ok.out);
      assert.ok(ok.out.includes(`OK ${status} ctx.status.v1`), ok.out);

      const bad = write("bad.json", JSON.stringify(patched(MIN_STATUS, ["pages", null])) + "\n");
      const badRun = run(version, bad);
      assert.equal(badRun.code, 1, badRun.out);
      assert.match(badRun.out, /FAIL .*bad\.json/);
      assert.equal(run(path.join(tmp, "missing.json")).code, 1, "missing file");
      assert.equal(run(write("unknown.json", '{"schema":"ctx.repair.v1"}\n')).code, 1, "explicit file with a schema outside the 6");
      assert.equal(run(write("garbage.txt", "not json\nstill not json\n")).code, 1, "no JSON at all");

      write("m/version.release.json", JSON.stringify(MIN_VERSION, null, 2) + "\n");
      write("m/error.busy.json", JSON.stringify(envelope("busy", 12, true)) + "\n");
      write("m/push.partial-conflict.stderr.json", `log line\n${JSON.stringify(envelope("conflict", 6, false, { details: { paths: ["a.md"] } }))}\n`);
      write("m/raw/retry-policy.base.md", "---\nschema: ctx.page.v1\n---\n# Retry\n");
      write("m/classify.cases.json", "[]\n");
      write("m/repair.json", '{"schema":"ctx.repair.v1"}\n');
      write("m/version.contract2.json", JSON.stringify(patched(MIN_VERSION, ["contract_version", 2])) + "\n");
      const entry = (file: string, schema: string | null, stream: string, exit: number | null): Json =>
        ({ file, schema, command: null, stream, exit_code: exit, sha256: "0".repeat(64) });
      const manifest = write("m/manifest.json", JSON.stringify({
        contract_version: 1,
        fixtures: [
          entry("version.release.json", "ctx.version.v1", "stdout", 0),
          entry("version.contract2.json", "ctx.version.v1", "stdout", 0),
          entry("error.busy.json", "ctx.error.v1", "stderr", 12),
          entry("push.partial-conflict.stderr.json", "ctx.error.v1", "stderr", 6),
          entry("raw/retry-policy.base.md", null, "raw", 0),
          entry("classify.cases.json", null, "data", null),
          entry("repair.json", "ctx.repair.v1", "stdout", 0),
          entry("nothing.json", null, "stdout", 0),
        ],
      }, null, 2));
      const m = run("--manifest", manifest);
      assert.equal(m.code, 0, m.out);
      assert.equal(m.out.match(/^OK /gm)?.length, 4, m.out);
      assert.equal(m.out.match(/^SKIP /gm)?.length, 4, m.out);
      assert.match(m.out, /^OK version\.release\.json ctx\.version\.v1$/m);
      assert.match(m.out, /^OK push\.partial-conflict\.stderr\.json ctx\.error\.v1$/m);
      assert.match(m.out, /^SKIP raw\/retry-policy\.base\.md /m);
      assert.match(m.out, /^SKIP repair\.json /m);

      const broken = write("m/manifest-broken.json", JSON.stringify({
        contract_version: 1,
        fixtures: [entry("version.release.json", "ctx.version.v1", "stdout", 0), entry("absent.json", "ctx.status.v1", "stdout", 0)],
      }));
      assert.equal(run("--manifest", broken).code, 1, "a manifest entry whose file is missing");
      const wrongExit = write("m/manifest-exit.json", JSON.stringify({
        contract_version: 1, fixtures: [entry("error.busy.json", "ctx.error.v1", "stderr", 7)],
      }));
      assert.equal(run("--manifest", wrongExit).code, 1, "envelope exit_code differs from the manifest exit_code");
      const wrongStream = write("m/manifest-stream.json", JSON.stringify({
        contract_version: 1, fixtures: [entry("push.partial-conflict.stderr.json", "ctx.error.v1", "stdout", 6)],
      }));
      assert.equal(run("--manifest", wrongStream).code, 1, "stdout entries are whole-file documents, never a last line");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
