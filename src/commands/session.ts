// Session commands (WP-1.12): log in, initialize, install and update ctx, share via your
// agent, and the E37 notice when ctx's version changes. Login, init and update run ctx in a
// terminal (src/terminal.ts); install only opens the install instructions (WP-6H.4). The
// extension never reads or writes credentials itself.
import * as vscode from "vscode";
import type { BinaryState, ICtxCli } from "../cli/types";
import type { VersionDoc } from "../contract/types";
import type { Services } from "../services";
import { runCtxInTerminal } from "../terminal";
import type { Prompts } from "../ui/prompts";
import type { ShareViaAgentArgs } from "./ids";

export const DEFAULT_AGENT_PROMPT =
  "Push my pending Contexo changes with the ctx_push tool. Distill the pending session into a source page first when ctx_push asks you to.";
export const SHARE_COPIED_MESSAGE = "Prompt copied. Paste it into your agent chat (Claude Code, Cursor, Codex).";
/** The ctx install instructions (checksum-verified binaries from GitHub Releases). */
export const INSTALL_DOCS_URL = "https://github.com/sugihAF/Contexo#install";
export const INSTALL_OPENED_MESSAGE =
  "Contexo: the ctx install instructions are open in your browser. After installing ctx, run Contexo: Refresh.";
/** globalState key: the ctx version key the E37 notice was last shown for. */
export const LAST_CTX_VERSION_KEY = "contexo.lastCtxVersion";

/** Environment seams, read at call time; tests replace members and restore them. */
export const sessionSeams = {
  remoteName: (): string | undefined => vscode.env.remoteName,
};

const NO_FOLDER_MESSAGE = "Contexo: open a folder first.";
const LOCATE_CTX = "Locate ctx…";
const LEARN_MORE = "Learn more";

/** The repository root the argument resolves to, else the first workspace folder. */
export function targetRoot(s: Services, arg: unknown): string | undefined {
  return s.model.resolveTarget(arg)?.repository.root.fsPath ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

/** contexo.login: `ctx auth login` in a terminal; --no-browser in a remote window (D8 paste-token flow). */
export async function login(s: Services, arg?: unknown): Promise<void> {
  const root = targetRoot(s, arg);
  if (root === undefined) {
    void s.prompts.warn(NO_FOLDER_MESSAGE);
    return;
  }
  const remote = sessionSeams.remoteName();
  const argv = ["auth", "login", "--root", root];
  if (remote) { argv.push("--no-browser"); }
  void s.prompts.info(remote
    ? "Contexo: log in in the terminal; in a remote window ctx prints a link to open and asks you to paste the token."
    : "Contexo: log in in the terminal; ctx opens your browser.");
  await runCtxInTerminal(s, root, argv);
}

/** contexo.init: `ctx init` in a workspace folder that has no Contexo project yet. */
export async function init(s: Services, arg?: unknown): Promise<void> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) {
    void s.prompts.warn(NO_FOLDER_MESSAGE);
    return;
  }
  const candidates = folders.filter((f) => s.model.getRepository(f.uri) === undefined);
  const requested = arg instanceof vscode.Uri ? vscode.workspace.getWorkspaceFolder(arg) : undefined;
  let folder = requested && candidates.includes(requested) ? requested : undefined;
  if (!folder) {
    if (candidates.length === 0) {
      void s.prompts.info("Contexo: every workspace folder already has a Contexo project.");
      return;
    }
    if (candidates.length === 1) {
      folder = candidates[0];
    } else {
      const items = candidates.map((f) => ({ label: f.name, description: f.uri.fsPath }));
      const picked = await s.prompts.quickPick(items, { placeHolder: "Folder to initialize Contexo in" });
      if (!picked) { return; }
      folder = candidates.find((f) => f.uri.fsPath === picked.description);
    }
  }
  if (!folder) { return; }
  // Its refreshAll re-discovers roots; the .contexo/*.json watcher covers it too (E28).
  await runCtxInTerminal(s, folder.uri.fsPath, ["init", "--root", folder.uri.fsPath]);
}

/**
 * contexo.installCtx: opens the ctx install instructions in the browser. It runs nothing;
 * Contexo: Refresh finds ctx once it is installed.
 */
export async function installCtx(s: Services): Promise<void> {
  await s.prompts.openExternal(vscode.Uri.parse(INSTALL_DOCS_URL));
  const pick = await s.prompts.info(INSTALL_OPENED_MESSAGE, LOCATE_CTX);
  if (pick === LOCATE_CTX) {
    await vscode.commands.executeCommand("workbench.action.openSettings", "contexo.path");
  }
}

/** contexo.updateCtx: `ctx update` in a terminal, then rediscover ctx before the refresh. */
export async function updateCtx(s: Services, arg?: unknown): Promise<void> {
  const root = targetRoot(s, arg);
  const argv = root === undefined ? ["update"] : ["update", "--root", root];
  await runCtxInTerminal(s, root, argv, { beforeRefresh: () => s.cli.rediscover() });
}

/** contexo.shareViaAgent: copy a prompt for the user's agent (never runs ctx). */
export async function shareViaAgent(s: Services, arg?: unknown): Promise<void> {
  const prompt = typeof arg === "object" && arg !== null ? (arg as ShareViaAgentArgs).agentPrompt : undefined;
  const text = typeof prompt === "string" && prompt !== "" ? prompt : DEFAULT_AGENT_PROMPT;
  await s.prompts.copyToClipboard(text);
  void s.prompts.info(SHARE_COPIED_MESSAGE);
}

/** The E37 notice key: the version, plus the commit for a dev build. */
export function ctxVersionKey(v: VersionDoc): string {
  return v.dev_build ? `${v.version}+${v.commit}` : v.version;
}

/** Keys whose notice is being recorded right now (two triggers can race). */
const noticeInFlight = new Set<string>();

/**
 * E37: once per ctx version (key), tell the user to restart their agent sessions so their
 * Contexo MCP server runs the same ctx. Resolves true when the notice was shown.
 */
export async function ctxVersionNotice(
  memento: vscode.Memento,
  cli: Pick<ICtxCli, "getBinary">,
  prompts: Pick<Prompts, "info" | "openExternal">,
  binary?: BinaryState,
): Promise<boolean> {
  const b = binary ?? await cli.getBinary();
  if (b.kind !== "ok") { return false; }
  const key = ctxVersionKey(b.version);
  if (memento.get<string>(LAST_CTX_VERSION_KEY) === key || noticeInFlight.has(key)) { return false; }
  noticeInFlight.add(key);
  try {
    // Recorded before the notice shows, so a racing trigger finds it.
    await memento.update(LAST_CTX_VERSION_KEY, key);
  } finally {
    noticeInFlight.delete(key);
  }
  void prompts.info(
    `Contexo is using ctx ${key}. Restart your agent sessions so their Contexo MCP server runs this ctx; older MCP servers can still overwrite local edits.`,
    LEARN_MORE,
  ).then(async (choice) => {
    if (choice === LEARN_MORE) { await prompts.openExternal(vscode.Uri.parse(INSTALL_DOCS_URL)); }
  }).catch(() => undefined);
  return true;
}
