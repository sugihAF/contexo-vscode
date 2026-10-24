// WP-6H.3 (NO-GO defect D3, acceptance row E17): with the server unreachable the status bar
// showed `$(cloud-offline) Contexo`, but no supported VS Code or Cursor build registers a
// `cloud-offline` codicon, so the item rendered as a blank gap + "Contexo" with no visible
// offline signal. A `$(name)` only renders when `name` is a registered codicon, so every
// icon the status bar can produce must be in the codicon list of VS Code 1.100.0 (the
// engines.vscode minimum, vendored in test/fixtures/codicons/known-codicons.txt), and the
// offline item must say "offline" in its visible text.
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { ERROR_CODES, type ErrorBody, type StatusDoc } from "../../../src/contract/types";
import type { ExtensionState } from "../../../src/model/types";
import { presentStatusBar, statusBarCommandsFor } from "../../../src/statusBar";
import { REPO_ROOT, loadStatusDoc } from "../../helpers/fixtures";

const KNOWN: ReadonlySet<string> = new Set(
  fs.readFileSync(path.join(REPO_ROOT, "test", "fixtures", "codicons", "known-codicons.txt"), "utf8")
    .split("\n").map((l) => l.trim()).filter((l) => l !== "" && !l.startsWith("#")),
);

const STATES: readonly ExtensionState[] = [
  "loading", "ctxMissing", "ctxTooOld", "extensionTooOld", "untrusted", "noRepositories", "notLoggedIn", "ready",
];
const OFFLINE_CODES = ["network", "server_error", "rate_limited"] as const;

/** The codicon ids of every `$(name)` / `$(name~modifier)` in a label. */
function icons(label: string): string[] {
  return [...label.matchAll(/\$\(([^)~]+)(?:~[^)]*)?\)/g)].map((m) => m[1] ?? "");
}

/** The label as the user reads it: icon tokens removed. */
function visibleText(label: string): string {
  return label.replace(/\$\([^)]*\)/g, "").trim();
}

function status(scenario: string, o: { offline?: boolean } = {}): StatusDoc {
  return structuredClone(loadStatusDoc(scenario, o));
}

/** e6-ready with remote.error replaced by `code` (remote.source none, like ctx reports it). */
function withRemoteError(code: ErrorBody["code"], message: string): StatusDoc {
  const st = status("e6-ready");
  st.remote = { source: "none", page_count: 0, error: { code, message, advice: [], retryable: false } as ErrorBody };
  return st;
}

/** Every status-bar label: the item for each state, status set and busy flag, plus the SCM commands. */
function everyStatusBarLabel(): { where: string; label: string }[] {
  const statusSets: [string, StatusDoc[]][] = [
    ["none", []],
    ...["e6-ready", "e6-not-authenticated", "e6-rejected", "e6-network-error", "e6-two-repos", "mixed", "clean"]
      .map((s): [string, StatusDoc[]] => [s, [status(s)]]),
    ...ERROR_CODES.map((c): [string, StatusDoc[]] => [`remote.error ${c}`, [withRemoteError(c, `${c} happened`)]]),
  ];
  const out: { where: string; label: string }[] = [];
  for (const state of STATES) {
    for (const [name, statuses] of statusSets) {
      for (const busy of [false, true]) {
        out.push({ where: `item ${state}/${name}/busy=${busy}`, label: presentStatusBar(state, statuses, busy).text });
      }
    }
  }
  for (const [name, st] of [["mixed", status("mixed")], ["clean", status("clean")], ["offline", status("mixed", { offline: true })]] as const) {
    for (const c of statusBarCommandsFor(st)) { out.push({ where: `scm ${name}`, label: c.title }); }
  }
  return out;
}

/** Every `$(name)` literal and ThemeIcon("name") id in src/**\/*.ts and the manifest. */
function staticIconRefs(): { where: string; id: string }[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); } else if (e.name.endsWith(".ts")) { files.push(p); }
    }
  };
  walk(path.join(REPO_ROOT, "src"));
  files.push(path.join(REPO_ROOT, "package.json"));
  const refs: { where: string; id: string }[] = [];
  for (const f of files) {
    const text = fs.readFileSync(f, "utf8");
    const rel = path.relative(REPO_ROOT, f);
    for (const id of icons(text)) { refs.push({ where: rel, id }); }
    for (const m of text.matchAll(/ThemeIcon\("([^"]+)"\)/g)) { refs.push({ where: rel, id: m[1] ?? "" }); }
  }
  return refs;
}

describe("WP-6H.3 offline-icon: every status-bar codicon exists in VS Code 1.100.0 (D3, E17)", () => {
  it("the vendored codicon list is the 1.100.0 set: complete, and without cloud-offline", () => {
    assert.ok(KNOWN.size >= 600, `only ${KNOWN.size} ids parsed`);
    for (const id of ["cloud", "cloud-upload", "cloud-download", "sync", "account", "debug-disconnect"]) {
      assert.ok(KNOWN.has(id), id);
    }
    assert.ok(!KNOWN.has("cloud-offline"), "no supported VS Code registers cloud-offline");
  });

  for (const code of OFFLINE_CODES) {
    it(`remote.error ${code}: a known codicon plus the word "offline", tooltip and Show Log kept`, () => {
      for (const busy of [false, true]) {
        const p = presentStatusBar("ready", [withRemoteError(code, `${code} happened`)], busy);
        const ids = icons(p.text);
        assert.ok(ids.length > 0, `the offline item has an icon: ${p.text}`);
        for (const id of ids) { assert.ok(KNOWN.has(id), `$(${id}) in "${p.text}" is not a VS Code 1.100.0 codicon`); }
        assert.match(visibleText(p.text), /\boffline\b/i, `the visible text says offline: "${p.text}"`);
        assert.match(visibleText(p.text), /Contexo/, p.text);
        assert.equal(p.tooltip, `${code} happened`);
        assert.deepEqual(p.command, { command: "contexo.showLog", title: "Show Log" });
      }
    });
  }

  it("the e6-network-error fixture (ctx status with the network down) shows the offline item", () => {
    const st = status("e6-network-error");
    const p = presentStatusBar("ready", [st], false);
    for (const id of icons(p.text)) { assert.ok(KNOWN.has(id), `$(${id}) in "${p.text}"`); }
    assert.match(visibleText(p.text), /\boffline\b/i, p.text);
    assert.equal(p.tooltip, st.remote.error?.message);
  });

  it("every $(name) the status bar item and SCM status bar commands can produce is a known codicon", () => {
    const labels = everyStatusBarLabel();
    const bad = labels.flatMap(({ where, label }) => icons(label).filter((id) => !KNOWN.has(id)).map((id) => `${where}: $(${id})`));
    assert.deepEqual([...new Set(bad)], []);
    assert.ok(labels.some(({ label }) => /\boffline\b/i.test(visibleText(label))), "the enumeration reaches the offline item");
  });

  it("every $(name) and ThemeIcon(\"name\") literal in src/ and package.json is a known codicon", () => {
    const refs = staticIconRefs();
    assert.ok(refs.some((r) => r.where === path.join("src", "statusBar.ts")), "the scan reads src/statusBar.ts");
    const bad = refs.filter((r) => !KNOWN.has(r.id)).map((r) => `${r.where}: ${r.id}`);
    assert.deepEqual(bad, []);
  });
});
