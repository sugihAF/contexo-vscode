// The vendored Go contract fixtures (test/fixtures/contract/v1, copied from
// internal/syncops/contract/testdata/v1) through the handshake gate (src/cli/capabilities.ts)
// exactly as discovery feeds a `ctx version --json` run. Plain mocha: no vscode, no process.
import * as assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { classifyProbe, gate, isHandshake } from "../../../src/cli/capabilities";
import type { ProcessResult } from "../../../src/cli/spawn";
import type { BinaryState } from "../../../src/cli/types";
import { REQUIRED_CAPABILITIES, type VersionDoc } from "../../../src/contract/types";
import { REPO_ROOT } from "../../helpers/fixtures";

const CONTRACT_DIR = path.join(REPO_ROOT, "test", "fixtures", "contract", "v1");
const BIN = "/opt/contexo/bin/ctx";

interface ManifestEntry {
  file: string;
  schema: string | null;
  command: string | null;
  stream: "stdout" | "stderr" | "raw" | "data";
  exit_code: number | null;
  sha256: string;
}

/** The expected BinaryState of each vendored version fixture (bytes = the parsed fixture). */
const EXPECTED: Record<string, (doc: VersionDoc) => BinaryState> = {
  "version.release.json": (doc) => ({ kind: "ok", path: BIN, version: doc }),
  "version.dev.json": (doc) => ({ kind: "ok", path: BIN, version: doc }),
  "version.missing-caps.json": () => ({
    kind: "tooOld", path: BIN, versionText: "0.6.9",
    missing: REQUIRED_CAPABILITIES.filter((c) => c === "push.distill_guard" || c === "resolve"),
  }),
  "version.contract2.json": () => ({ kind: "extensionTooOld", path: BIN, contractVersion: 2 }),
};

describe("contract v1 handshake fixtures", () => {
  it("every vendored version.*.json maps to the expected BinaryState", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(CONTRACT_DIR, "manifest.json"), "utf8")) as { fixtures: ManifestEntry[] };
    const entries = manifest.fixtures.filter((e) => e.schema === "ctx.version.v1");
    const seen = new Set<string>();
    const failures: string[] = [];
    for (const e of entries) {
      const expect = EXPECTED[e.file];
      if (expect === undefined) { failures.push(`${e.file}: a ctx.version.v1 fixture without an expected BinaryState`); continue; }
      seen.add(e.file);
      assert.equal(e.command, "version", e.file);
      assert.equal(e.stream, "stdout", e.file);
      const bytes = fs.readFileSync(path.join(CONTRACT_DIR, e.file));
      assert.equal(createHash("sha256").update(bytes).digest("hex"), e.sha256, `${e.file} is the vendored bytes`);
      const json: ProcessResult = {
        args: ["version", "--json"], stdout: bytes, stderr: "", exitCode: e.exit_code ?? 0, signal: null, durationMs: 1,
      };
      assert.equal(isHandshake(json), true, `${e.file} is a handshake (no version --short probe)`);
      const state = gate(BIN, classifyProbe(json));
      assert.deepEqual(state, expect(JSON.parse(bytes.toString("utf8")) as VersionDoc), e.file);
    }
    assert.deepEqual(failures, []);
    // every version fixture the gate is pinned to is still in the manifest
    assert.deepEqual([...seen].sort(), Object.keys(EXPECTED).sort());
    // and the manifest lists every version.*.json on disk
    const onDisk = fs.readdirSync(CONTRACT_DIR).filter((f) => /^version\..*\.json$/.test(f)).sort();
    assert.deepEqual(onDisk, [...seen].sort());
  });
});
