// errorActions (src/commands/errorActions.ts, WP-1.13): every ctx failure mapped to a
// message and the actions the user can take, the busy retry, and presentError over
// scripted Prompts and a fake log. Plain mocha over the vscode stub: picking a command
// action calls vscode.commands, which the stub lacks, so that is left to the e7 tests.
import * as assert from "node:assert/strict";
import { CtxError, type ExtensionErrorCode } from "../../../src/cli/types";
import {
  ACTION_LABELS, BUSY_MESSAGE, BUSY_RETRY_MS, EXTENSION_ERROR_CODES, MAPPED_ERROR_CODES, SHOW_SCM_COMMAND,
  effectiveCode, errorActions, isBusy, presentError, withBusyRetry,
  type ErrorPresentation, type MappedErrorCode,
} from "../../../src/commands/errorActions";
import { COMMAND_IDS } from "../../../src/commands/ids";
import { SHOW_CONFLICTS_LABEL } from "../../../src/commands/sync";
import { ERROR_CODES, type ErrorCode, type ErrorEnvelope } from "../../../src/contract/types";
import type { Services } from "../../../src/services";
import type { Prompts } from "../../../src/ui/prompts";
import { waitFor } from "../../helpers/waitFor";

// ---------- harness ----------

/** The contract exit code of every ErrorCode (exit-code table, E2/E17). */
const EXIT_OF: Record<ErrorCode, number> = {
  internal: 1, usage: 3, invalid_path: 3,
  not_authenticated: 4, auth_rejected: 4, forbidden: 4,
  not_initialized: 5, repo_not_configured: 5, server_unresolved: 5,
  conflict: 6, stale: 6,
  network: 7, server_error: 7, rate_limited: 7,
  repo_not_found: 8, page_not_found: 8, base_unavailable: 8, sha_not_found: 8,
  distill_required: 9, not_resolvable: 9,
  server_unsupported: 10, not_implemented: 10, quota_exceeded: 11, busy: 12,
};

/** A CtxError as WP-1.7 builds it from a ctx envelope (the code is authoritative over the exit). */
function ctxError(code: string, o: { exit?: number; message?: string; details?: unknown } = {}): CtxError {
  const exit = o.exit ?? EXIT_OF[code as ErrorCode] ?? 1;
  const envelope = {
    schema: "ctx.error.v1",
    exit_code: exit,
    error: {
      code, message: o.message ?? `ctx says ${code}`, advice: [], retryable: exit === 7 || exit === 12,
      ...(o.details === undefined ? {} : { details: o.details }),
    },
  } as unknown as ErrorEnvelope;
  return new CtxError(envelope, "");
}

/** label, kind and command of each action. */
function actionsOf(p: ErrorPresentation): [string, string, string | undefined][] {
  return p.actions.map((a) => [a.label, a.kind, a.command]);
}

type Log = Services["log"];
interface LogLine { level: "error" | "warn" | "info"; text: string; }

/** The LogOutputChannel members presentError may use, recorded. */
function fakeLog(): { log: Log; lines: LogLine[]; shown: () => number } {
  const lines: LogLine[] = [];
  let shown = 0;
  const line = (level: LogLine["level"]) => (m: string | Error, ...rest: unknown[]): void => {
    lines.push({ level, text: [m instanceof Error ? m.message : m, ...rest.map(String)].join(" ") });
  };
  const log = {
    error: line("error"), warn: line("warn"), info: line("info"),
    debug: () => undefined, trace: () => undefined, appendLine: () => undefined,
    show: () => { shown++; },
  };
  return { log: log as unknown as Log, lines, shown: () => shown };
}

interface PromptCall { method: keyof Prompts; args: unknown[]; }

/** Prompts that log every call; info/warn/error resolve with `choice` (an action label, or undefined: dismissed). */
class ScriptedPrompts {
  readonly calls: PromptCall[] = [];
  choice: string | undefined;

  readonly prompts: Prompts = {
    info: async (...args) => { this.calls.push({ method: "info", args }); return this.choice; },
    warn: async (...args) => { this.calls.push({ method: "warn", args }); return this.choice; },
    error: async (...args) => { this.calls.push({ method: "error", args }); return this.choice; },
    confirm: async (...args) => { this.calls.push({ method: "confirm", args }); return false; },
    quickPick: async (...args) => { this.calls.push({ method: "quickPick", args }); return undefined; },
    inputBox: async (...args) => { this.calls.push({ method: "inputBox", args }); return undefined; },
    copyToClipboard: async (...args) => { this.calls.push({ method: "copyToClipboard", args }); },
    openExternal: async (...args) => { this.calls.push({ method: "openExternal", args }); return true; },
  };
}

/** A repository stand-in that records refresh({remote}) calls. */
function refreshSpy(): { repo: { refresh(o?: { remote?: boolean }): Promise<void> }; calls: { remote?: boolean }[] } {
  const calls: { remote?: boolean }[] = [];
  return { repo: { refresh: async (o) => { calls.push({ ...o }); } }, calls };
}

/** Let not-awaited promise chains (the toast's .then) run. */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

// Compile-time half of the exhaustiveness check: the table's keys are exactly ErrorCode.
const _everyCodeMapped: [ErrorCode] extends [MappedErrorCode] ? ([MappedErrorCode] extends [ErrorCode] ? true : false) : false = true;

// ---------- errorActions ----------

describe("errorActions (src/commands/errorActions.ts)", () => {
  it("every ErrorCode, including not_implemented, has a mapping", () => {
    assert.equal(_everyCodeMapped, true);
    assert.equal(MAPPED_ERROR_CODES.length, ERROR_CODES.length, "no code mapped twice");
    assert.deepEqual(new Set(MAPPED_ERROR_CODES), new Set(ERROR_CODES));
    assert.ok(MAPPED_ERROR_CODES.includes("not_implemented"));
    for (const code of ERROR_CODES) {
      const p = errorActions(ctxError(code));
      assert.equal(p.code, code, `${code}: effective code`);
      assert.equal(typeof p.message, "string");
      assert.ok(p.message.trim().length > 0, `${code}: a message`);
      assert.notEqual(p.severity, "log", `${code}: a ctx failure is never only logged`);
    }
  });

  it("an unknown code maps by exit category", () => {
    const network = errorActions(ctxError("future_thing", { exit: 7, message: "socket hang up" }));
    assert.equal(network.code, "network");
    assert.deepEqual(actionsOf(network), [["Retry", "retry", undefined], ["Show Log", "showLog", undefined]]);
    assert.match(network.message, /socket hang up/);

    const busy = errorActions(ctxError("future_thing", { exit: 12 }));
    assert.equal(busy.code, "busy");
    assert.equal(busy.autoRetryMs, BUSY_RETRY_MS);

    const auth = errorActions(ctxError("future_thing", { exit: 4 }));
    assert.equal(auth.code, "not_authenticated");
    assert.deepEqual(actionsOf(auth), [["Log in", "command", COMMAND_IDS.login]]);

    assert.equal(errorActions(ctxError("future_thing", { exit: 8 })).code, "page_not_found");
    assert.equal(errorActions(ctxError("future_thing", { exit: 2 })).code, "internal", "exit 2 (Go panic) -> internal");
    assert.equal(errorActions(ctxError("future_thing", { exit: 99 })).code, "internal");
  });

  it("no action's command or args contains --no-distill", () => {
    const sneaky = "ctx push --no-distill";
    const errors: CtxError[] = [
      ...ERROR_CODES.map((code) => ctxError(code, {
        message: `failed; or run ${sneaky}`,
        details: code === "distill_required"
          ? { pages: ["wiki/concepts/auth-flow.md"], sessions: [], agent_prompt: `Distill, do not run ${sneaky}` }
          : code === "quota_exceeded"
            ? { quota_code: "pages", limit: 100, upgrade_url: "https://contexo.live/upgrade" }
            : code === "not_resolvable" ? { path: "a.md", state: "modified", strategy: "ours" } : undefined,
      })),
      ...EXTENSION_ERROR_CODES.map((code) => CtxError.extension(code, `extension ${code} ${sneaky}`)),
      ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((exit) => ctxError("future_thing", { exit, message: sneaky })),
    ];
    for (const err of errors) {
      const p = errorActions(err, { repoId: "fixture-repo" });
      assert.doesNotMatch(JSON.stringify(p.actions), /--no-distill/, `${String(err.code)}: actions`);
    }
    // The D4 presentation offers nothing but the modal: not even the envelope's advice text.
    const distill = errorActions(errors[ERROR_CODES.indexOf("distill_required")] as CtxError);
    assert.equal(distill.distillModal, true);
    assert.deepEqual(distill.actions, []);
    assert.doesNotMatch(distill.message, /--no-distill/);
  });

  it("quota upgrade_url javascript: is ignored", () => {
    for (const bad of ["javascript:alert(1)", " JavaScript:alert(1)", "data:text/html,<b>x</b>", "file:///etc/passwd", "vscode://x", "not a url", "", 42, undefined]) {
      const p = errorActions(ctxError("quota_exceeded", { details: { quota_code: "pages", limit: 100, upgrade_url: bad } }));
      assert.equal(p.code, "quota_exceeded");
      assert.equal(p.actions.find((a) => a.label === "Upgrade"), undefined, `no Upgrade for ${String(bad)}`);
      assert.equal(p.actions.some((a) => a.url !== undefined), false, `no url for ${String(bad)}`);
      assert.ok(p.message.length > 0);
    }
    for (const good of ["https://contexo.live/billing/upgrade", "http://localhost:8080/upgrade"]) {
      const p = errorActions(ctxError("quota_exceeded", { details: { quota_code: "pages", limit: 100, upgrade_url: good } }));
      assert.deepEqual(p.actions, [{ label: "Upgrade", kind: "openUrl", url: good }]);
    }
    assert.equal(ACTION_LABELS.upgrade, "Upgrade");
  });

  it("busy: 'Another ctx operation (possibly your agent) is syncing', auto-retry once after 1000 ms, then [Retry]", () => {
    const p = errorActions(ctxError("busy", { details: { pid: 4242, host: "dev", command: "push", started_at: "2026-10-22T09:00:00Z" } }));
    assert.equal(BUSY_MESSAGE, "Another ctx operation (possibly your agent) is syncing");
    assert.equal(p.message, BUSY_MESSAGE);
    assert.equal(BUSY_RETRY_MS, 1000);
    assert.equal(p.autoRetryMs, 1000);
    assert.deepEqual(actionsOf(p), [["Retry", "retry", undefined]]);
    assert.equal(p.refresh, false);
  });

  it("not_authenticated, auth_rejected and server_unresolved offer [Log in] (contexo.login)", () => {
    for (const code of ["not_authenticated", "auth_rejected", "server_unresolved"] as const) {
      const p = errorActions(ctxError(code));
      assert.deepEqual(actionsOf(p), [["Log in", "command", "contexo.login"]], code);
      assert.equal(p.refresh, false, code);
    }
  });

  it("not_initialized offers [Initialize Contexo] (contexo.init); conflict offers [Show Conflicts] (workbench.view.scm); not_implemented offers [Update ctx] (contexo.updateCtx)", () => {
    assert.deepEqual(actionsOf(errorActions(ctxError("not_initialized"))), [["Initialize Contexo", "command", COMMAND_IDS.init]]);
    assert.equal(SHOW_SCM_COMMAND, "workbench.view.scm");
    const conflict = errorActions(ctxError("conflict", { details: { paths: ["wiki/concepts/rate-limits.md"] } }));
    assert.deepEqual(actionsOf(conflict), [[SHOW_CONFLICTS_LABEL, "command", "workbench.view.scm"]]);
    const old = errorActions(ctxError("not_implemented"));
    assert.deepEqual(actionsOf(old), [["Update ctx", "command", "contexo.updateCtx"]]);
    assert.match(old.message, /ctx/);
  });

  it("forbidden names the repository; repo_not_configured advises 'ctx remote set-repo'; server_unsupported says 'Server outdated'", () => {
    const forbidden = errorActions(ctxError("forbidden"), { repoId: "acme-kb" });
    assert.match(forbidden.message, /acme-kb/);
    assert.notEqual(forbidden.severity, "log");
    assert.ok(errorActions(ctxError("forbidden")).message.length > 0, "without a repo id too");

    assert.match(errorActions(ctxError("repo_not_configured")).message, /ctx remote set-repo/);
    assert.match(errorActions(ctxError("server_unsupported", { details: { missing: ["pages.at"] } })).message, /Server outdated/);
  });

  it("stale, not_resolvable and the not-found codes ask for a refresh; not_resolvable names details.state", () => {
    const stale = errorActions(ctxError("stale", { details: { path: "a.md", expected_sha: "1", server_sha: "2" } }));
    assert.equal(stale.refresh, true);
    const nr = errorActions(ctxError("not_resolvable", { details: { path: "wiki/concepts/auth-flow.md", state: "incoming", strategy: "ours" } }));
    assert.equal(nr.refresh, true);
    assert.match(nr.message, /incoming/);
    assert.ok(errorActions(ctxError("not_resolvable")).message.length > 0, "without details too");
    for (const code of ["repo_not_found", "page_not_found", "sha_not_found", "base_unavailable"] as const) {
      const p = errorActions(ctxError(code));
      assert.equal(p.refresh, true, code);
      assert.notEqual(p.severity, "log", `${code}: a toast`);
    }
    for (const code of ERROR_CODES.filter((c) => !["stale", "not_resolvable", "repo_not_found", "page_not_found", "sha_not_found", "base_unavailable"].includes(c))) {
      assert.equal(errorActions(ctxError(code)).refresh, false, `${code}: no refresh`);
    }
  });

  it("network, server_error and rate_limited offer [Retry] [Show Log] and quote ctx's message", () => {
    for (const code of ["network", "server_error", "rate_limited"] as const) {
      const p = errorActions(ctxError(code, { message: `${code} detail` }));
      assert.deepEqual(actionsOf(p), [["Retry", "retry", undefined], ["Show Log", "showLog", undefined]], code);
      assert.match(p.message, new RegExp(`${code} detail`), code);
      assert.equal(p.autoRetryMs, undefined, `${code}: no automatic retry`);
    }
  });

  it("usage and invalid_path are an extension bug (error, [Show Log]); internal shows [Show Log]", () => {
    for (const code of ["usage", "invalid_path"] as const) {
      const p = errorActions(ctxError(code, { message: "unknown flag --frobnicate" }));
      assert.equal(p.severity, "error", code);
      assert.deepEqual(actionsOf(p), [["Show Log", "showLog", undefined]], code);
      assert.match(p.message, /bug/i, code);
      assert.match(p.message, /unknown flag --frobnicate/, code);
    }
    const internal = errorActions(ctxError("internal", { message: "panic: nil map" }));
    assert.equal(internal.severity, "error");
    assert.deepEqual(actionsOf(internal), [["Show Log", "showLog", undefined]]);
    assert.match(internal.message, /panic: nil map/);
  });

  it("distill_required asks for the D4 modal", () => {
    const p = errorActions(ctxError("distill_required", { details: { pages: ["wiki/concepts/auth-flow.md"], sessions: [], agent_prompt: "Distill the session" } }));
    assert.equal(p.distillModal, true);
    assert.deepEqual(p.actions, []);
    assert.match(p.message, /so the decision record is kept/);
    assert.doesNotMatch(p.message, /reasoning/i);
    for (const code of ERROR_CODES.filter((c) => c !== "distill_required")) {
      assert.notEqual(errorActions(ctxError(code)).distillModal, true, code);
    }
  });

  it("extension-side codes (timeout, cancelled, spawn_failed, contract_mismatch) are a quiet log line only", () => {
    assert.deepEqual([...EXTENSION_ERROR_CODES].sort(), ["cancelled", "contract_mismatch", "spawn_failed", "timeout"]);
    for (const code of EXTENSION_ERROR_CODES) {
      const p = errorActions(CtxError.extension(code, `ctx ${code}`));
      assert.equal(p.code, code);
      assert.equal(p.severity, "log", code);
      assert.deepEqual(p.actions, [], code);
      assert.equal(p.refresh, false, code);
      assert.ok(p.message.length > 0, code);
    }
  });

  it("effectiveCode: an extension code and a known code as is, an unknown code by its exit category", () => {
    const ext: ExtensionErrorCode = "timeout";
    assert.equal(effectiveCode(CtxError.extension(ext, "slow", { exitCode: 7 })), "timeout", "not by its exit");
    assert.equal(effectiveCode(ctxError("stale")), "stale");
    assert.equal(effectiveCode(ctxError("not_implemented", { exit: 1 })), "not_implemented", "the code wins over the exit");
    assert.equal(effectiveCode(ctxError("future_thing", { exit: 6 })), "conflict");
    assert.equal(effectiveCode(ctxError("future_thing", { exit: 9 })), "not_resolvable");
    assert.equal(effectiveCode(ctxError("future_thing", { exit: -1 })), "internal");
  });

  it("isBusy: a CtxError whose effective code is busy", () => {
    assert.equal(isBusy(ctxError("busy")), true);
    assert.equal(isBusy(ctxError("future_thing", { exit: 12 })), true);
    assert.equal(isBusy(ctxError("network")), false);
    assert.equal(isBusy(CtxError.extension("timeout", "slow", { exitCode: 12 })), false);
    assert.equal(isBusy(Object.assign(new Error("busy"), { code: "busy", exitCode: 12 })), false, "not a CtxError");
    assert.equal(isBusy(undefined), false);
  });
});

// ---------- withBusyRetry ----------

describe("withBusyRetry (src/commands/errorActions.ts)", () => {
  function scripted(results: (string | Error)[]): { fn: () => Promise<string>; calls: () => number } {
    let calls = 0;
    return {
      fn: async () => {
        const r = results[calls++];
        if (r instanceof Error) { throw r; }
        return r ?? "done";
      },
      calls: () => calls,
    };
  }
  function sleeper(): { sleep: (ms: number) => Promise<void>; slept: number[] } {
    const slept: number[] = [];
    return { sleep: async (ms) => { slept.push(ms); }, slept };
  }

  it("busy once: waits 1000 ms (the injected sleep) and calls fn exactly twice", async () => {
    const f = scripted([ctxError("busy"), "pushed"]);
    const z = sleeper();
    assert.equal(await withBusyRetry(f.fn, BUSY_RETRY_MS, z.sleep), "pushed");
    assert.equal(f.calls(), 2);
    assert.deepEqual(z.slept, [1000]);
  });

  it("busy twice: rejects with the second busy after 2 calls", async () => {
    const second = ctxError("busy", { message: "still busy" });
    const f = scripted([ctxError("busy"), second, "never"]);
    const z = sleeper();
    await assert.rejects(withBusyRetry(f.fn, undefined, z.sleep), (err) => err === second);
    assert.equal(f.calls(), 2);
    assert.deepEqual(z.slept, [1000], "the default delay is BUSY_RETRY_MS");
  });

  it("another error: 1 call, rethrown unchanged, no wait", async () => {
    const err = ctxError("network");
    const f = scripted([err, "never"]);
    const z = sleeper();
    await assert.rejects(withBusyRetry(f.fn, 1000, z.sleep), (e) => e === err);
    assert.equal(f.calls(), 1);
    assert.deepEqual(z.slept, []);
  });

  it("success: 1 call, no wait", async () => {
    const f = scripted(["ok"]);
    const z = sleeper();
    assert.equal(await withBusyRetry(f.fn, 1000, z.sleep), "ok");
    assert.equal(f.calls(), 1);
    assert.deepEqual(z.slept, []);
  });
});

// ---------- presentError ----------

describe("presentError (src/commands/errorActions.ts)", () => {
  it("routes by severity to prompts.error / warn / info with the action labels, and logs every error with log.error", () => {
    const p = new ScriptedPrompts();
    const l = fakeLog();
    const s = { prompts: p.prompts, log: l.log };
    const retry = async (): Promise<void> => undefined;

    presentError(s, ctxError("network", { message: "connection refused" }), { retry });
    presentError(s, ctxError("conflict"));
    presentError(s, ctxError("stale"));
    assert.deepEqual(p.calls.map((c) => [c.method, ...c.args.slice(1)]), [
      ["error", "Retry", "Show Log"],
      ["warn", SHOW_CONFLICTS_LABEL],
      ["info"],
    ]);
    assert.equal(p.calls[0]?.args[0], errorActions(ctxError("network", { message: "connection refused" })).message, "the presentation's message");
    assert.equal(l.lines.filter((x) => x.level === "error").length, 3, "each one logged as an error");
    assert.match(l.lines[0]?.text ?? "", /connection refused/);
  });

  it("without o.retry no Retry button is offered", () => {
    const p = new ScriptedPrompts();
    presentError({ prompts: p.prompts, log: fakeLog().log }, ctxError("server_error"));
    presentError({ prompts: p.prompts, log: fakeLog().log }, ctxError("busy"));
    assert.deepEqual(p.calls.map((c) => [c.method, ...c.args.slice(1)]), [["error", "Show Log"], ["warn"]]);
  });

  it("severity 'log' calls no prompt and logs quietly (warn or info, never error)", () => {
    const p = new ScriptedPrompts();
    const l = fakeLog();
    assert.equal(EXTENSION_ERROR_CODES.length, 4);
    for (const code of EXTENSION_ERROR_CODES) {
      presentError({ prompts: p.prompts, log: l.log }, CtxError.extension(code, `ctx ${code} happened`), { retry: async () => undefined });
    }
    assert.deepEqual(p.calls, []);
    assert.equal(l.lines.length, EXTENSION_ERROR_CODES.length);
    assert.ok(l.lines.every((x) => x.level === "warn" || x.level === "info"), JSON.stringify(l.lines));
    assert.ok(EXTENSION_ERROR_CODES.every((code) => l.lines.some((x) => x.text.includes(`ctx ${code} happened`))));
  });

  it("picking Retry calls o.retry; picking Show Log calls log.show", async () => {
    const p = new ScriptedPrompts();
    const l = fakeLog();
    let retried = 0;
    p.choice = "Retry";
    presentError({ prompts: p.prompts, log: l.log }, ctxError("rate_limited"), { retry: async () => { retried++; } });
    await waitFor(() => retried === 1);

    p.choice = "Show Log";
    presentError({ prompts: p.prompts, log: l.log }, ctxError("rate_limited"), { retry: async () => { retried++; } });
    await waitFor(() => l.shown() === 1);
    await settle();
    assert.equal(retried, 1, "Show Log does not retry");

    p.choice = undefined; // dismissed
    presentError({ prompts: p.prompts, log: l.log }, ctxError("rate_limited"), { retry: async () => { retried++; } });
    await settle();
    assert.equal(retried, 1);
    assert.equal(l.shown(), 1);
  });

  it("picking Upgrade calls prompts.openExternal with the upgrade URL", async () => {
    const p = new ScriptedPrompts();
    p.choice = "Upgrade";
    const url = "https://contexo.live/billing/upgrade";
    presentError({ prompts: p.prompts, log: fakeLog().log }, ctxError("quota_exceeded", { details: { quota_code: "pages", limit: 100, upgrade_url: url } }));
    const call = await waitFor(() => p.calls.find((c) => c.method === "openExternal"));
    const uri = call.args[0] as { scheme: string; toString(): string };
    assert.equal(uri.scheme, "https");
    assert.equal(uri.toString(), url);
  });

  it("an action that fails is logged, never thrown", async () => {
    const p = new ScriptedPrompts();
    const l = fakeLog();
    p.choice = "Retry";
    presentError({ prompts: p.prompts, log: l.log }, ctxError("network"), { retry: async () => { throw new Error("retry exploded"); } });
    await waitFor(() => l.lines.some((x) => x.level === "error" && x.text.includes("retry exploded")));
  });

  it("refreshes the repository only when the presentation asks for it, the caller has not refreshed, and a repo is given", async () => {
    const p = new ScriptedPrompts();
    const s = { prompts: p.prompts, log: fakeLog().log };

    const asked = refreshSpy();
    presentError(s, ctxError("stale"), { repo: asked.repo });
    await waitFor(() => asked.calls.length === 1);
    assert.deepEqual(asked.calls, [{ remote: true }]);

    const refreshed = refreshSpy();
    presentError(s, ctxError("page_not_found"), { repo: refreshed.repo, refreshed: true });
    const notAsked = refreshSpy();
    presentError(s, ctxError("network"), { repo: notAsked.repo });
    presentError(s, ctxError("stale")); // no repo: nothing to refresh, no throw
    await settle();
    assert.deepEqual(refreshed.calls, [], "run() already refreshed");
    assert.deepEqual(notAsked.calls, [], "network does not ask for a refresh");
  });
});
