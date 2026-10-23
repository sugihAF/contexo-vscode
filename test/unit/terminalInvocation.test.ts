// exitingTerminalInvocation (WP-4.4): the terminal process host tests give runCtxInTerminal
// must be a console program on win32. VS Code 1.143 on Windows (node-pty 1.2 ConPTY) never
// reports the pid or the exit of a GUI-subsystem process such as the Electron binary
// process.execPath names, so `-e process.exit(0)` under ELECTRON_RUN_AS_NODE hung every e6
// terminal test there; cmd.exe, node.exe and ctx.exe (console programs) report both.
import * as assert from "node:assert/strict";
import { exitingTerminalInvocation } from "../helpers/fakeCtxCli";

const COMSPEC = "C:\\Windows\\system32\\cmd.exe";

describe("exitingTerminalInvocation", () => {
  it("win32: cmd.exe from ComSpec exits with the code, never the Electron binary", () => {
    const inv = exitingTerminalInvocation(3, { platform: "win32", env: { ComSpec: COMSPEC } });
    assert.deepEqual(inv, { shellPath: COMSPEC, shellArgs: ["/d", "/c", "exit 3"] });
    assert.notEqual(inv.shellPath, process.execPath);
  });

  it("win32: afterMs keeps the console program running about that long first", () => {
    assert.deepEqual(exitingTerminalInvocation(0, { platform: "win32", env: { ComSpec: COMSPEC }, afterMs: 60_000 }),
      { shellPath: COMSPEC, shellArgs: ["/d", "/c", "ping -n 61 127.0.0.1 >nul & exit 0"] });
  });

  it("win32: without ComSpec it falls back to System32 cmd.exe", () => {
    assert.equal(exitingTerminalInvocation(0, { platform: "win32", env: {} }).shellPath, "C:\\Windows\\System32\\cmd.exe");
  });

  for (const platform of ["darwin", "linux"] as const) {
    it(`${platform}: the Electron binary running as node`, () => {
      assert.deepEqual(exitingTerminalInvocation(3, { platform }),
        { shellPath: process.execPath, shellArgs: ["-e", "process.exit(3)"], env: { ELECTRON_RUN_AS_NODE: "1" } });
      assert.deepEqual(exitingTerminalInvocation(0, { platform, afterMs: 60_000 }),
        { shellPath: process.execPath, shellArgs: ["-e", "setTimeout(() => process.exit(0), 60000)"], env: { ELECTRON_RUN_AS_NODE: "1" } });
    });
  }
});
