// WP-1.8: src/model/paths.ts, the vscode-free path core plus its Uri adapter.
import * as assert from "node:assert/strict";
import {
  fileUriOf,
  isCaseInsensitive,
  pathKey,
  relPathOfUri,
  relativeUnder,
  samePath,
  uriContains,
} from "../../../src/model/paths";
import { vscodeStub } from "../../helpers/vscodeStub";

const { Uri } = vscodeStub;

describe("model/paths", () => {
  it("WIKI/Concepts/Auth-Flow.md matches wiki/concepts/auth-flow.md on darwin and win32, not on linux", () => {
    const upper = "WIKI/Concepts/Auth-Flow.md";
    const lower = "wiki/concepts/auth-flow.md";
    assert.equal(samePath(upper, lower, "darwin"), true);
    assert.equal(samePath(upper, lower, "win32"), true);
    assert.equal(samePath(upper, lower, "linux"), false);
    assert.equal(pathKey(upper, "darwin"), pathKey(lower, "darwin"));
    assert.notEqual(pathKey(upper, "linux"), pathKey(lower, "linux"));

    const dir = Uri.file("/ws/repo/.contexo");
    const upperUri = Uri.file("/WS/Repo/.contexo/WIKI/Concepts/Auth-Flow.md");
    assert.equal(relPathOfUri(dir, upperUri, "darwin"), upper, "the file's own spelling is kept");
    assert.equal(relPathOfUri(dir, upperUri, "win32"), upper);
    assert.equal(relPathOfUri(dir, upperUri, "linux"), undefined, "/WS/Repo is another directory on linux");
    assert.equal(isCaseInsensitive("darwin"), true);
    assert.equal(isCaseInsensitive("win32"), true);
    assert.equal(isCaseInsensitive("linux"), false);
  });

  it("relPath to Uri never concatenates strings", () => {
    const dir = Uri.file("/ws/my repo/.contexo");
    const rel = "wiki/concepts/a #b?c%20d.md";
    const u = fileUriOf(dir, rel);
    // String concatenation into Uri.parse would turn '#' into a fragment and '?' into a query,
    // and '%20' into a space.
    assert.equal(u.scheme, "file");
    assert.equal(u.path, "/ws/my repo/.contexo/wiki/concepts/a #b?c%20d.md");
    assert.equal(u.query, "");
    assert.equal(u.fragment, "");
    assert.equal(u.toString(), Uri.joinPath(dir, "wiki", "concepts", "a #b?c%20d.md").toString());
    assert.equal(relPathOfUri(dir, u, "linux"), rel, "round trip");

    const win = Uri.file("C:\\ws\\repo\\.contexo");
    const w = fileUriOf(win, "wiki/x.md");
    assert.equal(w.toString(), Uri.joinPath(win, "wiki", "x.md").toString());
    assert.equal(relPathOfUri(win, w, "win32"), "wiki/x.md");
  });

  it("relativeUnder: outside, equal, sibling-prefix and trailing-slash cases", () => {
    assert.equal(relativeUnder("/ws/.contexo", "/ws/.contexo/wiki/a.md", "linux"), "wiki/a.md");
    assert.equal(relativeUnder("/ws/.contexo/", "/ws/.contexo/wiki/a.md", "linux"), "wiki/a.md");
    assert.equal(relativeUnder("/ws/.contexo", "/ws/.contexo", "linux"), undefined, "equal is not below");
    assert.equal(relativeUnder("/ws/.contexo", "/ws/.contexo/", "linux"), undefined);
    assert.equal(relativeUnder("/ws/.contexo", "/ws/.contexo-old/a.md", "linux"), undefined, "a sibling sharing the prefix");
    assert.equal(relativeUnder("/ws/.contexo", "/other/a.md", "linux"), undefined);
    assert.equal(relativeUnder("/ws/.contexo", "/WS/.CONTEXO/a.md", "darwin"), "a.md");
  });

  it("relPathOfUri accepts file: and contexo: URIs only", () => {
    const dir = Uri.file("/ws/.contexo");
    const file = Uri.file("/ws/.contexo/wiki/a.md");
    assert.equal(relPathOfUri(dir, file, "linux"), "wiki/a.md");
    assert.equal(relPathOfUri(dir, file.with({ scheme: "contexo", query: "{}" }), "linux"), "wiki/a.md");
    assert.equal(relPathOfUri(dir, file.with({ scheme: "untitled" }), "linux"), undefined);
    assert.equal(relPathOfUri(dir, Uri.file("/ws/README.md"), "linux"), undefined);
  });

  it("uriContains: a root contains itself and its descendants, never a sibling", () => {
    const root = Uri.file("/ws/alpha");
    assert.equal(uriContains(root, Uri.file("/ws/alpha"), "linux"), true);
    assert.equal(uriContains(root, Uri.file("/ws/alpha/.contexo/wiki/a.md"), "linux"), true);
    assert.equal(uriContains(root, Uri.file("/ws/alphabet/a.md"), "linux"), false);
    assert.equal(uriContains(root, Uri.file("/WS/ALPHA/a.md"), "darwin"), true);
    assert.equal(uriContains(root, Uri.file("/WS/ALPHA/a.md"), "linux"), false);
    assert.equal(uriContains(root, Uri.file("/ws/alpha/a.md").with({ scheme: "untitled" }), "linux"), false);
  });
});
