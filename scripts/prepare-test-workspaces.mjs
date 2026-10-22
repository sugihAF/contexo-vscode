#!/usr/bin/env node
// Copies the committed test workspaces (test/fixtures/workspaces/*) to
// .vscode-test/workspaces/, replacing any previous copy, so VS Code host tests and the
// fake ctx (which appends .fake-ctx/calls.jsonl and rewrites .fake-ctx/current) never
// mutate the repository. Any calls.jsonl in the source is dropped.
//
// Usage: node scripts/prepare-test-workspaces.mjs [--from <dir>] [--out <dir>]
//   --from  source directory (default: test/fixtures/workspaces)
//   --out   destination directory (default: .vscode-test/workspaces); removed first
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
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
const CASE_INSENSITIVE_FS = process.platform === "darwin" || process.platform === "win32";

/** True when `child` is `dir` or below it (case-insensitive where the file system is). */
function within(dir, child) {
  const fold = (p) => (CASE_INSENSITIVE_FS ? resolve(p).toLowerCase() : resolve(p));
  const rel = relative(fold(dir), fold(child));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
// --out is deleted recursively: it must not be --from, sit inside it, contain it, or
// contain the repository.
if (within(from, out) || within(out, from) || within(out, REPO_ROOT)) {
  console.error("prepare-test-workspaces: --out must not be --from, inside it, or an ancestor of it or of the repository");
  process.exit(2);
}

/**
 * Copies the directory tree `src` to `dest` (files and directories only), skipping entries
 * for which keep(path) is false. Deliberately not fs.cpSync: Node 22 copies directories
 * natively (cpSyncCopyDir, std::filesystem), which on Windows mis-converts non-ASCII paths
 * and left basic/.fake-ctx missing under 'C:\Users\RUNNER~1\...\contexo ws src é-…' (D4).
 */
function copyTree(src, dest, keep) {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const s = join(src, entry.name);
    if (!keep(s)) { continue; }
    if (entry.isDirectory()) {
      copyTree(s, join(dest, entry.name), keep);
    } else if (entry.isFile()) {
      copyFileSync(s, join(dest, entry.name));
    } else {
      throw new Error(`prepare-test-workspaces: ${s} is neither a file nor a directory`);
    }
  }
}

rmSync(out, { recursive: true, force: true });
copyTree(from, out, (src) => basename(src) !== "calls.jsonl");
const names = readdirSync(out).sort();
console.log(`prepare-test-workspaces: ${names.join(", ")} -> ${out}`);
