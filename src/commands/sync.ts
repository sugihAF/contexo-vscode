// Push / Push Selected / Pull (WP-1.13): the mutating SCM flows. Every flow first runs
// the E27 dirty guard, goes through IRepository.run (which refreshes the remote status
// afterwards), and never passes or offers --no-distill (D4).
import * as vscode from "vscode";
import { CtxError, PUSH_PATHS_MAX, type PushOutcome } from "../cli/types";
import type { DistillRequiredDetails, PageEntry, PageState, PullDoc, PushDoc, StatusDoc } from "../contract/types";
import type { IRepository } from "../model/types";
import type { Services } from "../services";
import { ensureSaved } from "./dirtyGuard";
import { effectiveCode, presentError, SHOW_SCM_COMMAND, withBusyRetry } from "./errorActions";
import { COMMAND_IDS, type ShareViaAgentArgs } from "./ids";
import { resolveRepo, selectedPages, selectionOf, sourceControlOf, type SourceControlLike } from "./repoPicker";

/** Page states a push sends. Every other state is never planned. */
export const PUSHABLE_STATES: readonly PageState[] = ["modified", "new"];

/** D4 modal button; runs contexo.shareViaAgent. */
export const SHARE_VIA_AGENT_LABEL = "Share via your agent";
/** Button of the push-conflict warning; runs workbench.view.scm. */
export const SHOW_CONFLICTS_LABEL = "Show Conflicts";
/** Button of the 'Kept your local edits' pull summary; runs workbench.view.scm. */
export const SHOW_CHANGES_LABEL = "Show Changes";

/** The D4 modal text for n un-distilled sessions. */
export function distillMessage(n: number): string {
  return `${n} agent session(s) have not been distilled yet. Share these pages through your agent so the reasoning trail is kept.`;
}

/** The relPaths in state modified or new, in status order (pages are sorted by path). */
export function pushPlan(status: StatusDoc): string[] {
  return status.pages.filter((p) => PUSHABLE_STATES.includes(p.state)).map((p) => p.path);
}

/** The relPaths of the selected entries in state modified or new, in the given order, without duplicates. */
export function pushSelectedPlan(states: readonly PageEntry[]): string[] {
  const paths = new Set<string>();
  for (const p of states) {
    if (PUSHABLE_STATES.includes(p.state)) { paths.add(p.path); }
  }
  return [...paths]; // a Set keeps the first occurrence's position
}

// ---------- reports (pure) ----------

/** What a finished push tells the user. */
export interface PushReport {
  severity: "info" | "warning";
  message: string;
  /** The conflicting paths; the warning then offers [Show Conflicts]. */
  conflicts: string[];
  /** The SourceControl input box is cleared only after a push that sent pages and hit no conflict. */
  clearInput: boolean;
}

/** 'Pushed N page(s)', or a warning naming every conflict; skips other than unchanged are named once. */
export function pushReport(doc: PushDoc): PushReport {
  const notable = doc.skipped.filter((k) => k.reason !== "unchanged");
  const skipped = notable.length > 0
    ? ` Skipped ${notable.length} page(s): ${notable.map((k) => `${k.path} (${k.reason})`).join(", ")}.`
    : "";
  const conflicts = doc.conflicts.map((c) => c.path);
  if (conflicts.length > 0) {
    const pushed = doc.pushed.length > 0 ? `Pushed ${doc.pushed.length} page(s). ` : "";
    return {
      severity: "warning",
      message: `${pushed}${conflicts.length} conflict(s) need resolving: ${conflicts.join(", ")}.${skipped}`,
      conflicts,
      clearInput: false,
    };
  }
  if (doc.pushed.length === 0) {
    return { severity: "info", message: `Nothing was pushed.${skipped}`, conflicts, clearInput: false };
  }
  return { severity: "info", message: `Pushed ${doc.pushed.length} page(s).${skipped}`, conflicts, clearInput: true };
}

/** What a finished pull tells the user. */
export interface PullReport {
  message: string;
  /** Skips with reason modified or conflict; the notification then offers [Show Changes]. */
  keptLocalEdits: number;
}

/** Skip reasons a pull summary names once, path by path. */
const NAMED_PULL_SKIPS: readonly { reason: string; text: string }[] = [
  { reason: "invalid", text: "Invalid page(s) not pulled" },
  { reason: "case_collision", text: "Page(s) whose paths differ only by letter case not pulled" },
  { reason: "changed_during_pull", text: "Page(s) that changed during the pull left alone (pull again)" },
];

/** The one-notification pull summary (WP-1.13 Deliverables). */
export function pullReport(doc: PullDoc): PullReport {
  const written = doc.written.length;
  const adopted = doc.adopted.length;
  const parts = [written === 0 && adopted === 0
    ? "Already up to date"
    : `Pulled ${written} page(s)${adopted > 0 ? `, ${adopted} already identical` : ""}`];
  const kept = doc.skipped.filter((k) => k.reason === "modified" || k.reason === "conflict").length;
  if (kept > 0) { parts.push(`Kept your local edits to ${kept} page(s)`); }
  const deleted = doc.skipped.filter((k) => k.reason === "deleted_local").length;
  if (deleted > 0) { parts.push(`${deleted} locally deleted page(s) not restored (use Restore Server Version)`); }
  for (const { reason, text } of NAMED_PULL_SKIPS) {
    const paths = doc.skipped.filter((k) => k.reason === reason).map((k) => k.path);
    if (paths.length > 0) { parts.push(`${text}: ${paths.join(", ")}`); }
  }
  const known = new Set(["modified", "conflict", "deleted_local", ...NAMED_PULL_SKIPS.map((n) => n.reason)]);
  const other = doc.skipped.filter((k) => !known.has(k.reason));
  if (other.length > 0) { parts.push(`Not pulled: ${other.map((k) => `${k.path} (${k.reason})`).join(", ")}`); }
  return { message: `${parts.join(". ")}.`, keptLocalEdits: kept };
}

// ---------- shared UI helpers (also used by resolve.ts) ----------

/** One notification button and what picking it does. */
export interface NoticeAction { label: string; run: () => unknown }

/**
 * Show a notification WITHOUT awaiting it (VS Code settles it only when the user dismisses
 * it), and run the picked action later. Failures are logged, never thrown.
 */
export function notify(s: Pick<Services, "prompts" | "log">, severity: "info" | "warning" | "error", message: string, actions: readonly NoticeAction[] = []): void {
  const labels = actions.map((a) => a.label);
  const shown = severity === "error" ? s.prompts.error(message, ...labels)
    : severity === "warning" ? s.prompts.warn(message, ...labels)
      : s.prompts.info(message, ...labels);
  void shown
    .then(async (picked) => { await actions.find((a) => a.label === picked)?.run(); })
    .catch((err: unknown) => { s.log.error(`Contexo: notification action failed: ${err instanceof Error ? err.message : String(err)}`); });
}

/**
 * Progress in the SCM view with no cancel button: once ctx has started, cancelling could
 * leave the server and the local state out of step.
 */
export function withScmProgress<T>(title: string, task: () => Promise<T>): Promise<T> {
  return Promise.resolve(vscode.window.withProgress({ location: vscode.ProgressLocation.SourceControl, title, cancellable: false }, task));
}

/** The repository's status, after one offline refresh when none has been loaded yet. */
async function currentStatus(repo: IRepository): Promise<StatusDoc | undefined> {
  if (!repo.status) { await repo.refresh({ remote: false }); }
  return repo.status;
}

const STATUS_NOT_READY = "Contexo status is not available yet; try again in a moment.";

/**
 * The D4 refusal: a modal offering only [Share via your agent] (never 'Push anyway', never
 * --no-distill). Confirmed: contexo.shareViaAgent with {agentPrompt} when ctx gave one, else
 * with no argument. The share command is not awaited (it may show its own notification).
 */
async function offerShareViaAgent(s: Services, sessions: number, agentPrompt?: string): Promise<void> {
  const confirmed = await s.prompts.confirm(distillMessage(sessions), { modal: true, confirmLabel: SHARE_VIA_AGENT_LABEL });
  if (!confirmed) { return; }
  const shared = agentPrompt === undefined
    ? vscode.commands.executeCommand(COMMAND_IDS.shareViaAgent)
    : vscode.commands.executeCommand(COMMAND_IDS.shareViaAgent, { agentPrompt } satisfies ShareViaAgentArgs);
  void Promise.resolve(shared).then(undefined, (err: unknown) => {
    s.log.error(`${COMMAND_IDS.shareViaAgent} failed: ${err instanceof Error ? err.message : String(err)}`);
  });
}

function showScm(): Thenable<unknown> {
  return vscode.commands.executeCommand(SHOW_SCM_COMMAND);
}

// ---------- handlers ----------

/**
 * contexo.push (acceptInputCommand with the SourceControl as args[0], scm/title, view/title).
 * 1. resolveRepo(args[0]). 2. ensureSaved(mode push). 3. An empty pushPlan: info 'Nothing to
 * push', no ctx call. 4. status.captures.blocks_push: confirm(distillMessage(captures.fresh),
 * {modal, confirmLabel: SHARE_VIA_AGENT_LABEL}); confirmed -> executeCommand(contexo.shareViaAgent)
 * with no args; no ctx call either way. 5. withProgress(SourceControl, not cancellable) +
 * repo.run('push', withBusyRetry(cli.push(root, {message: inputBox.value.trim() || undefined,
 * paths: plan.length > 150 ? undefined : plan}))). 6. PushOutcome: no conflicts -> clear the
 * SourceControl inputBox, info 'Pushed N page(s)'; conflicts -> warning naming every conflict
 * path with [Show Conflicts]; skipped (other than unchanged) named once; warnings logged.
 * 7. CtxError distill_required -> the same modal, confirmed -> executeCommand(contexo.shareViaAgent,
 * {agentPrompt: details.agent_prompt}); any other CtxError -> presentError (retry = push again).
 */
export async function push(s: Services, ...args: unknown[]): Promise<void> {
  const repo = await resolveRepo(s, args[0]);
  if (!repo) { return; }
  if (!(await ensureSaved(s, repo, { mode: "push" }))) { return; }
  const status = await currentStatus(repo);
  if (!status) { notify(s, "info", STATUS_NOT_READY); return; }
  const plan = pushPlan(status);
  if (plan.length === 0) { notify(s, "info", "Nothing to push"); return; }
  if (status.captures.blocks_push) {
    await offerShareViaAgent(s, status.captures.fresh);
    return;
  }
  const sc = sourceControlOf(args[0]);
  const message = sc?.inputBox.value.trim() || undefined;
  if (plan.length > PUSH_PATHS_MAX) {
    s.log.info(`push: ${plan.length} pages planned (more than ${PUSH_PATHS_MAX}), so no paths are passed and ctx pushes every modified and new page`);
  }
  await runPush(s, repo, { message, paths: plan.length > PUSH_PATHS_MAX ? undefined : plan }, sc, () => push(s, ...args));
}

/**
 * contexo.pushSelected (SCM resource context menu: (clicked, selected[]) or the selected
 * states spread): ensureSaved, then pushSelectedPlan over the selected entries of the
 * refreshed status; no blocks_push pre-check (the batch may be entity-only; ctx's
 * distill_required decides). Same outcome handling as push. More than 150 selected paths
 * that are not the whole pushPlan are refused, because omitting the paths would push every
 * change.
 */
export async function pushSelected(s: Services, ...args: unknown[]): Promise<void> {
  const selection = selectionOf(args);
  const repo = await resolveRepo(s, selection);
  if (!repo) { return; }
  if (!(await ensureSaved(s, repo, { mode: "pushSelected" }))) { return; }
  const status = await currentStatus(repo);
  if (!status) { notify(s, "info", STATUS_NOT_READY); return; }
  const plan = pushSelectedPlan(selectedPages(selection, repo));
  if (plan.length === 0) { notify(s, "info", "Nothing to push"); return; }
  let paths: string[] | undefined = plan;
  if (plan.length > PUSH_PATHS_MAX) {
    const all = pushPlan(status);
    if (all.length !== plan.length || !all.every((p) => plan.includes(p))) {
      notify(s, "warning", `Push Selected sends at most ${PUSH_PATHS_MAX} pages. Select fewer, or use Push to send every change.`);
      return;
    }
    paths = undefined;
    s.log.info(`pushSelected: all ${plan.length} changed pages are selected (more than ${PUSH_PATHS_MAX}), so no paths are passed`);
  }
  await runPush(s, repo, { paths }, undefined, () => pushSelected(s, ...args));
}

/** One ctx push inside repo.run('push') (one busy retry), then its outcome or error. */
async function runPush(
  s: Services,
  repo: IRepository,
  o: { message?: string; paths?: string[] },
  sc: SourceControlLike | undefined,
  retry: () => Promise<void>,
): Promise<void> {
  const root = repo.root.fsPath;
  let outcome: PushOutcome;
  try {
    outcome = await withScmProgress("Pushing to Contexo", () => repo.run("push", () => withBusyRetry(() => s.cli.push(root, o))));
  } catch (err) {
    if (!(err instanceof CtxError)) { throw err; }
    if (effectiveCode(err) === "distill_required") {
      const details = err.details as Partial<DistillRequiredDetails> | undefined;
      const sessions = Array.isArray(details?.sessions) ? details.sessions.length : repo.status?.captures.fresh ?? 0;
      await offerShareViaAgent(s, sessions, typeof details?.agent_prompt === "string" ? details.agent_prompt : undefined);
      return;
    }
    presentError(s, err, { retry, repoId: repo.status?.project.repo_id, repo, refreshed: true });
    return;
  }
  const doc = outcome.doc;
  for (const w of doc.warnings) { s.log.warn(`push: ${w.code}: ${w.message}`); }
  if (doc.distill.bypassed) { s.log.warn("push: ctx reports the distill guard as bypassed (set outside the extension)"); }
  const report = pushReport(doc);
  if (report.clearInput && sc) { sc.inputBox.value = ""; }
  notify(s, report.severity, report.message, report.conflicts.length > 0 ? [{ label: SHOW_CONFLICTS_LABEL, run: showScm }] : []);
}

/**
 * contexo.pull: ensureSaved(mode pull), then repo.run('pull', withBusyRetry(cli.pull(root))).
 * One summary notification (pullReport): 'Pulled N page(s)' (+ ', M already identical' when
 * adopted > 0), or 'Already up to date' when nothing was written or adopted; then 'Kept your
 * local edits to M page(s)' (skips with reason modified or conflict) with [Show Changes];
 * 'M locally deleted page(s) not restored (use Restore Server Version)'; invalid,
 * case_collision and changed_during_pull skips named once. Warnings go to the log.
 */
export async function pull(s: Services, ...args: unknown[]): Promise<void> {
  const repo = await resolveRepo(s, args[0]);
  if (!repo) { return; }
  if (!(await ensureSaved(s, repo, { mode: "pull" }))) { return; }
  const root = repo.root.fsPath;
  let doc: PullDoc;
  try {
    doc = await withScmProgress("Pulling from Contexo", () => repo.run("pull", () => withBusyRetry(() => s.cli.pull(root))));
  } catch (err) {
    if (!(err instanceof CtxError)) { throw err; }
    presentError(s, err, { retry: () => pull(s, ...args), repoId: repo.status?.project.repo_id, repo, refreshed: true });
    return;
  }
  for (const w of doc.warnings) { s.log.warn(`pull: ${w.code}: ${w.message}`); }
  const report = pullReport(doc);
  notify(s, "info", report.message, report.keptLocalEdits > 0 ? [{ label: SHOW_CHANGES_LABEL, run: showScm }] : []);
}
