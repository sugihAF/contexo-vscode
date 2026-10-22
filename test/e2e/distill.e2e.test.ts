// distill (WP-2.3): the D4 guard through the REAL wiring. With captures.blocks_push=true Push
// spawns no ctx push and offers only [Share via your agent]; when ctx push itself exits 9
// distill_required the same modal appears and Share copies details.agent_prompt to the
// clipboard. Nothing ever retries with --no-distill (argv and env checked through
// calls.jsonl; the root call audit checks every call too), and the modal never echoes ctx's
// message or advice (e8-distill-required's envelope mentions --no-distill on purpose).
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { COMMAND_IDS } from "../../src/commands/ids";
import { DEFAULT_AGENT_PROMPT, SHARE_COPIED_MESSAGE } from "../../src/commands/session";
import { SHARE_VIA_AGENT_LABEL, distillMessage } from "../../src/commands/sync";
import { parseEnvelope, type DistillRequiredDetails, type ErrorEnvelope } from "../../src/contract/types";
import { placeholderFor } from "../../src/scm/resourceModel";
import {
  SCENARIOS, holdsFor, openWorkspaceCopy, pagePath, scmRepo, sourceControlOf,
  type CallRecord, type E2EPrompts, type E2EWorkspace,
} from "../helpers/e2e";

const SYNC_MODEL = "wiki/analyses/sync-model.md";
const AUTH_FLOW = "wiki/concepts/auth-flow.md";
/** Longer than the 1 s busy retry and the 1 s watcher debounce: a retry would show up in it. */
const QUIET_MS = 2500;

const show = (calls: readonly CallRecord[]): string => JSON.stringify(calls.map((c) => c.argv.join(" ")));
const pushes = (w: E2EWorkspace): CallRecord[] => w.calls().filter((c) => c.argv[0] === "push");

/** holdsFor, failing with the calls recorded when the predicate broke (not when the window opened). */
async function hold(w: E2EWorkspace, pred: () => boolean, ms: number, what: string): Promise<void> {
  try {
    await holdsFor(pred, ms, what);
  } catch (err) {
    throw new Error(`${err instanceof Error ? err.message : String(err)}; calls: ${show(w.calls())}`, { cause: err });
  }
}

/** Run the SourceControl's acceptInputCommand exactly as VS Code does on Cmd/Ctrl+Enter. */
async function acceptInput(w: E2EWorkspace, message: string): Promise<void> {
  sourceControlOf(w.api).inputBox.value = message;
  const accept = scmRepo(w.api).acceptInputCommand;
  assert.ok(accept, "the SourceControl has an acceptInputCommand");
  assert.equal(accept.command, COMMAND_IDS.push);
  await vscode.commands.executeCommand(accept.command, ...(accept.arguments ?? []));
}

/** The distill_required envelope a scenario's stderr file holds (last non-empty line). */
function envelopeOf(scenario: string, file: string): { envelope: ErrorEnvelope; details: DistillRequiredDetails } {
  const envelope = parseEnvelope(fs.readFileSync(path.join(SCENARIOS, scenario, file), "utf8"), 9);
  assert.equal(envelope.error.code, "distill_required");
  const details = envelope.error.details as DistillRequiredDetails | undefined;
  assert.ok(details && typeof details.agent_prompt === "string" && details.sessions.length > 0, `${scenario}/${file} has distill details`);
  return { envelope, details };
}

/** D4: no prompt offers a bypass, and none echoes ctx's own message or advice. */
function assertNoBypass(prompts: E2EPrompts, envelope?: ErrorEnvelope): void {
  for (const c of prompts.calls) {
    const shown = JSON.stringify({ message: c.message, actions: c.actions, options: c.options });
    assert.ok(!/no-distill|push anyway/i.test(shown), `D4: a prompt offers a bypass: ${shown}`);
    if (envelope) {
      assert.ok(!c.message.includes(envelope.error.message), `the modal echoes ctx's message: ${shown}`);
      for (const advice of envelope.error.advice) { assert.ok(!c.message.includes(advice), `ctx advice shown: ${shown}`); }
    }
  }
}

/** No call ever passed --no-distill or CONTEXO_DISTILL_DISABLE (D4, E26). */
function assertNoDistillBypassInCalls(w: E2EWorkspace): void {
  for (const c of w.calls()) {
    assert.ok(!c.argv.some((a) => a.startsWith("--no-distill")), `--no-distill in ${c.argv.join(" ")}`);
    assert.ok(!Object.prototype.hasOwnProperty.call(c.env, "CONTEXO_DISTILL_DISABLE"), `CONTEXO_DISTILL_DISABLE reached ${c.argv.join(" ")}`);
  }
}

describe("distill (e2e): the D4 guard through the real wiring", function () {
  this.timeout(60000);

  it("captures.blocks_push=true: Push spawns no ctx push and offers Share via your agent, which copies the default prompt", async () => {
    const w = await openWorkspaceCopy({ scenario: "e8-distill-blocked" });
    const status = w.repo().status;
    assert.ok(status);
    assert.equal(status.captures.blocks_push, true);
    assert.equal(scmRepo(w.api).inputPlaceholder, placeholderFor(status, process.platform), "the input box says Push offers Share via your agent");
    w.prompts.confirmAnswers = [true];

    await acceptInput(w, "Share the auth flow");

    const confirm = w.prompts.find(distillMessage(status.captures.fresh), "confirm");
    assert.ok(confirm, `the D4 modal (prompts: ${JSON.stringify(w.prompts.calls.map((c) => `${c.method}: ${c.message}`))})`);
    assert.deepEqual(confirm.options, { modal: true, confirmLabel: SHARE_VIA_AGENT_LABEL }, "the only button is Share via your agent");
    const copied = await w.prompts.waitFor(DEFAULT_AGENT_PROMPT, { method: "copyToClipboard" });
    assert.equal(copied.message, DEFAULT_AGENT_PROMPT, "the pre-check shares with no argument: the default prompt");
    await w.prompts.waitFor(SHARE_COPIED_MESSAGE, { method: "info" });

    await hold(w, () => pushes(w).length === 0, QUIET_MS, "a ctx push under blocks_push");
    assert.deepEqual(w.calls(), [], "the pre-check makes no ctx call at all");
    assertNoBypass(w.prompts);
  });

  it("ctx push exit 9 distill_required: the same guard appears, and Share copies details.agent_prompt to the clipboard", async () => {
    const w = await openWorkspaceCopy({ scenario: "e8-distill-required" });
    const { envelope, details } = envelopeOf("e8-distill-required", "distill_required.stderr");
    assert.equal(w.repo().status?.captures.blocks_push, false, "no pre-check: ctx decides");
    w.prompts.confirmAnswers = [true];

    await acceptInput(w, "Document the sync model");

    const push = pushes(w)[0];
    assert.ok(push, `ctx push ran: ${show(w.calls())}`);
    assert.equal(push.exit, 9);
    assert.deepEqual(push.argv, ["push", "--json", "--yes", "--root", w.root, "-m", "Document the sync model", "--", SYNC_MODEL, AUTH_FLOW]);
    const confirm = w.prompts.find(distillMessage(details.sessions.length), "confirm");
    assert.ok(confirm, `the D4 modal counts details.sessions (prompts: ${JSON.stringify(w.prompts.calls.map((c) => `${c.method}: ${c.message}`))})`);
    assert.deepEqual(confirm.options, { modal: true, confirmLabel: SHARE_VIA_AGENT_LABEL });

    const copied = await w.prompts.waitFor(details.agent_prompt, { method: "copyToClipboard" });
    assert.equal(copied.message, details.agent_prompt, "Share copies ctx's agent_prompt verbatim");
    assert.equal(await vscode.env.clipboard.readText(), details.agent_prompt, "the system clipboard holds the agent prompt");
    await w.prompts.waitFor(SHARE_COPIED_MESSAGE, { method: "info" });

    await hold(w, () => pushes(w).length === 1, QUIET_MS, "a second ctx push after distill_required");
    assertNoBypass(w.prompts, envelope);
    assertNoDistillBypassInCalls(w);
  });

  it("there is never a retry with --no-distill: Cancel on the exit-9 guard leaves exactly one push, copies nothing, and no call carries --no-distill", async () => {
    const w = await openWorkspaceCopy({ scenario: "e8-distill-required" });
    const { envelope, details } = envelopeOf("e8-distill-required", "distill_required.stderr");
    w.prompts.confirmAnswers = [false];

    await acceptInput(w, "Document the sync model");

    assert.equal(w.prompts.find(distillMessage(details.sessions.length), "confirm")?.answer, false);
    await hold(w, () => pushes(w).length === 1, QUIET_MS, "a retry after the user cancelled the D4 modal");
    assert.equal(pushes(w).length, 1, show(w.calls()));
    assert.equal(w.prompts.calls.filter((c) => c.method === "copyToClipboard").length, 0, "nothing copied");
    assertNoBypass(w.prompts, envelope);
    assertNoDistillBypassInCalls(w);
  });

  it("Push Selected under blocks_push has no pre-check: ctx push runs with the selected path, and its exit 9 shows the same guard", async () => {
    const w = await openWorkspaceCopy({ scenario: "e8-distill-blocked" });
    const { details } = envelopeOf("e7-distill-required", "distill_required.stderr");
    w.prompts.confirmAnswers = [false];
    const state = { resourceUri: vscode.Uri.file(pagePath(w.root, AUTH_FLOW)) };

    await vscode.commands.executeCommand(COMMAND_IDS.pushSelected, state, [state]);

    const push = pushes(w)[0];
    assert.ok(push, `ctx push ran: ${show(w.calls())}`);
    assert.deepEqual(push.argv, ["push", "--json", "--yes", "--root", w.root, "--", AUTH_FLOW]);
    assert.equal(push.exit, 9);
    assert.ok(w.prompts.find(distillMessage(details.sessions.length), "confirm"), "the D4 modal after exit 9");
    await hold(w, () => pushes(w).length === 1, QUIET_MS, "a retry of Push Selected");
    assertNoBypass(w.prompts);
    assertNoDistillBypassInCalls(w);
  });
});
