// busy (WP-2.3): ctx exit 12 (busy, another ctx process holds .sync/lock) through the REAL
// wiring. The first busy failure of a push or pull is retried once, BUSY_RETRY_MS after it
// ended, inside the same repo.run; a second busy shows BUSY_MESSAGE with [Retry] and nothing
// runs again by itself. Timing comes from calls.jsonl (FAKE_CTX_TIMESTAMPS start/end).
import * as assert from "node:assert/strict";
import * as vscode from "vscode";
import type { PushDoc } from "../../src/contract/types";
import { ACTION_LABELS, BUSY_MESSAGE, BUSY_RETRY_MS } from "../../src/commands/errorActions";
import { COMMAND_IDS } from "../../src/commands/ids";
import { pushPlan, pushReport } from "../../src/commands/sync";
import {
  holdsFor, isOnlineStatus, openWorkspaceCopy, sourceControlOf, type CallRecord, type E2EWorkspace,
} from "../helpers/e2e";
import { scenarioOutput } from "../helpers/fixtures";

/** The calls of one ctx command, in start order. */
function callsOf(w: E2EWorkspace, command: string): CallRecord[] {
  return w.calls().filter((c) => c.argv[0] === command);
}

/** Online statuses that started inside [from, to). */
function onlineBetween(w: E2EWorkspace, from: number, to: number): CallRecord[] {
  return w.calls().filter((c) => isOnlineStatus(c) && (c.start ?? 0) >= from && (c.start ?? 0) < to);
}

/** The two attempts of a busy operation: same argv, the retry about BUSY_RETRY_MS after the first one ended. */
function assertOneRetry(attempts: readonly CallRecord[], what: string): [CallRecord, CallRecord] {
  assert.equal(attempts.length, 2, `${what}: one automatic retry, then stop (got ${JSON.stringify(attempts.map((c) => c.argv))})`);
  const [first, second] = attempts as [CallRecord, CallRecord];
  assert.deepEqual(second.argv, first.argv, `${what}: the retry is the same operation`);
  assert.ok(first.end !== undefined && second.start !== undefined, `${what}: both attempts are timestamped`);
  const gap = (second.start ?? 0) - (first.end ?? 0);
  assert.ok(gap >= BUSY_RETRY_MS * 0.9, `${what}: retry ${gap} ms after the busy attempt ended (want about ${BUSY_RETRY_MS} ms)`);
  assert.ok(gap < BUSY_RETRY_MS + 5000, `${what}: retry ${gap} ms after the busy attempt ended (want about ${BUSY_RETRY_MS} ms)`);
  return [first, second];
}

describe("busy (e2e): ctx exit 12 is retried once after about 1 s, then the busy message offers Retry", function () {
  this.timeout(60000);

  for (const command of ["push", "pull"] as const) {
    it(`${command}: exit 12 twice -> exactly 2 spawns, the second >= 0.9 x BUSY_RETRY_MS after the first ended, then BUSY_MESSAGE with [Retry] and no third attempt (e8-busy)`, async () => {
      const w = await openWorkspaceCopy({ scenario: "e8-busy" });
      const sc = sourceControlOf(w.api);
      sc.inputBox.value = "busy e2e";

      await vscode.commands.executeCommand(COMMAND_IDS[command], sc);

      const [first, second] = assertOneRetry(callsOf(w, command), command);
      assert.equal(first.exit, 12);
      assert.equal(second.exit, 12);
      assert.deepEqual(onlineBetween(w, first.start ?? 0, second.start ?? 0), [], "the retry runs inside the same repo.run: no refresh between the attempts");

      const busy = await w.prompts.waitFor(BUSY_MESSAGE, { method: "warn" });
      assert.equal(busy.message, BUSY_MESSAGE);
      assert.deepEqual(busy.actions, [ACTION_LABELS.retry], "the busy message offers [Retry]");
      assert.ok(busy.at >= (second.end ?? Infinity), "the message shows only after the automatic retry failed too");
      assert.equal(w.prompts.notifications().filter((n) => n.message === BUSY_MESSAGE).length, 1, "one busy message");

      // The prompt stub dismissed [Retry]: nothing runs again by itself, and repo.run's own
      // follow-up refresh is the only online status after the second attempt.
      await holdsFor(() => callsOf(w, command).length === 2, BUSY_RETRY_MS * 2, `no further automatic ${command} after the busy message`);
      const online = w.calls().filter((c) => isOnlineStatus(c) && (c.start ?? 0) >= (second.end ?? Infinity));
      assert.equal(online.length, 1, `exactly one online status after the second ${command} (got ${online.length})`);
      assert.deepEqual(online[0]?.argv, ["status", "--json", "--root", w.root]);
    });
  }

  it("a busy lock that is gone by the retry: 2 push spawns, the retry succeeds with the planned paths, no busy message, and the input box is cleared (e8-busy-once -> e8-busy-cleared)", async () => {
    const w = await openWorkspaceCopy({ scenario: "e8-busy-once" });
    const status = w.repo().status;
    assert.ok(status, "the repository has a status");
    const plan = pushPlan(status);
    const sc = sourceControlOf(w.api);
    sc.inputBox.value = "busy once";

    await vscode.commands.executeCommand(COMMAND_IDS.push, sc);

    const [first, second] = assertOneRetry(callsOf(w, "push"), "push");
    assert.equal(first.exit, 12);
    assert.equal(second.exit, 0, "the retried push succeeded");
    assert.deepEqual(second.argv, ["push", "--json", "--yes", "--root", w.root, "-m", "busy once", "--", ...plan]);

    const out = scenarioOutput("e8-busy-cleared", second.argv);
    assert.ok(out && out.exit === 0, "e8-busy-cleared answers the push");
    const report = pushReport(JSON.parse(out.stdout) as PushDoc);
    await w.prompts.waitFor(report.message, { method: "info" });
    assert.equal(w.prompts.find(BUSY_MESSAGE), undefined, "a retry that succeeds shows no busy message");
    assert.equal(sc.inputBox.value, "", "a successful push clears the input box");
  });
});
