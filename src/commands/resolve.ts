// Keep Mine / Take Server Version / Restore Server Version (WP-1.13), through
// `ctx resolve <path> --ours|--theirs --if-server-sha <the remote sha the user saw>`.
import { CtxError } from "../cli/types";
import type { PageEntry, PageState, ResolveStrategy } from "../contract/types";
import type { IRepository } from "../model/types";
import type { Services } from "../services";
import { ensureSaved } from "./dirtyGuard";
import { effectiveCode, errorActions, presentError, withBusyRetry } from "./errorActions";
import { resolveRepo, selectedPages, selectionOf } from "./repoPicker";
import { notify, withScmProgress } from "./sync";

/** Confirm button of the Take Server Version modal. */
export const TAKE_SERVER_LABEL = "Take Server Version";
/** Confirm button of the Restore Server Version modal. */
export const RESTORE_SERVER_LABEL = "Restore Server Version";

/** States Keep Mine accepts; ctx refuses every other one with not_resolvable. */
export const OURS_STATES: readonly PageState[] = ["conflict", "unverified"];

/** theirs: Take Server Version; restore: Restore Server Version (deleted_local, same --theirs); ours: Keep Mine. */
export type ResolveFlow = "theirs" | "restore" | "ours";

/** How a modal names the selection: the relPath of one page, else '<n> pages'. */
export function selectionName(paths: readonly string[]): string {
  return paths.length === 1 ? (paths[0] as string) : `${paths.length} pages`;
}

/** The Take Server Version modal text. */
export function takeServerMessage(name: string): string {
  // eslint-disable-next-line no-restricted-syntax -- user-facing text only; the extension never reads or writes ctx's sync folder (D1)
  return `Replace your local version of ${name} with the server version? A backup is kept in .contexo/.sync/backup/.`;
}

/** The Restore Server Version (deleted_local) modal text. */
export function restoreServerMessage(name: string): string {
  return `Restore ${name} from the server?`;
}

/** The info for a path whose resolve failed with stale. */
export function staleMessage(relPath: string): string {
  return `The server version of ${relPath} changed since you looked; review the new diff`;
}

/** The info for a path whose page has no remote.sha even after one remote refresh. */
export function unknownServerMessage(relPath: string): string {
  return `${relPath}: Server version unknown; refresh and retry`;
}

/** The one-line summary after the resolve loop. */
export function resolveSummary(flow: ResolveFlow, done: number, skipped: number, notRun: number): string {
  const head = flow === "ours" ? `Kept your version of ${done} page(s); push to publish it`
    : flow === "restore" ? `Restored ${done} page(s) from the server`
      : `Took the server version of ${done} page(s)`;
  const tail = [skipped > 0 ? `${skipped} skipped` : "", notRun > 0 ? `${notRun} not run` : ""].filter((t) => t !== "");
  return tail.length > 0 ? `${head} (${tail.join(", ")}).` : `${head}.`;
}

/** A path and the remote sha the user saw: always passed as --if-server-sha (E25). */
interface Target { path: string; sha: string }

/** Failures that concern one path only: report them and go on with the next path. */
const PER_PATH_CODES: ReadonlySet<string> = new Set(["stale", "not_resolvable", "page_not_found"]);

/**
 * contexo.resolveTheirs (resource context: (clicked, selected[]) or the selected states
 * spread): refuse dirty targets (E27), then ONE modal confirm(takeServerMessage(
 * selectionName(paths)), {modal, confirmLabel: TAKE_SERVER_LABEL}); then inside ONE
 * repo.run('resolve'), sequentially per path, cli.resolve(root, path, 'theirs', {ifServerSha:
 * page.remote.sha}). A page without remote.sha: one repo.refresh({remote: true}) first;
 * still missing -> skipped with unknownServerMessage. stale -> info staleMessage(path),
 * continue; not_resolvable (and page_not_found) -> a toast naming details.state, continue;
 * busy -> one retry after 1 s; any other error stops the loop (presentError, whose [Retry]
 * runs the remaining paths with the same shas). Ends with a one-line summary.
 */
export async function resolveTheirs(s: Services, ...args: unknown[]): Promise<void> {
  await resolveFlow(s, args, "theirs");
}

/**
 * contexo.resolveOurs: only conflict and unverified entries (others filtered with an info);
 * no dirty check and no confirmation (non-destructive); per path cli.resolve(root, path,
 * 'ours', {ifServerSha: page.remote.sha}) inside one repo.run('resolve'); otherwise as theirs.
 */
export async function resolveOurs(s: Services, ...args: unknown[]): Promise<void> {
  await resolveFlow(s, args, "ours");
}

/**
 * contexo.restoreServerVersion (the deleted_local menu entry; a menu cannot retitle a
 * command): the resolveTheirs flow with confirm(restoreServerMessage(name), {modal,
 * confirmLabel: RESTORE_SERVER_LABEL}).
 */
export async function restoreServerVersion(s: Services, ...args: unknown[]): Promise<void> {
  await resolveFlow(s, args, "restore");
}

async function resolveFlow(s: Services, args: unknown[], flow: ResolveFlow): Promise<void> {
  const selection = selectionOf(args);
  const repo = await resolveRepo(s, selection);
  if (!repo) { return; }
  let pages = selectedPages(selection, repo);
  if (pages.length === 0) { notify(s, "info", "Select a Contexo page first."); return; }
  if (flow === "ours") {
    const refused = pages.filter((p) => !OURS_STATES.includes(p.state));
    if (refused.length > 0) {
      notify(s, "info", `Keep Mine applies only to conflicts and unverified pages; skipped ${refused.map((p) => `${p.path} (${p.state})`).join(", ")}.`);
    }
    pages = pages.filter((p) => OURS_STATES.includes(p.state));
    if (pages.length === 0) { return; }
  } else if (!(await ensureSaved(s, repo, { mode: "theirs", targets: pages.map((p) => p.path) }))) {
    return;
  }
  const targets = await targetsOf(s, repo, pages);
  if (targets.length === 0) { return; }
  if (flow !== "ours") {
    const name = selectionName(targets.map((t) => t.path));
    const confirmed = await s.prompts.confirm(
      flow === "restore" ? restoreServerMessage(name) : takeServerMessage(name),
      { modal: true, confirmLabel: flow === "restore" ? RESTORE_SERVER_LABEL : TAKE_SERVER_LABEL },
    );
    if (!confirmed) { return; }
  }
  await runResolve(s, repo, flow, targets);
}

/**
 * Each page with the remote sha the user saw. Pages without one get ONE remote refresh
 * (for all of them); a page still without one is skipped with unknownServerMessage.
 */
async function targetsOf(s: Services, repo: IRepository, pages: readonly PageEntry[]): Promise<Target[]> {
  if (pages.some((p) => !p.remote?.sha)) { await repo.refresh({ remote: true }); }
  const targets: Target[] = [];
  for (const p of pages) {
    const sha = p.remote?.sha || repo.pageAt(repo.fileUri(p.path))?.remote?.sha;
    if (sha) { targets.push({ path: p.path, sha }); } else { notify(s, "warning", unknownServerMessage(p.path)); }
  }
  return targets;
}

/** ONE repo.run('resolve'), one path at a time (ctx takes one path per call). */
async function runResolve(s: Services, repo: IRepository, flow: ResolveFlow, targets: readonly Target[]): Promise<void> {
  const strategy: ResolveStrategy = flow === "ours" ? "ours" : "theirs";
  const root = repo.root.fsPath;
  let done = 0;
  let skipped = 0;
  let stop: { err: CtxError; remaining: Target[] } | undefined;
  await withScmProgress(flow === "ours" ? "Keeping your version" : "Taking the server version", () => repo.run("resolve", async () => {
    for (const [i, t] of targets.entries()) {
      try {
        const doc = await withBusyRetry(() => s.cli.resolve(root, t.path, strategy, { ifServerSha: t.sha }));
        done++;
        if (doc.backup_file) { s.log.info(`resolve ${t.path} --${strategy}: backup kept at ${doc.backup_file}`); }
        for (const w of doc.warnings) { s.log.warn(`resolve ${t.path}: ${w.code}: ${w.message}`); }
      } catch (err) {
        if (!(err instanceof CtxError)) { throw err; }
        const code = effectiveCode(err);
        if (!PER_PATH_CODES.has(code)) {
          stop = { err, remaining: targets.slice(i) };
          return;
        }
        skipped++;
        s.log.warn(`resolve ${t.path} --${strategy}: ${code}: ${err.message}`);
        // stale never retries silently: the diff the user reviewed is outdated.
        if (code === "stale") { notify(s, "info", staleMessage(t.path)); } else { notify(s, "warning", `${t.path}: ${errorActions(err).message}`); }
      }
    }
  }));
  const notRun = stop?.remaining.length ?? 0;
  if (done > 0 || targets.length > 1) { notify(s, "info", resolveSummary(flow, done, skipped, notRun)); }
  if (stop) {
    const { err, remaining } = stop;
    presentError(s, err, { retry: () => runResolve(s, repo, flow, remaining), repoId: repo.status?.project.repo_id, repo, refreshed: true });
  }
}
