// The Knowledge tree as plain data (WP-1.11). Pure: no vscode import, so plain mocha unit
// tests load it. It maps StatusDoc fields only: it never reads files, parses YAML or derives
// a page state (D1). Membership follows Contract erratum E30 (listedInTree).
import { COMMAND_IDS } from "../commands/ids";
import { listedInTree, type PageEntry, type PageState, type StatusDoc } from "../contract/types";
import type { ExtensionState } from "../model/types";

export type GroupKey = "concepts" | "entities" | "analyses" | "sessions" | "other" | "invalid";

/** Groups in display order. `type` is the frontmatter type that selects the group. */
const GROUPS: readonly { key: GroupKey; label: string; type?: string; icon: string }[] = [
  { key: "concepts", label: "Concepts", type: "concept", icon: "lightbulb" },
  { key: "entities", label: "Entities", type: "entity", icon: "symbol-class" },
  { key: "analyses", label: "Analyses", type: "analysis", icon: "graph" },
  { key: "sessions", label: "Sessions", type: "source", icon: "comment-discussion" },
  { key: "other", label: "Other", icon: "file" },
  { key: "invalid", label: "Invalid", icon: "warning" },
];
const GROUP_BY_TYPE = new Map(GROUPS.filter((g) => g.type !== undefined).map((g) => [g.type as string, g]));
const OTHER = GROUPS[4] as (typeof GROUPS)[number];
const INVALID = GROUPS[5] as (typeof GROUPS)[number];

/** E30: these states have no working file and are never listed (they live in SCM). */
const UNLISTED_STATES: ReadonlySet<string> = new Set<PageState>(["incoming_new", "deleted_local"]);
/** States whose welcome view must show (ctx missing or unusable): the tree renders nothing. */
const BLOCKING_STATES: ReadonlySet<ExtensionState> = new Set<ExtensionState>([
  "ctxMissing", "ctxTooOld", "extensionTooOld", "untrusted", "noRepositories",
]);

export const NOT_LOGGED_IN_MESSAGE = "Not logged in: showing local pages only";
export const PUSH_BLOCKED_SENTENCE = "Push is blocked until these sessions are shared through your agent.";
const DESCRIPTION_MAX = 80;

export interface TreeOptions { showSessions: boolean }
/** One repository: root is its workspace-folder fsPath, name its workspace-folder name. */
export interface RepoInput { root: string; name: string; status: StatusDoc | undefined }
/** A vscode.Command as plain data. */
export interface TreeCommand { command: string; title: string; arguments?: unknown[] }
/** One tooltip line: name is our own text, value is teammate-authored (escaped by the renderer). */
export interface TooltipField { name: string; value: string }

export interface PageNode {
  kind: "page";
  /** '<root>|<path>' */
  id: string;
  root: string;
  /** The id of the group the page sits in (getParent). */
  groupId: string;
  path: string;
  state: PageState;
  label: string;
  description?: string;
  /** ThemeIcon id. */
  icon: string;
  /** 'page.<state>' */
  contextValue: string;
  tooltip: TooltipField[];
}
export interface GroupNode {
  kind: "group";
  /** '<root>|#<key>' */
  id: string;
  root: string;
  key: GroupKey;
  label: string;
  pages: PageNode[];
}
export interface PendingNode {
  kind: "pending";
  /** '<root>|#pending' */
  id: string;
  root: string;
  count: number;
  blocksPush: boolean;
  label: string;
  tooltip: string;
  icon: "sparkle";
  contextValue: "session";
  /** contexo.shareViaAgent with no arguments: WP-1.12 copies its default prompt. */
  command: TreeCommand;
}
export interface RepoNode {
  kind: "repo";
  /** '<root>|#repo' */
  id: string;
  root: string;
  label: string;
  contextValue: "repository";
  /** The pending item first (when captures.pending > 0), then the non-empty groups. */
  children: (PendingNode | GroupNode)[];
}
export type TreeNode = RepoNode | PendingNode | GroupNode | PageNode;

/** title, else slug, else the basename without .md. */
export function pageLabel(e: PageEntry): string {
  if (e.title) { return e.title; }
  if (e.slug) { return e.slug; }
  const base = e.path.slice(e.path.lastIndexOf("/") + 1);
  return base.toLowerCase().endsWith(".md") ? base.slice(0, -3) : base;
}

/** Tags joined with ', ' (undefined when none); for invalid entries the message, at most 80 chars. */
export function pageDescription(e: PageEntry): string | undefined {
  if (e.state === "invalid") {
    const m = e.invalid?.message ?? "";
    if (m === "") { return undefined; }
    return m.length > DESCRIPTION_MAX ? `${m.slice(0, DESCRIPTION_MAX - 1)}…` : m;
  }
  return e.tags.length > 0 ? e.tags.join(", ") : undefined;
}

function tooltipFields(e: PageEntry): TooltipField[] {
  const out: TooltipField[] = [];
  const add = (name: string, value: string | undefined): void => {
    if (value !== undefined && value !== "") { out.push({ name, value }); }
  };
  add("Path", e.path);
  add("Type", e.type);
  add("Tags", e.tags.join(", "));
  add("Author", e.author);
  add("Agent", e.agent);
  add("Updated", e.updated);
  add("Summary", e.reasoning_summary);
  add("State", e.conflict_kind ? `${e.state} (${e.conflict_kind})` : e.state);
  if (e.invalid) {
    add("Problem", `${e.invalid.stage}: ${e.invalid.message}`);
    add("Expected path", e.invalid.expected_path);
  }
  return out;
}

function pendingTooltip(count: number, blocksPush: boolean): string {
  const text = `${count} agent session(s) have not been shared yet. Sharing them through your agent ` +
    "distills each session's reasoning trail into the knowledge base (concept and analysis pages), " +
    "so teammates see why a page changed, not only what changed. Click to copy a prompt for your agent.";
  return blocksPush ? `${text} ${PUSH_BLOCKED_SENTENCE}` : text;
}

/** One repository's node (layout-independent; buildTree decides what is top level). */
export function buildRepo(repo: RepoInput, opts: TreeOptions): RepoNode {
  const children: (PendingNode | GroupNode)[] = [];
  const status = repo.status;
  if (status) {
    const pending = status.captures.pending;
    if (pending > 0) {
      children.push({
        kind: "pending",
        id: `${repo.root}|#pending`,
        root: repo.root,
        count: pending,
        blocksPush: status.captures.blocks_push,
        label: `${pending} agent session(s) not yet shared`,
        tooltip: pendingTooltip(pending, status.captures.blocks_push),
        icon: "sparkle",
        contextValue: "session",
        command: { command: COMMAND_IDS.shareViaAgent, title: "Share via Your Agent" },
      });
    }
    const buckets = new Map<GroupKey, { key: string; node: PageNode }[]>();
    for (const e of status.pages) {
      if (!listedInTree(e) || UNLISTED_STATES.has(e.state)) { continue; }
      const g = e.state === "invalid" ? INVALID : GROUP_BY_TYPE.get(e.type ?? "") ?? OTHER;
      if (g.key === "sessions" && !opts.showSessions) { continue; }
      const label = pageLabel(e);
      const description = pageDescription(e);
      const node: PageNode = {
        kind: "page",
        id: `${repo.root}|${e.path}`,
        root: repo.root,
        groupId: `${repo.root}|#${g.key}`,
        path: e.path,
        state: e.state,
        label,
        ...(description !== undefined ? { description } : {}),
        icon: g.icon,
        contextValue: `page.${e.state}`,
        tooltip: tooltipFields(e),
      };
      let bucket = buckets.get(g.key);
      if (!bucket) { bucket = []; buckets.set(g.key, bucket); }
      bucket.push({ key: label.toLowerCase(), node });
    }
    for (const g of GROUPS) {
      const bucket = buckets.get(g.key);
      if (!bucket) { continue; }
      bucket.sort((a, b) => cmp(a.key, b.key) || cmp(a.node.path, b.node.path));
      children.push({ kind: "group", id: `${repo.root}|#${g.key}`, root: repo.root, key: g.key, label: g.label, pages: bucket.map((x) => x.node) });
    }
  }
  return { kind: "repo", id: `${repo.root}|#repo`, root: repo.root, label: repo.name, contextValue: "repository", children };
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Top level: one repository shows its own children; two or more show one node each. */
export function layoutRoots(repos: readonly RepoNode[]): TreeNode[] {
  if (repos.length === 1) { return [...(repos[0] as RepoNode).children]; }
  return [...repos];
}

/** The whole tree for these repositories (in order). */
export function buildTree(repos: RepoInput[], opts: TreeOptions): TreeNode[] {
  return layoutRoots(repos.map((r) => buildRepo(r, opts)));
}

/**
 * Changes iff a field the tree renders changes: root, and per listed-or-not page its path,
 * state, conflict_kind, title, slug, type, tags, author, agent, updated, reasoning_summary,
 * local presence and invalid details; plus captures.pending and blocks_push. Hashes, shas,
 * times and counts are not rendered and do not move it.
 */
export function treeSignature(status: StatusDoc | undefined): string {
  if (!status) { return "-"; }
  const pages = status.pages.map((e) => [
    e.path, e.state, e.conflict_kind ?? "", e.title ?? "", e.slug ?? "", e.type ?? "", e.tags,
    e.author ?? "", e.agent ?? "", e.updated ?? "", e.reasoning_summary ?? "", e.local !== undefined ? 1 : 0,
    e.invalid ? [e.invalid.stage, e.invalid.message, e.invalid.expected_path ?? ""] : 0,
  ]);
  return JSON.stringify([status.root, status.captures.pending, status.captures.blocks_push, pages]);
}

/** TreeView.badge: Σ(captures.pending + counts.conflict) over the repositories, undefined when 0. */
export function treeBadge(statuses: readonly (StatusDoc | undefined)[]): { value: number; tooltip: string } | undefined {
  let pending = 0;
  let conflicts = 0;
  for (const s of statuses) {
    if (!s) { continue; }
    pending += s.captures.pending;
    conflicts += s.counts.conflict;
  }
  const value = pending + conflicts;
  return value > 0 ? { value, tooltip: `${pending} agent session(s) pending · ${conflicts} conflict(s)` } : undefined;
}

/** TreeView.message for the extension state. */
export function treeMessage(state: ExtensionState): string | undefined {
  return state === "notLoggedIn" ? NOT_LOGGED_IN_MESSAGE : undefined;
}

/** False in the states whose viewsWelcome entry must show (the tree then has no children). */
export function rendersPages(state: ExtensionState): boolean {
  return !BLOCKING_STATES.has(state);
}
