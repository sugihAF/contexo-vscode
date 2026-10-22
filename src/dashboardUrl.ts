// Open in Dashboard URLs (contexo-web routes repos/:repoId and repos/:repoId/page/*).
// Pure: imports types only, so plain mocha unit tests load it without VS Code.
import type { ProjectInfo } from "./contract/types";

/**
 * The dashboard URL for a repository (no relPath) or one of its pages (relPath, '/'-separated
 * and relative to .contexo), or undefined when there is none to open: dashboard_url is not an
 * absolute http(s) URL ("" when self-hosted, E23), relPath has an empty, '.' or '..' segment,
 * the repo id is missing where the URL needs it, or the result leaves the dashboard's origin.
 */
export function buildDashboardUrl(project: ProjectInfo, relPath?: string): string | undefined {
  const base = project.dashboard_url;
  const baseUrl = parseWebUrl(base);
  if (!baseUrl) { return undefined; }
  const root = base.replace(/\/+$/, "");
  const repoId = project.repo_id ?? "";

  let url: string;
  if (relPath !== undefined && relPath !== "") {
    const segments = relPath.split("/");
    if (segments.some((seg) => seg === "" || seg === "." || seg === "..")) { return undefined; }
    const encoded = segments.map(encodeURIComponent).join("/");
    const template = project.dashboard_page_url_template;
    if (typeof template === "string" && template.includes("{path}")) {
      // split/join, never String.replace: a replacement string would expand '$&' patterns.
      url = template.split("{path}").join(encoded);
    } else if (repoId !== "") {
      url = `${root}/repos/${encodeURIComponent(repoId)}/page/${encoded}`;
    } else {
      return undefined;
    }
  } else {
    if (repoId === "") { return undefined; }
    url = `${root}/repos/${encodeURIComponent(repoId)}`;
  }

  const parsed = parseWebUrl(url);
  return parsed && parsed.origin === baseUrl.origin ? url : undefined;
}

/**
 * s as an absolute http: or https: URL, else undefined. Strings the URL parser would silently
 * repair (surrounding or embedded whitespace, control characters, '\' read as '/') are refused,
 * so the string handed to openExternal is exactly the one checked here.
 */
function parseWebUrl(s: string): URL | undefined {
  for (const ch of s) {
    const c = ch.charCodeAt(0);
    if (c <= 0x20 || c === 0x7f || ch === "\\") { return undefined; }
  }
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return undefined;
  }
  return u.protocol === "http:" || u.protocol === "https:" ? u : undefined;
}
