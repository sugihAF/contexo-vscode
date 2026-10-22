// ctx binary discovery (E35) + handshake (E36). A vscode-free core: fs, env, platform,
// homedir, the contexo.path value, the probe and the log are injected; ctxCli.ts adapts them.
//
// SEAM (pinned by the WP-1.7 lead before the lanes split; bodies are lane A's).
//
// Candidate order (first hit wins):
//   1. contexo.path: absolute only (POSIX '/...'; win32 'X:\...' or '\\server\...'); a
//      relative value is ignored with a warning; a missing / non-file / (POSIX) non-executable
//      path is skipped with a warning.
//   2. PATH: POSIX <dir>/ctx; win32 <dir>\ctx<ext> for every PATHEXT entry (default
//      .COM;.EXE;.BAT;.CMD); never `which`/`where`. Empty, relative and quoted-empty entries
//      are skipped (never resolve against the cwd); env keys PATH/PATHEXT are matched
//      case-insensitively on win32.
//   3. ~/.local/bin/ctx (POSIX; scripts/install.sh:14)
//   4. %LOCALAPPDATA%\Programs\contexo\ctx.exe (win32, when LOCALAPPDATA is set; scripts/install.ps1:14)
//   5. ~/go/bin/ctx (POSIX) or ~\go\bin\ctx.exe (win32)
//   6. /opt/homebrew/bin/ctx, then /usr/local/bin/ctx (POSIX)
// Duplicates are dropped (case-insensitively on win32). Candidates ending in .cmd, .bat or
// .ps1 (any case) are rejected with a warning containing REJECTED_EXT_MESSAGE and skipped.
//
// Each existing candidate is probed with `version --json`; when that is not a handshake,
// with `version --short` (classifyProbe). foreign -> skip to the next candidate. A ctx that
// answers (ok, tooOld, extensionTooOld) STOPS discovery, so an old ctx first on PATH never
// falls through to a newer one. A probe that rejects (spawn_failed, timeout) skips the
// candidate with a warning and is never cached. Handshakes are cached in d.cache by
// candidateKey(path, stat); only probe results (doc/future/old/foreign) are cached.
//
// Test mode: when d.testMode and env CONTEXO_TEST_CTX is set (non-empty), it is the JSON
// TestCtxSpec {command, prefixArgs[, env]}: the only candidate, invocation
// {command, prefixArgs, env}, probed without the cache, the state's path = command; nothing
// else is tried. An unparseable or malformed value -> {kind:'missing'} with a warning (fail
// closed: a test never falls back to a real ctx). Outside Test mode the variable is ignored.
//
// Logging: each warning through log.warn; exactly one log.info line per discover() call,
// describeBinary(state) (capabilities.ts).
//
// Lane A rulings on what the header leaves open:
// - A .cmd/.bat/.ps1 contexo.path is rejected before any stat; a PATH x PATHEXT hit only once
//   it exists as a file (an absent ctx.BAT in every PATH dir is never reported).
// - Only contexo.path warns about being absent, a directory or not executable; the other
//   locations are a silent scan. A foreign binary is skipped with a warning.
// - Either probe rejecting (`version --short` included) counts as "a probe that rejects".
// - PATHEXT extensions keep the case PATHEXT gives them (ctx.EXE); the fixed win32 locations
//   use ctx.exe. Quotes around a win32 PATH entry are stripped; POSIX entries are used verbatim.
import * as fs from "node:fs";
import * as nodePath from "node:path";
import { classifyProbe, describeBinary, gate, isHandshake, type Handshake } from "./capabilities";
import type { CliLogger, CtxInvocation, ProcessResult } from "./spawn";
import { TEST_CTX_ENV, type BinaryState, type TestCtxSpec } from "./types";

/** The part of a stat result discovery uses (undefined from DiscoveryFs.stat when absent or unreadable). */
export interface StatInfo { isFile: boolean; mtimeMs: number; size: number; mode: number; }

export interface DiscoveryFs {
  stat(p: string): Promise<StatInfo | undefined>;
}

/** fs.promises.stat (follows symlinks). */
export const nodeDiscoveryFs: DiscoveryFs = {
  stat: async (p) => {
    try {
      const st = await fs.promises.stat(p);
      return { isFile: st.isFile(), mtimeMs: st.mtimeMs, size: st.size, mode: st.mode };
    } catch {
      return undefined;
    }
  },
};

/** Run a candidate with ctx args (a version-class run). Rejects (CtxError) when it cannot start or times out. */
export type Probe = (inv: CtxInvocation, args: readonly string[]) => Promise<ProcessResult>;

export type CandidateSource = "contexo.path" | "PATH" | "~/.local/bin" | "LOCALAPPDATA" | "~/go/bin" | "/opt/homebrew/bin" | "/usr/local/bin";

export interface Candidate { path: string; source: CandidateSource; }

export interface CandidateOptions {
  platform: NodeJS.Platform;
  env: Readonly<Record<string, string | undefined>>;
  homedir: string;
  /** ContexoConfig.path: trimmed, undefined when empty. */
  configPath: string | undefined;
}

export interface DiscoveryDeps extends CandidateOptions {
  /** context.extensionMode === ExtensionMode.Test. */
  testMode: boolean;
  fs: DiscoveryFs;
  probe: Probe;
  log: CliLogger;
  /** Handshakes by candidateKey; owned by the caller and shared across discover() calls. */
  cache: Map<string, Handshake>;
}

export interface DiscoveryResult {
  state: BinaryState;
  /** How to run the chosen binary; present iff state.kind !== 'missing'. */
  invocation?: CtxInvocation;
  /** Every warning raised (already logged). */
  warnings: string[];
  /** The candidate paths considered, in order (the Test-mode command alone in Test mode). */
  tried: string[];
}

/** The rejection message for .cmd/.bat/.ps1 candidates (E35). */
export const REJECTED_EXT_MESSAGE = "point contexo.path at ctx.exe";

/** The probe argv (E25): the handshake, then the old-ctx fallback. */
const VERSION_JSON_ARGS: readonly string[] = ["version", "--json"];
const VERSION_SHORT_ARGS: readonly string[] = ["version", "--short"];
/** Node cannot spawn these with shell:false (CVE-2024-27980), and shell:true is banned (E26). */
const REJECTED_EXTS: ReadonlySet<string> = new Set([".cmd", ".bat", ".ps1"]);
const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";

/** The E35 candidate list (pure; no fs access). `warnings` holds the relative-contexo.path warning. */
export function candidates(o: CandidateOptions): { list: Candidate[]; warnings: string[] } {
  const win = o.platform === "win32";
  const p = win ? nodePath.win32 : nodePath.posix;
  const list: Candidate[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  const add = (path: string, source: CandidateSource): void => {
    const key = win ? p.normalize(path).toLowerCase() : p.normalize(path);
    if (seen.has(key)) { return; }
    seen.add(key);
    list.push({ path, source });
  };

  // 1. contexo.path
  const configured = o.configPath?.trim();
  if (configured !== undefined && configured !== "") {
    if (isAbsoluteFor(o.platform, configured)) {
      add(configured, "contexo.path");
    } else {
      warnings.push(`contexo.path "${configured}" is not an absolute path; ignoring it (use the full path to the ctx binary${win ? ", ctx.exe" : ""})`);
    }
  }

  // 2. PATH (x PATHEXT on win32)
  const exts = win
    ? (envValue(o.env, "PATHEXT", o.platform) ?? DEFAULT_PATHEXT).split(";").map((e) => e.trim()).filter((e) => e !== "")
    : [""];
  for (const raw of (envValue(o.env, "PATH", o.platform) ?? "").split(win ? ";" : ":")) {
    const dir = win ? unquote(raw.trim()) : raw;
    if (dir === "" || !isAbsoluteFor(o.platform, dir)) { continue; }
    for (const ext of exts) { add(p.join(dir, `ctx${ext}`), "PATH"); }
  }

  // 3-6. the install locations
  const home = isAbsoluteFor(o.platform, o.homedir) ? o.homedir : undefined;
  if (!win && home !== undefined) { add(p.join(home, ".local", "bin", "ctx"), "~/.local/bin"); }
  const localAppData = win ? envValue(o.env, "LOCALAPPDATA", o.platform) : undefined;
  if (localAppData !== undefined && isAbsoluteFor(o.platform, localAppData.trim())) {
    add(p.join(localAppData.trim(), "Programs", "contexo", "ctx.exe"), "LOCALAPPDATA");
  }
  if (home !== undefined) { add(p.join(home, "go", "bin", win ? "ctx.exe" : "ctx"), "~/go/bin"); }
  if (!win) {
    add("/opt/homebrew/bin/ctx", "/opt/homebrew/bin");
    add("/usr/local/bin/ctx", "/usr/local/bin");
  }
  return { list, warnings };
}

/** Cache key: path + mtime + size. */
export function candidateKey(path: string, st: StatInfo): string {
  return `${path}\u0000${st.mtimeMs}\u0000${st.size}`;
}

/** CONTEXO_TEST_CTX -> TestCtxSpec, or an Error naming what is wrong. */
export function parseTestCtxSpec(raw: string): TestCtxSpec | Error {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch (err) {
    return new Error(`${TEST_CTX_ENV} is not JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!isPlainObject(v)) { return new Error(`${TEST_CTX_ENV} must be a JSON object {command, prefixArgs[, env]}`); }
  const { command, prefixArgs, env } = v;
  if (typeof command !== "string" || command === "") { return new Error(`${TEST_CTX_ENV}.command must be a non-empty string`); }
  if (!Array.isArray(prefixArgs) || !prefixArgs.every((a) => typeof a === "string")) {
    return new Error(`${TEST_CTX_ENV}.prefixArgs must be an array of strings`);
  }
  const spec: TestCtxSpec = { command, prefixArgs: [...(prefixArgs as string[])] };
  if (env !== undefined) {
    if (!isPlainObject(env) || !Object.values(env).every((x) => typeof x === "string")) {
      return new Error(`${TEST_CTX_ENV}.env must be an object of strings`);
    }
    spec.env = { ...(env as Record<string, string>) };
  }
  return spec;
}

export async function discover(d: DiscoveryDeps): Promise<DiscoveryResult> {
  const warnings: string[] = [];
  const warn = (m: string): void => {
    warnings.push(m);
    d.log.warn(m);
  };
  const tried: string[] = [];
  const raw = d.testMode ? envValue(d.env, TEST_CTX_ENV, d.platform) : undefined;
  const found = raw !== undefined && raw !== ""
    ? await discoverTestCtx(d, raw, tried, warn)
    : await discoverBinary(d, tried, warn);
  const result: DiscoveryResult = found === undefined
    ? { state: { kind: "missing" }, warnings, tried }
    : { state: found.state, invocation: found.invocation, warnings, tried };
  d.log.info(describeBinary(result.state));
  return result;
}

type Found = { state: BinaryState; invocation: CtxInvocation } | undefined;

/** Test mode: the spec is the only candidate, probed without the cache; anything wrong -> missing. */
async function discoverTestCtx(d: DiscoveryDeps, raw: string, tried: string[], warn: (m: string) => void): Promise<Found> {
  const spec = parseTestCtxSpec(raw);
  if (spec instanceof Error) {
    warn(`${spec.message}; no ctx is used (Test mode never falls back to a real ctx)`);
    return undefined;
  }
  tried.push(spec.command);
  const invocation: CtxInvocation = spec.env === undefined
    ? { command: spec.command, prefixArgs: spec.prefixArgs }
    : { command: spec.command, prefixArgs: spec.prefixArgs, env: spec.env };
  const h = await probeHandshake(d.probe, invocation, `${TEST_CTX_ENV} command ${spec.command}`, warn);
  if (h === undefined) { return undefined; }
  return answered(spec.command, h, invocation, warn);
}

/** The E35 scan: the first candidate that answers like ctx (ok, tooOld, extensionTooOld) wins. */
async function discoverBinary(d: DiscoveryDeps, tried: string[], warn: (m: string) => void): Promise<Found> {
  const { list, warnings } = candidates(d);
  for (const w of warnings) { warn(w); }
  const p = d.platform === "win32" ? nodePath.win32 : nodePath.posix;
  for (const c of list) {
    tried.push(c.path);
    const where = `${c.path} (${c.source})`;
    const configured = c.source === "contexo.path";
    const rejected = REJECTED_EXTS.has(p.extname(c.path).toLowerCase());
    if (configured && rejected) { warn(rejectedMessage(where)); continue; }
    const st = await d.fs.stat(c.path);
    if (st === undefined || !st.isFile) {
      if (configured) { warn(`contexo.path ${c.path} ${st === undefined ? "does not exist" : "is not a file"}; skipping it`); }
      continue;
    }
    if (rejected) { warn(rejectedMessage(where)); continue; }
    if (d.platform !== "win32" && (st.mode & 0o111) === 0) {
      if (configured) { warn(`contexo.path ${c.path} is not executable; skipping it`); }
      continue;
    }
    const invocation: CtxInvocation = { command: c.path, prefixArgs: [] };
    const key = candidateKey(c.path, st);
    let h = d.cache.get(key);
    if (h === undefined) {
      h = await probeHandshake(d.probe, invocation, where, warn);
      if (h === undefined) { continue; }
      d.cache.set(key, h);
    }
    const found = answered(c.path, h, invocation, warn);
    if (found !== undefined) { return found; }
  }
  return undefined;
}

/** `version --json`, then `version --short` when that is no handshake; undefined (warned) when a probe rejects. */
async function probeHandshake(probe: Probe, inv: CtxInvocation, where: string, warn: (m: string) => void): Promise<Handshake | undefined> {
  let args = VERSION_JSON_ARGS;
  try {
    const json = await probe(inv, args);
    if (isHandshake(json)) { return classifyProbe(json); }
    args = VERSION_SHORT_ARGS;
    const short = await probe(inv, args);
    return classifyProbe(json, short);
  } catch (err) {
    warn(`skipping ${where}: \`ctx ${args.join(" ")}\` failed (${errorText(err)})`);
    return undefined;
  }
}

/** The state for a probed candidate, or undefined (warned) when it is not ctx. */
function answered(path: string, h: Handshake, invocation: CtxInvocation, warn: (m: string) => void): Found {
  const state = gate(path, h);
  if (state.kind === "missing") {
    warn(`skipping ${path}: not ctx (${h.kind === "foreign" ? h.reason : h.kind})`);
    return undefined;
  }
  return { state, invocation };
}

function rejectedMessage(where: string): string {
  return `skipping ${where}: .cmd, .bat and .ps1 files cannot be run without a shell; ${REJECTED_EXT_MESSAGE}`;
}

/** POSIX '/...'; win32 'X:\...' / 'X:/...' or a UNC '\\server\...' (never drive- or root-relative). */
function isAbsoluteFor(platform: NodeJS.Platform, p: string): boolean {
  if (platform === "win32") { return /^[A-Za-z]:[\\/]/.test(p) || /^[\\/]{2}[^\\/]/.test(p); }
  return p.startsWith("/");
}

/** env[name]; on win32 the first key equal to it ignoring case (an exact match first). */
function envValue(env: Readonly<Record<string, string | undefined>>, name: string, platform: NodeJS.Platform): string | undefined {
  const exact = env[name];
  if (exact !== undefined || platform !== "win32") { return exact; }
  const upper = name.toUpperCase();
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined && k.toUpperCase() === upper) { return v; }
  }
  return undefined;
}

/** A win32 PATH entry without its surrounding double quotes ('"C:\Program Files\x"'). */
function unquote(s: string): string {
  return s.length >= 2 && s.startsWith("\"") && s.endsWith("\"") ? s.slice(1, -1).trim() : s;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function errorText(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    return typeof code === "string" ? `${code}: ${err.message}` : err.message;
  }
  return String(err);
}
