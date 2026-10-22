// perf (WP-2.3): the plan's budgets through the REAL wiring. activate() returns before the
// first online status completes and takes < 500 ms (x3 when CI is set; measured inside
// activate(), startupRecord()); 50 synchronous page writes made in < 200 ms cost exactly one
// `status --offline`; a push costs exactly one online status; 5 s of idleness after a settled
// reset costs none. Counts are taken over windows this suite controls (w.calls()).
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as vscode from "vscode";
import {
  holdsFor, isOfflineStatus, isOnlineStatus, openWorkspaceCopy, pagePath, scmRepo, sourceControlOf, startupRecord, waitFor,
  type CallRecord, type E2EWorkspace,
} from "../helpers/e2e";

/** activate() budget (plan: 500 ms, x3 on CI). */
const ACTIVATE_BUDGET_MS = process.env.CI ? 1500 : 500;
/** The burst must really be one burst: well inside the 1 s trailing debounce. */
const BURST_BUDGET_MS = 200;
/** Longer than the 1 s trailing debounce plus file-event latency. */
const QUIET_MS = 3000;
const IDLE_MS = 5000;
const BURST = 50;

const show = (calls: readonly CallRecord[]): string => JSON.stringify(calls.map((c) => c.argv.join(" ")));
/** holdsFor, failing with the calls recorded when the predicate broke (not when the window opened). */
async function hold(w: E2EWorkspace, pred: () => boolean, ms: number, what: string): Promise<void> {
  try {
    await holdsFor(pred, ms, what);
  } catch (err) {
    throw new Error(`${err instanceof Error ? err.message : String(err)}; calls: ${show(w.calls())}`, { cause: err });
  }
}

const byStart = (a: CallRecord, b: CallRecord): number => (a.start ?? 0) - (b.start ?? 0);

/** Run the SourceControl's acceptInputCommand exactly as VS Code does on Cmd/Ctrl+Enter. */
async function acceptInput(w: E2EWorkspace, message: string): Promise<void> {
  sourceControlOf(w.api).inputBox.value = message;
  const accept = scmRepo(w.api).acceptInputCommand;
  assert.ok(accept, "the SourceControl has an acceptInputCommand");
  await vscode.commands.executeCommand(accept.command, ...(accept.arguments ?? []));
}

describe("perf (e2e): activation, watcher and refresh budgets", function () {
  this.timeout(60000);

  it(`activate() returns before the first online status completes, in under ${ACTIVATE_BUDGET_MS} ms`, async () => {
    const w = await openWorkspaceCopy({ scenario: "mixed" }); // records the run's activation on first use
    const startup = startupRecord();
    assert.ok(startup, "startupRecord() after openWorkspaceCopy");
    const timing = startup.timing;
    assert.ok(timing, "api.hooks.activationTiming() is wired");
    assert.deepEqual(w.api.hooks.activationTiming?.(), timing, "the timing belongs to the running activation");
    assert.ok(timing.activateMs >= 0 && timing.activateMs < ACTIVATE_BUDGET_MS, `activate() took ${timing.activateMs.toFixed(1)} ms`);
    const first = startup.calls.filter(isOnlineStatus).sort(byStart)[0];
    assert.ok(first?.end !== undefined, `the activation's first online status ended (calls: ${show(startup.calls)})`);
    assert.ok(timing.activatedAt <= first.end,
      `activate() returned at ${timing.activatedAt}, after the first online status ended at ${first.end}`);
    const handshake = startup.calls.find((c) => c.argv[0] === "version" && c.argv[1] === "--json");
    assert.ok(handshake?.end !== undefined && (first.start ?? 0) >= handshake.end, "the handshake ran before the first status");
  });

  it(`${BURST} synchronous .md writes made in under ${BURST_BUDGET_MS} ms produce exactly one \`status --offline\``, async () => {
    const w = await openWorkspaceCopy({ scenario: "mixed" });
    const t0 = performance.now();
    for (let i = 0; i < BURST; i++) {
      const rel = `wiki/concepts/e8-perf-${String(i).padStart(2, "0")}.md`;
      fs.writeFileSync(pagePath(w.root, rel), `---\ntype: concept\ntitle: Perf ${i}\n---\n\nBurst page ${i}.\n`);
    }
    const writeMs = performance.now() - t0;
    assert.ok(writeMs < BURST_BUDGET_MS, `the ${BURST} writes took ${writeMs.toFixed(1)} ms`);
    const statuses = (): CallRecord[] => w.calls().filter((c) => c.argv[0] === "status");
    await waitFor(() => statuses().some((c) => c.end !== undefined), { timeoutMs: 10000, message: "the offline status after the burst" });
    await hold(w, () => statuses().length <= 1, QUIET_MS, "more than one status after the burst");
    assert.equal(statuses().length, 1, show(statuses()));
    assert.ok(isOfflineStatus(statuses()[0] as CallRecord), show(statuses()));
  });

  it("after a push exactly one online status runs (the queue's follow-up refresh)", async () => {
    const w = await openWorkspaceCopy({ scenario: "e8-ready-to-push" });
    await acceptInput(w, "perf push");
    const pushes = w.calls().filter((c) => c.argv[0] === "push");
    assert.equal(pushes.length, 1, show(w.calls()));
    const push = pushes[0] as CallRecord;
    assert.ok(push.end !== undefined, "the push recorded its end");
    const online = (): CallRecord[] => w.calls().filter((c) => isOnlineStatus(c) && (c.start ?? 0) >= (push.end ?? Infinity));
    await hold(w, () => online().length <= 1, QUIET_MS, "more than one online status after the push");
    assert.equal(online().length, 1, show(w.calls()));
    assert.equal(w.calls().filter(isOnlineStatus).length, 1, `no online status before or during the push: ${show(w.calls())}`);
  });

  it(`${IDLE_MS / 1000} s idle after a settled reset runs no online status`, async () => {
    const w = await openWorkspaceCopy({ scenario: "mixed" });
    await hold(w, () => !w.calls().some(isOnlineStatus), IDLE_MS, "an online status while idle");
    assert.deepEqual(w.calls().map((c) => c.argv), [], "no ctx call at all while idle");
  });
});
