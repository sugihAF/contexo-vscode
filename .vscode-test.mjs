// VS Code host test labels for @vscode/test-cli (WP-0.6). `npm test` runs integration
// (VS Code 1.100.0, the engines minimum), integration-stable and integration-multi, one
// after another; test:e2e runs e2e (1.100.0), e2e-stable and e2e-multi (WP-2.3), one after
// another; test:real-ctx runs real-ctx (WP-3.1), which exists only when REAL_CTX_ALICE is set.
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
// - e2e labels (WP-2.3) do not share those copies: when this file loads, every SELECTED e2e
//   label gets a fresh copy of test/fixtures/workspaces under .vscode-test/w/<short> (calls.jsonl
//   dropped), plus env CONTEXO_DISTILL_DISABLE=1 (E26: the extension must strip it from every
//   spawn), FAKE_CTX_TIMESTAMPS=1 (start/end per call) and FAKE_CTX_CALLS=<copy>/version-calls.jsonl
//   (`version` carries no --root). Files: out/test/e2e/*.test.js (e2e, e2e-stable) and
//   out/test/e2e/multi/**/*.test.js (e2e-multi).
// - TDD lanes: CONTEXO_E2E_LANE=<name> suffixes the e2e profile and copy dirs, and
//   CONTEXO_E2E_OUT=<dir> (relative to the repo) replaces out/ in the e2e globs, so two lanes
//   can run e2e hosts in one worktree at the same time.
import { cpSync, mkdirSync, rmSync } from "node:fs";
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

const E2E_LANE = process.env.CONTEXO_E2E_LANE ? `-${process.env.CONTEXO_E2E_LANE}` : "";
const E2E_OUT = process.env.CONTEXO_E2E_OUT ?? "out";

/** Where an e2e label's private workspace copies live (made fresh when the label is selected). */
function e2eCopyDir(short) {
  return path.join(TEST_DIR, "w", `${short}${E2E_LANE}`);
}

/** An e2e label: own profile, own workspace copies, the E26/timestamp env. */
function e2eConfig(label, version, short, files, workspace) {
  const copy = e2eCopyDir(short);
  return {
    label,
    version,
    files: `${E2E_OUT}/test/e2e/${files}`,
    workspaceFolder: path.join(copy, ...workspace),
    launchArgs: profileArgs(`${short}${E2E_LANE}`),
    env: {
      ...FAKE_CTX_ENV,
      CONTEXO_DISTILL_DISABLE: "1",
      FAKE_CTX_TIMESTAMPS: "1",
      FAKE_CTX_CALLS: path.join(copy, "version-calls.jsonl"),
    },
    mocha: { ...MOCHA, timeout: 60000 },
    e2eCopy: copy,
  };
}

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
  e2eConfig("e2e", MIN_VSCODE, "e", "*.test.js", ["basic"]),
  e2eConfig("e2e-stable", "stable", "f", "*.test.js", ["basic"]),
  e2eConfig("e2e-multi", "stable", "g", "multi/**/*.test.js", ["multi", "multi.code-workspace"]),
];

if (process.env.REAL_CTX_ALICE) {
  // WP-3.1: the Extension Host scenarios against the REAL ctx (scripts/real-ctx-env.mjs test).
  // No CONTEXO_TEST_CTX: discovery finds $RUN/bin/ctx through contexo.path (seeded in the
  // profile's User/settings.json by the harness) and PATH. alice's isolated HOME, a profile
  // under $RUN, and REAL_CTX_OUT (default out) for a container lane's own compile output.
  const run = process.env.REAL_CTX_RUN ?? path.dirname(process.env.REAL_CTX_ALICE);
  const home = process.env.REAL_CTX_HOME_ALICE ?? path.join(run, "home-alice");
  configs.push({
    label: "real-ctx",
    version: "stable",
    files: `${process.env.REAL_CTX_OUT ?? "out"}/test/real-ctx/scenarios.real.js`,
    workspaceFolder: process.env.REAL_CTX_ALICE,
    env: {
      HOME: home,
      USERPROFILE: home,
      PATH: `${path.join(run, "bin")}${path.delimiter}${process.env.PATH ?? ""}`,
    },
    launchArgs: [
      "--disable-extensions",
      `--user-data-dir=${path.join(run, "vscode-user-data")}`,
      `--extensions-dir=${path.join(run, "vscode-ext")}`,
    ],
    mocha: { ...MOCHA, timeout: 120000, ...(process.env.REAL_CTX_GREP ? { grep: process.env.REAL_CTX_GREP } : {}) },
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
  if (c.e2eCopy) {
    rmSync(c.e2eCopy, { recursive: true, force: true });
    cpSync(path.join(ROOT, "test", "fixtures", "workspaces"), c.e2eCopy, {
      recursive: true,
      filter: (src) => path.basename(src) !== "calls.jsonl",
    });
  }
}
for (const c of configs) { delete c.e2eCopy; }

mkdirSync(CACHE, { recursive: true }); // test-electron creates only the last path segment
const executables = new Map();
for (const version of new Set(selected.map((c) => c.version))) {
  executables.set(version, await downloadAndUnzipVSCode({ version, cachePath: CACHE }));
}
for (const c of selected) {
  c.useInstallation = { fromPath: executables.get(c.version) };
}

export default defineConfig(configs);
