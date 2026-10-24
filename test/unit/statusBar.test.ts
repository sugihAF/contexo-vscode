// The status bar's pure half (src/statusBar.ts) in plain mocha: the SCM statusBarCommands
// for one StatusDoc, and the Contexo item's text/tooltip/command/background for the
// extension state plus every repository's status. registerStatusBar is host-tested.
import * as assert from "node:assert/strict";
import type { ErrorBody, StatusDoc } from "../../src/contract/types";
import type { ExtensionState } from "../../src/model/types";
import {
  STATUS_BAR_ITEM_ID, presentStatusBar, statusBarCommandsFor, statusBarVisible,
  type StatusBarPresentation,
} from "../../src/statusBar";
import { loadStatusDoc } from "../helpers/fixtures";

/** A fresh copy of a scenario's online StatusDoc (safe to mutate). */
function status(scenario: string, o: { offline?: boolean } = {}): StatusDoc {
  return structuredClone(loadStatusDoc(scenario, o));
}

/** e6-ready with remote.error replaced by `code` (remote.source none, like ctx reports it). */
function withRemoteError(code: ErrorBody["code"], message: string): StatusDoc {
  const st = status("e6-ready");
  st.remote = { source: "none", page_count: 0, error: { code, message, advice: [], retryable: false } as ErrorBody };
  return st;
}

const WARNING_BG = "statusBarItem.warningBackground";
const LOGIN_TEXT = "$(account) Contexo: Log in";
const OFFLINE_TEXT = "$(debug-disconnect) Contexo: offline";
const READY_TEXT = "$(cloud) Contexo";

/** The command's arguments with Uris as strings. */
function args(p: StatusBarPresentation): unknown[] | undefined {
  return p.command.arguments?.map((a) => (typeof a === "object" && a !== null && "scheme" in a ? String(a) : a));
}

describe("statusBarCommandsFor (SourceControl.statusBarCommands)", () => {
  it('statusBarCommandsFor(mixed)[0].title === "$(cloud-upload) 2 $(cloud-download) 2 $(warning) 1"', () => {
    const mixed = status("mixed");
    const { ahead, behind, conflict } = mixed.counts;
    assert.deepEqual([ahead, behind, conflict], [2, 2, 1], "fixture precondition");
    const cmds = statusBarCommandsFor(mixed);
    assert.equal(cmds.length, 1);
    assert.equal(cmds[0]?.title, `$(cloud-upload) ${ahead} $(cloud-download) ${behind} $(warning) ${conflict}`);
    assert.equal(cmds[0]?.title, "$(cloud-upload) 2 $(cloud-download) 2 $(warning) 1");
  });

  it('a clean status gives "$(cloud-upload) 0 $(cloud-download) 0" with no warning', () => {
    const cmds = statusBarCommandsFor(status("clean"));
    assert.equal(cmds.length, 1);
    assert.equal(cmds[0]?.title, "$(cloud-upload) 0 $(cloud-download) 0");
  });

  it("undefined gives []", () => {
    assert.deepEqual(statusBarCommandsFor(undefined), []);
  });

  it("the command is contexo.refresh", () => {
    for (const scenario of ["mixed", "clean"]) {
      const cmds = statusBarCommandsFor(status(scenario));
      assert.deepEqual(cmds.map((c) => c.command), ["contexo.refresh"], scenario);
      assert.equal(cmds[0]?.arguments, undefined, scenario);
    }
  });

  it("the tooltip reads '<ahead> to push · <behind> incoming · <conflict> conflict(s) · last checked <local time>'", () => {
    const mixed = status("mixed");
    mixed.counts.unverified = 0;
    const when = new Date("2026-10-15T09:30:00Z").toLocaleString();
    assert.equal(statusBarCommandsFor(mixed)[0]?.tooltip, `2 to push · 2 incoming · 1 conflict(s) · last checked ${when}`);
  });

  it("the tooltip includes the unverified count only when it is above 0", () => {
    const mixed = status("mixed");
    assert.equal(mixed.counts.unverified, 1, "fixture precondition");
    const when = new Date(mixed.remote.fetched_at as string).toLocaleString();
    assert.equal(
      statusBarCommandsFor(mixed)[0]?.tooltip,
      `2 to push · 2 incoming · 1 conflict(s) · last checked ${when} · 1 unverified`,
    );
    const clean = status("clean");
    assert.equal(clean.counts.unverified, 0, "fixture precondition");
    const tip = statusBarCommandsFor(clean)[0]?.tooltip ?? "";
    assert.ok(!tip.includes("unverified"), tip);
    assert.equal(tip, `0 to push · 0 incoming · 0 conflict(s) · last checked ${new Date("2026-10-15T09:31:30Z").toLocaleString()}`);
  });

  it('an offline status (remote.source "none") says "offline" instead of "last checked"', () => {
    const offline = status("mixed", { offline: true });
    assert.equal(offline.remote.source, "none", "fixture precondition");
    const tip = statusBarCommandsFor(offline)[0]?.tooltip ?? "";
    assert.equal(tip, "3 to push · 0 incoming · 0 conflict(s) · offline · 1 unverified");
    assert.equal(statusBarCommandsFor(offline)[0]?.title, "$(cloud-upload) 3 $(cloud-download) 0");

    const clone = status("mixed");
    clone.remote.source = "none";
    assert.ok((statusBarCommandsFor(clone)[0]?.tooltip ?? "").includes(" · offline"), "a remote.source none clone");
    assert.ok(!(statusBarCommandsFor(clone)[0]?.tooltip ?? "").includes("last checked"));
  });

  it('a live status without fetched_at says "last checked unknown"', () => {
    const mixed = status("mixed");
    delete mixed.remote.fetched_at;
    assert.equal(statusBarCommandsFor(mixed)[0]?.tooltip, "2 to push · 2 incoming · 1 conflict(s) · last checked unknown · 1 unverified");
  });
});

describe("presentStatusBar (the Contexo status bar item)", () => {
  it("authenticated: $(cloud) Contexo, contexo.refresh, no background; tooltip names the user, server and repo", () => {
    const p = presentStatusBar("ready", [status("e6-ready")], false);
    assert.equal(p.text, READY_TEXT);
    assert.equal(p.command.command, "contexo.refresh");
    assert.equal(p.command.title, "Refresh");
    assert.equal(p.background, undefined);
    assert.equal(p.tooltip, "Alice Tan <alice@example.com> · https://api.example.test · r_test");
    for (const part of ["Alice Tan <alice@example.com>", "https://api.example.test", "r_test"]) {
      assert.ok(p.tooltip.includes(part), part);
    }
  });

  it("the ready tooltip falls back to one of name/email, then the auth state, 'unknown server' and 'no repo id'", () => {
    const st = status("e6-ready");
    delete st.auth.user_email;
    assert.equal(presentStatusBar("ready", [st], false).tooltip, "Alice Tan · https://api.example.test · r_test");
    delete st.auth.user_name;
    st.auth.user_email = "alice@example.com";
    assert.equal(presentStatusBar("ready", [st], false).tooltip, "alice@example.com · https://api.example.test · r_test");
    delete st.auth.user_email;
    st.auth.state = "unchecked";
    delete st.server.url;
    delete st.project.repo_id;
    assert.equal(presentStatusBar("ready", [st], false).tooltip, "unchecked · unknown server · no repo id");
    assert.equal(presentStatusBar("ready", [], false).tooltip, "Contexo", "no statuses");
    assert.equal(presentStatusBar("ready", [], false).text, READY_TEXT);
  });

  it("not_authenticated: Log in, warning background, contexo.login with the repository root", () => {
    const st = status("e6-not-authenticated");
    for (const state of ["ready", "notLoggedIn"] as const) {
      const p = presentStatusBar(state, [st], false);
      assert.equal(p.text, LOGIN_TEXT, state);
      assert.equal(p.background, WARNING_BG, state);
      assert.equal(p.command.command, "contexo.login", state);
      assert.equal(p.command.title, "Log in", state);
      assert.deepEqual(args(p), ["file:///fixture-root"], state);
      assert.equal(
        p.tooltip,
        "Contexo: log in to https://api.example.test: not logged in: no Contexo credentials for this project. Click to log in.",
        state,
      );
    }
  });

  it("rejected: Log in", () => {
    const p = presentStatusBar("ready", [status("e6-rejected")], false);
    assert.equal(p.text, LOGIN_TEXT);
    assert.equal(p.background, WARNING_BG);
    assert.equal(p.command.command, "contexo.login");
    assert.deepEqual(args(p), ["file:///fixture-root"]);
    assert.equal(
      p.tooltip,
      "Contexo: log in to https://api.example.test: GET https://api.example.test/v1/repos/r_test/pages: 401 Unauthorized: token rejected. Click to log in.",
    );
  });

  it("auth.state rejected alone (no remote.error) still gives Log in", () => {
    const st = status("e6-ready");
    st.auth = { state: "rejected" };
    const p = presentStatusBar("ready", [st], false);
    assert.equal(p.text, LOGIN_TEXT);
    assert.equal(p.tooltip, "Contexo: log in to https://api.example.test. Click to log in.");
  });

  it("remote.error server_unresolved: Log in", () => {
    const st = withRemoteError("server_unresolved", "no Contexo server configured");
    delete st.server.url;
    const p = presentStatusBar("ready", [st], false);
    assert.equal(p.text, LOGIN_TEXT);
    assert.equal(p.background, WARNING_BG);
    assert.equal(p.command.command, "contexo.login");
    assert.deepEqual(args(p), ["file:///fixture-root"]);
    assert.equal(p.tooltip, "Contexo: log in to the Contexo server: no Contexo server configured. Click to log in.");
  });

  it("state notLoggedIn with no matching status: Log in without arguments", () => {
    for (const statuses of [[], [status("e6-ready")]]) {
      const p = presentStatusBar("notLoggedIn", statuses, false);
      assert.equal(p.text, LOGIN_TEXT);
      assert.equal(p.background, WARNING_BG);
      assert.equal(p.command.command, "contexo.login");
      assert.equal(p.command.arguments, undefined);
      assert.equal(p.tooltip, "Contexo: log in to the Contexo server. Click to log in.");
    }
  });

  it("network: $(debug-disconnect) Contexo: offline, contexo.showLog, tooltip = the error message", () => {
    const st = status("e6-network-error");
    const p = presentStatusBar("ready", [st], false);
    assert.equal(p.text, OFFLINE_TEXT);
    assert.equal(p.command.command, "contexo.showLog");
    assert.equal(p.command.title, "Show Log");
    assert.equal(p.background, undefined);
    assert.equal(p.tooltip, st.remote.error?.message);
    assert.equal(p.tooltip, "GET https://api.example.test/v1/repos/r_test/pages: dial tcp: lookup api.example.test: no such host");
  });

  it("server_error and rate_limited: $(debug-disconnect) Contexo: offline", () => {
    for (const code of ["server_error", "rate_limited"] as const) {
      const p = presentStatusBar("ready", [withRemoteError(code, `${code} happened`)], false);
      assert.equal(p.text, OFFLINE_TEXT, code);
      assert.equal(p.command.command, "contexo.showLog", code);
      assert.equal(p.tooltip, `${code} happened`, code);
    }
  });

  it('server_unsupported: "$(warning) Contexo: server outdated"', () => {
    const st = withRemoteError("server_unsupported", "server lacks pages.at");
    const p = presentStatusBar("ready", [st], false);
    assert.equal(p.text, "$(warning) Contexo: server outdated");
    assert.equal(p.command.command, "contexo.showLog");
    assert.equal(p.background, undefined);
    assert.equal(p.tooltip, "Contexo: the server at https://api.example.test is too old for this ctx: server lacks pages.at");
    delete st.server.url;
    assert.equal(
      presentStatusBar("ready", [st], false).tooltip,
      "Contexo: the server at unknown is too old for this ctx: server lacks pages.at",
    );
  });

  it("ctxMissing: $(error) ctx not found, contexo.installCtx", () => {
    const p = presentStatusBar("ctxMissing", [status("e6-not-authenticated")], true);
    assert.equal(p.text, "$(error) ctx not found");
    assert.deepEqual(p.command, { command: "contexo.installCtx", title: "Install ctx" });
    assert.equal(p.tooltip, "Contexo: the ctx CLI was not found. Click to install it.");
    assert.equal(p.background, undefined);
  });

  it("ctxTooOld: $(warning) Update ctx, contexo.updateCtx", () => {
    const p = presentStatusBar("ctxTooOld", [], false);
    assert.equal(p.text, "$(warning) Update ctx");
    assert.deepEqual(p.command, { command: "contexo.updateCtx", title: "Update ctx" });
    assert.equal(p.tooltip, "Contexo: this ctx is too old for the extension. Click to run ctx update.");
  });

  it("extensionTooOld: $(warning) Update Contexo extension, workbench.extensions.search contexo.contexo", () => {
    const p = presentStatusBar("extensionTooOld", [status("e6-network-error")], false);
    assert.equal(p.text, "$(warning) Update Contexo extension");
    assert.deepEqual(p.command, {
      command: "workbench.extensions.search",
      title: "Update Contexo extension",
      arguments: ["contexo.contexo"],
    });
    assert.equal(p.tooltip, "Contexo: this ctx needs a newer Contexo extension. Click to find the update.");
  });

  it("noRepositories: $(info) Contexo: Initialize, contexo.init", () => {
    const p = presentStatusBar("noRepositories", [], false);
    assert.equal(p.text, "$(info) Contexo: Initialize");
    assert.deepEqual(p.command, { command: "contexo.init", title: "Initialize Contexo" });
    assert.equal(p.tooltip, "No Contexo project in this workspace. Click to run ctx init.");
  });

  it("busy: $(sync~spin) Contexo, contexo.showLog", () => {
    const p = presentStatusBar("ready", [status("e6-ready")], true);
    assert.equal(p.text, "$(sync~spin) Contexo");
    assert.equal(p.command.command, "contexo.showLog");
    assert.equal(p.tooltip, "Contexo: syncing…");
    assert.equal(p.background, undefined);
  });

  it("busy does not override Log in or offline", () => {
    assert.equal(presentStatusBar("ready", [status("e6-not-authenticated")], true).text, LOGIN_TEXT);
    assert.equal(presentStatusBar("notLoggedIn", [], true).text, LOGIN_TEXT);
    assert.equal(presentStatusBar("ready", [status("e6-network-error")], true).text, OFFLINE_TEXT);
    assert.equal(
      presentStatusBar("ready", [withRemoteError("server_unsupported", "old")], true).text,
      "$(warning) Contexo: server outdated",
    );
  });

  it("a two-repo aggregate uses the first rule that applies across repos", () => {
    const network = status("e6-network-error");
    const rejected = status("e6-rejected");
    rejected.root = "/fixture-root-rejected";
    const login = presentStatusBar("ready", [network, rejected], false);
    assert.equal(login.text, LOGIN_TEXT, "rule 5 beats rule 6 even though the network repo is first");
    assert.deepEqual(args(login), ["file:///fixture-root-rejected"], "Log in targets the matching repository");

    const offline = presentStatusBar("ready", [status("e6-ready"), network], false);
    assert.equal(offline.text, OFFLINE_TEXT);
    assert.equal(offline.tooltip, network.remote.error?.message);

    const beta = status("e6-two-repos");
    const both = presentStatusBar("ready", [status("e6-ready"), beta], false);
    assert.equal(both.text, READY_TEXT);
    assert.equal(both.command.command, "contexo.refresh");
    const lines = both.tooltip.split("\n");
    assert.equal(lines.length, 2, both.tooltip);
    assert.deepEqual(lines, [
      "Alice Tan <alice@example.com> · https://api.example.test · r_test",
      "Bob Lee <bob@example.com> · https://api.example.test · r_beta",
    ]);

    const unsupported = withRemoteError("server_unsupported", "old");
    assert.equal(presentStatusBar("ready", [unsupported, network], false).text, OFFLINE_TEXT, "rule 6 beats rule 7");
  });

  it("STATUS_BAR_ITEM_ID is contexo.status", () => {
    assert.equal(STATUS_BAR_ITEM_ID, "contexo.status");
  });
});

describe("statusBarVisible", () => {
  const cases: [ExtensionState, number, boolean][] = [
    ["ready", 0, false],
    ["ready", 1, true],
    ["ready", 2, true],
    ["noRepositories", 0, true],
    ["ctxMissing", 0, true],
    ["ctxTooOld", 0, true],
    ["extensionTooOld", 0, true],
    ["notLoggedIn", 1, true],
    ["loading", 0, false],
    ["loading", 1, false],
  ];
  for (const [state, n, visible] of cases) {
    it(`${state} with ${n} repositories is ${visible ? "shown" : "hidden"}`, () => {
      assert.equal(statusBarVisible(state, n), visible);
    });
  }
});
