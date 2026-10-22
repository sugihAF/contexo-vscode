// TEMPORARY WP-4.4 diagnostic (removed before the WP lands): how a terminal whose process is
// not a shell reports its exit on this platform and VS Code version. Never fails; prints one
// "WP44DIAG <json>" line per variant for the CI log.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";

interface Variant {
  name: string;
  shellPath: string | undefined;
  shellArgs: string[];
  env?: Record<string, string>;
  conptyDll?: boolean;
  waitMs?: number;
}

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "wp44-"));
const SCRIPT = path.join(DIR, "marker.js");
fs.writeFileSync(SCRIPT, [
  "const fs = require('fs');",
  "const [marker, code, delay] = process.argv.slice(2);",
  "fs.writeFileSync(marker, JSON.stringify({ pid: process.pid, execPath: process.execPath, ELECTRON_RUN_AS_NODE: process.env.ELECTRON_RUN_AS_NODE ?? null, electron: process.versions.electron ?? null, node: process.versions.node, isTTY: !!process.stdout.isTTY, cwd: process.cwd() }));",
  "process.stdout.write('marker written\\r\\n');",
  "setTimeout(() => process.exit(Number(code)), Number(delay || 0));",
].join("\n"));

function nativeNode(): string | undefined {
  const exe = process.platform === "win32" ? "node.exe" : "node";
  for (const dir of (process.env.PATH ?? process.env.Path ?? "").split(path.delimiter)) {
    const p = path.join(dir, exe);
    if (dir && fs.existsSync(p)) { return p; }
  }
  return undefined;
}

function variants(): Variant[] {
  const electron = { ELECTRON_RUN_AS_NODE: "1" };
  const marker = (n: string): string => path.join(DIR, `${n}.json`);
  const v: Variant[] = [
    { name: "electron-e-exit0", shellPath: process.execPath, shellArgs: ["-e", "process.exit(0)"], env: electron },
    { name: "electron-script-exit3", shellPath: process.execPath, shellArgs: [SCRIPT, marker("electron-script-exit3"), "3"], env: electron },
    { name: "electron-script-exit3-delay1500", shellPath: process.execPath, shellArgs: [SCRIPT, marker("electron-script-exit3-delay1500"), "3", "1500"], env: electron },
  ];
  const node = nativeNode();
  if (node) {
    v.push({ name: "native-node-script-exit3", shellPath: node, shellArgs: [SCRIPT, marker("native-node-script-exit3"), "3"] });
    v.push({ name: "native-node-e-exit0", shellPath: node, shellArgs: ["-e", "process.exit(0)"] });
  }
  if (process.platform === "win32") {
    const cmd = process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe";
    v.push({ name: "cmd-exit3", shellPath: cmd, shellArgs: ["/d", "/c", "exit 3"] });
    v.push({ name: "cmd-exit3-delay", shellPath: cmd, shellArgs: ["/d", "/c", "ping -n 2 127.0.0.1 >nul & exit 3"] });
    v.push({ name: "electron-script-exit3-conptyDll-false", shellPath: process.execPath, shellArgs: [SCRIPT, marker("electron-script-exit3-conptyDll-false"), "3"], env: electron, conptyDll: false });
    v.push({ name: "electron-script-exit3-conptyDll-true", shellPath: process.execPath, shellArgs: [SCRIPT, marker("electron-script-exit3-conptyDll-true"), "3"], env: electron, conptyDll: true });
    if (node) {
      v.push({ name: "native-node-script-exit3-conptyDll-false", shellPath: node, shellArgs: [SCRIPT, marker("native-node-script-exit3-conptyDll-false"), "3"], conptyDll: false });
    }
  } else {
    v.push({ name: "sh-exit3", shellPath: "/bin/sh", shellArgs: ["-c", "exit 3"] });
  }
  return v;
}

async function run(v: Variant): Promise<Record<string, unknown>> {
  const cfg = vscode.workspace.getConfiguration("terminal.integrated");
  const conptyBefore = cfg.inspect("windowsUseConptyDll");
  if (v.conptyDll !== undefined) {
    await cfg.update("windowsUseConptyDll", v.conptyDll, vscode.ConfigurationTarget.Global);
  }
  const t0 = Date.now();
  const events: string[] = [];
  const stamp = (e: string): void => { events.push(`${Date.now() - t0}ms ${e}`); };
  const terminal = vscode.window.createTerminal({ name: `wp44 ${v.name}`, shellPath: v.shellPath, shellArgs: v.shellArgs, env: v.env, cwd: DIR });
  const subs = [
    vscode.window.onDidOpenTerminal((t) => { if (t === terminal) { stamp("open"); } }),
    vscode.window.onDidCloseTerminal((t) => { if (t === terminal) { stamp(`close exit=${JSON.stringify(t.exitStatus)}`); } }),
    vscode.window.onDidChangeTerminalState((t) => { if (t === terminal) { stamp(`state ${JSON.stringify(t.state)}`); } }),
  ];
  void terminal.processId.then((pid) => stamp(`processId ${pid}`), (err: unknown) => stamp(`processId error ${String(err)}`));
  let firstExit: string | undefined;
  const deadline = t0 + (v.waitMs ?? 8000);
  while (Date.now() < deadline) {
    if (terminal.exitStatus && firstExit === undefined) {
      firstExit = `${Date.now() - t0}ms ${JSON.stringify(terminal.exitStatus)}`;
      stamp(`exitStatus ${JSON.stringify(terminal.exitStatus)}`);
      break;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  const nameAtEnd = terminal.name;
  terminal.dispose();
  await new Promise((r) => setTimeout(r, 500));
  for (const s of subs) { s.dispose(); }
  if (v.conptyDll !== undefined) {
    await cfg.update("windowsUseConptyDll", conptyBefore?.globalValue, vscode.ConfigurationTarget.Global);
  }
  const markerPath = path.join(DIR, `${v.name}.json`);
  return {
    variant: v.name,
    vscode: vscode.version,
    platform: process.platform,
    shellPath: v.shellPath,
    shellArgs: v.shellArgs,
    conptyDllSetting: v.conptyDll ?? conptyBefore,
    firstExit: firstExit ?? null,
    nameAtEnd,
    events,
    marker: fs.existsSync(markerPath) ? fs.readFileSync(markerPath, "utf8") : null,
  };
}

describe("WP-4.4 terminal diagnostic (temporary)", () => {
  before(() => {
    console.log(`WP44DIAG ${JSON.stringify({ header: true, vscode: vscode.version, execPath: process.execPath, platform: process.platform, nativeNode: nativeNode() ?? null, env: { ComSpec: process.env.ComSpec ?? null } })}`);
  });
  for (const v of variants()) {
    it(`diag ${v.name}`, async function () {
      this.timeout(20000);
      let out: Record<string, unknown>;
      try {
        out = await run(v);
      } catch (err) {
        out = { variant: v.name, error: String(err) };
      }
      console.log(`WP44DIAG ${JSON.stringify(out)}`);
    });
  }
});
