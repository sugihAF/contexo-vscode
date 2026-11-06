// WP-6H.4 (lead ruling L51): the VS Marketplace rejected 0.2.0 as "does not align with the VS
// Marketplace policy" without naming a rule. 0.2.1 removes the likely triggers: Install ctx no
// longer pipes a remote script into a shell (it opens the install instructions on GitHub), the
// listing and UI make no "official" claim, the package names no contexo.live host, and a
// PRIVACY.md (kept out of the VSIX) states what the extension and ctx send.
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as session from "../../../src/commands/session";
import type { Services } from "../../../src/services";
import type { ConfirmOptions } from "../../../src/ui/prompts";
import type { URI } from "vscode-uri";
import { REPO_ROOT } from "../../helpers/fixtures";

const INSTALL_URL = "https://github.com/sugihAF/Contexo#install";
const README_URL = "https://github.com/sugihAF/contexo-vscode#readme";
const PRIVACY_URL = "https://github.com/sugihAF/contexo-vscode/blob/HEAD/PRIVACY.md";
const DESCRIPTION = "Contexo for the ctx CLI: your team knowledge base in Source Control, with push, pull and conflict resolution.";

/** Listing and UI text the Marketplace reviews: no contexo.live host, no piped install, no "official" claim. */
const FORBIDDEN: readonly [string, RegExp][] = [
  ["contexo.live", /contexo\.live/i],
  ["| sh", /\|\s*sh\b/],
  ["| iex", /\|\s*iex\b/i],
  ["iwr ", /\biwr\s/i],
  ["curl ", /\bcurl\s/i],
  ["official", /official/i],
];
/** The piped-install strings src/ must not hold (comments citing scripts/install.sh are fine). */
const PIPED_INSTALL: readonly [string, RegExp][] = FORBIDDEN.filter(([name]) => name !== "contexo.live" && name !== "official");

function read(rel: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");
}

function hits(text: string, patterns: readonly [string, RegExp][]): string[] {
  const found: string[] = [];
  text.split("\n").forEach((line, i) => {
    for (const [name, re] of patterns) {
      if (re.test(line)) { found.push(`${i + 1}: [${name}] ${line.trim()}`); }
    }
  });
  return found;
}

/** The first `## ` entry of CHANGELOG.md, heading included. */
function latestChangelogEntry(): string {
  const lines = read("CHANGELOG.md").split("\n");
  const start = lines.findIndex((l) => l.startsWith("## "));
  assert.ok(start >= 0, "CHANGELOG.md has an entry");
  const next = lines.findIndex((l, i) => i > start && l.startsWith("## "));
  return lines.slice(start, next < 0 ? undefined : next).join("\n");
}

function srcFiles(dir = path.join(REPO_ROOT, "src")): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? srcFiles(p) : e.name.endsWith(".ts") ? [p] : [];
  });
}

interface Pkg {
  version: string;
  description: string;
  homepage: string;
  contributes: { viewsWelcome: { when: string; contents: string }[] };
}

describe("WP-6H.4 marketplace-remediation: no piped install, no official claim, no contexo.live host (L51)", () => {
  for (const file of ["package.json", "README.md"]) {
    it(`${file} has no contexo.live, '| sh', '| iex', 'iwr ', 'curl ' or "official"`, () => {
      assert.deepEqual(hits(read(file), FORBIDDEN), []);
    });
  }

  it("the latest CHANGELOG.md entry is this version and has none of them either", () => {
    const entry = latestChangelogEntry();
    const pkg = JSON.parse(read("package.json")) as Pkg;
    assert.equal(entry.split("\n")[0], `## ${pkg.version} (preview)`);
    assert.deepEqual(hits(entry, FORBIDDEN), []);
  });

  it("src/ holds none of the piped-install strings", () => {
    const found = srcFiles().flatMap((f) => hits(fs.readFileSync(f, "utf8"), PIPED_INSTALL).map((h) => `${path.relative(REPO_ROOT, f)}:${h}`));
    assert.deepEqual(found, []);
  });

  it("package.json: the neutral description, the GitHub homepage and the GitHub docs link in the welcome view", () => {
    const pkg = JSON.parse(read("package.json")) as Pkg;
    assert.equal(pkg.description, DESCRIPTION);
    assert.equal(pkg.homepage, README_URL);
    const noRepos = pkg.contributes.viewsWelcome.find((v) => v.when === "contexo.state == noRepositories");
    assert.ok(noRepos?.contents.includes(`[Read the docs](${README_URL})`), `the noRepositories welcome links the README: ${noRepos?.contents}`);
  });

  it("README.md links the install instructions and PRIVACY.md on GitHub", () => {
    const readme = read("README.md");
    assert.ok(readme.includes(`(${INSTALL_URL})`), "the install section links the Contexo install instructions");
    assert.ok(readme.includes(`(${PRIVACY_URL})`), "Security and privacy links PRIVACY.md");
  });

  it("PRIVACY.md exists at the repo root, names no contexo.live URL and stays out of the VSIX", () => {
    const privacy = read("PRIVACY.md");
    assert.deepEqual(hits(privacy, FORBIDDEN.filter(([name]) => name === "contexo.live")), []);
    for (const phrase of ["telemetry", "X-Contexo-Client", "Workspace Trust"]) {
      assert.ok(privacy.includes(phrase), `PRIVACY.md mentions ${phrase}`);
    }
    const ignored = read(".vscodeignore").split("\n").map((l) => l.trim());
    assert.ok(ignored.includes("PRIVACY.md"), ".vscodeignore keeps PRIVACY.md out of the VSIX");
  });

  it("installCtx opens the install instructions in the browser: no confirm, no terminal, no shell, no ctx", async () => {
    assert.equal(session.INSTALL_DOCS_URL, INSTALL_URL);
    assert.equal("INSTALL_COMMANDS" in session, false, "no install one-liners are exported");
    assert.equal("installCommandFor" in session, false, "no install command builder is exported");

    const opened: string[] = [];
    const confirms: [string, ConfirmOptions][] = [];
    const infos: string[][] = [];
    const prompts = {
      info: async (message: string, ...actions: string[]) => { infos.push([message, ...actions]); return undefined; },
      confirm: async (message: string, options: ConfirmOptions) => { confirms.push([message, options]); return true; },
      openExternal: async (uri: URI) => { opened.push(uri.toString(true)); return true; },
    };
    // Any other member (cli, model, context, log, or a prompt such as warn) throws, and so does
    // vscode.window (createTerminal) under the unit stub.
    const s = new Proxy({ prompts }, {
      get(target, key) {
        if (key === "prompts") { return target.prompts; }
        throw new Error(`installCtx used services.${String(key)}`);
      },
    }) as unknown as Services;

    await session.installCtx(s);

    assert.deepEqual(opened, [INSTALL_URL]);
    assert.deepEqual(confirms, [], "no modal confirm");
    assert.ok(infos.every((m) => hits(m.join(" "), PIPED_INSTALL).length === 0), `no install command in a message: ${JSON.stringify(infos)}`);
  });
});
