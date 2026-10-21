// Baseline fake-ctx scenarios and loaders. No vscode import: unit and host tests share it.
// The rule matcher mirrors test/fake-ctx/fake-ctx.mjs (pinned by fakeCtx.test.ts).
import * as fs from "node:fs";
import * as path from "node:path";
import type { StatusDoc, VersionDoc } from "../../src/contract/types";

/**
 * The baseline scenarios WP-0.6 owns. Wave-1 scenarios are e1-..e8- prefixed and owned
 * by those WPs; tests iterate this list, never readdir.
 */
export const BASELINE_SCENARIOS = [
  "clean",
  "mixed",
  "mixed-offline",
  "not-initialized",
  "not-authenticated",
  "ctx-too-old",
  "ctx-missing-caps",
  "ctx-contract2",
  "network-error",
  "push-success",
  "push-conflict",
  "push-distill-required",
  "pull-skipped",
  "resolve-theirs",
  "resolve-ours",
  "busy",
  "show-not-implemented",
] as const;
export type BaselineScenario = (typeof BASELINE_SCENARIOS)[number];

/** Repository root, found from this file's location (works from test/helpers and out/test/helpers). */
export const REPO_ROOT: string = findRepoRoot(__dirname);
export const SCENARIOS_DIR = path.join(REPO_ROOT, "test", "fixtures", "ctx", "scenarios");
export const WORKSPACES_DIR = path.join(REPO_ROOT, "test", "fixtures", "workspaces");
export const FAKE_CTX = path.join(REPO_ROOT, "test", "fake-ctx", "fake-ctx.mjs");

/** The fake ctx's built-in handshake document (test/fake-ctx/builtin-version.json): contract 1, 11 v1 capabilities + 'repair'. */
export const BUILTIN_VERSION_DOC: VersionDoc = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, "test", "fake-ctx", "builtin-version.json"), "utf8"),
) as VersionDoc;

/** One scenario.json rule. Files are relative to the scenario's directory ('..' allowed). */
export interface ScenarioOutput {
  stdout?: string;
  stdoutFile?: string;
  stderr?: string;
  stderrFile?: string;
  /** Process exit code (default 0). */
  exit?: number;
  delayMs?: number;
  /** After answering, rewrite <root>/.fake-ctx/current to this scenario (only when --root is given). */
  then?: string;
}
export interface ScenarioRule extends ScenarioOutput {
  /** Every token must be present in argv. */
  match: string[];
  /** No token may be present in argv. */
  unless?: string[];
}
export interface Scenario { rules: ScenarioRule[]; default?: ScenarioOutput; }

export function scenarioDir(name: string): string {
  return path.join(SCENARIOS_DIR, name);
}

export function loadScenario(name: string): Scenario {
  return JSON.parse(fs.readFileSync(path.join(scenarioDir(name), "scenario.json"), "utf8")) as Scenario;
}

/** argv without the value of `-m` (a commit message is free text, never a rule token). */
export function matchTokens(argv: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    out.push(argv[i] as string);
    if (argv[i] === "-m") { i++; }
  }
  return out;
}

/**
 * First rule whose match tokens are all in argv (minus the -m value) and whose unless
 * tokens are not; else the default, except for `version`, which never uses the default
 * (fake-ctx.mjs then answers with its built-in handshake; this returns undefined).
 */
export function selectRule(scenario: Scenario, argv: readonly string[]): ScenarioOutput | undefined {
  const tokens = matchTokens(argv);
  for (const rule of scenario.rules) {
    if (rule.match.every((t) => tokens.includes(t)) && !(rule.unless ?? []).some((t) => tokens.includes(t))) {
      return rule;
    }
  }
  return argv[0] === "version" ? undefined : scenario.default;
}

/**
 * What the fake ctx would print for argv (no delay, no `then`), including its built-in
 * handshake for a `version --json` / `version --short` the scenario has no rule for.
 * undefined when the fake would fail with its internal 'no rule' envelope.
 */
export function scenarioOutput(name: string, argv: readonly string[]): { stdout: string; stderr: string; exit: number } | undefined {
  const rule = selectRule(loadScenario(name), argv);
  if (!rule) { return builtinVersionOutput(argv); }
  return {
    stdout: readText(name, rule.stdout, rule.stdoutFile),
    stderr: readText(name, rule.stderr, rule.stderrFile),
    exit: rule.exit ?? 0,
  };
}

/** The StatusDoc a scenario returns for `status --json [--offline] --root R`. */
export function loadStatusDoc(name: string, o: { offline?: boolean } = {}): StatusDoc {
  const argv = ["status", "--json", ...(o.offline ? ["--offline"] : []), "--root", "/fixture-root"];
  const out = scenarioOutput(name, argv);
  if (!out || out.exit !== 0 || out.stdout.trim() === "") {
    throw new Error(`scenario ${name} has no StatusDoc for ${argv.join(" ")}`);
  }
  return JSON.parse(out.stdout) as StatusDoc;
}

/** Every stdout/stderr payload of a scenario's rules and default, for schema checks. */
export interface ScenarioPayload {
  scenario: string;
  /** Rule index, or 'default'. */
  rule: number | "default";
  /** match[0] of the rule ('status', 'show', 'version', ...); '' for the default. */
  command: string;
  stream: "stdout" | "stderr";
  /** Absolute file path, or 'inline'. */
  source: string;
  text: string;
  exit: number;
}

export function scenarioPayloads(name: string): ScenarioPayload[] {
  const sc = loadScenario(name);
  const entries: [number | "default", string, ScenarioOutput][] = sc.rules.map((r, i) => [i, r.match[0] ?? "", r]);
  if (sc.default) { entries.push(["default", "", sc.default]); }
  const out: ScenarioPayload[] = [];
  for (const [rule, command, r] of entries) {
    const exit = r.exit ?? 0;
    if (r.stdout !== undefined || r.stdoutFile !== undefined) {
      out.push({ scenario: name, rule, command, stream: "stdout", source: sourceOf(name, r.stdoutFile), text: readText(name, r.stdout, r.stdoutFile), exit });
    }
    if (r.stderr !== undefined || r.stderrFile !== undefined) {
      out.push({ scenario: name, rule, command, stream: "stderr", source: sourceOf(name, r.stderrFile), text: readText(name, r.stderr, r.stderrFile), exit });
    }
  }
  return out;
}

/** fake-ctx.mjs's built-in handshake output, or undefined when it does not answer argv. */
export function builtinVersionOutput(argv: readonly string[]): { stdout: string; stderr: string; exit: number } | undefined {
  if (argv[0] !== "version") { return undefined; }
  if (argv.includes("--json")) { return { stdout: `${JSON.stringify(BUILTIN_VERSION_DOC, null, 2)}\n`, stderr: "", exit: 0 }; }
  if (argv.includes("--short")) { return { stdout: `${BUILTIN_VERSION_DOC.version}\n`, stderr: "", exit: 0 }; }
  return undefined;
}

function sourceOf(name: string, file: string | undefined): string {
  return file === undefined ? "inline" : path.resolve(scenarioDir(name), file);
}

function readText(name: string, inline: string | undefined, file: string | undefined): string {
  if (file !== undefined) { return fs.readFileSync(path.resolve(scenarioDir(name), file), "utf8"); }
  return inline ?? "";
}

function findRepoRoot(start: string): string {
  let dir = start;
  for (;;) {
    if (fs.existsSync(path.join(dir, "package.json")) && fs.existsSync(path.join(dir, "tsconfig.test.json"))) { return dir; }
    const parent = path.dirname(dir);
    if (parent === dir) { throw new Error(`repo root not found above ${start}`); }
    dir = parent;
  }
}
