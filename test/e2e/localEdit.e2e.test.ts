// localEdit (WP-2.3): local file edits drive the WP-1.8 refresh scheduler through the REAL
// watchers: a page write -> one `status --offline` after the 1 s trailing debounce (the SCM,
// decorations and tree follow), a burst of writes -> still one, a .contexo/*.json touch ->
// one ONLINE status (E28), and the files ctx writes itself -> none. Counts are taken over
// w.calls() only, and "exactly one" is held for a window longer than the debounce.
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { decorationForState } from "../../src/decorations/decorationModel";
import {
  groupPaths, holdsFor, isOfflineStatus, isOnlineStatus, openWorkspaceCopy, pagePath, scmRepo, setScenario, waitFor,
  type CallRecord, type E2EWorkspace,
} from "../helpers/e2e";

const GITSTORE = "wiki/entities/gitstore.md";
const AUTH_FLOW = "wiki/concepts/auth-flow.md";
const OLD_NAME = "wiki/concepts/old-name.md";
/** Appended to gitstore.md; e8-gitstore-modified's local.hash is the hash of the edited bytes. */
const GITSTORE_EDIT = "\n<!-- e8: local edit -->\n";
/** Pages the burst test rewrites (all exist in the basic fixture). */
const BURST_PAGES = [
  "raw/sessions/2026-10-01-login-debug.md",
  "wiki/analyses/sync-model.md",
  AUTH_FLOW,
  "wiki/concepts/legacy-sync.md",
  GITSTORE,
];
/** Longer than the 1 s trailing debounce plus file-event latency. */
const QUIET_MS = 3000;

const statuses = (w: E2EWorkspace): CallRecord[] => w.calls().filter((c) => c.argv[0] === "status");
const show = (calls: readonly CallRecord[]): string => JSON.stringify(calls.map((c) => c.argv.join(" ")));

/** holdsFor, failing with the calls recorded when the predicate broke (not when the window opened). */
async function hold(w: E2EWorkspace, pred: () => boolean, ms: number, what: string): Promise<void> {
  try {
    await holdsFor(pred, ms, what);
  } catch (err) {
    throw new Error(`${err instanceof Error ? err.message : String(err)}; calls: ${show(w.calls())}`, { cause: err });
  }
}

describe("localEdit (e2e): page and .contexo/*.json edits through the real watchers", function () {
  this.timeout(60000);

  it("writing wiki/entities/gitstore.md under scenario e8-gitstore-modified puts it in Changes within 2.5 s (an offline status)", async () => {
    const w = await openWorkspaceCopy({ scenario: "mixed" });
    const file = pagePath(w.root, GITSTORE);
    const uri = vscode.Uri.file(file);
    assert.ok(!groupPaths(scmRepo(w.api), "changes").includes(GITSTORE), "gitstore starts unchanged");
    assert.equal(w.api.hooks.decorationFor?.(uri), undefined);

    setScenario(w.root, "e8-gitstore-modified");
    const t0 = Date.now();
    fs.appendFileSync(file, GITSTORE_EDIT);
    await waitFor(() => groupPaths(scmRepo(w.api), "changes").includes(GITSTORE), {
      timeoutMs: 2500, intervalMs: 10, message: `gitstore in Changes within 2.5 s (calls: ${show(w.calls())})`,
    });
    const elapsed = Date.now() - t0;
    assert.ok(elapsed <= 2500, `Changes updated after ${elapsed} ms`);

    assert.deepEqual(groupPaths(scmRepo(w.api), "changes"), [AUTH_FLOW, OLD_NAME, GITSTORE], "Changes, sorted by path");
    const resource = scmRepo(w.api).groups.flatMap((g) => g.resources).find((r) => r.relPath === GITSTORE);
    assert.equal(resource?.contextValue, "modified");
    const ran = statuses(w);
    assert.ok(ran.length >= 1 && ran.every(isOfflineStatus), `a page write refreshes offline only: ${show(ran)}`);
    assert.deepEqual(ran[0]?.argv, ["status", "--json", "--root", w.root, "--offline"]);
    await waitFor(() => w.api.hooks.decorationFor?.(uri)?.badge === decorationForState("modified")?.badge, {
      timeoutMs: 2000, message: "gitstore decorated as modified",
    });
    const node = w.api.hooks.treeSnapshot?.().roots
      .flatMap((n) => n.children)
      .find((n) => n.id === `${w.root}|${GITSTORE}`);
    assert.equal(node?.contextValue, "page.modified", "the Knowledge tree shows gitstore modified");
    assert.equal(w.repo().status?.counts.modified, 2, "the offline result was merged over the last online one (auth-flow, gitstore)");
    assert.equal(w.repo().status?.counts.conflict, 1, "the online conflict survives the offline refresh (stateMerge)");
  });

  it("50 writes to pages produce exactly one `status --offline` (and no online status)", async () => {
    const w = await openWorkspaceCopy({ scenario: "mixed" });
    const originals = new Map(BURST_PAGES.map((rel) => [rel, fs.readFileSync(pagePath(w.root, rel), "utf8")]));
    for (let i = 0; i < 50; i++) {
      const rel = BURST_PAGES[i % BURST_PAGES.length] as string;
      fs.writeFileSync(pagePath(w.root, rel), `${originals.get(rel) ?? ""}\n<!-- e8 write ${i} -->\n`);
    }
    await waitFor(() => statuses(w).some((c) => c.end !== undefined), { timeoutMs: 10000, message: "the offline status after the burst" });
    await hold(w, () => statuses(w).length <= 1, QUIET_MS, "more than one status after 50 writes");
    const ran = statuses(w);
    assert.equal(ran.length, 1, show(ran));
    assert.ok(isOfflineStatus(ran[0] as CallRecord), `the one status is offline: ${show(ran)}`);
    assert.equal(w.calls().filter(isOnlineStatus).length, 0);
  });

  it("touching .contexo/config.json produces exactly one online status (E28)", async () => {
    const w = await openWorkspaceCopy({ scenario: "mixed" });
    const config = path.join(w.root, ".contexo", "config.json");
    fs.writeFileSync(config, fs.readFileSync(config)); // same bytes, new mtime
    await waitFor(() => statuses(w).some((c) => c.end !== undefined), { timeoutMs: 10000, message: "the status after the config touch" });
    await hold(w, () => statuses(w).length <= 1, QUIET_MS, "more than one status after the touch");
    const ran = statuses(w);
    assert.equal(ran.length, 1, show(ran));
    assert.ok(isOnlineStatus(ran[0] as CallRecord), `E28: a .contexo/*.json event refreshes ONLINE: ${show(ran)}`);
    assert.deepEqual(ran[0]?.argv, ["status", "--json", "--root", w.root]);
  });

  it("files ctx writes itself (.contexo/.sync/**, the root index.md and tags.md) trigger no status", async () => {
    const w = await openWorkspaceCopy({ scenario: "mixed" });
    const syncRoot = path.join(w.root, ".contexo", ".sync");
    const sync = path.join(syncRoot, "e8-local");
    const created = !fs.existsSync(syncRoot); // a reset never touches .sync: remove what this test made
    try {
      fs.mkdirSync(sync, { recursive: true });
      fs.writeFileSync(path.join(sync, "auth-flow.md"), "# a base copy ctx keeps\n");
      for (const name of ["index.md", "tags.md"]) {
        const file = path.join(w.root, ".contexo", name);
        fs.appendFileSync(file, "\n<!-- e8: regenerated -->\n");
      }
      await hold(w, () => statuses(w).length === 0, QUIET_MS, "a ctx-owned file triggered a status");
    } finally {
      fs.rmSync(created ? syncRoot : sync, { recursive: true, force: true });
    }
    assert.deepEqual(w.calls(), [], "no ctx call at all");
  });
});
