// VS Code host test labels for @vscode/test-cli (WP-0.6). `npm test` runs integration
// (VS Code 1.100.0, the engines minimum), integration-stable and integration-multi, one
// after another; test:e2e runs e2e (WP-2.3); test:real-ctx runs real-ctx (WP-3.1), which
// exists only when REAL_CTX_ALICE is set.
//
// - VS Code downloads go to ONE shared cache: $CONTEXO_VSCODE_TEST_CACHE, else
//   <os.tmpdir()>/contexo-vscode-test-cache. Sessions with a per-session TMPDIR should
//   export CONTEXO_VSCODE_TEST_CACHE=<one fixed path> to avoid re-downloading ~200 MB per
//   version. test-cli's own `download` option has no cache path, hence the top-level
//   downloadAndUnzipVSCode + useInstallation.fromPath.
// - Only the versions of the labels selected with --label are downloaded (all of them
//   when no label is given, e.g. when an editor's test runner loads this file).
//   --code-version <v> replaces every selected label's version.
// - Every label gets its own short --user-data-dir and --extensions-dir under
//   .vscode-test/ (short: macOS caps socket paths near 104 bytes; per label and per
//   worktree, so parallel worktrees and a running desktop VS Code never share an instance
//   mutex), plus --disable-extensions. test-electron already adds --disable-workspace-trust.
// - Fake-ctx labels get CONTEXO_TEST_CTX = JSON {command: <this node>, prefixArgs:
//   [<abs test/fake-ctx/fake-ctx.mjs>]}, which the extension honours only in
//   ExtensionMode.Test (WP-1.7). Workspaces are the copies `npm run pretest` makes under
//   .vscode-test/workspaces/ (scripts/prepare-test-workspaces.mjs), never the fixtures.
import { mkdirSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "@vscode/test-cli";
import { downloadAndUnzipVSCode } from "@vscode/test-electron";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const TEST_DIR = path.join(ROOT, ".vscode-test");
const WORKSPACES = path.join(TEST_DIR, "workspaces");
const FAKE_CTX = path.join(ROOT, "test", "fake-ctx", "fake-ctx.mjs");
const CACHE = process.env.CONTEXO_VSCODE_TEST_CACHE ?? path.join(os.tmpdir(), "contexo-vscode-test-cache");

/** engines.vscode minimum. */
const MIN_VSCODE = "1.100.0";

/** Per-label profile: short dir names under .vscode-test/u and .vscode-test/x. */
function profileArgs(short) {
  return [
    `--user-data-dir=${path.join(TEST_DIR, "u", short)}`,
    `--extensions-dir=${path.join(TEST_DIR, "x", short)}`,
    "--disable-extensions",
  ];
}

const FAKE_CTX_ENV = {
  CONTEXO_TEST_CTX: JSON.stringify({ command: process.execPath, prefixArgs: [FAKE_CTX] }),
};

const MOCHA = { ui: "bdd", timeout: 20000 };

/** The configurations, without useInstallation (added below for the selected ones). */
const configs = [
  {
    label: "integration",
    version: MIN_VSCODE,
    files: "out/test/integration/**/*.test.js",
    workspaceFolder: path.join(WORKSPACES, "basic"),
    launchArgs: profileArgs("i"),
    env: FAKE_CTX_ENV,
    mocha: MOCHA,
  },
  {
    label: "integration-stable",
    version: "stable",
    files: "out/test/integration/**/*.test.js",
    workspaceFolder: path.join(WORKSPACES, "basic"),
    launchArgs: profileArgs("s"),
    env: FAKE_CTX_ENV,
    mocha: MOCHA,
  },
  {
    label: "integration-multi",
    version: "stable",
    files: "out/test/integration-multi/**/*.test.js",
    workspaceFolder: path.join(WORKSPACES, "multi", "multi.code-workspace"),
    launchArgs: profileArgs("m"),
    env: FAKE_CTX_ENV,
    mocha: MOCHA,
  },
  {
    // WP-2.3 adds the tests.
    label: "e2e",
    version: "stable",
    files: "out/test/e2e/**/*.test.js",
    workspaceFolder: path.join(WORKSPACES, "basic"),
    launchArgs: profileArgs("e"),
    env: FAKE_CTX_ENV,
    mocha: MOCHA,
  },
];

if (process.env.REAL_CTX_ALICE) {
  // Placeholder; WP-3.1 owns this entry (its HOME/PATH env, timeouts and files). It runs the
  // real ctx, so it gets no CONTEXO_TEST_CTX.
  configs.push({
    label: "real-ctx",
    version: "stable",
    files: "out/test/real-ctx/**/*.test.js",
    workspaceFolder: process.env.REAL_CTX_ALICE,
    launchArgs: profileArgs("r"),
    mocha: MOCHA,
  });
}

/** The values of `--label`/`-l` (yargs array option: `--label a b`, `--label a --label b`, `--label=a`). */
function requestedLabels(argv) {
  const labels = [];
  for (let i = 0; i < argv.length; i++) {
    const inline = /^--label=(.*)$/.exec(argv[i]);
    if (inline) {
      labels.push(inline[1]);
    } else if (argv[i] === "--label" || argv[i] === "-l") {
      while (i + 1 < argv.length && !argv[i + 1].startsWith("-")) { labels.push(argv[++i]); }
    }
  }
  return labels;
}

function optionValue(argv, name) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === name && i + 1 < argv.length) { return argv[i + 1]; }
    if (argv[i].startsWith(`${name}=`)) { return argv[i].slice(name.length + 1); }
  }
  return undefined;
}

const argv = process.argv.slice(2);
const labels = requestedLabels(argv);
const codeVersion = optionValue(argv, "--code-version");
// An unknown label (or an index) selects nothing we can name: download for every label.
const selected = labels.length > 0 && labels.every((l) => configs.some((c) => c.label === l))
  ? configs.filter((c) => labels.includes(c.label))
  : configs;
for (const c of selected) {
  if (codeVersion) { c.version = codeVersion; }
}

mkdirSync(CACHE, { recursive: true }); // test-electron creates only the last path segment
const executables = new Map();
for (const version of new Set(selected.map((c) => c.version))) {
  executables.set(version, await downloadAndUnzipVSCode({ version, cachePath: CACHE }));
}
for (const c of selected) {
  c.useInstallation = { fromPath: executables.get(c.version) };
}

export default defineConfig(configs);
