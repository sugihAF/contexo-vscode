// The Contexo status bar item and each SourceControl's statusBarCommands (WP-1.12).
// statusBarCommandsFor, presentStatusBar and statusBarVisible are pure (types plus
// vscode.Uri), so plain mocha unit tests run them against test/helpers/vscodeStub.ts.
import * as vscode from "vscode";
import { COMMAND_IDS } from "./commands/ids";
import type { StatusDoc } from "./contract/types";
import type { ExtensionState, IRepository } from "./model/types";
import type { Services } from "./services";
import { testHooks, type StatusBarItemSnapshot, type StatusBarSnapshot } from "./testApi";

export const STATUS_BAR_ITEM_ID = "contexo.status";

/** What the Contexo status bar item shows. */
export interface StatusBarPresentation {
  text: string;
  tooltip: string;
  command: vscode.Command;
  /** ThemeColor id for the item background. */
  background?: string;
}

/** remote.error codes that mean the user has to (re)run ctx auth login. */
const LOGIN_ERROR_CODES: ReadonlySet<string> = new Set(["not_authenticated", "auth_rejected", "server_unresolved"]);
/** remote.error codes of a server that could not be reached right now. */
const OFFLINE_ERROR_CODES: ReadonlySet<string> = new Set(["network", "server_error", "rate_limited"]);

/** The status says this repository needs a login (rule 5). */
function needsLogin(st: StatusDoc): boolean {
  return st.auth.state === "not_authenticated" || st.auth.state === "rejected"
    || LOGIN_ERROR_CODES.has(st.remote.error?.code ?? "");
}

/** "last checked <local time>", "last checked unknown", or "offline" when ctx did not reach the server. */
function lastChecked(st: StatusDoc): string {
  if (st.remote.source === "none") { return "offline"; }
  const t = st.remote.fetched_at === undefined ? Number.NaN : Date.parse(st.remote.fetched_at);
  return `last checked ${Number.isNaN(t) ? "unknown" : new Date(t).toLocaleString()}`;
}

/** "<user> · <server> · <repo id>" for the ready tooltip. */
function describeRepo(st: StatusDoc): string {
  const { user_name: name, user_email: email, state } = st.auth;
  const who = name && email ? `${name} <${email}>` : name || email || state;
  return `${who} · ${st.server.url || "unknown server"} · ${st.project.repo_id || "no repo id"}`;
}

/** SourceControl.statusBarCommands for a repository's status (WP-1.9 imports it; WP-1.12 owns the body). */
export function statusBarCommandsFor(status: StatusDoc | undefined): vscode.Command[] {
  if (!status) { return []; }
  const c = status.counts;
  const title = `$(cloud-upload) ${c.ahead} $(cloud-download) ${c.behind}` + (c.conflict > 0 ? ` $(warning) ${c.conflict}` : "");
  const parts = [`${c.ahead} to push`, `${c.behind} incoming`, `${c.conflict} conflict(s)`, lastChecked(status)];
  if (c.unverified > 0) { parts.push(`${c.unverified} unverified`); }
  return [{ command: COMMAND_IDS.refresh, title, tooltip: parts.join(" · ") }];
}

/**
 * The item for the extension state and every repository's status; the first rule that
 * applies wins, and each status rule (log in, offline, server outdated) is checked across
 * all statuses before the next one.
 */
export function presentStatusBar(state: ExtensionState, statuses: StatusDoc[], busy: boolean): StatusBarPresentation {
  switch (state) {
    case "ctxMissing":
      return {
        text: "$(error) ctx not found",
        tooltip: "Contexo: the ctx CLI was not found. Click to install it.",
        command: { command: COMMAND_IDS.installCtx, title: "Install ctx" },
      };
    case "ctxTooOld":
      return {
        text: "$(warning) Update ctx",
        tooltip: "Contexo: this ctx is too old for the extension. Click to run ctx update.",
        command: { command: COMMAND_IDS.updateCtx, title: "Update ctx" },
      };
    case "extensionTooOld":
      return {
        text: "$(warning) Update Contexo extension",
        tooltip: "Contexo: this ctx needs a newer Contexo extension. Click to find the update.",
        command: { command: "workbench.extensions.search", title: "Update Contexo extension", arguments: ["contexo.contexo"] },
      };
    case "noRepositories":
      return {
        text: "$(info) Contexo: Initialize",
        tooltip: "No Contexo project in this workspace. Click to run ctx init.",
        command: { command: COMMAND_IDS.init, title: "Initialize Contexo" },
      };
    default:
      break;
  }

  const login = statuses.find(needsLogin);
  if (login || state === "notLoggedIn") {
    const error = login?.remote.error;
    return {
      text: "$(account) Contexo: Log in",
      tooltip: `Contexo: log in to ${login?.server.url || "the Contexo server"}${error ? `: ${error.message}` : ""}. Click to log in.`,
      command: login
        ? { command: COMMAND_IDS.login, title: "Log in", arguments: [vscode.Uri.file(login.root)] }
        : { command: COMMAND_IDS.login, title: "Log in" },
      background: "statusBarItem.warningBackground",
    };
  }

  const offline = statuses.find((st) => OFFLINE_ERROR_CODES.has(st.remote.error?.code ?? ""))?.remote.error;
  if (offline) {
    return {
      text: "$(cloud-offline) Contexo",
      tooltip: offline.message,
      command: { command: COMMAND_IDS.showLog, title: "Show Log" },
    };
  }

  const outdated = statuses.find((st) => st.remote.error?.code === "server_unsupported");
  if (outdated) {
    return {
      text: "$(warning) Contexo: server outdated",
      tooltip: `Contexo: the server at ${outdated.server.url || "unknown"} is too old for this ctx: ${outdated.remote.error?.message ?? ""}`,
      command: { command: COMMAND_IDS.showLog, title: "Show Log" },
    };
  }

  if (busy) {
    return {
      text: "$(sync~spin) Contexo",
      tooltip: "Contexo: syncing…",
      command: { command: COMMAND_IDS.showLog, title: "Show Log" },
    };
  }

  return {
    text: "$(cloud) Contexo",
    tooltip: statuses.length > 0 ? statuses.map(describeRepo).join("\n") : "Contexo",
    command: { command: COMMAND_IDS.refresh, title: "Refresh" },
  };
}

/** Hidden while loading (and in the unreachable 'untrusted' state, E38), and when ready with no repository. */
export function statusBarVisible(state: ExtensionState, repositoryCount: number): boolean {
  if (state === "loading" || state === "untrusted") { return false; }
  return !(state === "ready" && repositoryCount === 0);
}

/** The one Contexo status bar item, re-rendered on every state, repository, status and operation change. */
export function registerStatusBar(s: Services): vscode.Disposable {
  const item = vscode.window.createStatusBarItem(STATUS_BAR_ITEM_ID, vscode.StatusBarAlignment.Left);
  item.name = "Contexo";
  const repoSubs = new Map<IRepository, vscode.Disposable>();
  let shown: StatusBarItemSnapshot | undefined;

  const render = (): void => {
    const model = s.model;
    const repos = model.repositories;
    const withStatus = repos.filter((r): r is IRepository & { status: StatusDoc } => r.status !== undefined);
    const busy = repos.some((r) => r.operation !== undefined);
    const p = presentStatusBar(model.state, withStatus.map((r) => r.status), busy);
    let command = p.command;
    if (command.command === COMMAND_IDS.login && command.arguments) {
      // Log in targets the repository that owns the matching status: its root Uri, not
      // Uri.file(status.root) (the root ctx reported may be spelled differently).
      const match = withStatus.find((r) => needsLogin(r.status));
      if (match) { command = { ...command, arguments: [match.root] }; }
    }
    item.text = p.text;
    item.tooltip = p.tooltip;
    item.command = command;
    item.backgroundColor = p.background ? new vscode.ThemeColor(p.background) : undefined;
    if (statusBarVisible(model.state, repos.length)) {
      item.show();
      shown = { id: STATUS_BAR_ITEM_ID, text: p.text, tooltip: p.tooltip, command: command.command };
    } else {
      item.hide();
      shown = undefined;
    }
  };

  const watch = (repo: IRepository): void => {
    if (repoSubs.has(repo)) { return; }
    repoSubs.set(repo, vscode.Disposable.from(
      repo.onDidChangeStatus(() => render()),
      repo.onDidChangeOperation(() => render()),
    ));
  };
  const unwatch = (repo: IRepository): void => {
    repoSubs.get(repo)?.dispose();
    repoSubs.delete(repo);
  };

  const subs: vscode.Disposable[] = [
    s.model.onDidChangeState(() => render()),
    s.model.onDidOpenRepository((repo) => { watch(repo); render(); }),
    s.model.onDidCloseRepository((repo) => { unwatch(repo); render(); }),
  ];
  for (const repo of s.model.repositories) { watch(repo); }

  const hook = (): StatusBarSnapshot => ({ items: shown ? [{ ...shown }] : [] });
  testHooks.statusBarSnapshot = hook;
  render();

  return new vscode.Disposable(() => {
    if (testHooks.statusBarSnapshot === hook) { delete testHooks.statusBarSnapshot; }
    for (const d of subs) { d.dispose(); }
    for (const d of repoSubs.values()) { d.dispose(); }
    repoSubs.clear();
    item.dispose();
  });
}
