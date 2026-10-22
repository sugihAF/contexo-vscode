// The Source Control open/diff commands (WP-1.9): contexo.openChange, contexo.openFile,
// contexo.openServerVersion and contexo.openAllChanges. Handlers take the services first,
// then whatever VS Code passes (resource states, possibly several; a resource group; a
// SourceControl; a Uri; or nothing). Every page comes from the repository's StatusDoc via
// s.model.resolveTarget and repository.pageAt; every contexo: URI from specToUri. The
// contexo: content itself is served by WP-1.10's FileSystemProvider.
import * as vscode from "vscode";
import type { PageEntry, ScmGroup } from "../contract/types";
import type { IRepository } from "../model/types";
import type { Services } from "../services";
import { GROUP_LABELS, GROUP_ORDER, changesTuples, clickFor, type ChangeTuple, type UriSpec } from "./resourceModel";
import { commandFor, specToUri } from "./resourceStates";
import { groupContextOf, isUri } from "./scmProvider";

/** One page a command acts on. */
interface Target {
  repository: IRepository;
  relPath: string;
  page: PageEntry | undefined;
}

/** The groups View All Changes concatenates when no single group is given. */
const ALL_CHANGES_GROUPS: readonly ScmGroup[] = ["conflicts", "changes", "new", "incoming"];

/**
 * The pages behind the arguments, in argument order, deduped by root + relPath. Array
 * arguments (a multi-selection) are flattened; no argument means [undefined]; targets
 * without a relPath (a SourceControl, a file outside .contexo) are skipped.
 */
function targetsOf(s: Services, args: readonly unknown[]): Target[] {
  const flat = args.length === 0 ? [undefined] : args.flatMap((a) => (Array.isArray(a) ? (a as unknown[]) : [a]));
  const seen = new Set<string>();
  const out: Target[] = [];
  for (const arg of flat) {
    const t = s.model.resolveTarget(arg);
    if (!t || t.relPath === undefined) { continue; }
    const key = `${t.repository.root.toString()}\n${t.relPath}`;
    if (seen.has(key)) { continue; }
    seen.add(key);
    out.push({ repository: t.repository, relPath: t.relPath, page: t.repository.pageAt(t.repository.fileUri(t.relPath)) });
  }
  if (out.length === 0) { s.log.info("contexo: no Contexo page in the command arguments"); }
  return out;
}

/** The read-only server version of a page (contexo:, ref server). */
function serverUri(t: Target): vscode.Uri {
  return specToUri(t.repository, { kind: "contexo", ref: "server", relPath: t.relPath });
}

/** The page has a working file (or ctx does not know it, so the file is all there is). */
function hasLocal(t: Target): boolean {
  return t.page === undefined || t.page.local !== undefined;
}

async function open(uri: vscode.Uri): Promise<void> {
  await vscode.commands.executeCommand("vscode.open", uri);
}

/** What a click runs (clickFor); with no click, the working file when there is one. */
export async function openChange(s: Services, ...args: unknown[]): Promise<void> {
  for (const t of targetsOf(s, args)) {
    const click = t.page ? clickFor(t.page) : undefined;
    if (click) {
      const c = commandFor(t.repository, click);
      await vscode.commands.executeCommand(c.command, ...(c.arguments ?? []));
    } else if (hasLocal(t)) {
      await open(t.repository.fileUri(t.relPath));
    } else {
      await s.prompts.info(`Contexo: no changes to show for ${t.relPath}`);
    }
  }
}

/** The working file; for a page without one (deleted_local, incoming_new), its server version. */
export async function openFile(s: Services, ...args: unknown[]): Promise<void> {
  for (const t of targetsOf(s, args)) {
    if (hasLocal(t)) {
      await open(t.repository.fileUri(t.relPath));
    } else if (t.page?.remote?.sha) {
      await open(serverUri(t));
    } else {
      await s.prompts.info(`Contexo: ${t.relPath} has no local file and is not on the server`);
    }
  }
}

/** The read-only server version (contexo:, ref server), when the server has the page. */
export async function openServerVersion(s: Services, ...args: unknown[]): Promise<void> {
  for (const t of targetsOf(s, args)) {
    if (t.page?.remote?.sha) {
      await open(serverUri(t));
    } else {
      await s.prompts.info(`Contexo: ${t.relPath} is not on the server`);
    }
  }
}

/** A resource-group-shaped argument that this module did not create (e.g. from a test or another caller). */
function duckGroup(arg: unknown): { id: ScmGroup; resourceUri: vscode.Uri | undefined } | undefined {
  if (typeof arg !== "object" || arg === null) { return undefined; }
  const g = arg as { id?: unknown; resourceStates?: unknown };
  if (typeof g.id !== "string" || !(GROUP_ORDER as readonly string[]).includes(g.id) || !Array.isArray(g.resourceStates)) {
    return undefined;
  }
  const first = (g.resourceStates as { resourceUri?: unknown }[])[0]?.resourceUri;
  return { id: g.id as ScmGroup, resourceUri: isUri(first) ? first : undefined };
}

/** ' (<workspace folder name>)' when more than one repository is open, else ''. */
function repoSuffix(s: Services, repository: IRepository): string {
  if (s.model.repositories.length <= 1) { return ""; }
  const name = vscode.workspace.getWorkspaceFolder(repository.root)?.name
    ?? repository.root.path.replace(/\/+$/, "").split("/").pop()
    ?? repository.root.fsPath;
  return ` (${name})`;
}

/**
 * View All Changes: vscode.changes(title, [resourceUri, original, modified][]) over one
 * resource group's changesTuples ('Contexo: <label>'), or over conflicts, changes, new and
 * incoming of the target repository ('Contexo: All Changes').
 */
export async function openAllChanges(s: Services, ...args: unknown[]): Promise<void> {
  const first = args[0];
  let repository: IRepository | undefined;
  let title: string;
  let tuples: ChangeTuple[];
  const known = groupContextOf(first);
  const duck = known ? undefined : duckGroup(first);
  if (known) {
    repository = known.repository;
    title = `Contexo: ${GROUP_LABELS[known.id]}`;
    tuples = changesTuples(known.id, repository.status);
  } else if (duck) {
    repository = duck.resourceUri ? s.model.getRepository(duck.resourceUri) : s.model.resolveTarget(undefined)?.repository;
    title = `Contexo: ${GROUP_LABELS[duck.id]}`;
    tuples = repository ? changesTuples(duck.id, repository.status) : [];
  } else {
    repository = s.model.resolveTarget(first)?.repository;
    title = "Contexo: All Changes";
    const status = repository?.status;
    tuples = repository ? ALL_CHANGES_GROUPS.flatMap((id) => changesTuples(id, status)) : [];
  }
  if (!repository || tuples.length === 0) {
    await s.prompts.info("Contexo: no changes");
    return;
  }
  const repo = repository;
  const resources = tuples.map((t) => t.map((spec: UriSpec) => specToUri(repo, spec)));
  await vscode.commands.executeCommand("vscode.changes", `${title}${repoSuffix(s, repo)}`, resources);
}
