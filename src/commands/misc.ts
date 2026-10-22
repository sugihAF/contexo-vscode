// Misc commands (WP-1.12): refresh, show the log, and open a page or project in the
// Contexo dashboard. Only http(s) URLs built by buildDashboardUrl are ever opened.
import * as vscode from "vscode";
import { buildDashboardUrl } from "../dashboardUrl";
import type { IRepository } from "../model/types";
import type { Services } from "../services";

/** contexo.refresh: an online status for every repository. */
export async function refresh(s: Services): Promise<void> {
  await s.model.refreshAll({ remote: true });
}

/** contexo.showLog: the Contexo output channel. */
export async function showLog(s: Services): Promise<void> {
  s.log.show();
}

/**
 * The page Uri a command argument names: a Uri, a resource state or tree item (resourceUri),
 * the active editor's document when there is no argument and it belongs to the repository,
 * else the target's relPath.
 */
function pageUri(s: Services, arg: unknown, repository: IRepository, relPath: string | undefined): vscode.Uri | undefined {
  if (arg instanceof vscode.Uri) { return arg; }
  const resourceUri = typeof arg === "object" && arg !== null ? (arg as { resourceUri?: unknown }).resourceUri : undefined;
  if (resourceUri instanceof vscode.Uri) { return resourceUri; }
  if (arg === undefined) {
    const active = vscode.window.activeTextEditor?.document.uri;
    if (active && s.model.getRepository(active) === repository) { return active; }
  }
  return relPath ? repository.fileUri(relPath) : undefined;
}

/** contexo.openInDashboard: the page's dashboard URL, else the repository's. */
export async function openInDashboard(s: Services, arg?: unknown): Promise<void> {
  const target = s.model.resolveTarget(arg);
  if (!target) {
    void s.prompts.info("Contexo: open a Contexo page or project first.");
    return;
  }
  const status = target.repository.status;
  if (!status) {
    void s.prompts.info("Contexo: no status yet for this project; refresh and try again.");
    return;
  }
  const uri = pageUri(s, arg, target.repository, target.relPath);
  const entry = uri ? target.repository.pageAt(uri) : undefined;
  if (status.project.dashboard_url === "") {
    // Self-hosted with no dashboard configured (E23).
    void s.prompts.info(`No dashboard is configured for ${status.server.url ?? "this server"}`);
    return;
  }
  const url = buildDashboardUrl(status.project, entry?.path);
  if (url === undefined) {
    void s.prompts.warn("Contexo: no safe dashboard link for this page.");
    return;
  }
  await s.prompts.openExternal(vscode.Uri.parse(url));
}
