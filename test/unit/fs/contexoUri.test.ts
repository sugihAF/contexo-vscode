// contexo: URIs (src/fs/contexoUri.ts) in plain mocha: vscode-uri's URI stands in for
// vscode.Uri (same with/toString/parse semantics), so no vscode import is needed.
import * as assert from "node:assert/strict";
import { URI } from "vscode-uri";
import { CONTEXO_SCHEME, fromContexoUri, toContexoUri } from "../../../src/fs/contexoUri";

type VsUri = Parameters<typeof toContexoUri>[0];
const asVs = (u: URI): VsUri => u as unknown as VsUri;
const asUri = (u: VsUri): URI => u as unknown as URI;

interface Case { label: string; fileUri: URI; root: string; relPath: string; }

const SHA = "3f9c2b7e8a1d4c5f6b7a8e9d0c1b2a3f4e5d6c7b";
const REFS = ["base", "server", "empty", SHA] as const;

const CASES: Case[] = [
  {
    label: "spaces",
    fileUri: URI.file("/Users/alice/My Projects/pay ments/.contexo/wiki/concepts/auth flow.md"),
    root: "/Users/alice/My Projects/pay ments",
    relPath: "wiki/concepts/auth flow.md",
  },
  {
    label: "unicode",
    fileUri: URI.file("/home/zoë/プロジェクト/.contexo/wiki/entities/naïve-café.md"),
    root: "/home/zoë/プロジェクト",
    relPath: "wiki/entities/naïve-café.md",
  },
  {
    label: "reserved URI characters",
    fileUri: URI.file("/srv/a#b/c?d/100% done/.contexo/wiki/concepts/x&y=z.md"),
    root: "/srv/a#b/c?d/100% done",
    relPath: "wiki/concepts/x&y=z.md",
  },
  {
    // Built from a path with forward slashes so URI.file behaves the same on every OS.
    label: "Windows drive letter",
    fileUri: URI.file("C:/Users/Alice Tan/Work Space/.contexo/raw/sessions/2026-10-01-login-debug.md"),
    root: "C:\\Users\\Alice Tan\\Work Space",
    relPath: "raw/sessions/2026-10-01-login-debug.md",
  },
  {
    label: "lower-case drive letter + unicode",
    fileUri: URI.from({ scheme: "file", path: "/d:/Données/équipe/.contexo/wiki/analyses/sync-model.md" }),
    root: "d:\\Données\\équipe",
    relPath: "wiki/analyses/sync-model.md",
  },
];

describe("contexoUri", () => {
  it("round-trips base|server|empty|<sha> for paths with spaces, unicode and Windows drive letters; scheme contexo; path equals the file path", () => {
    assert.equal(CONTEXO_SCHEME, "contexo");
    for (const c of CASES) {
      for (const ref of REFS) {
        const label = `${c.label} @ ${ref}`;
        const u = asUri(toContexoUri(asVs(c.fileUri), ref, c.root, c.relPath));
        assert.equal(u.scheme, "contexo", `${label}: scheme`);
        assert.equal(u.path, c.fileUri.path, `${label}: path equals the file path`);
        assert.equal(u.authority, c.fileUri.authority, `${label}: authority kept`);

        // Directly, and through the string form VS Code stores and passes around. The
        // string form lower-cases a drive letter ('/C:' -> '/c:'), for file: URIs too, so
        // the parsed contexo: URI is compared with the equally parsed file: URI.
        const parsedFile = URI.parse(c.fileUri.toString());
        for (const [how, v, file] of [["direct", u, c.fileUri], ["parsed", URI.parse(u.toString()), parsedFile]] as const) {
          assert.equal(v.scheme, "contexo", `${label} (${how}): scheme`);
          assert.equal(v.path, file.path, `${label} (${how}): path`);
          const r = fromContexoUri(asVs(v));
          assert.equal(r.ref, ref, `${label} (${how}): ref`);
          assert.equal(r.root, c.root, `${label} (${how}): root`);
          assert.equal(r.relPath, c.relPath, `${label} (${how}): relPath`);
          const f = asUri(r.fileUri);
          assert.equal(f.scheme, "file", `${label} (${how}): fileUri scheme`);
          assert.equal(f.query, "", `${label} (${how}): fileUri query`);
          assert.equal(f.path, file.path, `${label} (${how}): fileUri path`);
          assert.equal(f.fsPath, c.fileUri.fsPath, `${label} (${how}): fileUri fsPath`);
          assert.equal(f.toString(), c.fileUri.toString(), `${label} (${how}): fileUri string`);
        }
      }
    }
  });

  it("the query is JSON {ref, root, path} (Git-style), and the file path keeps the language mode", () => {
    const c = CASES[0]!;
    const u = asUri(toContexoUri(asVs(c.fileUri), "server", c.root, c.relPath));
    assert.deepEqual(JSON.parse(u.query), { ref: "server", root: c.root, path: c.relPath });
    assert.ok(u.path.endsWith(".md"));
    assert.equal(u.fragment, "");
  });

  it("fromContexoUri rejects other schemes and malformed queries", () => {
    const file = CASES[0]!.fileUri;
    assert.throws(() => fromContexoUri(asVs(file)), /not a contexo: uri/);
    const bad = (query: string): URI => file.with({ scheme: CONTEXO_SCHEME, query });
    assert.throws(() => fromContexoUri(asVs(bad("not json"))), /malformed contexo: query/);
    assert.throws(() => fromContexoUri(asVs(bad("null"))), /malformed contexo: query/);
    assert.throws(() => fromContexoUri(asVs(bad(JSON.stringify({ ref: "base", root: "/r" })))), /malformed contexo: query/);
    assert.throws(() => fromContexoUri(asVs(bad(JSON.stringify({ ref: 1, root: "/r", path: "a.md" })))), /malformed contexo: query/);
  });
});
