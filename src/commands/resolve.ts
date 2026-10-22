// Keep Mine / Take Server Version / Restore Server Version (WP-1.13), through
// `ctx resolve <path> --ours|--theirs --if-server-sha <the remote sha the user saw>`.
import type { Services } from "../services";

/** Confirm button of the Take Server Version modal. */
export const TAKE_SERVER_LABEL = "Take Server Version";
/** Confirm button of the Restore Server Version modal. */
export const RESTORE_SERVER_LABEL = "Restore Server Version";

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

/**
 * contexo.resolveTheirs (resource context: (clicked, selected[])): refuse dirty targets
 * (E27), then ONE modal confirm(takeServerMessage(selectionName(paths)), {modal,
 * confirmLabel: TAKE_SERVER_LABEL}); then inside ONE repo.run('resolve'), sequentially per
 * path, cli.resolve(root, path, 'theirs', {ifServerSha: page.remote.sha}). A page without
 * remote.sha: one repo.refresh({remote: true}) first; still missing -> skipped with
 * unknownServerMessage. stale -> info staleMessage(path), continue; not_resolvable -> a toast
 * naming details.state, continue; busy -> one retry after 1 s; any other error stops the
 * loop (presentError). Ends with a one-line summary.
 */
export async function resolveTheirs(s: Services, ...args: unknown[]): Promise<void> {
  void args;
  await s.prompts.info("Contexo: not implemented yet");
}

/**
 * contexo.resolveOurs: only conflict and unverified entries (others filtered with an info);
 * no dirty check and no confirmation (non-destructive); per path cli.resolve(root, path,
 * 'ours', {ifServerSha: page.remote.sha}) inside one repo.run('resolve'); otherwise as theirs.
 */
export async function resolveOurs(s: Services, ...args: unknown[]): Promise<void> {
  void args;
  await s.prompts.info("Contexo: not implemented yet");
}

/**
 * contexo.restoreServerVersion (the deleted_local menu entry; a menu cannot retitle a
 * command): the resolveTheirs flow with confirm(restoreServerMessage(name), {modal,
 * confirmLabel: RESTORE_SERVER_LABEL}).
 */
export async function restoreServerVersion(s: Services, ...args: unknown[]): Promise<void> {
  void args;
  await s.prompts.info("Contexo: not implemented yet");
}
