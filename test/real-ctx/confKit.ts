// Helpers for conformance.real.ts (WP-3.1): fresh per-case projects on the shared
// `${REAL_CTX_REPO}-conf` server repo, ajv validation against contract/schemas (plus the strict
// in-memory variant), the E2(1) exit table and small .sync readers. Plain node, no vscode.
//
// Setup commands (init, login, remote set-repo) spawn ctx directly: args array, shell false and
// an env without any CONTEXO_* variable, with HOME/USERPROFILE set to the case home. Every
// extension-shaped call in the suite goes through runCtx (ctx.ts) instead.
import { spawn } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import Ajv2020 from "ajv/dist/2020";
import type { ValidateFunction } from "ajv";
import { SCHEMAS, type ErrorCode, type SchemaId } from "../../src/contract/types";
import { REPO_ROOT } from "../helpers/fixtures";
import { realCtxEnv } from "./env";
import { pageText, relPathOf, type PageSpec } from "./pages";

type Json = Record<string, unknown>;

// ---------- the E2(1) exit table ----------

/** Errata E2(1): the exit code of every v1 error code. */
export const E2_EXIT: Readonly<Record<ErrorCode, number>> = {
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

/** Errata E2(1): the retryable codes (exit 7 and 12). */
export const E2_RETRYABLE: ReadonlySet<string> = new Set(["network", "server_error", "rate_limited", "busy"]);

// ---------- schemas ----------

const SCHEMA_DIR = path.join(REPO_ROOT, "contract", "schemas");
const SCHEMA_FILES: Record<SchemaId, string> = {
  "ctx.version.v1": "version.schema.json",
  "ctx.status.v1": "status.schema.json",
  "ctx.push.v1": "push.schema.json",
  "ctx.pull.v1": "pull.schema.json",
  "ctx.resolve.v1": "resolve.schema.json",
  "ctx.error.v1": "error.schema.json",
};

function loadSchema(id: SchemaId): Json {
  return JSON.parse(fs.readFileSync(path.join(SCHEMA_DIR, SCHEMA_FILES[id]), "utf8")) as Json;
}

/**
 * A deep copy of schema with additionalProperties:false added to every object schema that has
 * 'properties' and no additionalProperties of its own. Conditional branches (if/then/else/not)
 * are left alone: a closed `if` would stop matching and a closed `then` would reject the
 * sibling keys its parent declares. The $defs they reference are closed as usual.
 */
export function closeSchema(schema: unknown): unknown {
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) { return node.map(walk); }
    if (typeof node !== "object" || node === null) { return node; }
    const out: Json = {};
    for (const [k, v] of Object.entries(node as Json)) {
      out[k] = k === "if" || k === "then" || k === "else" || k === "not" || k === "const" || k === "enum" ? v : walk(v);
    }
    if (typeof out.properties === "object" && out.properties !== null && !("additionalProperties" in out)) {
      out.additionalProperties = false;
    }
    return out;
  };
  return walk(schema);
}

interface Validators { normal: Map<string, ValidateFunction>; strict: Map<string, ValidateFunction>; }
let compiled: Validators | undefined;

/** The 6 schemas, compiled like contract/validate.mjs (strictRequired off: it misreports `not: {required}`). */
function validators(): Validators {
  if (compiled) { return compiled; }
  const normal = new Map<string, ValidateFunction>();
  const strict = new Map<string, ValidateFunction>();
  const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
  const ajvStrict = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
  for (const id of SCHEMAS) {
    const s = loadSchema(id);
    normal.set(id, ajv.compile(s));
    strict.set(id, ajvStrict.compile(closeSchema(s) as Json));
  }
  compiled = { normal, strict };
  return compiled;
}

function errorsOf(v: ValidateFunction | undefined, id: string, doc: unknown): string[] {
  if (!v) { return [`no schema for ${id}`]; }
  return v(doc) ? [] : (v.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message ?? ""}${e.keyword === "additionalProperties" ? ` (${String((e.params as { additionalProperty?: string }).additionalProperty)})` : ""}`);
}

/** ajv errors of doc against contract/schemas/<id> (empty when valid). */
export function schemaErrors(id: SchemaId, doc: unknown): string[] {
  return errorsOf(validators().normal.get(id), id, doc);
}

/** Like schemaErrors, against the in-memory closed schema (unknown keys are reported). */
export function strictSchemaErrors(id: SchemaId, doc: unknown): string[] {
  return errorsOf(validators().strict.get(id), id, doc);
}

// ---------- E16 times ----------

/** E16: RFC 3339, UTC, whole seconds. */
export const E16_TIME = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/;
/** Keys that hold contract times. */
const TIME_KEYS = new Set(["generated_at", "fetched_at", "synced_at", "updated_at", "time", "updated", "detected_at", "started_at"]);

/** Every [json-pointer, value] whose key is a time key or whose value looks like a date-time. */
export function timeStrings(doc: unknown): [string, unknown][] {
  const out: [string, unknown][] = [];
  const walk = (v: unknown, ptr: string, key: string | undefined): void => {
    if (Array.isArray(v)) { v.forEach((x, i) => walk(x, `${ptr}/${i}`, undefined)); return; }
    if (typeof v === "object" && v !== null) {
      for (const [k, x] of Object.entries(v as Json)) { walk(x, `${ptr}/${k}`, k); }
      return;
    }
    if ((key !== undefined && TIME_KEYS.has(key)) || (typeof v === "string" && /^\d{4}-\d\d-\d\dT/.test(v))) {
      out.push([ptr, v]);
    }
  };
  walk(doc, "", undefined);
  return out;
}

// ---------- per-case projects ----------

export interface ConfUser {
  name: string;
  /** The project root (--root). */
  root: string;
  /** <root>/.contexo */
  hub: string;
  home: string;
}

export interface ConfCase {
  /** The effective case name: the requested one, or `<name>-r<k>` when it already ran in this run. */
  name: string;
  dir: string;
  /** `${REAL_CTX_REPO}-conf` */
  repo: string;
  a: ConfUser;
  b: ConfUser;
}

export interface Spawned { code: number; stdout: string; stderr: string; }

/** The setup env: process.env without any CONTEXO_* variable, then `extra`, HOME/USERPROFILE = home. */
function setupEnv(home: string, extra: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.toUpperCase().startsWith("CONTEXO_")) { env[k] = v; }
  }
  Object.assign(env, extra);
  env.HOME = home;
  env.USERPROFILE = home;
  return env;
}

/**
 * Runs CTX_BIN directly (setup and controls only, never an extension-shaped call): args array,
 * shell false, stdin ignored, cwd = cwd or home, env = setupEnv(home, extraEnv).
 */
export function setupCtx(home: string, args: readonly string[], cwd?: string, extraEnv: Readonly<Record<string, string>> = {}): Promise<Spawned> {
  return new Promise((resolve, reject) => {
    const child = spawn(realCtxEnv().ctxBin, [...args], { cwd: cwd ?? home, env: setupEnv(home, extraEnv), shell: false, stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (b: Buffer) => out.push(b));
    child.stderr.on("data", (b: Buffer) => err.push(b));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? -1, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") }));
  });
}

async function mustSetup(home: string, args: readonly string[]): Promise<void> {
  const r = await setupCtx(home, args);
  if (r.code !== 0) { throw new Error(`setup: ctx ${args.join(" ")} exited ${r.code}\n${r.stderr}${r.stdout}`); }
}

/**
 * A fresh case under $REAL_CTX_RUN/conf/<name>/: projects a and b with their own homes, each
 * initialised, logged in (to serverA / serverB, default CONTEXO_TEST_SERVER) and set to the
 * `${REAL_CTX_REPO}-conf` repo. When the suite runs again against the same `up`, the case
 * becomes <name>-r2, -r3, ... so its directories and page slugs stay fresh (slugOf(c.name, n)).
 */
export async function confCase(requested: string, o: { serverA?: string; serverB?: string } = {}): Promise<ConfCase> {
  const e = realCtxEnv();
  let name = requested;
  for (let k = 2; fs.existsSync(path.join(e.run, "conf", name)); k++) { name = `${requested}-r${k}`; }
  const dir = path.join(e.run, "conf", name);
  const repo = `${e.repo}-conf`;
  const user = async (u: "a" | "b", n: string, server: string): Promise<ConfUser> => {
    const root = path.join(dir, u);
    const home = path.join(dir, `home-${u}`);
    fs.mkdirSync(root, { recursive: true });
    fs.mkdirSync(home, { recursive: true });
    await mustSetup(home, ["init", "--no-mcp", "--no-hooks", "--no-gitignore", "--no-vscode", "--root", root]);
    await mustSetup(home, ["login", "--server", server, "--api-key", e.key, "--name", n, "--email", `${n}@example.test`, "--root", root]);
    await mustSetup(home, ["remote", "set-repo", repo, "--root", root]);
    return { name: n, root, hub: path.join(root, ".contexo"), home };
  };
  const a = await user("a", "alice", o.serverA ?? e.server);
  const b = await user("b", "bob", o.serverB ?? e.server);
  return { name, dir, repo, a, b };
}

/** Writes a valid page (pages.ts text) into the user's hub; returns its RelPath. */
export function writePage(u: ConfUser, spec: PageSpec): string {
  const rel = relPathOf(spec.type, spec.slug);
  writeRel(u, rel, pageText({ author: u.name, ...spec }));
  return rel;
}

/** Writes raw text at <hub>/<rel>. */
export function writeRel(u: ConfUser, rel: string, text: string | Buffer): void {
  const file = path.join(u.hub, ...rel.split("/"));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

/** The working file bytes of rel. */
export function readRel(u: ConfUser, rel: string): Buffer {
  return fs.readFileSync(path.join(u.hub, ...rel.split("/")));
}

/** <hub>/.sync/<...parts> (tests may read .sync; src never does). */
export function syncPath(u: ConfUser, ...parts: string[]): string {
  return path.join(u.hub, ".sync", ...parts.flatMap((p) => p.split("/")));
}

/** sha256 of every file under <hub>/.sync, keyed by '/'-separated relative path. */
export function syncTreeHashes(u: ConfUser): Record<string, string> {
  const root = path.join(u.hub, ".sync");
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) { walk(full); continue; }
      out[path.relative(root, full).split(path.sep).join("/")] = crypto.createHash("sha256").update(fs.readFileSync(full)).digest("hex");
    }
  };
  if (fs.existsSync(root)) { walk(root); }
  return out;
}

/**
 * The RelPaths of a case's pages share this slug prefix (all cases share one server repo).
 * No case name is a prefix of another followed by '-', so the prefixes never overlap.
 */
export function slugOf(caseName: string, n: number | string): string {
  return `conf-${caseName}-${n}`;
}

/** A page path belongs to the case when its file name starts with conf-<case>-. */
export function ownedBy(caseName: string): (p: { path: string }) => boolean {
  const prefix = `conf-${caseName}-`;
  return (p) => (p.path.split("/").pop() ?? "").startsWith(prefix);
}
