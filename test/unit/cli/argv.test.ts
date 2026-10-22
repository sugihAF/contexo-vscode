// ctxArgv (src/cli/spawn.ts): the exact E25 argv per command and the builder-side
// validation (invalid_path / usage CtxErrors with a synthetic exit_code -1 envelope).
// Plain mocha, no vscode; pure, no process is started.
import * as assert from "node:assert/strict";
import { ctxArgv } from "../../../src/cli/spawn";
import { CtxError, PUSH_PATHS_MAX } from "../../../src/cli/types";

/** An absolute root with a space and a non-ASCII character (argv elements are never split). */
const R = "/home/dana/my project é";
const P = "wiki/concepts/auth-flow.md";
const SHA40 = "0123456789abcdef0123456789abcdef01234567";

function pathsOf(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `wiki/concepts/page-${i}.md`);
}

/** Runs fn and asserts it throws a CtxError with `code`, exit_code -1 and an empty stderr. */
function assertCtxError(fn: () => unknown, code: string, label: string): void {
  assert.throws(fn, (err: unknown) => {
    assert.ok(err instanceof CtxError, `${label}: a CtxError`);
    assert.equal(err.code, code, `${label}: code`);
    assert.equal(err.envelope.error.code, code, `${label}: envelope code`);
    assert.equal(err.exitCode, -1, `${label}: synthetic exit_code -1`);
    assert.equal(err.envelope.exit_code, -1, `${label}: envelope exit_code -1`);
    assert.equal(err.stderr, "", `${label}: no stderr`);
    assert.equal(err.retryable, false, `${label}: not retryable`);
    return true;
  }, label);
}

describe("argv equals E25 per command", () => {
  it("version has no --root", () => {
    assert.deepEqual(ctxArgv.version(), ["version", "--json"]);
    assert.deepEqual(ctxArgv.versionShort(), ["version", "--short"]);
    assert.ok(!ctxArgv.version().includes("--root"));
    assert.ok(!ctxArgv.versionShort().includes("--root"));
  });

  it("status has --offline only when offline", () => {
    assert.deepEqual(ctxArgv.status(R, false), ["status", "--json", "--root", R]);
    const offline = ctxArgv.status(R, true);
    assert.deepEqual(offline, ["status", "--json", "--root", R, "--offline"]);
    assert.equal(offline[offline.length - 1], "--offline", "--offline comes last");
    assert.equal(offline.filter((a) => a === "--offline").length, 1);
  });

  it("show has no --json", () => {
    assert.deepEqual(ctxArgv.show(R, P, "base"), ["show", P, "--at", "base", "--root", R]);
    assert.deepEqual(ctxArgv.show(R, P, "server"), ["show", P, "--at", "server", "--root", R]);
    assert.deepEqual(ctxArgv.show(R, P, SHA40), ["show", P, "--at", SHA40, "--root", R]);
    assert.deepEqual(ctxArgv.show(R, P, "abc1234"), ["show", P, "--at", "abc1234", "--root", R], "a 7-hex short sha");
    assert.deepEqual(ctxArgv.show(R, P, "a".repeat(64)), ["show", P, "--at", "a".repeat(64), "--root", R], "a 64-hex sha");
    for (const ref of ["base", "server", SHA40]) { assert.ok(!ctxArgv.show(R, P, ref).includes("--json"), ref); }
  });

  it("pull is pull --json --root R", () => {
    assert.deepEqual(ctxArgv.pull(R), ["pull", "--json", "--root", R]);
  });

  it("push: no -m for an empty message", () => {
    const bare = ["push", "--json", "--yes", "--root", R];
    assert.deepEqual(ctxArgv.push(R, { message: "" }), bare);
    assert.deepEqual(ctxArgv.push(R, {}), bare, "undefined message");
    assert.deepEqual(ctxArgv.push(R, { message: undefined, paths: [] }), bare);
    assert.ok(!ctxArgv.push(R, { message: "" }).includes("-m"));
  });

  it("push: the message is one argv element", () => {
    for (const message of ["Clarify ledger ownership", "line one\nline two\n", "-m --theirs --", "--json", " leading space", "émoji 🚀 \"quoted\" $(x) `y`"]) {
      const argv = ctxArgv.push(R, { message });
      assert.deepEqual(argv, ["push", "--json", "--yes", "--root", R, "-m", message], JSON.stringify(message));
      assert.equal(argv.indexOf("-m"), 5);
      assert.equal(argv.length, 7, "the message is exactly one element after -m");
    }
    const both = ctxArgv.push(R, { message: "two words", paths: [P] });
    assert.deepEqual(both, ["push", "--json", "--yes", "--root", R, "-m", "two words", "--", P]);
  });

  it("push: '--' + paths for 1..150 paths; nothing for 0 or 151", () => {
    assert.equal(PUSH_PATHS_MAX, 150);
    const bare = ["push", "--json", "--yes", "--root", R];
    for (const n of [1, 2, 149, PUSH_PATHS_MAX]) {
      const paths = pathsOf(n);
      assert.deepEqual(ctxArgv.push(R, { paths }), [...bare, "--", ...paths], `${n} paths`);
    }
    assert.deepEqual(ctxArgv.push(R, { paths: [] }), bare, "0 paths");
    assert.deepEqual(ctxArgv.push(R, { paths: pathsOf(PUSH_PATHS_MAX + 1) }), bare, "151 paths widen the push");
    assert.deepEqual(ctxArgv.push(R, { message: "m", paths: pathsOf(PUSH_PATHS_MAX + 1) }), [...bare, "-m", "m"]);
    assert.ok(!ctxArgv.push(R, { paths: pathsOf(PUSH_PATHS_MAX + 1) }).includes("--"));
  });

  it("resolve ours/theirs, with and without --if-server-sha", () => {
    assert.deepEqual(ctxArgv.resolve(R, P, "ours"), ["resolve", P, "--ours", "--json", "--root", R]);
    assert.deepEqual(ctxArgv.resolve(R, P, "theirs"), ["resolve", P, "--theirs", "--json", "--root", R]);
    assert.deepEqual(ctxArgv.resolve(R, P, "theirs", {}), ["resolve", P, "--theirs", "--json", "--root", R]);
    assert.deepEqual(ctxArgv.resolve(R, P, "ours", { ifServerSha: "" }), ["resolve", P, "--ours", "--json", "--root", R], "empty S is omitted");
    assert.deepEqual(
      ctxArgv.resolve(R, P, "theirs", { ifServerSha: SHA40 }),
      ["resolve", P, "--theirs", "--json", "--root", R, "--if-server-sha", SHA40],
    );
    assert.deepEqual(
      ctxArgv.resolve(R, P, "ours", { ifServerSha: SHA40 }),
      ["resolve", P, "--ours", "--json", "--root", R, "--if-server-sha", SHA40],
    );
  });

  it("each call returns a fresh array", () => {
    const a = ctxArgv.status(R, false);
    a.push("--offline");
    assert.deepEqual(ctxArgv.status(R, false), ["status", "--json", "--root", R]);
    const v = ctxArgv.version();
    v.length = 0;
    assert.deepEqual(ctxArgv.version(), ["version", "--json"]);
  });

  it("a relPath that is empty, starts with '-' or contains NUL throws invalid_path", () => {
    for (const bad of ["", "-rf", "--theirs", "wiki/a\u0000.md"]) {
      const label = JSON.stringify(bad);
      assertCtxError(() => ctxArgv.show(R, bad, "base"), "invalid_path", `show ${label}`);
      assertCtxError(() => ctxArgv.resolve(R, bad, "ours"), "invalid_path", `resolve ${label}`);
      assertCtxError(() => ctxArgv.push(R, { paths: [P, bad] }), "invalid_path", `push path ${label}`);
    }
  });

  it("a bad show ref, 'empty', a non-hex ifServerSha or a NUL byte throws usage", () => {
    for (const ref of ["empty", "", "HEAD", "abc123", "a".repeat(65), "-base", "--json", "0123456g"]) {
      assertCtxError(() => ctxArgv.show(R, P, ref), "usage", `show ref ${JSON.stringify(ref)}`);
    }
    for (const sha of ["xyz", "abc123", "a".repeat(65), "--ours", "0123456789abcdef\u0000"]) {
      assertCtxError(() => ctxArgv.resolve(R, P, "theirs", { ifServerSha: sha }), "usage", `ifServerSha ${JSON.stringify(sha)}`);
    }
    assertCtxError(() => ctxArgv.push(R, { message: "a\u0000b" }), "usage", "NUL in the push message");
    assertCtxError(() => ctxArgv.status(`${R}\u0000`, false), "usage", "NUL in the root (status)");
    assertCtxError(() => ctxArgv.pull(`${R}\u0000`), "usage", "NUL in the root (pull)");
    assertCtxError(() => ctxArgv.show(`${R}\u0000`, P, "base"), "usage", "NUL in the root (show)");
    assertCtxError(() => ctxArgv.push(`${R}\u0000`, {}), "usage", "NUL in the root (push)");
    assertCtxError(() => ctxArgv.resolve(`${R}\u0000`, P, "ours"), "usage", "NUL in the root (resolve)");
  });
});
