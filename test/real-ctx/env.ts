// Typed env loader for the real-ctx suites (WP-3.1). The values come from process.env (what
// `real-ctx-env.mjs up` exports and `test` passes on) or, when REAL_CTX_RUN is unset, from the
// pointer's env.json. A missing environment throws: these suites never skip.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface RealCtxEnv {
  /** $RUN/bin/ctx (dev build). */
  ctxBin: string;
  /** $RUN/bin-rc/ctx (version stamped 0.7.0-rc.1). */
  ctxBinRc: string;
  /** http://127.0.0.1:18080 */
  server: string;
  run: string;
  alice: string;
  bob: string;
  homeAlice: string;
  homeBob: string;
  /** The server's legacy API key (both users log in with it). */
  key: string;
  repo: string;
  /** 40-hex Contexo commit the binaries were built from. */
  sourceCommit: string;
}

const KEYS: Record<keyof RealCtxEnv, string> = {
  ctxBin: "CTX_BIN",
  ctxBinRc: "CTX_BIN_RC",
  server: "CONTEXO_TEST_SERVER",
  run: "REAL_CTX_RUN",
  alice: "REAL_CTX_ALICE",
  bob: "REAL_CTX_BOB",
  homeAlice: "REAL_CTX_HOME_ALICE",
  homeBob: "REAL_CTX_HOME_BOB",
  key: "REAL_CTX_KEY",
  repo: "REAL_CTX_REPO",
  sourceCommit: "REAL_CTX_SOURCE_COMMIT",
};

/** $TMPDIR/contexo-real-ctx/current (realpath'd, like the harness). */
export function pointerFile(): string {
  return path.join(fs.realpathSync(os.tmpdir()), "contexo-real-ctx", "current");
}

let cached: RealCtxEnv | undefined;

export function realCtxEnv(): RealCtxEnv {
  if (cached) { return cached; }
  let raw: Record<string, string | undefined> = process.env;
  if (!process.env.REAL_CTX_RUN) {
    let run: string | undefined;
    try {
      run = fs.readFileSync(pointerFile(), "utf8").trim();
    } catch {
      run = undefined;
    }
    const file = run ? path.join(run, "env.json") : undefined;
    if (!file || !fs.existsSync(file)) {
      throw new Error("no real-ctx environment: run `eval \"$(node scripts/real-ctx-env.mjs up --src <dir>)\"` (or `real-ctx-env.mjs run`) first; nothing is skipped");
    }
    raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, string>;
  }
  const missing = Object.values(KEYS).filter((k) => !raw[k]);
  if (missing.length > 0) { throw new Error(`real-ctx env is incomplete: ${missing.join(", ")} unset`); }
  cached = Object.fromEntries(Object.entries(KEYS).map(([field, key]) => [field, raw[key] as string])) as unknown as RealCtxEnv;
  return cached;
}
