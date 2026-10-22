// WP-1.8: src/model/refreshScheduler.ts, WHEN a repository refreshes. Fake watchers, focus and
// config drive the scheduler under sinon fake timers (systemClock reads the faked globals), and
// the tests assert on the FakeCtxCli method-call log the refresh harness produces.
import * as assert from "node:assert/strict";
import * as sinon from "sinon";
import type { AuthState, StatusDoc } from "../../../src/contract/types";
import {
  DEBOUNCE,
  MAX_BACKOFF_SECONDS,
  RefreshScheduler,
  WATCH_GLOBS,
  isWatchedPagePath,
  systemClock,
  type FileEventSource,
  type FocusSource,
  type RefreshSchedulerDeps,
} from "../../../src/model/refreshScheduler";
import { FakeCtxCli } from "../../helpers/fakeCtxCli";
import { loadStatusDoc } from "../../helpers/fixtures";
import { vscodeStub } from "../../helpers/vscodeStub";

type Uri = ReturnType<typeof vscodeStub.Uri.file>;

const ROOT = "/ws/repo";
const CONTEXO = `${ROOT}/.contexo/`;
const START = Date.UTC(2026, 9, 22, 9, 0, 0);
const SEC = 1_000;

const ONLINE: StatusDoc = loadStatusDoc("mixed");
const RATE_LIMITED: StatusDoc = {
  ...ONLINE,
  remote: {
    source: "none",
    page_count: 0,
    error: { code: "rate_limited", message: "too many requests", advice: [], retryable: true },
  },
};
const NETWORK_ERROR: StatusDoc = {
  ...ONLINE,
  remote: {
    source: "none",
    page_count: 0,
    error: { code: "network", message: "connection refused", advice: [], retryable: true },
  },
};

function uri(rel: string): Uri {
  return vscodeStub.Uri.file(`${CONTEXO}${rel}`);
}

class FakeWatcher implements FileEventSource {
  readonly create = new vscodeStub.EventEmitter<Uri>();
  readonly change = new vscodeStub.EventEmitter<Uri>();
  readonly delete = new vscodeStub.EventEmitter<Uri>();
  readonly onDidCreate = this.create.event;
  readonly onDidChange = this.change.event;
  readonly onDidDelete = this.delete.event;
  disposed = false;

  /** Fire one event of every kind for rel. */
  all(rel: string): void {
    this.create.fire(uri(rel));
    this.change.fire(uri(rel));
    this.delete.fire(uri(rel));
  }

  dispose(): void { this.disposed = true; }
}

class FakeFocus implements FocusSource {
  focused = true;
  private readonly emitter = new vscodeStub.EventEmitter<boolean>();
  readonly onDidChange = this.emitter.event;

  set(focused: boolean): void {
    this.focused = focused;
    this.emitter.fire(focused);
  }
}

class FakeConfig {
  remoteRefreshEnabled = true;
  remoteRefreshIntervalSeconds = 180;
  private readonly emitter = new vscodeStub.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;

  fire(): void { this.emitter.fire(); }
}

interface Harness {
  cli: FakeCtxCli;
  sched: RefreshScheduler;
  watchers: { md: FakeWatcher; json: FakeWatcher; pending: FakeWatcher };
  focus: FakeFocus;
  config: FakeConfig;
  auth: { state: AuthState | undefined };
  /** 'online' / 'offline' per ctx status call, in order. */
  statuses(): string[];
  /** Clock time (ms since START) of every ctx status call. */
  times: number[];
}

function makeHarness(o: { platform?: NodeJS.Platform; refresh?: RefreshSchedulerDeps["refresh"] } = {}): Harness {
  const cli = new FakeCtxCli();
  const times: number[] = [];
  cli.setHandler("status", (_root, opts) => {
    times.push(Date.now() - START);
    return loadStatusDoc("mixed", opts);
  });
  const watchers = { md: new FakeWatcher(), json: new FakeWatcher(), pending: new FakeWatcher() };
  const focus = new FakeFocus();
  const config = new FakeConfig();
  const auth: { state: AuthState | undefined } = { state: undefined };
  const sched: RefreshScheduler = new RefreshScheduler({
    clock: systemClock,
    focus,
    config,
    watchers,
    relPathOf: (u) => (u.path.startsWith(CONTEXO) ? u.path.slice(CONTEXO.length) : undefined),
    refresh: o.refresh ?? (async ({ remote }) => {
      let doc: StatusDoc | undefined;
      try {
        doc = await cli.status(ROOT, { offline: !remote });
      } catch {
        doc = undefined;
      }
      if (remote) { sched.noteOnline(doc); }
    }),
    authState: () => auth.state,
    platform: o.platform ?? "linux",
  });
  const statuses = (): string[] => cli.callsOf("status").map((a) => (a[1].offline ? "offline" : "online"));
  return { cli, sched, watchers, focus, config, auth, statuses, times };
}

describe("model/refreshScheduler", () => {
  let clock: sinon.SinonFakeTimers;
  let h: Harness;

  beforeEach(() => {
    clock = sinon.useFakeTimers({ now: START });
    h = makeHarness();
  });

  afterEach(() => {
    h.sched.dispose();
    clock.restore();
  });

  it("exports the watcher globs and debounce constants", () => {
    assert.deepEqual(WATCH_GLOBS, {
      md: ".contexo/**/*.md",
      json: ".contexo/*.json",
      pending: ".contexo/raw/sessions/_pending/*",
    });
    assert.equal(DEBOUNCE.md.delayMs, 1_000);
    assert.equal(DEBOUNCE.pending.delayMs, 5_000);
    assert.equal(MAX_BACKOFF_SECONDS, 900);
  });

  describe("watchers", () => {
    it("20 .md change events within 1s give exactly one status({offline:true})", async () => {
      h.sched.start();
      for (let i = 0; i < 20; i++) {
        h.watchers.md.change.fire(uri(`wiki/concepts/page-${i % 3}.md`));
        await clock.tickAsync(50);
      }
      assert.deepEqual(h.statuses(), [], "the debounce is still pending");
      await clock.tickAsync(1_000);
      assert.deepEqual(h.cli.callsOf("status").map((a) => a[1]), [{ offline: true }]);
      await clock.tickAsync(60_000);
      assert.deepEqual(h.statuses(), ["offline"], "exactly one");
    });

    it("md create and delete events refresh offline too", async () => {
      h.sched.start();
      h.watchers.md.create.fire(uri("wiki/new.md"));
      await clock.tickAsync(1_000);
      h.watchers.md.delete.fire(uri("wiki/new.md"));
      await clock.tickAsync(1_000);
      assert.deepEqual(h.statuses(), ["offline", "offline"]);
    });

    it("events under .sync/ (incl. .sync/base/x.md), root index.md and tags.md give zero refreshes", async () => {
      h.sched.start();
      for (const rel of [".sync/x.md", ".sync/base/x.md", ".sync/backup/wiki/a.md", ".sync/conflicts/wiki/a.md",
        "wiki/.sync/x.md", "index.md", "tags.md"]) {
        h.watchers.md.all(rel);
      }
      h.watchers.md.change.fire(vscodeStub.Uri.file("/elsewhere/wiki/a.md"));
      h.watchers.json.all(".sync/state.json");
      h.watchers.json.all("wiki/data.json");
      h.watchers.json.all("config.yaml");
      await clock.tickAsync(60_000);
      assert.deepEqual(h.statuses(), []);
    });

    it("a _pending/*.jsonl create gives one offline refresh after 5s; a change gives none", async () => {
      h.sched.start();
      h.watchers.pending.change.fire(uri("raw/sessions/_pending/s1.jsonl"));
      await clock.tickAsync(60_000);
      assert.deepEqual(h.statuses(), [], "change events are ignored");

      h.watchers.pending.create.fire(uri("raw/sessions/_pending/s1.jsonl"));
      await clock.tickAsync(4_999);
      assert.deepEqual(h.statuses(), []);
      await clock.tickAsync(1);
      assert.deepEqual(h.cli.callsOf("status").map((a) => a[1]), [{ offline: true }]);

      h.watchers.pending.delete.fire(uri("raw/sessions/_pending/s1.jsonl"));
      await clock.tickAsync(5_000);
      assert.deepEqual(h.statuses(), ["offline", "offline"], "a delete refreshes too");

      h.watchers.pending.create.fire(uri("raw/sessions/_pending/nested/s2.jsonl"));
      h.watchers.pending.create.fire(uri("raw/sessions/other/s3.jsonl"));
      await clock.tickAsync(60_000);
      assert.deepEqual(h.statuses(), ["offline", "offline"], "only one segment below _pending counts");
    });

    it("a .contexo/*.json change gives one online refresh", async () => {
      h.sched.start();
      h.watchers.json.change.fire(uri("config.json"));
      await clock.tickAsync(500);
      h.watchers.json.create.fire(uri("config.json"));
      await clock.tickAsync(999);
      assert.deepEqual(h.statuses(), []);
      await clock.tickAsync(1);
      assert.deepEqual(h.cli.callsOf("status").map((a) => a[1]), [{ offline: false }]);
      await clock.tickAsync(10_000);
      assert.deepEqual(h.statuses(), ["online"]);
    });

    it("json events are not gated by focus, enabled or auth", async () => {
      h.sched.start();
      h.focus.set(false);
      h.config.remoteRefreshEnabled = false;
      h.config.fire();
      h.auth.state = "not_authenticated";
      h.watchers.json.delete.fire(uri("config.json"));
      await clock.tickAsync(1_000);
      assert.deepEqual(h.statuses(), ["online"], "login / init / set-repo still refresh");
    });

    it("a continuous storm still refreshes every maxWaitMs", async () => {
      h.sched.start();
      for (let t = 0; t < 12_000; t += 500) {
        h.watchers.md.change.fire(uri("wiki/a.md"));
        await clock.tickAsync(500);
      }
      await clock.tickAsync(1_000);
      assert.deepEqual(h.times, [5_000, 10_000, 12_500], "max wait at 5s and 10s, then the trailing edge");
      assert.deepEqual(h.statuses(), ["offline", "offline", "offline"]);
    });

    it("the pending watcher's storm waits at most 15s", async () => {
      h.sched.start();
      for (let t = 0; t < 20_000; t += 2_000) {
        h.watchers.pending.create.fire(uri(`raw/sessions/_pending/s${t}.jsonl`));
        await clock.tickAsync(2_000);
      }
      assert.deepEqual(h.times, [15_000]);
    });

    it("start() is idempotent", async () => {
      h.sched.start();
      h.sched.start();
      h.focus.set(false);
      h.focus.set(true);
      await clock.tickAsync(0);
      assert.deepEqual(h.statuses(), ["online"], "one focus subscription");
    });

    it("nothing is subscribed before start()", async () => {
      h.watchers.md.all("wiki/a.md");
      h.watchers.json.all("config.json");
      h.focus.set(false);
      h.focus.set(true);
      await clock.tickAsync(60_000);
      assert.deepEqual(h.statuses(), []);
    });
  });

  describe("isWatchedPagePath", () => {
    it("nested index.md / tags.md are pages; the root ones and any .sync segment are not", () => {
      for (const p of ["linux", "darwin", "win32"] as const) {
        assert.equal(isWatchedPagePath("wiki/concepts/auth-flow.md", p), true);
        assert.equal(isWatchedPagePath("wiki/index.md", p), true, "nested wiki/index.md IS a page");
        assert.equal(isWatchedPagePath("wiki/tags.md", p), true);
        assert.equal(isWatchedPagePath("raw/sessions/2026-10-01-login.md", p), true);
        assert.equal(isWatchedPagePath("wiki/.synced/a.md", p), true, "only an exact .sync segment");
        assert.equal(isWatchedPagePath("index.md", p), false);
        assert.equal(isWatchedPagePath("tags.md", p), false);
        assert.equal(isWatchedPagePath(".sync/x.md", p), false);
        assert.equal(isWatchedPagePath(".sync/base/x.md", p), false);
        assert.equal(isWatchedPagePath(".sync/backup/wiki/a.md", p), false);
        assert.equal(isWatchedPagePath("wiki/.sync/x.md", p), false);
      }
    });

    it("'.SYNC' is folded on darwin/win32 but not linux", () => {
      assert.equal(isWatchedPagePath(".SYNC/base/x.md", "darwin"), false);
      assert.equal(isWatchedPagePath(".Sync/x.md", "win32"), false);
      assert.equal(isWatchedPagePath(".SYNC/base/x.md", "linux"), true);
      assert.equal(isWatchedPagePath("INDEX.md", "darwin"), false, "the root index.md on a case-insensitive fs");
      assert.equal(isWatchedPagePath("Tags.MD", "win32"), false);
      assert.equal(isWatchedPagePath("INDEX.md", "linux"), true);
    });

    it("the scheduler applies the platform's case rule", async () => {
      const darwin = makeHarness({ platform: "darwin" });
      darwin.sched.start();
      darwin.watchers.md.change.fire(uri(".SYNC/base/x.md"));
      h.sched.start();
      h.watchers.md.change.fire(uri(".SYNC/base/x.md"));
      await clock.tickAsync(1_000);
      assert.deepEqual(darwin.statuses(), []);
      assert.deepEqual(h.statuses(), ["offline"], "linux: .SYNC is an ordinary folder");
      darwin.sched.dispose();
    });
  });

  describe("remote poll", () => {
    it("remote poll runs only while focused, at intervalSeconds, and on focus regain when stale; never when enabled=false or auth.state is not_authenticated/rejected", async () => {
      h.sched.start();
      await clock.tickAsync(3_600 * SEC);
      assert.deepEqual(h.statuses(), [], "no poll before the first online status");

      h.sched.noteOnline(ONLINE); // the activation refresh (t = 3600s)
      assert.equal(h.sched.intervalSeconds, 180);
      await clock.tickAsync(180 * SEC - 1);
      assert.deepEqual(h.statuses(), []);
      await clock.tickAsync(1);
      assert.deepEqual(h.statuses(), ["online"], "polled at intervalSeconds");
      await clock.tickAsync(180 * SEC);
      assert.deepEqual(h.statuses(), ["online", "online"]);

      h.focus.set(false);
      await clock.tickAsync(3_600 * SEC);
      assert.deepEqual(h.statuses(), ["online", "online"], "never while unfocused");

      h.focus.set(true);
      await clock.tickAsync(0);
      assert.deepEqual(h.statuses(), ["online", "online", "online"], "focus regained while stale: refresh now");
      await clock.tickAsync(180 * SEC);
      assert.deepEqual(h.statuses().length, 4, "and the poll continues");

      h.config.remoteRefreshEnabled = false;
      h.config.fire();
      await clock.tickAsync(3_600 * SEC);
      h.focus.set(false);
      h.focus.set(true);
      await clock.tickAsync(3_600 * SEC);
      assert.equal(h.statuses().length, 4, "never when enabled=false");

      h.config.remoteRefreshEnabled = true;
      h.config.fire();
      await clock.tickAsync(0);
      assert.equal(h.statuses().length, 5, "re-enabled while overdue: the recomputed timer fires");

      for (const state of ["not_authenticated", "rejected"] as const) {
        const before = h.statuses().length;
        h.auth.state = state;
        h.sched.noteOnline(ONLINE);
        await clock.tickAsync(3_600 * SEC);
        h.focus.set(false);
        h.focus.set(true);
        h.config.fire();
        await clock.tickAsync(3_600 * SEC);
        assert.equal(h.statuses().length, before, `never when auth.state is ${state}`);
      }

      for (const state of ["authenticated", "unchecked"] as const) {
        const before = h.statuses().length;
        h.auth.state = state;
        h.sched.noteOnline(ONLINE);
        await clock.tickAsync(180 * SEC);
        assert.equal(h.statuses().length, before + 1, `polls when auth.state is ${state}`);
      }
      assert.ok(h.statuses().every((s) => s === "online"));
    });

    it("intervalSeconds 10 is clamped to 60", async () => {
      h.config.remoteRefreshIntervalSeconds = 10;
      h.sched.start();
      assert.equal(h.sched.intervalSeconds, 60);
      h.sched.noteOnline(ONLINE);
      await clock.tickAsync(60 * SEC - 1);
      assert.deepEqual(h.statuses(), []);
      await clock.tickAsync(1);
      assert.deepEqual(h.statuses(), ["online"]);
      await clock.tickAsync(60 * SEC);
      assert.deepEqual(h.times, [60 * SEC, 120 * SEC]);
    });

    it("rate_limited doubles the interval up to 900s; a success resets it", async () => {
      h.sched.start();
      h.cli.setResult("status", RATE_LIMITED);
      h.sched.noteOnline(RATE_LIMITED);
      assert.equal(h.sched.intervalSeconds, 360);

      await clock.tickAsync(360 * SEC);
      assert.equal(h.statuses().length, 1);
      assert.equal(h.sched.intervalSeconds, 720);
      await clock.tickAsync(720 * SEC);
      assert.equal(h.statuses().length, 2);
      assert.equal(h.sched.intervalSeconds, 900);
      await clock.tickAsync(900 * SEC - 1);
      assert.equal(h.statuses().length, 2);
      await clock.tickAsync(1);
      assert.equal(h.statuses().length, 3);
      assert.equal(h.sched.intervalSeconds, 900, "capped at MAX_BACKOFF_SECONDS");

      h.cli.setResult("status", ONLINE);
      await clock.tickAsync(900 * SEC);
      assert.equal(h.statuses().length, 4);
      assert.equal(h.sched.intervalSeconds, 180, "a live remote clears the backoff");
      await clock.tickAsync(180 * SEC);
      assert.equal(h.statuses().length, 5);
    });

    it("another remote.error or a failed status leaves the backoff unchanged", () => {
      h.sched.noteOnline(RATE_LIMITED);
      assert.equal(h.sched.intervalSeconds, 360);
      h.sched.noteOnline(NETWORK_ERROR);
      assert.equal(h.sched.intervalSeconds, 360);
      h.sched.noteOnline(undefined);
      assert.equal(h.sched.intervalSeconds, 360);
      h.sched.noteOnline(loadStatusDoc("mixed", { offline: true }));
      assert.equal(h.sched.intervalSeconds, 360, "remote.source none without an error is not a success");
      h.sched.noteOnline(ONLINE);
      assert.equal(h.sched.intervalSeconds, 180);
    });

    it("the backoff never drops below a base interval above 900s", () => {
      h.config.remoteRefreshIntervalSeconds = 3_600;
      h.sched.noteOnline(RATE_LIMITED);
      assert.equal(h.sched.intervalSeconds, 3_600);
    });

    it("focus regain when not stale schedules instead of refreshing", async () => {
      h.sched.start();
      h.sched.noteOnline(ONLINE);
      await clock.tickAsync(60 * SEC);
      h.focus.set(false);
      await clock.tickAsync(60 * SEC);
      h.focus.set(true);
      await clock.tickAsync(0);
      assert.deepEqual(h.statuses(), [], "not stale: no refresh now");
      await clock.tickAsync(60 * SEC - 1);
      assert.deepEqual(h.statuses(), []);
      await clock.tickAsync(1);
      assert.deepEqual(h.times, [180 * SEC], "scheduled at lastOnlineAt + interval");
    });

    it("focus regain before any online result refreshes now", async () => {
      h.sched.start();
      h.focus.set(false);
      h.focus.set(true);
      await clock.tickAsync(0);
      assert.deepEqual(h.statuses(), ["online"]);
    });

    it("the poll timer re-checks eligibility when it fires", async () => {
      h.sched.start();
      h.sched.noteOnline(ONLINE);
      h.auth.state = "rejected"; // no event: only the timer can notice
      await clock.tickAsync(180 * SEC);
      assert.deepEqual(h.statuses(), []);

      h.auth.state = "authenticated";
      h.sched.noteOnline(ONLINE);
      h.config.remoteRefreshEnabled = false; // no onDidChange
      await clock.tickAsync(180 * SEC);
      assert.deepEqual(h.statuses(), []);

      h.config.remoteRefreshEnabled = true;
      h.sched.noteOnline(ONLINE);
      h.focus.focused = false; // no onDidChange
      await clock.tickAsync(180 * SEC);
      assert.deepEqual(h.statuses(), []);
    });

    it("a config interval change recomputes the timer", async () => {
      h.sched.start();
      h.sched.noteOnline(ONLINE);
      await clock.tickAsync(60 * SEC);
      h.config.remoteRefreshIntervalSeconds = 300;
      h.config.fire();
      await clock.tickAsync(239 * SEC);
      assert.deepEqual(h.statuses(), [], "not at the old 180s");
      await clock.tickAsync(1 * SEC);
      assert.deepEqual(h.times, [300 * SEC]);
    });

    it("an online refresh from any source reschedules the poll", async () => {
      h.sched.start();
      h.sched.noteOnline(ONLINE);
      await clock.tickAsync(170 * SEC);
      h.sched.noteOnline(ONLINE); // e.g. after a push
      await clock.tickAsync(170 * SEC);
      assert.deepEqual(h.statuses(), [], "the timer moved to the latest online result");
      await clock.tickAsync(10 * SEC);
      assert.deepEqual(h.times, [350 * SEC]);
    });
  });

  describe("dispose", () => {
    it("clears every timer and subscription; no refresh is requested afterwards", async () => {
      let requests = 0;
      const d = makeHarness({ refresh: () => { requests++; } });
      d.sched.start();
      d.sched.noteOnline(ONLINE);
      d.watchers.md.change.fire(uri("wiki/a.md"));
      d.watchers.json.change.fire(uri("config.json"));
      d.watchers.pending.create.fire(uri("raw/sessions/_pending/s.jsonl"));
      d.sched.dispose();
      d.sched.dispose();
      await clock.tickAsync(3_600 * SEC);
      d.watchers.md.all("wiki/a.md");
      d.watchers.json.all("config.json");
      d.watchers.pending.all("raw/sessions/_pending/s.jsonl");
      d.focus.set(false);
      d.focus.set(true);
      d.config.fire();
      d.sched.noteOnline(ONLINE);
      d.sched.start();
      d.watchers.md.all("wiki/a.md");
      await clock.tickAsync(3_600 * SEC);
      assert.equal(requests, 0);
      assert.equal(clock.countTimers(), 0, "no timer left behind");
      assert.equal(d.watchers.md.disposed, false, "the repository owns its watchers");
    });

    it("deps.refresh rejections and throws are swallowed", async () => {
      let calls = 0;
      const rejecting = makeHarness({ refresh: () => { calls++; return Promise.reject(new Error("refresh failed")); } });
      const throwing = makeHarness({ refresh: () => { calls++; throw new Error("refresh threw"); } });
      for (const x of [rejecting, throwing]) {
        x.sched.start();
        x.watchers.md.change.fire(uri("wiki/a.md"));
        x.focus.set(false);
        x.focus.set(true);
      }
      await clock.tickAsync(1_000);
      assert.equal(calls, 4);
      rejecting.sched.dispose();
      throwing.sched.dispose();
    });
  });
});
