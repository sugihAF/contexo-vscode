// runCtx(home, args): one ctx process exactly as the extension spawns it. It goes through
// src/cli/spawn.ts createRunner, so the env is the extension's E26 env (NO_COLOR,
// CONTEXO_NO_UPDATE_CHECK, CONTEXO_CLIENT=contexo-vscode/<version>, CONTEXO_DISTILL_DISABLE
// removed), the args are an array and shell is false. Only HOME and USERPROFILE are overridden.
import * as fs from "node:fs";
import * as path from "node:path";
import { createRunner, type CommandClass, type CtxRunner } from "../../src/cli/spawn";
import { REPO_ROOT } from "../helpers/fixtures";
import { realCtxEnv } from "./env";

export interface CtxRun {
  /** Process exit code (-1 when it ended by a signal). */
  code: number;
  stdout: string;
  stdoutBytes: Buffer;
  stderr: string;
  args: readonly string[];
}

export const EXT_VERSION: string = (JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as { version: string }).version;

const silent = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined };

function classOf(args: readonly string[]): CommandClass {
  switch (args[0]) {
    case "version": return "version";
    case "status": return args.includes("--offline") ? "statusOffline" : "status";
    case "show": return "show";
    case "pull": return "pull";
    case "resolve": return "resolve";
    default: return "push";
  }
}

function rootOf(args: readonly string[]): string | undefined {
  const i = args.indexOf("--root");
  return i >= 0 ? args[i + 1] : undefined;
}

const runners = new Map<string, CtxRunner>();

function runnerFor(home: string): CtxRunner {
  let r = runners.get(home);
  if (!r) {
    r = createRunner({ extVersion: EXT_VERSION, log: silent, parentEnv: () => ({ ...process.env, HOME: home, USERPROFILE: home }) });
    runners.set(home, r);
  }
  return r;
}

/** Run `<bin> ...args` as the user whose home is `home` (bin defaults to CTX_BIN); cwd = --root or home. */
export async function runCtx(home: string, args: readonly string[], o: { bin?: string } = {}): Promise<CtxRun> {
  const bin = o.bin ?? realCtxEnv().ctxBin;
  const res = await runnerFor(home).run({ command: bin, prefixArgs: [] }, { cls: classOf(args), args, cwd: rootOf(args) ?? home });
  return {
    code: res.exitCode ?? -1,
    stdout: res.stdout.toString("utf8"),
    stdoutBytes: res.stdout,
    stderr: res.stderr,
    args,
  };
}

/** The last non-empty stderr line (where the ctx.error.v1 envelope lives). */
export function lastStderrLine(stderr: string): string {
  return stderr.split(/\r?\n/).filter((l) => l.trim() !== "").pop() ?? "";
}
