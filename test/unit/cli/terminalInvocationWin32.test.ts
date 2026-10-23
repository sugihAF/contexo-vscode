// WP-4.4: the product's terminal invocation on win32. The Windows e6 hang was the test
// harness (a GUI-subsystem Electron binary as the terminal process), not this: ctx runs as
// itself, the absolute ctx.exe discovery found, with the ctx args verbatim (VS Code quotes
// them) and no shell in between. Discovery runs against a fake win32 fs; its probe is
// answered by the real fake ctx.
import * as assert from "node:assert/strict";
import * as os from "node:os";
import { createCtxCliWith } from "../../../src/cli/ctxCli";
import type { DiscoveryFs } from "../../../src/cli/discovery";
import { defaultSpawnFn, type SpawnFn } from "../../../src/cli/spawn";
import type { CtxCliDeps } from "../../../src/cli/types";
import type { ContexoConfig } from "../../../src/services";
import { FAKE_CTX } from "../../helpers/fixtures";

const LOCAL_APP_DATA = "C:\\Users\\Dev User\\AppData\\Local";
const CTX_EXE = `${LOCAL_APP_DATA}\\Programs\\contexo\\ctx.exe`;
const ROOT = "C:\\Users\\Dev User\\My Project";

const log = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined, trace: () => undefined } as unknown as CtxCliDeps["log"];
const context = { extensionMode: 1, extension: { packageJSON: { version: "9.9.9-test" } } } as unknown as CtxCliDeps["context"];
const config = {
  path: undefined, remoteRefreshEnabled: true, remoteRefreshIntervalSeconds: 180, scmCountIncoming: false,
  decorationsEnabled: true, treeShowSessions: true, onDidChange: () => ({ dispose: () => undefined }),
} as unknown as ContexoConfig;

describe("terminalInvocation on win32 (WP-4.4)", () => {
  it("is the discovered ctx.exe itself with the ctx args verbatim: no cmd.exe, no PowerShell, no Electron", async () => {
    const fs: DiscoveryFs = { stat: async (p) => (p === CTX_EXE ? { isFile: true, mtimeMs: 1, size: 1, mode: 0o644 } : undefined) };
    const probes: string[][] = [];
    // The version probe of ctx.exe is answered by the fake ctx (this host is not Windows).
    const spawnFn: SpawnFn = (command, args, options) => {
      assert.equal(command, CTX_EXE, "discovery probes the ctx.exe it found");
      probes.push([...args]);
      return defaultSpawnFn(process.execPath, [FAKE_CTX, ...args], { ...options, cwd: os.tmpdir() });
    };
    const cli = createCtxCliWith({ context, log, config }, {
      testMode: false, isTrusted: () => true, platform: "win32", fs, spawnFn,
      env: { Path: "", LOCALAPPDATA: LOCAL_APP_DATA, SystemRoot: "C:\\Windows" },
      homedir: () => "C:\\Users\\Dev User",
    });
    try {
      const binary = await cli.getBinary();
      assert.equal(binary.kind, "ok", JSON.stringify(binary));
      assert.ok(probes.length > 0);

      for (const args of [["auth", "login", "--root", ROOT], ["auth", "login", "--root", ROOT, "--no-browser"], ["init", "--root", ROOT], ["update", "--root", ROOT]]) {
        const inv = cli.terminalInvocation(args);
        assert.equal(inv.shellPath, CTX_EXE, "ctx itself is the terminal process");
        assert.deepEqual(inv.shellArgs, args, "the args are passed verbatim, a root with spaces included");
        assert.equal(inv.env?.ELECTRON_RUN_AS_NODE, undefined);
        assert.equal(inv.env?.CONTEXO_DISTILL_DISABLE, null, "E26: the distill switch is removed");
        assert.equal(inv.env?.CONTEXO_CLIENT, "contexo-vscode/9.9.9-test");
      }
    } finally {
      cli.dispose();
    }
  });
});
