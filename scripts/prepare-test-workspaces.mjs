#!/usr/bin/env node
// Copies the committed test workspaces (test/fixtures/workspaces/*) to
// .vscode-test/workspaces/, replacing any previous copy, so VS Code host tests and the
// fake ctx (which appends .fake-ctx/calls.jsonl and rewrites .fake-ctx/current) never
// mutate the repository. Any calls.jsonl in the source is dropped.
//
// Usage: node scripts/prepare-test-workspaces.mjs [--from <dir>] [--out <dir>]
//   --from  source directory (default: test/fixtures/workspaces)
//   --out   destination directory (default: .vscode-test/workspaces); removed first
import { cpSync, existsSync, readdirSync, rmSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function option(name, fallback) {
  const i = process.argv.indexOf(name);
  if (i < 0) { return fallback; }
  const v = process.argv[i + 1];
  if (v === undefined || v.startsWith("--")) {
    console.error(`prepare-test-workspaces: ${name} needs a directory`);
    process.exit(2);
  }
  return resolve(v);
}

const from = option("--from", resolve(REPO_ROOT, "test", "fixtures", "workspaces"));
const out = option("--out", resolve(REPO_ROOT, ".vscode-test", "workspaces"));

if (!existsSync(from)) {
  console.error(`prepare-test-workspaces: ${from} does not exist`);
  process.exit(1);
}
const inside = relative(from, out);
if (inside === "" || (!inside.startsWith("..") && !isAbsolute(inside))) {
  console.error("prepare-test-workspaces: --out must not be inside --from");
  process.exit(2);
}

rmSync(out, { recursive: true, force: true });
cpSync(from, out, { recursive: true, filter: (src) => basename(src) !== "calls.jsonl" });
const names = readdirSync(out).sort();
console.log(`prepare-test-workspaces: ${names.join(", ")} -> ${out}`);
