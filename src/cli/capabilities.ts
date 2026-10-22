// The handshake gate (E36, D11): `ctx version --json` (or the old-ctx `version --short`
// fallback) -> the frozen BinaryState. It decides on contract_version and capabilities, never
// semver, so 'dev' and '0.7.0-rc.1' pass. vscode-free.
//
// SEAM (pinned by the WP-1.7 lead before the lanes split; bodies are lane A's).
import {
  REQUIRED_CAPABILITIES, SUPPORTED_CONTRACT_VERSION, parseDoc, type Capability, type VersionDoc,
} from "../contract/types";
import type { ProcessResult } from "./spawn";
import type { BinaryState } from "./types";

/**
 * What a candidate binary answered, independent of its path (so discovery can cache it by
 * path + mtime + size):
 * - doc: `version --json` exited 0 with a ctx.version.v1 document (fields as printed; the gate
 *   treats a non-integer contract_version as < 1 and a non-array capabilities as []);
 * - future: exit 0 with a JSON object whose schema is ctx.version.vN, N > 1 (a later contract
 *   whose handshake document changed): contractVersion = max(N, an integer contract_version);
 * - old: `version --json` failed (typically 'unknown flag: --json', exit 1) and `version --short`
 *   exited 0 with one version line (parseShortVersion);
 * - foreign: neither (not ctx); discovery skips it and tries the next candidate.
 */
export type Handshake =
  | { kind: "doc"; doc: VersionDoc }
  | { kind: "future"; contractVersion: number }
  | { kind: "old"; versionText: string }
  | { kind: "foreign"; reason: string };

/** [v]MAJOR.MINOR.PATCH[-pre][+build] (semver 2.0 identifier syntax; only recognised, never compared). */
const SHORT_VERSION_RE = /^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)$/;
/** A later handshake document: ctx.version.vN. */
const FUTURE_SCHEMA_RE = /^ctx\.version\.v(\d+)$/;

/**
 * `version --short` output -> the version, or undefined when it is not one line of the form
 * [v]MAJOR.MINOR.PATCH[-pre][+build] or 'dev' (surrounding whitespace ignored; returned
 * without the leading 'v').
 */
export function parseShortVersion(stdout: string): string | undefined {
  const line = stdout.trim();
  if (line === "dev") { return line; }
  return SHORT_VERSION_RE.exec(line)?.[1];
}

/** True when `version --json` answered a handshake (doc or future): no `version --short` probe is needed. */
export function isHandshake(json: ProcessResult): boolean {
  return readHandshake(json) !== undefined;
}

/**
 * Classify the probe results: `json` is the `version --json` run; `short` the `version --short`
 * run, made only when isHandshake(json) is false (undefined when it was not made or failed to
 * start).
 */
export function classifyProbe(json: ProcessResult, short?: ProcessResult): Handshake {
  const h = readHandshake(json);
  if (h !== undefined) { return h; }
  if (short !== undefined && short.exitCode === 0) {
    const versionText = parseShortVersion(utf8(short.stdout));
    if (versionText !== undefined) { return { kind: "old", versionText }; }
  }
  const shortText = short === undefined ? "was not run" : `${exitText(short)}${short.exitCode === 0 ? " without a version line" : ""}`;
  return { kind: "foreign", reason: `version --json ${exitText(json)}${json.exitCode === 0 ? " without a ctx.version document" : ""}; version --short ${shortText}` };
}

/** The REQUIRED_CAPABILITIES entries absent from `caps`, in REQUIRED_CAPABILITIES order (a non-array counts as []). */
export function missingCapabilities(caps: unknown): string[] {
  const have = new Set<unknown>(Array.isArray(caps) ? caps : []);
  return REQUIRED_CAPABILITIES.filter((c) => !have.has(c));
}

/**
 * Handshake -> BinaryState (E36), checked in this order:
 * - foreign -> {kind:'missing'};
 * - future, or doc with contract_version > SUPPORTED_CONTRACT_VERSION -> {kind:'extensionTooOld', path, contractVersion};
 * - old -> {kind:'tooOld', path, versionText, missing: [...REQUIRED_CAPABILITIES]};
 * - doc with contract_version < 1 (or not an integer), or any REQUIRED capability missing ->
 *   {kind:'tooOld', path, versionText: doc.version (when a string), missing: missingCapabilities(...)};
 * - otherwise {kind:'ok', path, version: doc}.
 */
export function gate(path: string, h: Handshake): BinaryState {
  switch (h.kind) {
    case "foreign": return { kind: "missing" };
    case "future": return { kind: "extensionTooOld", path, contractVersion: h.contractVersion };
    case "old": return { kind: "tooOld", path, versionText: h.versionText, missing: [...REQUIRED_CAPABILITIES] };
    case "doc": break;
  }
  const doc = h.doc;
  const cv: unknown = doc.contract_version;
  const contract = Number.isInteger(cv) ? (cv as number) : 0;
  if (contract > SUPPORTED_CONTRACT_VERSION) { return { kind: "extensionTooOld", path, contractVersion: contract }; }
  const missing = missingCapabilities(doc.capabilities);
  if (contract < 1 || missing.length > 0) {
    const v: unknown = doc.version;
    return typeof v === "string" ? { kind: "tooOld", path, versionText: v, missing } : { kind: "tooOld", path, missing };
  }
  return { kind: "ok", path, version: doc };
}

/** True only for an ok binary that advertises `c` (the optional 'show.sha' and 'repair'; required ones too). */
export function hasCapability(state: BinaryState, c: Capability): boolean {
  return state.kind === "ok" && Array.isArray(state.version.capabilities) && state.version.capabilities.includes(c);
}

/**
 * The once-per-discovery info line: kind, path, version, contract_version and capabilities, e.g.
 *   ctx binary ok: /usr/local/bin/ctx version 0.7.0 contract 1 capabilities [status.json, ...]
 *   ctx binary tooOld: /usr/local/bin/ctx version 0.6.6 missing [status.json, ...]
 *   ctx binary extensionTooOld: /x/ctx contract 2
 *   ctx binary missing
 */
export function describeBinary(state: BinaryState): string {
  switch (state.kind) {
    case "ok": {
      const v = state.version;
      const caps: unknown[] = Array.isArray(v.capabilities) ? v.capabilities : [];
      return `ctx binary ok: ${state.path} version ${typeof v.version === "string" ? v.version : "unknown"}`
        + ` contract ${String(v.contract_version)} capabilities [${caps.filter((c) => typeof c === "string").join(", ")}]`;
    }
    case "tooOld": return `ctx binary tooOld: ${state.path} version ${state.versionText ?? "unknown"} missing [${state.missing.join(", ")}]`;
    case "extensionTooOld": return `ctx binary extensionTooOld: ${state.path} contract ${state.contractVersion}`;
    case "missing": return "ctx binary missing";
  }
}

/** The doc or future handshake a `version --json` run answered, or undefined (exit != 0, not JSON, another schema). */
function readHandshake(json: ProcessResult): Handshake | undefined {
  if (json.exitCode !== 0) { return undefined; }
  const text = utf8(json.stdout);
  try {
    return { kind: "doc", doc: parseDoc<VersionDoc>(text, "ctx.version.v1") };
  } catch {
    // not a v1 document: maybe a later contract's handshake
  }
  let v: unknown;
  try { v = JSON.parse(text); } catch { return undefined; }
  if (typeof v !== "object" || v === null || Array.isArray(v)) { return undefined; }
  const o = v as { schema?: unknown; contract_version?: unknown };
  const m = typeof o.schema === "string" ? FUTURE_SCHEMA_RE.exec(o.schema) : null;
  const n = m?.[1] === undefined ? NaN : Number(m[1]);
  if (!(n > 1)) { return undefined; }
  const cv = Number.isInteger(o.contract_version) ? (o.contract_version as number) : 0;
  return { kind: "future", contractVersion: Math.max(n, cv) };
}

function utf8(b: Buffer | string): string {
  return typeof b === "string" ? b : b.toString("utf8");
}

function exitText(r: ProcessResult): string {
  return r.exitCode === null ? `ended by ${r.signal ?? "a signal"}` : `exited ${r.exitCode}`;
}
