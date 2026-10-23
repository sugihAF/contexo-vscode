// WP-1.11: the pure Knowledge-tree model (src/tree/treeModel.ts) and the TreeItem mapping
// (src/tree/treeItems.ts, loaded against the test:unit vscode stub). Membership follows
// Contract erratum E30; expectations for 'mixed' come from mixedExpectation.ts.
import * as assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { COMMAND_IDS } from "../../../src/commands/ids";
import type { PageEntry, StatusDoc } from "../../../src/contract/types";
import { pageItem, pendingItem } from "../../../src/tree/treeItems";
import {
  NOT_LOGGED_IN_MESSAGE,
  PUSH_BLOCKED_SENTENCE,
  buildTree,
  pageDescription,
  pageLabel,
  rendersPages,
  treeBadge,
  treeMessage,
  treeSignature,
  type GroupNode,
  type PageNode,
  type PendingNode,
  type RepoNode,
  type TreeNode,
} from "../../../src/tree/treeModel";
import { loadStatusDoc } from "../../helpers/fixtures";
import { vscodeStub } from "../../helpers/vscodeStub";
import { MIXED_BADGE, MIXED_GROUPS, MIXED_PENDING } from "./mixedExpectation";

const ROOT = "/fixture-root";
const ON = { showSessions: true };

function one(status: StatusDoc | undefined, opts = ON): TreeNode[] {
  return buildTree([{ root: ROOT, name: "fixture-root", status }], opts);
}
function groups(nodes: TreeNode[]): GroupNode[] {
  return nodes.filter((n): n is GroupNode => n.kind === "group");
}
function group(nodes: TreeNode[], key: string): GroupNode | undefined {
  return groups(nodes).find((g) => g.key === key);
}
function allPages(nodes: TreeNode[]): PageNode[] {
  return groups(nodes).flatMap((g) => g.pages);
}
/** A StatusDoc with exactly these pages (counts and captures zeroed unless given). */
function docWith(pages: Partial<PageEntry>[], captures?: Partial<StatusDoc["captures"]>): StatusDoc {
  const base = loadStatusDoc("mixed");
  return {
    ...base,
    pages: pages.map((p) => ({ tags: [], notes: [], state: "unchanged", path: "wiki/concepts/x.md", local: { file: p.path ?? "wiki/concepts/x.md" }, ...p }) as PageEntry),
    counts: { ...base.counts, conflict: 0 },
    captures: { pending: 0, fresh: 0, blocks_push: false, sessions: [], ...captures },
  };
}
const fileUri = (rel: string) => vscodeStub.Uri.joinPath(vscodeStub.Uri.file(`${ROOT}/.contexo`), ...rel.split("/"));

describe("WP-1.11 tree model (E30)", () => {
  describe("part 1: membership", () => {
    it("mixed: Concepts 4 (auth-flow, legacy-sync, rate-limits, retry-policy), Entities 1 (gitstore), Analyses 1 (sync-model), Sessions 1 (login-debug), Invalid 1 (broken)", () => {
      const nodes = one(loadStatusDoc("mixed"));
      const actual = groups(nodes).map((g) => ({
        key: g.key,
        label: g.label,
        pages: g.pages.map((p) => ({ label: p.label, path: p.path, contextValue: p.contextValue, description: p.description })),
      }));
      assert.deepEqual(actual, MIXED_GROUPS);
      assert.deepEqual(groups(nodes).map((g) => g.id), MIXED_GROUPS.map((g) => `${ROOT}|#${g.key}`));
      assert.deepEqual(group(nodes, "concepts")?.pages.map((p) => p.id), [
        `${ROOT}|wiki/concepts/auth-flow.md`,
        `${ROOT}|wiki/concepts/legacy-sync.md`,
        `${ROOT}|wiki/concepts/rate-limits.md`,
        `${ROOT}|wiki/concepts/retry-policy.md`,
      ]);
    });

    it("billing (incoming_new) and old-name (deleted_local) are absent", () => {
      const doc = loadStatusDoc("mixed");
      const paths = allPages(one(doc)).map((p) => p.path);
      assert.ok(doc.pages.some((p) => p.path === "wiki/entities/billing.md" && p.state === "incoming_new"));
      assert.ok(doc.pages.some((p) => p.path === "wiki/concepts/old-name.md" && p.state === "deleted_local"));
      assert.ok(!paths.includes("wiki/entities/billing.md"));
      assert.ok(!paths.includes("wiki/concepts/old-name.md"));
      // Exactly the entries with a local file are listed (WP-2.3's assertion).
      assert.deepEqual([...paths].sort(), doc.pages.filter((p) => p.local !== undefined).map((p) => p.path).sort());
    });

    it("legacy-sync (unverified) is listed with resourceUri set", () => {
      const node = group(one(loadStatusDoc("mixed")), "concepts")?.pages.find((p) => p.path === "wiki/concepts/legacy-sync.md");
      assert.ok(node, "legacy-sync is listed under Concepts");
      assert.equal(node.state, "unverified");
      const item = pageItem(node, fileUri);
      assert.equal(item.resourceUri?.toString(), "file:///fixture-root/.contexo/wiki/concepts/legacy-sync.md");
      assert.equal(item.contextValue, "page.unverified");
      assert.equal(item.id, `${ROOT}|wiki/concepts/legacy-sync.md`);
      assert.equal(item.command?.command, "vscode.open");
      assert.deepEqual(item.command?.arguments?.map(String), [item.resourceUri?.toString()]);
      assert.equal(item.tooltip, undefined, "the untrusted MarkdownString tooltip is built in resolveTreeItem");
    });

    it("a page that has a local file but an unlisted state is still not listed (defense in depth)", () => {
      const nodes = one(docWith([
        { path: "wiki/concepts/a.md", state: "incoming_new", type: "concept" },
        { path: "wiki/concepts/b.md", state: "deleted_local", type: "concept" },
        { path: "wiki/concepts/c.md", state: "new", type: "concept", local: undefined },
      ]));
      assert.deepEqual(allPages(nodes), []);
    });
  });

  describe("part 2: presentation", () => {
    it("label falls back title -> slug -> basename", () => {
      const e = (p: Partial<PageEntry>) => ({ path: "wiki/concepts/some-page.md", state: "unchanged", tags: [], notes: [], ...p }) as PageEntry;
      assert.equal(pageLabel(e({ title: "Some Page", slug: "some-slug" })), "Some Page");
      assert.equal(pageLabel(e({ slug: "some-slug" })), "some-slug");
      assert.equal(pageLabel(e({ title: "", slug: "" })), "some-page");
      assert.equal(pageLabel(e({})), "some-page");
      assert.equal(pageLabel(e({ path: "README" })), "README");
    });

    it("contextValue is page.conflict for rate-limits and page.invalid for broken", () => {
      const pages = allPages(one(loadStatusDoc("mixed")));
      assert.equal(pages.find((p) => p.path === "wiki/concepts/rate-limits.md")?.contextValue, "page.conflict");
      assert.equal(pages.find((p) => p.path === "wiki/concepts/broken.md")?.contextValue, "page.invalid");
      for (const p of pages) { assert.equal(p.contextValue, `page.${p.state}`); }
    });

    it("an unknown type goes to Other", () => {
      const nodes = one(docWith([
        { path: "wiki/decisions/adr-1.md", type: "decision", title: "ADR 1" },
        { path: "wiki/misc/untyped.md", title: "Untyped" },
        { path: "wiki/concepts/c.md", type: "concept", title: "C" },
      ]));
      assert.deepEqual(groups(nodes).map((g) => g.label), ["Concepts", "Other"]);
      assert.deepEqual(group(nodes, "other")?.pages.map((p) => p.label), ["ADR 1", "Untyped"]);
      assert.equal(group(nodes, "other")?.pages[0]?.icon, "file");
    });

    it("empty groups are hidden", () => {
      const nodes = one(docWith([{ path: "wiki/entities/e.md", type: "entity", title: "E" }]));
      assert.deepEqual(nodes.map((n) => n.id), [`${ROOT}|#entities`]);
      assert.deepEqual(one(docWith([])), []);
      assert.deepEqual(one(undefined), [], "no status yet: no children");
    });

    it("showSessions=false drops Sessions", () => {
      const doc = loadStatusDoc("e5-sessions-hidden");
      assert.deepEqual(group(one(doc), "sessions")?.pages.map((p) => p.label), ["Cache tuning session", "Login debug session"]);
      const hidden = one(doc, { showSessions: false });
      assert.equal(group(hidden, "sessions"), undefined);
      assert.deepEqual(groups(hidden).map((g) => g.label), ["Concepts", "Entities"]);
      assert.equal(hidden[0]?.kind, "pending", "the pending agent-session item stays (D4 nudge)");
      assert.equal(group(one(loadStatusDoc("mixed"), { showSessions: false }), "sessions"), undefined);
    });

    it("the pending item comes first, with N = captures.pending and the shareViaAgent command with no args", () => {
      const nodes = one(loadStatusDoc("mixed"));
      const pending = nodes[0] as PendingNode;
      assert.equal(pending.kind, "pending");
      assert.equal(pending.count, MIXED_PENDING);
      assert.equal(pending.label, "2 agent session(s) not yet shared");
      assert.equal(pending.id, `${ROOT}|#pending`);
      assert.equal(pending.contextValue, "session");
      assert.equal(pending.icon, "sparkle");
      assert.deepEqual(pending.command, { command: COMMAND_IDS.shareViaAgent, title: "Share via Your Agent" });
      assert.ok(!("arguments" in pending.command), "no arguments: WP-1.12 copies its default prompt");
      const item = pendingItem(pending);
      assert.equal(item.command?.command, "contexo.shareViaAgent");
      assert.equal(item.command?.arguments, undefined);
      assert.equal(item.contextValue, "session");
      assert.equal(item.label, "2 agent session(s) not yet shared");
      assert.equal((item.iconPath as { id?: string } | undefined)?.id, "sparkle");
      assert.equal(one(docWith([{ path: "wiki/concepts/c.md", type: "concept" }]))[0]?.kind, "group", "no pending item when captures.pending is 0");
    });

    it("blocks_push adds the Push-blocked sentence to the tooltip", () => {
      const blocked = one(loadStatusDoc("e5-sessions-hidden"))[0] as PendingNode;
      assert.equal(blocked.kind, "pending");
      assert.equal(PUSH_BLOCKED_SENTENCE, "Push is blocked until these sessions are shared through your agent.");
      assert.ok(blocked.tooltip.includes(PUSH_BLOCKED_SENTENCE));
      assert.match(blocked.tooltip, /decision record/i);
      assert.equal(pendingItem(blocked).tooltip, blocked.tooltip);
      const free = one(loadStatusDoc("mixed"))[0] as PendingNode;
      assert.ok(!free.tooltip.includes(PUSH_BLOCKED_SENTENCE));
      assert.match(free.tooltip, /decision record/i);
    });

    it("treeSignature is equal for identical docs and differs when one tag changes", () => {
      const a = loadStatusDoc("mixed");
      const b = loadStatusDoc("mixed");
      assert.notEqual(a, b);
      assert.equal(treeSignature(a), treeSignature(b));
      const c = loadStatusDoc("mixed");
      (c.pages.find((p) => p.path === "wiki/entities/gitstore.md") as PageEntry).tags = ["server", "storage", "git"];
      assert.notEqual(treeSignature(c), treeSignature(a));
      // Every other rendered field moves it too; fields the tree never renders do not.
      const mut = (f: (d: StatusDoc) => void): string => { const d = loadStatusDoc("mixed"); f(d); return treeSignature(d); };
      const sig = treeSignature(a);
      assert.notEqual(mut((d) => { d.root = "/elsewhere"; }), sig);
      assert.notEqual(mut((d) => { (d.pages[0] as PageEntry).state = "modified"; }), sig);
      assert.notEqual(mut((d) => { (d.pages[0] as PageEntry).title = "Other"; }), sig);
      assert.notEqual(mut((d) => { (d.pages[0] as PageEntry).type = "concept"; }), sig);
      assert.notEqual(mut((d) => { d.captures.pending = 3; }), sig);
      assert.notEqual(mut((d) => { d.captures.blocks_push = true; }), sig);
      assert.notEqual(mut((d) => { (d.pages[0] as PageEntry).reasoning_summary = "changed"; }), sig);
      assert.equal(mut((d) => { d.generated_at = "2030-01-01T00:00:00Z"; }), sig);
      assert.equal(mut((d) => { ((d.pages[0] as PageEntry).local as { hash?: string }).hash = "sha256:other"; }), sig);
      assert.equal(treeSignature(undefined), treeSignature(undefined));
      assert.notEqual(treeSignature(undefined), sig);
    });

    it("a 2,000-page synthetic status builds in under 200 ms", () => {
      const doc = loadStatusDoc("e5-large-2000");
      assert.equal(doc.pages.length, 2000);
      const t0 = performance.now();
      const nodes = one(doc);
      const ms = performance.now() - t0;
      assert.ok(ms < 200, `buildTree took ${ms.toFixed(1)} ms`);
      const t1 = performance.now();
      treeSignature(doc);
      const sigMs = performance.now() - t1;
      assert.ok(sigMs < 200, `treeSignature took ${sigMs.toFixed(1)} ms`);
      const listed = doc.pages.filter((p) => p.local !== undefined).length;
      assert.equal(allPages(nodes).length, listed);
      assert.equal(group(nodes, "invalid")?.pages.length, doc.counts.invalid);
      assert.deepEqual(groups(nodes).map((g) => g.label), ["Concepts", "Entities", "Analyses", "Sessions", "Other", "Invalid"]);
      assert.equal(nodes[0]?.kind, "pending");
    });

    it("items are sorted by label case-insensitively, then by path", () => {
      const nodes = one(docWith([
        { path: "wiki/concepts/b2.md", type: "concept", title: "beta" },
        { path: "wiki/concepts/a.md", type: "concept", title: "Beta" },
        { path: "wiki/concepts/c.md", type: "concept", title: "alpha" },
        { path: "wiki/concepts/b1.md", type: "concept", title: "BETA" },
      ]));
      assert.deepEqual(group(nodes, "concepts")?.pages.map((p) => p.path), [
        "wiki/concepts/c.md", "wiki/concepts/a.md", "wiki/concepts/b1.md", "wiki/concepts/b2.md",
      ]);
    });

    it("description is the tags joined with ', ', or the invalid message truncated to 80 chars", () => {
      const e = (p: Partial<PageEntry>) => ({ path: "wiki/concepts/x.md", state: "unchanged", tags: [], notes: [], ...p }) as PageEntry;
      assert.equal(pageDescription(e({ tags: ["a", "b c"] })), "a, b c");
      assert.equal(pageDescription(e({ tags: [] })), undefined);
      const long = `page: validate: ${"x".repeat(100)}`;
      const d = pageDescription(e({ state: "invalid", tags: ["ignored"], invalid: { stage: "validate", message: long } }));
      assert.equal(d?.length, 80);
      assert.ok(d?.endsWith("…"));
      assert.ok(long.startsWith((d as string).slice(0, 79)));
      assert.equal(pageDescription(e({ state: "invalid", invalid: { stage: "parse", message: "short" } })), "short");
    });

    it("ThemeIcon per type: concept lightbulb, entity symbol-class, analysis graph, source comment-discussion, other file, invalid warning", () => {
      const nodes = one(docWith([
        { path: "wiki/concepts/c.md", type: "concept" },
        { path: "wiki/entities/e.md", type: "entity" },
        { path: "wiki/analyses/a.md", type: "analysis" },
        { path: "raw/sessions/s.md", type: "source" },
        { path: "wiki/x/o.md", type: "other-kind" },
        { path: "wiki/concepts/bad.md", type: "concept", state: "invalid", invalid: { stage: "parse", message: "bad" } },
      ]));
      const icons = Object.fromEntries(allPages(nodes).map((p) => [p.path, p.icon]));
      assert.deepEqual(icons, {
        "wiki/concepts/c.md": "lightbulb",
        "wiki/entities/e.md": "symbol-class",
        "wiki/analyses/a.md": "graph",
        "raw/sessions/s.md": "comment-discussion",
        "wiki/x/o.md": "file",
        "wiki/concepts/bad.md": "warning",
      });
      assert.equal(group(nodes, "invalid")?.pages[0]?.path, "wiki/concepts/bad.md", "invalid entries go under Invalid whatever their type");
      const item = pageItem(allPages(nodes)[0] as PageNode, fileUri);
      assert.ok(item.iconPath instanceof vscodeStub.ThemeIcon);
    });

    it("tooltip fields: path, type, tags, author, agent, updated, reasoning_summary, state (plus conflict_kind)", () => {
      const rate = allPages(one(loadStatusDoc("mixed"))).find((p) => p.path === "wiki/concepts/rate-limits.md") as PageNode;
      const fields = Object.fromEntries(rate.tooltip.map((f) => [f.name, f.value]));
      assert.equal(fields.Path, "wiki/concepts/rate-limits.md");
      assert.equal(fields.Type, "concept");
      assert.equal(fields.Tags, "api, limits");
      assert.equal(fields.State, "conflict (both_modified)");
      for (const name of ["Author", "Agent", "Updated", "Summary"]) {
        assert.ok(name in fields, `${name} is shown for rate-limits`);
      }
      const broken = allPages(one(loadStatusDoc("mixed"))).find((p) => p.path === "wiki/concepts/broken.md") as PageNode;
      const bf = Object.fromEntries(broken.tooltip.map((f) => [f.name, f.value]));
      assert.equal(bf.State, "invalid");
      assert.equal(bf.Problem, "parse: page: parse frontmatter: yaml: line 9: found unexpected end of stream");
      assert.ok(!("Type" in bf), "absent fields are omitted");
    });

    it("two or more repositories: one node per repository, labelled with the folder name, with distinct ids", () => {
      const nodes = buildTree([
        { root: "/w/alpha", name: "alpha", status: loadStatusDoc("mixed") },
        { root: "/w/beta", name: "beta", status: loadStatusDoc("e5-two-repos") },
      ], ON);
      assert.deepEqual(nodes.map((n) => n.kind), ["repo", "repo"]);
      const [alpha, beta] = nodes as RepoNode[];
      assert.deepEqual([alpha?.label, beta?.label], ["alpha", "beta"]);
      assert.notEqual(alpha?.id, beta?.id);
      assert.equal(alpha?.children[0]?.kind, "pending");
      assert.deepEqual(beta?.children.map((c) => c.id), ["/w/beta|#concepts", "/w/beta|#entities"]);
      const ids = [alpha, beta].flatMap((r) => [r?.id, ...(r?.children ?? []).flatMap((c) => [c.id, ...(c.kind === "group" ? c.pages.map((p) => p.id) : [])])]);
      assert.equal(new Set(ids).size, ids.length, "every id is unique across the tree");
      assert.deepEqual(group(beta?.children ?? [], "concepts")?.pages.map((p) => p.groupId), ["/w/beta|#concepts", "/w/beta|#concepts"]);
    });

    it("badge = Σ(captures.pending + counts.conflict) with its tooltip, or undefined when 0", () => {
      assert.deepEqual(treeBadge([loadStatusDoc("mixed")]), MIXED_BADGE);
      assert.deepEqual(treeBadge([loadStatusDoc("mixed"), loadStatusDoc("e5-two-repos"), undefined]), {
        value: 4, tooltip: "2 agent session(s) pending · 2 conflict(s)",
      });
      assert.equal(treeBadge([loadStatusDoc("clean")]), undefined);
      assert.equal(treeBadge([]), undefined);
    });

    it("message is shown only for notLoggedIn with a non-empty tree (WP-6H.1); pages render except in the ctx/extension blocking states", () => {
      const roots = one(loadStatusDoc("mixed"));
      assert.ok(roots.length > 0);
      assert.equal(NOT_LOGGED_IN_MESSAGE, "Not logged in: showing local pages only");
      assert.equal(treeMessage("notLoggedIn", roots), NOT_LOGGED_IN_MESSAGE);
      assert.equal(treeMessage("notLoggedIn", []), undefined, "an empty tree leaves the viewsWelcome visible");
      for (const s of ["loading", "ready", "ctxMissing", "ctxTooOld", "extensionTooOld", "noRepositories", "untrusted"] as const) {
        assert.equal(treeMessage(s, roots), undefined, s);
        assert.equal(treeMessage(s, []), undefined, s);
      }
      for (const s of ["loading", "ready", "notLoggedIn"] as const) { assert.equal(rendersPages(s), true, s); }
      for (const s of ["ctxMissing", "ctxTooOld", "extensionTooOld", "noRepositories", "untrusted"] as const) {
        assert.equal(rendersPages(s), false, s);
      }
    });
  });
});
