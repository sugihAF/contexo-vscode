// Contract v1 between ctx and this extension: the TypeScript mirror of
// github.com/sugihAF/contexo/internal/syncops/contract.
//
// Source: wiki concepts/contexo-vscode-mvp-contract.md (ts_types) with the plan's
// Contract errata E1-E41 applied (E17 not_implemented, E18 repair, E23 dashboard_url,
// E29 scmCount, E30 listedInTree, E34 file location and parseEnvelope fallback).
// Human-readable copy: contract/ctx-json-v1.md. JSON Schemas: contract/schemas/.
//
// FROZEN after WP-0.I: additions only. Removing, renaming or retyping a field, or
// adding a PageState, is contract 2. This file imports nothing so plain mocha unit
// tests can load it without VS Code.

export const SUPPORTED_CONTRACT_VERSION = 1;

/** A ctx-side feature advertised by `ctx version --json` (contract order, E19). */
export type Capability =
  | "status.json" | "status.offline" | "show.base" | "show.server" | "show.sha"
  | "pull.json" | "push.json" | "push.paths" | "push.distill_guard" | "resolve" | "errors.envelope"
  | "repair";

/** contract.Capabilities: the 11 v1 capabilities in contract order (E19). */
export const CAPABILITIES: readonly Capability[] = [
  "status.json", "status.offline", "show.base", "show.server", "show.sha",
  "pull.json", "push.json", "push.paths", "push.distill_guard", "resolve", "errors.envelope",
];

/** The MVP refuses to run against a ctx that lacks any of these (E2(4), D11). */
export const REQUIRED_CAPABILITIES: readonly Capability[] = [
  "status.json", "status.offline", "show.base", "show.server",
  "pull.json", "push.json", "push.paths", "push.distill_guard", "resolve", "errors.envelope",
];

/**
 * Capabilities the extension uses when present and hides when absent (contract
 * compatibility §1d + E18). Not the same list as Go's contract.OptionalCapabilities
 * (which holds only "repair", the capabilities outside contract.Capabilities).
 */
export const OPTIONAL_CAPABILITIES: readonly Capability[] = ["show.sha", "repair"];

/** Server feature from X-Contexo-Capabilities. "pages.etag" is RESERVED: v1 never advertises it (E13). */
export type ServerCapability = "pages.at" | "pages.etag" | "push.expect_absent" | "write.path_sha";

/** RFC 3339, UTC, whole seconds: "2026-11-03T09:14:07Z" (E16). */
export type Rfc3339 = string;
/** '/'-separated path relative to <root>/.contexo/. */
export type RelPath = string;

export interface VersionDoc {
  schema: "ctx.version.v1";
  contract_version: number;
  version: string; // "0.7.0", "0.7.0-rc.1" or "dev"
  commit: string;
  date: string;
  dev_build: boolean;
  os: string;
  arch: string;
  capabilities: string[]; // string[], not Capability[]: unknown future capabilities are allowed
}

/** "remote_stale" is RESERVED: v1 ctx never emits it (E8). */
export type WarningCode =
  | "server_url_mismatch" | "server_outdated" | "remote_stale"
  | "base_repair_skipped" | "case_collision" | "reindex_failed" | "state_unreadable";

export interface Warning { code: WarningCode | string; message: string; paths: RelPath[]; }

/** CLOSED v1 enum (D12). Adding a value is contract 2. */
export type PageState =
  | "unchanged" | "modified" | "new" | "incoming" | "incoming_new"
  | "conflict" | "deleted_local" | "invalid" | "unverified";

export const PAGE_STATES: readonly PageState[] = [
  "unchanged", "modified", "new", "incoming", "incoming_new",
  "conflict", "deleted_local", "invalid", "unverified",
];

export type ConflictKind = "both_modified" | "both_added";
export type InvalidStage = "parse" | "validate" | "path_mismatch";
export type NoteCode = "missing_on_server" | "remote_changed" | "case_collision";
export type UrlSource = "credentials" | "config" | "default";
export type AuthState = "authenticated" | "unchecked" | "not_authenticated" | "rejected";
/** "cache" is RESERVED: v1 ctx has no remote cache and never emits it (E8). */
export type RemoteSource = "live" | "cache" | "none";

export interface StatusDoc {
  schema: "ctx.status.v1";
  generated_at: Rfc3339;
  offline: boolean;
  root: string; // absolute, native separators (informational)
  contexo_dir: string; // absolute, native separators (informational)
  project: ProjectInfo;
  server: ServerInfo;
  auth: AuthInfo;
  remote: RemoteInfo;
  counts: StateCounts;
  pages: PageEntry[]; // sorted by path
  captures: CaptureInfo;
  warnings: Warning[];
}

export interface ProjectInfo {
  repo_id?: string;
  config_server_url?: string;
  /**
   * Always present; "" when the server is self-hosted and no dashboard URL is
   * configured (E23). Then dashboard_page_url_template is absent and the
   * extension disables Open in Dashboard.
   */
  dashboard_url: string;
  dashboard_page_url_template?: string; // replace "{path}" with a RelPath
  last_pull_sha?: string;
}

export interface ServerInfo {
  url?: string;
  url_source?: UrlSource;
  version?: string;
  capabilities_known: boolean;
  capabilities: (ServerCapability | string)[];
}

export interface AuthInfo {
  state: AuthState;
  credentials_source?: "project" | "global";
  token_kind?: "pat" | "session" | "legacy" | "invite_key";
  user_name?: string;
  user_email?: string;
}

export interface RemoteInfo {
  source: RemoteSource;
  fetched_at?: Rfc3339;
  repo_exists?: boolean;
  head?: string;
  page_count: number;
  /** Why the remote could not be used (E22: not_authenticated > server_unresolved > repo_not_configured, or the HTTP/network failure); status itself still exited 0. */
  error?: ErrorBody;
}

export interface StateCounts {
  unchanged: number; modified: number; new: number; incoming: number; incoming_new: number;
  conflict: number; deleted_local: number; invalid: number; unverified: number;
  ahead: number; // modified + new
  behind: number; // incoming + incoming_new
}

export interface PageEntry {
  path: RelPath;
  state: PageState;
  conflict_kind?: ConflictKind; // only when state == conflict
  type?: "concept" | "entity" | "analysis" | "source" | string;
  slug?: string;
  title?: string;
  tags: string[];
  author?: string;
  agent?: string;
  updated?: Rfc3339;
  reasoning_summary?: string;
  local?: LocalSide; // present iff the working file exists
  base?: BaseSide;
  remote?: RemoteSide; // from a sidecar offline (E9): {sha} only
  invalid?: InvalidInfo; // only when state == invalid
  notes: (NoteCode | string)[];
}

export interface LocalSide { file: RelPath; hash?: string; }
export interface BaseSide { sha: string; hash?: string; synced_at?: Rfc3339; stale: boolean; }
export interface RemoteSide { sha: string; author?: string; email?: string; time?: Rfc3339; message?: string; }
export interface InvalidInfo { stage: InvalidStage; message: string; expected_path?: RelPath; }

export interface CaptureInfo {
  pending: number;
  fresh: number;
  /** captures.blocks_push = GuardResult.Required && !Bypassed for the modified ∪ new batch (E24). */
  blocks_push: boolean;
  sessions: CaptureSession[];
}
export interface CaptureSession { session_id: string; turns: number; updated_at: Rfc3339; fresh: boolean; }

export type SkipReason =
  | "unchanged" | "incoming" | "conflict" | "invalid" | "deleted_local" | "unverified"
  | "modified" | "changed_during_pull" | "case_collision" | "not_found";
export interface SkippedPage { path: RelPath; state?: PageState; reason: SkipReason | string; server_sha?: string; }
export type WriteKind = "create" | "update";

export interface DistillCheck {
  required: boolean;
  /** true when --no-distill was passed or CONTEXO_DISTILL_DISABLE=1 was set (E24); the extension never causes it. */
  bypassed: boolean;
}

export interface PushDoc {
  schema: "ctx.push.v1";
  dry_run: boolean;
  message: string;
  server_url: string;
  repo_id: string;
  new_head?: string;
  pushed: PushedPage[];
  conflicts: PushConflict[];
  skipped: SkippedPage[];
  distill: DistillCheck;
  warnings: Warning[];
}
export interface PushedPage { path: RelPath; kind: WriteKind; sha?: string; }
export interface PushConflict { path: RelPath; kind: ConflictKind; base_sha?: string; server_sha: string; }

export interface PullDoc {
  schema: "ctx.pull.v1";
  server_url: string;
  repo_id: string;
  head?: string;
  written: PulledPage[];
  adopted: PulledPage[];
  skipped: SkippedPage[];
  reindexed: boolean;
  warnings: Warning[];
}
export interface PulledPage { path: RelPath; sha: string; kind?: WriteKind; }

export type ResolveStrategy = "ours" | "theirs";
export interface ResolveDoc {
  schema: "ctx.resolve.v1";
  path: RelPath;
  strategy: ResolveStrategy;
  previous_state: PageState;
  state: PageState;
  base_sha: string;
  file_written: boolean;
  backup_file?: RelPath;
  warnings: Warning[];
}

/** The 24 stable error codes (E17). Unknown future codes are handled by exit category. */
export type ErrorCode =
  | "internal" | "usage" | "invalid_path"
  | "not_authenticated" | "auth_rejected" | "forbidden"
  | "not_initialized" | "repo_not_configured" | "server_unresolved"
  | "conflict" | "stale"
  | "network" | "server_error" | "rate_limited"
  | "repo_not_found" | "page_not_found" | "base_unavailable" | "sha_not_found"
  | "distill_required" | "not_resolvable"
  | "server_unsupported" | "not_implemented" | "quota_exceeded" | "busy";

export const ERROR_CODES: readonly ErrorCode[] = [
  "internal", "usage", "invalid_path",
  "not_authenticated", "auth_rejected", "forbidden",
  "not_initialized", "repo_not_configured", "server_unresolved",
  "conflict", "stale",
  "network", "server_error", "rate_limited",
  "repo_not_found", "page_not_found", "base_unavailable", "sha_not_found",
  "distill_required", "not_resolvable",
  "server_unsupported", "not_implemented", "quota_exceeded", "busy",
];

/** Exit table (Global Constraints 'Exit codes'). 2 is only a Go panic and maps to internal. */
export const EXIT = {
  ok: 0, internal: 1, /* 2 = Go panic */ usage: 3, auth: 4, config: 5, conflict: 6,
  network: 7, notFound: 8, refused: 9, unsupported: 10, quota: 11, busy: 12,
} as const;

export interface ErrorEnvelope { schema: "ctx.error.v1"; exit_code: number; error: ErrorBody; }

export interface DistillRequiredDetails {
  pages: RelPath[];
  sessions: CaptureSession[];
  agent_prompt: string;
}
export interface ConflictDetails { paths: RelPath[]; }
export interface StaleDetails { path: RelPath; expected_sha: string; server_sha: string; }
export interface NotResolvableDetails { path: RelPath; state: PageState; strategy: ResolveStrategy; }
export interface ServerUnsupportedDetails { missing: (ServerCapability | string)[]; }
export interface BusyDetails { pid: number; host: string; command: string; started_at: Rfc3339; }
export interface QuotaDetails { quota_code: string; limit: number; upgrade_url?: string; }

interface ErrorBodyBase<C extends string, D> {
  code: C; message: string; advice: string[]; retryable: boolean; http_status?: number; details?: D;
}
export type ErrorBody =
  | ErrorBodyBase<"distill_required", DistillRequiredDetails>
  | ErrorBodyBase<"conflict", ConflictDetails>
  | ErrorBodyBase<"stale", StaleDetails>
  | ErrorBodyBase<"not_resolvable", NotResolvableDetails>
  | ErrorBodyBase<"server_unsupported", ServerUnsupportedDetails>
  | ErrorBodyBase<"busy", BusyDetails>
  | ErrorBodyBase<"quota_exceeded", QuotaDetails>
  | ErrorBodyBase<Exclude<ErrorCode, "distill_required" | "conflict" | "stale" | "not_resolvable"
      | "server_unsupported" | "busy" | "quota_exceeded">, undefined>;

export type ScmGroup = "conflicts" | "changes" | "new" | "incoming" | "invalid";

/** Presentation only (== Go contract.SCMGroup). The extension never derives a state; it only maps one. */
export function groupFor(state: PageState): ScmGroup | undefined {
  switch (state) {
    case "conflict": return "conflicts";
    case "modified": case "deleted_local": return "changes";
    case "new": return "new";
    case "incoming": case "incoming_new": return "incoming";
    case "invalid": return "invalid";
    default: return undefined; // unchanged, unverified
  }
}

/**
 * SourceControl.count (E29): conflict + modified + new, plus incoming + incoming_new
 * only when contexo.scm.countIncoming is true. deleted_local, invalid and unverified
 * are never counted.
 */
export function scmCount(c: StateCounts, countIncoming: boolean): number {
  return c.conflict + c.modified + c.new + (countIncoming ? c.incoming + c.incoming_new : 0);
}

/**
 * Knowledge-tree membership (E30): every entry whose working file exists. Invalid
 * entries go under the 'Invalid' node; incoming_new and deleted_local have no
 * working file and are not listed.
 */
export function listedInTree(e: PageEntry): boolean {
  return e.local !== undefined;
}

/** Fallback code from the exit code when stderr is not a parseable envelope (old ctx, panic). Exit 2 -> internal. */
export function fallbackCode(exit: number): ErrorCode {
  switch (exit) {
    case 3: return "usage"; case 4: return "not_authenticated"; case 5: return "not_initialized";
    case 6: return "conflict"; case 7: return "network"; case 8: return "page_not_found";
    case 9: return "not_resolvable"; case 10: return "server_unsupported"; case 11: return "quota_exceeded";
    case 12: return "busy"; default: return "internal";
  }
}

/**
 * A `ctx show --at` ref. "empty" is client-side only (the empty left side of a diff
 * for a new page) and is never passed to `ctx show`. Any other string is a commit sha.
 */
export type ShowRef = "base" | "server" | "empty" | (string & {});

export const SCHEMAS = ["ctx.version.v1", "ctx.status.v1", "ctx.push.v1", "ctx.pull.v1", "ctx.resolve.v1", "ctx.error.v1"] as const;
export type SchemaId = (typeof SCHEMAS)[number];
export type Doc = VersionDoc | StatusDoc | PushDoc | PullDoc | ResolveDoc | ErrorEnvelope;

/** Parses one stdout document (or an envelope line). Unknown fields are ignored (forward-compatible). */
export function parseDoc<T extends Doc>(text: string, schema: T["schema"]): T {
  if (!(SCHEMAS as readonly string[]).includes(schema)) { throw new Error(`unknown schema ${schema}`); }
  const v = JSON.parse(text) as { schema?: unknown } | null;
  if (typeof v !== "object" || v === null || v.schema !== schema) {
    throw new Error(`ctx: expected ${schema}, got ${String(v === null || typeof v !== "object" ? v : v.schema)}`);
  }
  return v as T;
}

/**
 * stderr contract: the LAST non-empty line is the envelope. When it does not parse, or
 * lacks an error body with string code and message (old ctx, panic trace, exit 2,
 * truncated output), synthesize code = fallbackCode(exit) with the raw stderr as the
 * message; retryable = exit 7 || exit 12, matching Go's Retryable (E34). A valid body
 * keeps its code (authoritative over the exit code); a missing exit_code is filled from
 * the process exit, a missing advice array becomes [] and a missing retryable is derived
 * from the exit code.
 */
export function parseEnvelope(stderr: string, exitCode: number): ErrorEnvelope {
  const last = stderr.split(/\r?\n/).filter((l) => l.trim() !== "").pop() ?? "";
  try {
    const env = parseDoc<ErrorEnvelope>(last, "ctx.error.v1");
    const body = env.error as Partial<ErrorBody> | null | undefined;
    if (typeof body !== "object" || body === null || typeof body.code !== "string" || typeof body.message !== "string") {
      throw new Error("malformed ctx.error.v1 envelope");
    }
    if (typeof env.exit_code !== "number") { (env as { exit_code: number }).exit_code = exitCode; }
    if (!Array.isArray(body.advice)) { (body as { advice: string[] }).advice = []; }
    if (typeof body.retryable !== "boolean") { (body as { retryable: boolean }).retryable = exitCode === 7 || exitCode === 12; }
    return env;
  } catch {
    const code = fallbackCode(exitCode);
    return {
      schema: "ctx.error.v1", exit_code: exitCode,
      error: { code, message: stderr.trim() || `ctx exited ${exitCode}`, advice: [], retryable: exitCode === 7 || exitCode === 12 } as ErrorBody,
    };
  }
}
