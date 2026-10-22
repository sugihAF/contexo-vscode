// Push / Push Selected / Pull (WP-1.13): the mutating SCM flows. Every flow first runs
// the E27 dirty guard, goes through IRepository.run (which refreshes the remote status
// afterwards), and never passes or offers --no-distill (D4).
import type { PageEntry, PageState, StatusDoc } from "../contract/types";
import type { Services } from "../services";

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
  void status;
  throw new Error("not implemented");
}

/** The relPaths of the selected entries in state modified or new, in the given order, without duplicates. */
export function pushSelectedPlan(states: readonly PageEntry[]): string[] {
  void states;
  throw new Error("not implemented");
}

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
  void args;
  await s.prompts.info("Contexo: not implemented yet");
}

/**
 * contexo.pushSelected (SCM resource context menu: (clicked, selected[])): ensureSaved, then
 * pushSelectedPlan over the selected entries of the refreshed status; no blocks_push
 * pre-check (the batch may be entity-only; ctx's distill_required decides). Same outcome
 * handling as push. More than 150 selected paths that are not the whole pushPlan are refused.
 */
export async function pushSelected(s: Services, ...args: unknown[]): Promise<void> {
  void args;
  await s.prompts.info("Contexo: not implemented yet");
}

/**
 * contexo.pull: ensureSaved(mode pull), then repo.run('pull', withBusyRetry(cli.pull(root))).
 * One summary notification: 'Pulled N page(s)' (+ ', M already identical' when adopted > 0),
 * or 'Already up to date' when nothing was written or adopted; then 'Kept your local edits
 * to M page(s)' (skips with reason modified or conflict) with [Show Changes]; 'M locally
 * deleted page(s) not restored (use Restore Server Version)'; invalid, case_collision and
 * changed_during_pull skips named once. Warnings go to the log.
 */
export async function pull(s: Services, ...args: unknown[]): Promise<void> {
  void args;
  await s.prompts.info("Contexo: not implemented yet");
}
