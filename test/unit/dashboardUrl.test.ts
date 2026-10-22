// buildDashboardUrl (src/dashboardUrl.ts) in plain mocha: Open in Dashboard URLs from a
// StatusDoc's ProjectInfo, including the scheme, path-segment and same-origin guards.
import * as assert from "node:assert/strict";
import type { ProjectInfo } from "../../src/contract/types";
import { buildDashboardUrl } from "../../src/dashboardUrl";
import { loadStatusDoc } from "../helpers/fixtures";

/** A fresh copy of a scenario's ProjectInfo (safe to mutate). */
function project(scenario: string): ProjectInfo {
  return structuredClone(loadStatusDoc(scenario).project);
}

/** e6-ready's project without dashboard_page_url_template (the repo_id fallback). */
function untemplated(): ProjectInfo {
  const p = project("e6-ready");
  delete p.dashboard_page_url_template;
  return p;
}

describe("buildDashboardUrl", () => {
  it("the page URL is https://app.example.test/repos/r_test/page/wiki/concepts/auth-flow.md", () => {
    const p = project("e6-ready");
    assert.equal(p.dashboard_page_url_template, "https://app.example.test/repos/r_test/page/{path}", "fixture precondition");
    assert.equal(
      buildDashboardUrl(p, "wiki/concepts/auth-flow.md"),
      "https://app.example.test/repos/r_test/page/wiki/concepts/auth-flow.md",
    );
  });

  it("the repo URL is https://app.example.test/repos/r_test (no relPath, or an empty one)", () => {
    assert.equal(buildDashboardUrl(project("e6-ready")), "https://app.example.test/repos/r_test");
    assert.equal(buildDashboardUrl(project("e6-ready"), ""), "https://app.example.test/repos/r_test");
  });

  it("a repo id containing / is encoded", () => {
    const p = project("e6-ready");
    p.repo_id = "team/r1";
    assert.equal(buildDashboardUrl(p), "https://app.example.test/repos/team%2Fr1");
    const q = untemplated();
    q.repo_id = "team/r1";
    assert.equal(buildDashboardUrl(q, "wiki/a.md"), "https://app.example.test/repos/team%2Fr1/page/wiki/a.md");
  });

  it("a path with spaces is encoded per segment", () => {
    assert.equal(
      buildDashboardUrl(project("e6-ready"), "wiki/concepts/my page.md"),
      "https://app.example.test/repos/r_test/page/wiki/concepts/my%20page.md",
    );
    assert.equal(
      buildDashboardUrl(untemplated(), "wiki/concepts/my page.md"),
      "https://app.example.test/repos/r_test/page/wiki/concepts/my%20page.md",
      "same encoding without a template",
    );
    assert.equal(
      buildDashboardUrl(project("e6-ready"), "wiki/a?b#c/x%y.md"),
      "https://app.example.test/repos/r_test/page/wiki/a%3Fb%23c/x%25y.md",
      "reserved characters inside a segment are escaped",
    );
  });

  it("without a template the page URL is <dashboard_url>/repos/<repo_id>/page/<path>, trailing '/' dropped", () => {
    assert.equal(
      buildDashboardUrl(untemplated(), "wiki/concepts/auth-flow.md"),
      "https://app.example.test/repos/r_test/page/wiki/concepts/auth-flow.md",
    );
    const p = untemplated();
    p.dashboard_url = "https://app.example.test/";
    assert.equal(buildDashboardUrl(p), "https://app.example.test/repos/r_test");
    assert.equal(buildDashboardUrl(p, "wiki/a.md"), "https://app.example.test/repos/r_test/page/wiki/a.md");
    const t = untemplated();
    t.dashboard_page_url_template = "https://app.example.test/no-placeholder";
    assert.equal(
      buildDashboardUrl(t, "wiki/a.md"),
      "https://app.example.test/repos/r_test/page/wiki/a.md",
      "a template without {path} is ignored",
    );
  });

  it("a missing or empty repo_id gives no repo URL, and no page URL without a template", () => {
    for (const repoId of [undefined, ""]) {
      const p = project("e6-ready");
      if (repoId === undefined) { delete p.repo_id; } else { p.repo_id = repoId; }
      assert.equal(buildDashboardUrl(p), undefined, `repo_id ${String(repoId)}: repo URL`);
      assert.equal(
        buildDashboardUrl(p, "wiki/a.md"),
        "https://app.example.test/repos/r_test/page/wiki/a.md",
        `repo_id ${String(repoId)}: the template still works`,
      );
      delete p.dashboard_page_url_template;
      assert.equal(buildDashboardUrl(p, "wiki/a.md"), undefined, `repo_id ${String(repoId)}: page URL without a template`);
    }
  });

  it("javascript: and file: dashboard URLs return undefined", () => {
    const bad = [
      "javascript:alert(1)",
      "file:///etc/passwd",
      "data:text/html,<script>alert(1)</script>",
      "vscode://contexo.contexo/x",
      "ftp://app.example.test",
      "app.example.test",
      "/repos",
      "not a url",
    ];
    for (const url of bad) {
      for (const templated of [true, false]) {
        const p = templated ? project("e6-ready") : untemplated();
        p.dashboard_url = url;
        assert.equal(buildDashboardUrl(p), undefined, `${url} (template ${templated}): repo URL`);
        assert.equal(buildDashboardUrl(p, "wiki/a.md"), undefined, `${url} (template ${templated}): page URL`);
      }
    }
  });

  it('dashboard_url "" returns undefined', () => {
    const p = project("e6-self-hosted");
    assert.equal(p.dashboard_url, "", "fixture precondition (E23)");
    assert.equal(p.dashboard_page_url_template, undefined, "fixture precondition (E23)");
    assert.equal(buildDashboardUrl(p), undefined);
    assert.equal(buildDashboardUrl(p, "wiki/concepts/auth-flow.md"), undefined);
    p.dashboard_page_url_template = "https://contexo.internal.example/page/{path}";
    assert.equal(buildDashboardUrl(p, "wiki/concepts/auth-flow.md"), undefined, "a template alone is not enough");
  });

  it("an empty, '.' or '..' path segment returns undefined", () => {
    for (const rel of ["../secrets.md", "wiki/../../x.md", "./wiki/a.md", "wiki/./a.md", "wiki//a.md", "/wiki/a.md", "wiki/a.md/", "..", "."]) {
      assert.equal(buildDashboardUrl(project("e6-ready"), rel), undefined, `${rel} (template)`);
      assert.equal(buildDashboardUrl(untemplated(), rel), undefined, `${rel} (no template)`);
    }
  });

  it("a template whose origin differs from dashboard_url returns undefined", () => {
    for (const template of [
      "https://evil.example/repos/r_test/page/{path}",
      "http://app.example.test/repos/r_test/page/{path}",
      "https://app.example.test:8443/repos/r_test/page/{path}",
      "javascript:{path}",
      "//app.example.test/{path}",
      "{path}",
    ]) {
      const p = project("e6-ready");
      p.dashboard_page_url_template = template;
      assert.equal(buildDashboardUrl(p, "wiki/a.md"), undefined, template);
    }
  });

  it("a relPath containing $& is inserted literally", () => {
    assert.equal(
      buildDashboardUrl(project("e6-ready"), "wiki/$&$1$$.md"),
      "https://app.example.test/repos/r_test/page/wiki/%24%26%241%24%24.md",
    );
  });

  it("every {path} in the template is replaced", () => {
    const p = project("e6-ready");
    p.dashboard_page_url_template = "https://app.example.test/page/{path}?from={path}";
    assert.equal(buildDashboardUrl(p, "wiki/a b.md"), "https://app.example.test/page/wiki/a%20b.md?from=wiki/a%20b.md");
  });

  it("a base or template with whitespace, control characters or a backslash returns undefined", () => {
    for (const url of [" https://app.example.test", "https://app.example.test\n", "https://app.exa\tmple.test", "https:\\\\app.example.test"]) {
      const p = project("e6-ready");
      p.dashboard_url = url;
      assert.equal(buildDashboardUrl(p), undefined, JSON.stringify(url));
    }
    for (const template of ["https://app.example.test/page/{path} ", "https://app.example.test\\page\\{path}"]) {
      const p = project("e6-ready");
      p.dashboard_page_url_template = template;
      assert.equal(buildDashboardUrl(p, "wiki/a.md"), undefined, JSON.stringify(template));
    }
  });

  it("accepts an http: dashboard and keeps a dashboard path prefix", () => {
    const p = untemplated();
    p.dashboard_url = "http://localhost:5173/dash/";
    assert.equal(buildDashboardUrl(p), "http://localhost:5173/dash/repos/r_test");
    assert.equal(buildDashboardUrl(p, "wiki/a.md"), "http://localhost:5173/dash/repos/r_test/page/wiki/a.md");
  });
});
