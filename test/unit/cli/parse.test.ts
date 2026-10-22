// parse.ts (contract §3, E34): stdout documents and stderr envelopes -> typed results or
// CtxError, over hand-made output and the vendored contract fixtures
// (test/fixtures/contract/v1, read only). Plain mocha, no vscode.
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { decodeStdout, docFromResult, errorFromExit, exitStatus, pushOutcomeFromResult } from "../../../src/cli/parse";
import type { ProcessResult } from "../../../src/cli/spawn";
import { CtxError } from "../../../src/cli/types";
import type { DistillRequiredDetails, ErrorEnvelope, PushDoc, StatusDoc, VersionDoc } from "../../../src/contract/types";
import { REPO_ROOT } from "../../helpers/fixtures";

const CONTRACT_DIR = path.join(REPO_ROOT, "test", "fixtures", "contract", "v1");

function fixture(name: string): Buffer {
  return fs.readFileSync(path.join(CONTRACT_DIR, name));
}

function result(o: Omit<Partial<ProcessResult>, "stdout"> & { stdout?: Buffer | string }): ProcessResult {
  return {
    args: o.args ?? ["status", "--json", "--root", "/r"],
    stdout: typeof o.stdout === "string" ? Buffer.from(o.stdout, "utf8") : o.stdout ?? Buffer.alloc(0),
    stderr: o.stderr ?? "",
    exitCode: o.exitCode === undefined ? 0 : o.exitCode,
    signal: o.signal ?? null,
    durationMs: o.durationMs ?? 12,
  };
}

/** Runs fn, asserts it throws a CtxError and returns it. */
function ctxErrorOf(fn: () => unknown): CtxError {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof CtxError, `expected a CtxError, got ${String(err)}`);
    return err;
  }
  assert.fail("expected a CtxError, nothing was thrown");
}

const NOISE = "2026/11/03 09:14:07 sync: fetching remote listing (attempt 1)";

const VERSION_DOC = JSON.parse(fixture("version.release.json").toString("utf8")) as VersionDoc;

describe("parse.ts: ctx output -> results and CtxError", () => {
  it("exitStatus: the exit code passes through; SIGINT 130, SIGKILL 137, SIGTERM 143; neither -> -1", () => {
    for (const code of [0, 1, 2, 4, 6, 12, 255]) { assert.equal(exitStatus(code, null), code); }
    assert.equal(exitStatus(null, "SIGINT"), 130);
    assert.equal(exitStatus(null, "SIGKILL"), 137);
    assert.equal(exitStatus(null, "SIGTERM"), 143);
    assert.equal(exitStatus(null, "SIGHUP"), 129);
    assert.equal(exitStatus(null, null), -1);
    assert.equal(exitStatus(3, "SIGTERM"), 3, "an exit code wins over a signal");
  });

  it("an envelope after a noise line gives code/advice/details/exitCode", () => {
    const env: ErrorEnvelope = {
      schema: "ctx.error.v1", exit_code: 6,
      error: {
        code: "stale", message: "resolve: the server moved", advice: ["ctx status", "ctx resolve x --theirs"], retryable: false, http_status: 409,
        details: { path: "wiki/a.md", expected_sha: "a".repeat(40), server_sha: "b".repeat(40) },
      },
    };
    const stderr = `${NOISE}\nwarning: something else\n${JSON.stringify(env)}\n\n`;
    const err = errorFromExit(stderr, 6);
    assert.equal(err.code, "stale");
    assert.equal(err.message, "resolve: the server moved");
    assert.deepEqual(err.advice, ["ctx status", "ctx resolve x --theirs"]);
    assert.deepEqual(err.details, { path: "wiki/a.md", expected_sha: "a".repeat(40), server_sha: "b".repeat(40) });
    assert.equal(err.exitCode, 6);
    assert.equal(err.httpStatus, 409);
    assert.equal(err.retryable, false);
    assert.equal(err.stderr, stderr, "the raw stderr is kept");

    const viaDoc = ctxErrorOf(() => docFromResult<StatusDoc>(result({ exitCode: 6, stderr }), "ctx.status.v1"));
    assert.equal(viaDoc.code, "stale");
    assert.equal(viaDoc.exitCode, 6);

    const authoritative = errorFromExit(`${NOISE}\n${JSON.stringify({ ...env, exit_code: 9, error: { ...env.error, code: "busy", retryable: true } })}`, 1);
    assert.equal(authoritative.code, "busy", "the envelope code wins over the exit code");
    assert.equal(authoritative.exitCode, 9);
    assert.equal(authoritative.retryable, true);
  });

  it("non-JSON stderr with exit 4 gives not_authenticated and keeps the raw message", () => {
    const stderr = "Error: not logged in; run `ctx auth login`\n";
    const err = errorFromExit(stderr, 4);
    assert.equal(err.code, "not_authenticated");
    assert.equal(err.message, "Error: not logged in; run `ctx auth login`");
    assert.equal(err.stderr, stderr);
    assert.equal(err.exitCode, 4);
    assert.equal(err.retryable, false);
    assert.deepEqual(err.advice, []);
  });

  it("non-JSON exit 7 gives network retryable=true; exit 12 gives busy retryable=true", () => {
    const network = errorFromExit("dial tcp: lookup api.contexo.live: no such host\n", 7);
    assert.equal(network.code, "network");
    assert.equal(network.retryable, true);
    assert.equal(network.exitCode, 7);
    const busy = errorFromExit("lock held\n", 12);
    assert.equal(busy.code, "busy");
    assert.equal(busy.retryable, true);
    assert.equal(busy.exitCode, 12);
    for (const [exit, code] of [[1, "internal"], [3, "usage"], [5, "not_initialized"], [6, "conflict"], [8, "page_not_found"], [9, "not_resolvable"], [10, "server_unsupported"], [11, "quota_exceeded"]] as const) {
      const e = errorFromExit("plain text\n", exit);
      assert.equal(e.code, code, `exit ${exit}`);
      assert.equal(e.retryable, false, `exit ${exit} is not retryable`);
    }
    const empty = errorFromExit("", 7);
    assert.equal(empty.code, "network");
    assert.equal(empty.message, "ctx exited 7", "an empty stderr still gives a message");
  });

  it("exit 2 gives internal", () => {
    const panic = "panic: runtime error: index out of range [3] with length 3\n\ngoroutine 1 [running]:\nmain.main()\n\t/src/cmd/ctx/main.go:12 +0x1d\nexit status 2\n";
    const err = errorFromExit(panic, 2);
    assert.equal(err.code, "internal");
    assert.equal(err.exitCode, 2);
    assert.equal(err.retryable, false);
    assert.ok(err.message.startsWith("panic: runtime error"), "the raw stderr is the message");
    const viaDoc = ctxErrorOf(() => docFromResult<StatusDoc>(result({ exitCode: 2, stderr: panic }), "ctx.status.v1"));
    assert.equal(viaDoc.code, "internal");
  });

  it("143 after our kill gives cancelled", () => {
    const cancelled = errorFromExit("partial output\n", 143, { killedBy: "cancelled" });
    assert.equal(cancelled.code, "cancelled");
    assert.equal(cancelled.exitCode, 143);
    assert.equal(cancelled.stderr, "partial output\n");
    assert.equal(cancelled.envelope.error.code, "internal", "the synthetic envelope carries internal");
    assert.equal(errorFromExit("", 130, { killedBy: "cancelled" }).code, "cancelled");
    assert.equal(errorFromExit("", 137, { killedBy: "cancelled" }).code, "cancelled");
    assert.equal(errorFromExit("", -1, { killedBy: "cancelled" }).exitCode, -1, "killed before an exit status was known");
    const timeout = errorFromExit("", 143, { killedBy: "timeout" });
    assert.equal(timeout.code, "timeout");
    assert.equal(timeout.exitCode, 143);
    const envelope = JSON.stringify({ schema: "ctx.error.v1", exit_code: 12, error: { code: "busy", message: "m", advice: [], retryable: true } });
    assert.equal(errorFromExit(envelope, 12, { killedBy: "timeout" }).code, "timeout", "our kill wins over an envelope");
    assert.equal(errorFromExit("", 143).code, "internal", "143 without our kill is a plain failure");
  });

  it("unknown fields are ignored", () => {
    const doc = { ...VERSION_DOC, future_field: { nested: [1, 2] }, capabilities: [...VERSION_DOC.capabilities, "future.cap"] };
    const decoded = decodeStdout<VersionDoc>(Buffer.from(JSON.stringify(doc)), "ctx.version.v1");
    assert.equal(decoded.schema, "ctx.version.v1");
    assert.equal(decoded.contract_version, 1);
    assert.equal(decoded.version, VERSION_DOC.version);
    assert.ok(decoded.capabilities.includes("future.cap"));
    const viaResult = docFromResult<VersionDoc>(result({ stdout: JSON.stringify(doc) }), "ctx.version.v1");
    assert.equal(viaResult.version, VERSION_DOC.version);

    const env = {
      schema: "ctx.error.v1", exit_code: 4, trace_id: "t-1",
      error: { code: "auth_rejected", message: "token rejected", advice: ["ctx auth login"], retryable: false, http_status: 401, hint: "old field", extra: { a: 1 } },
    };
    const err = errorFromExit(`${NOISE}\n${JSON.stringify(env)}\n`, 4);
    assert.equal(err.code, "auth_rejected");
    assert.equal(err.message, "token rejected");
    assert.deepEqual(err.advice, ["ctx auth login"]);
    assert.equal(err.httpStatus, 401);
    assert.equal(err.exitCode, 4);
  });

  it("ctx.status.v2 gives contract_mismatch", () => {
    const v2 = JSON.stringify({ schema: "ctx.status.v2", pages: [] });
    const err = ctxErrorOf(() => docFromResult<StatusDoc>(result({ stdout: v2, stderr: "note\n" }), "ctx.status.v1"));
    assert.equal(err.code, "contract_mismatch");
    assert.equal(err.exitCode, 0, "carries the exit code");
    assert.equal(err.stderr, "note\n", "carries the stderr");
    assert.match(err.message, /ctx\.status\.v1/);
    for (const stdout of ["", "not json at all", "{\"schema\":", "[]", "null", "42", "\"ctx.status.v1\"", JSON.stringify({ schema: "ctx.version.v1" })]) {
      const e = ctxErrorOf(() => decodeStdout<StatusDoc>(Buffer.from(stdout), "ctx.status.v1"));
      assert.equal(e.code, "contract_mismatch", JSON.stringify(stdout));
      assert.equal(e.exitCode, -1, "no exit code given -> -1");
    }
    const withExit = ctxErrorOf(() => decodeStdout<StatusDoc>("nope", "ctx.status.v1", { exitCode: 0, stderr: "s" }));
    assert.equal(withExit.exitCode, 0);
    assert.equal(withExit.stderr, "s");
  });

  it("docFromResult: exit 0 decodes stdout as UTF-8; a non-zero exit or a signal throws errorFromExit", () => {
    const doc = { ...VERSION_DOC, version: "0.7.0-rc.1 é" };
    assert.equal(docFromResult<VersionDoc>(result({ stdout: Buffer.from(JSON.stringify(doc), "utf8") }), "ctx.version.v1").version, "0.7.0-rc.1 é");
    assert.equal(decodeStdout<VersionDoc>(JSON.stringify(doc), "ctx.version.v1").version, "0.7.0-rc.1 é", "a string is accepted too");
    const failed = ctxErrorOf(() => docFromResult<VersionDoc>(result({ exitCode: 1, stdout: JSON.stringify(doc), stderr: "Error: unknown flag: --json\n" }), "ctx.version.v1"));
    assert.equal(failed.code, "internal", "a non-zero exit never decodes stdout");
    assert.equal(failed.message, "Error: unknown flag: --json");
    const killed = ctxErrorOf(() => docFromResult<VersionDoc>(result({ exitCode: null, signal: "SIGKILL" }), "ctx.version.v1"));
    assert.equal(killed.code, "internal", "a foreign signal is a plain failure");
    assert.equal(killed.exitCode, 137);
  });

  it("push exit 0 resolves {doc} without a conflict", () => {
    const out = pushOutcomeFromResult(result({ args: ["push"], stdout: fixture("push.ok.json") }));
    assert.equal(out.doc.schema, "ctx.push.v1");
    assert.equal(out.conflict, undefined);
    assert.ok(!("conflict" in out), "no conflict key at all");
  });

  it("push exit 6 with push.partial-conflict stdout resolves with 1 conflict", () => {
    const stderr = `${NOISE}\n${fixture("push.partial-conflict.stderr.json").toString("utf8")}`;
    const out = pushOutcomeFromResult(result({ args: ["push"], exitCode: 6, stdout: fixture("push.partial-conflict.json"), stderr }));
    assert.equal(out.doc.schema, "ctx.push.v1");
    assert.equal(out.doc.conflicts.length, 1);
    assert.equal(out.doc.conflicts[0]?.path, "wiki/entities/settlement-batch.md");
    assert.equal(out.doc.pushed.length, 2, "the other pages were pushed");
    assert.ok(out.conflict, "the conflict envelope is attached");
    assert.equal(out.conflict.exit_code, 6);
    assert.equal(out.conflict.error.code, "conflict");
    assert.deepEqual(out.conflict.error.details, { paths: ["wiki/entities/settlement-batch.md"] });
    assert.deepEqual(out.conflict.error.advice, [
      "ctx resolve wiki/entities/settlement-batch.md --ours",
      "ctx resolve wiki/entities/settlement-batch.md --theirs",
    ]);
  });

  it("push exit 6 without a PushDoc throws", () => {
    const stderr = fixture("push.partial-conflict.stderr.json").toString("utf8");
    for (const stdout of ["", "garbage", JSON.stringify({ schema: "ctx.pull.v1" })]) {
      const err = ctxErrorOf(() => pushOutcomeFromResult(result({ args: ["push"], exitCode: 6, stdout, stderr })));
      assert.equal(err.code, "conflict", JSON.stringify(stdout));
      assert.equal(err.exitCode, 6);
      assert.deepEqual(err.details, { paths: ["wiki/entities/settlement-batch.md"] });
    }
    const other = ctxErrorOf(() => pushOutcomeFromResult(result({ args: ["push"], exitCode: 12, stdout: fixture("push.ok.json"), stderr: fixture("error.busy.json").toString("utf8") })));
    assert.equal(other.code, "busy", "only exit 6 reads a PushDoc on failure");
    assert.equal(other.retryable, true);
    const bad = ctxErrorOf(() => pushOutcomeFromResult(result({ args: ["push"], stdout: "{}" })));
    assert.equal(bad.code, "contract_mismatch", "exit 0 without a PushDoc");
  });

  it("exit 9 with error.distill_required.json gives details.agent_prompt", () => {
    const stderr = fixture("error.distill_required.json").toString("utf8");
    const expected = (JSON.parse(stderr) as { error: { details: DistillRequiredDetails } }).error.details;
    const err = ctxErrorOf(() => pushOutcomeFromResult(result({ args: ["push"], exitCode: 9, stderr })));
    assert.equal(err.code, "distill_required");
    assert.equal(err.exitCode, 9);
    assert.equal(err.retryable, false);
    const details = err.details as DistillRequiredDetails;
    assert.equal(details.agent_prompt, expected.agent_prompt);
    assert.ok(details.agent_prompt.length > 0);
    assert.deepEqual(details.pages, ["wiki/concepts/settlement-windows.md"]);
    assert.equal(details.sessions.length, 1);
    const viaDoc = ctxErrorOf(() => docFromResult<PushDoc>(result({ exitCode: 9, stderr: `${NOISE}\n${stderr}` }), "ctx.push.v1"));
    assert.equal((viaDoc.details as DistillRequiredDetails).agent_prompt, expected.agent_prompt);
  });
});
