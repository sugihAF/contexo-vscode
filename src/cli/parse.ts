// ctx stdout documents and stderr envelopes -> typed results or CtxError (contract §3, E34).
// vscode-free (WP-3.1 loads it under plain node mocha).
//
// SEAM (pinned by the WP-1.7 lead before the lanes split; bodies are lane B's).
import * as os from "node:os";
import { parseDoc, parseEnvelope, type Doc, type PushDoc } from "../contract/types";
import type { ProcessResult } from "./spawn";
import { CtxError, type PushOutcome } from "./types";

/** The stdout schemas the extension decodes (the extension never parses ctx.repair.v1). */
export type StdoutSchema = "ctx.version.v1" | "ctx.status.v1" | "ctx.push.v1" | "ctx.pull.v1" | "ctx.resolve.v1";

/** Longest parseDoc mismatch text kept in a contract_mismatch message (it quotes stdout's schema value). */
const MISMATCH_DETAIL_MAX = 160;

/**
 * The exit status of a finished process: exitCode, or 128 + the signal number when it ended
 * by a signal (SIGINT 130, SIGKILL 137, SIGTERM 143); -1 when neither is known.
 */
export function exitStatus(exitCode: number | null, signal: NodeJS.Signals | null): number {
  if (exitCode !== null) { return exitCode; }
  if (signal === null) { return -1; }
  const n = (os.constants.signals as Readonly<Record<string, number | undefined>>)[signal];
  return n === undefined ? -1 : 128 + n;
}

/**
 * Decode one stdout document of `schema` (UTF-8) through the frozen parseDoc. Non-JSON, a
 * non-object or another schema (e.g. ctx.status.v2) -> CtxError.extension('contract_mismatch',
 * ...) carrying exitCode/stderr when given. Unknown fields are ignored.
 */
export function decodeStdout<T extends Doc>(stdout: Buffer | string, schema: T["schema"], o: { exitCode?: number; stderr?: string } = {}): T {
  const text = typeof stdout === "string" ? stdout : stdout.toString("utf8");
  try {
    return parseDoc<T>(text, schema);
  } catch (err) {
    // A SyntaxError's message quotes stdout (page titles, paths): never copy it into the error.
    const detail = err instanceof SyntaxError
      ? "stdout is not JSON"
      : (err instanceof Error ? err.message : String(err)).slice(0, MISMATCH_DETAIL_MAX);
    throw CtxError.extension("contract_mismatch", `ctx printed no ${schema} document (${detail})`, { exitCode: o.exitCode, stderr: o.stderr });
  }
}

/**
 * The CtxError for a process that did not succeed:
 * - killedBy set (we killed it; any status, including exit 130/143) -> CtxError.extension
 *   ('timeout' | 'cancelled', ..., {exitCode: status, stderr});
 * - otherwise CtxError.fromProcess(stderr, status): the last non-empty stderr line is the
 *   envelope (its code is authoritative); fallback per E34: code = fallbackCode(status),
 *   retryable = status 7 or 12, exit 2 -> internal, the raw stderr kept as the message.
 */
export function errorFromExit(stderr: string, status: number, o: { killedBy?: "timeout" | "cancelled" } = {}): CtxError {
  if (o.killedBy === "timeout") { return CtxError.extension("timeout", "ctx did not finish in time and was stopped", { exitCode: status, stderr }); }
  if (o.killedBy === "cancelled") { return CtxError.extension("cancelled", "ctx was cancelled", { exitCode: status, stderr }); }
  return CtxError.fromProcess(stderr, status);
}

/** exit 0 -> decodeStdout(stdout, schema); anything else -> throw errorFromExit(stderr, exitStatus(...)). */
export function docFromResult<T extends Doc>(r: ProcessResult, schema: T["schema"]): T {
  const status = exitStatus(r.exitCode, r.signal);
  if (status !== 0) { throw errorFromExit(r.stderr, status); }
  return decodeStdout<T>(r.stdout, schema, { exitCode: status, stderr: r.stderr });
}

/**
 * `ctx push --json`: exit 0 -> {doc}; exit 6 whose stdout is a parseable PushDoc -> {doc,
 * conflict: parseEnvelope(stderr, 6)} (resolves, never rejects: a partial push is success
 * plus conflicts); anything else -> throw errorFromExit (exit 6 without a PushDoc included).
 */
export function pushOutcomeFromResult(r: ProcessResult): PushOutcome {
  const status = exitStatus(r.exitCode, r.signal);
  if (status === 0) { return { doc: decodeStdout<PushDoc>(r.stdout, "ctx.push.v1", { exitCode: status, stderr: r.stderr }) }; }
  if (status === 6) {
    let doc: PushDoc | undefined;
    try {
      doc = parseDoc<PushDoc>(r.stdout.toString("utf8"), "ctx.push.v1");
    } catch {
      doc = undefined;
    }
    if (doc !== undefined) { return { doc, conflict: parseEnvelope(r.stderr, status) }; }
  }
  throw errorFromExit(r.stderr, status);
}
