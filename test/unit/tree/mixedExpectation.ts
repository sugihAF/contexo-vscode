// The Knowledge tree WP-1.11 expects for the WP-0.6 'mixed' baseline (E30), shared by the
// pure unit test (test/unit/tree/treeModel.test.ts) and the host test
// (test/integration/e5-tree.test.ts). No vscode import.

export interface ExpectedPage { label: string; path: string; contextValue: string; description?: string }
export interface ExpectedGroup { key: string; label: string; pages: ExpectedPage[] }

/** captures.pending of mixed. */
export const MIXED_PENDING = 2;
/** captures.pending + counts.conflict of mixed. */
export const MIXED_BADGE = { value: 3, tooltip: "2 agent session(s) pending · 1 conflict(s)" };

/** Groups in display order (empty groups absent), pages sorted by label. */
export const MIXED_GROUPS: readonly ExpectedGroup[] = [
  {
    key: "concepts",
    label: "Concepts",
    pages: [
      { label: "Auth flow", path: "wiki/concepts/auth-flow.md", contextValue: "page.modified", description: "auth, security" },
      { label: "Legacy sync", path: "wiki/concepts/legacy-sync.md", contextValue: "page.unverified", description: "sync, migration" },
      { label: "Rate limits", path: "wiki/concepts/rate-limits.md", contextValue: "page.conflict", description: "api, limits" },
      { label: "Retry policy", path: "wiki/concepts/retry-policy.md", contextValue: "page.incoming", description: "api, retries" },
    ],
  },
  {
    key: "entities",
    label: "Entities",
    pages: [{ label: "Gitstore", path: "wiki/entities/gitstore.md", contextValue: "page.unchanged", description: "server, storage" }],
  },
  {
    key: "analyses",
    label: "Analyses",
    pages: [{ label: "Sync model", path: "wiki/analyses/sync-model.md", contextValue: "page.new", description: "sync, architecture" }],
  },
  {
    key: "sessions",
    label: "Sessions",
    pages: [{ label: "Login debug session", path: "raw/sessions/2026-10-01-login-debug.md", contextValue: "page.unchanged", description: "auth, debugging" }],
  },
  {
    key: "invalid",
    label: "Invalid",
    pages: [{
      label: "broken",
      path: "wiki/concepts/broken.md",
      contextValue: "page.invalid",
      description: "page: parse frontmatter: yaml: line 9: found unexpected end of stream",
    }],
  },
];
