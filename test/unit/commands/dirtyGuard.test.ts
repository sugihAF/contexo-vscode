// The E27 dirty guard (src/commands/dirtyGuard.ts, WP-1.13): ctx only sees bytes on disk,
// so unsaved Contexo pages are saved (or the operation cancelled) before push,
// pushSelected and pull, and Take Server Version refuses a dirty target. Plain mocha:
// FakeRepository (root /ws) loads over the vscode stub; documents are plain objects.
import * as assert from "node:assert/strict";
import { URI } from "vscode-uri";
import {
  SAVE_ALL_LABEL, dirtyDocumentsOf, ensureSaved, type DirtyGuardEnv, type GuardMode, type SavableDocument,
} from "../../../src/commands/dirtyGuard";
import type { Prompts } from "../../../src/ui/prompts";
import { fakeRepository, type FakeRepository } from "../../helpers/fakeRepository";

type VsUri = SavableDocument["uri"];
const asVs = (u: URI): VsUri => u as unknown as VsUri;

interface PromptCall { method: keyof Prompts; args: unknown[]; }

/** Prompts that log every call; confirm resolves with `confirmAnswer`. */
class ScriptedPrompts {
  readonly calls: PromptCall[] = [];
  confirmAnswer = false;

  readonly prompts: Prompts = {
    info: async (...args) => { this.calls.push({ method: "info", args }); return undefined; },
    warn: async (...args) => { this.calls.push({ method: "warn", args }); return undefined; },
    error: async (...args) => { this.calls.push({ method: "error", args }); return undefined; },
    confirm: async (...args) => { this.calls.push({ method: "confirm", args }); return this.confirmAnswer; },
    quickPick: async (...args) => { this.calls.push({ method: "quickPick", args }); return undefined; },
    inputBox: async (...args) => { this.calls.push({ method: "inputBox", args }); return undefined; },
    copyToClipboard: async (...args) => { this.calls.push({ method: "copyToClipboard", args }); },
    openExternal: async (...args) => { this.calls.push({ method: "openExternal", args }); return false; },
  };
}

/** A recorded document: save() logs 'save:<name>' to the shared event list and resolves `saves`. */
interface Doc extends SavableDocument { readonly name: string; }

describe("dirtyGuard (src/commands/dirtyGuard.ts)", () => {
  let repo: FakeRepository;
  let events: string[];
  let p: ScriptedPrompts;

  /** A document at uri; save() records the event and resolves `result` (or throws it when it is an Error). */
  function doc(name: string, uri: VsUri, isDirty: boolean, result: boolean | Error = true): Doc {
    return {
      name, uri, isDirty,
      save: async () => {
        events.push(`save:${name}`);
        if (result instanceof Error) { throw result; }
        return result;
      },
    };
  }
  const page = (rel: string): VsUri => repo.fileUri(rel);
  const envOf = (docs: readonly SavableDocument[]): DirtyGuardEnv => ({ textDocuments: () => docs });

  beforeEach(() => {
    repo = fakeRepository({ root: "/ws", status: "mixed" });
    events = [];
    repo.onRefresh = (o) => { events.push(`refresh:${o.remote ? "remote" : "offline"}`); };
    p = new ScriptedPrompts();
  });

  afterEach(() => repo.dispose());

  it("dirtyDocumentsOf keeps dirty file: documents under .contexo, in document order", () => {
    const a = doc("a", page("wiki/concepts/auth-flow.md"), true);
    const docs = [
      doc("outside", asVs(URI.file("/ws/README.md")), true),
      doc("clean", page("wiki/analyses/sync-model.md"), false),
      a,
      doc("untitled", asVs(URI.from({ scheme: "untitled", path: "/ws/.contexo/wiki/new.md" })), true),
      doc("contexo-scheme", asVs(URI.from({ scheme: "contexo", path: "/ws/.contexo/wiki/concepts/auth-flow.md", query: "ref=base" })), true),
      doc("other-root", asVs(URI.file("/elsewhere/.contexo/wiki/x.md")), true),
      doc("b", page("raw/sessions/2026-10-01-login-debug.md"), true),
    ];
    assert.deepEqual(dirtyDocumentsOf(repo, docs).map((d) => (d as Doc).name), ["a", "b"]);
    assert.deepEqual(dirtyDocumentsOf(repo, []), []);
  });

  it("push, pushSelected and pull with no dirty page resolve true without a prompt", async () => {
    const docs = [
      doc("outside", asVs(URI.file("/ws/src/main.ts")), true),
      doc("clean", page("wiki/concepts/auth-flow.md"), false),
    ];
    for (const mode of ["push", "pushSelected", "pull"] as const) {
      assert.equal(await ensureSaved({ prompts: p.prompts }, repo, { mode }, envOf(docs)), true, mode);
    }
    assert.deepEqual(p.calls, []);
    assert.deepEqual(events, [], "nothing saved, no refresh");
  });

  it("one dirty page under .contexo (plus a dirty file outside it and a clean page) asks the modal '1 unsaved Contexo page(s)' [Save All and Continue]; Cancel resolves false, saves nothing and does not refresh", async () => {
    const docs = [
      doc("outside", asVs(URI.file("/ws/notes.txt")), true),
      doc("dirty", page("wiki/concepts/auth-flow.md"), true),
      doc("clean", page("wiki/analyses/sync-model.md"), false),
    ];
    for (const mode of ["push", "pushSelected", "pull"] as const) {
      p.calls.length = 0;
      p.confirmAnswer = false;
      assert.equal(await ensureSaved({ prompts: p.prompts }, repo, { mode }, envOf(docs)), false, mode);
      assert.equal(SAVE_ALL_LABEL, "Save All and Continue");
      assert.deepEqual(p.calls, [{
        method: "confirm",
        args: ["1 unsaved Contexo page(s)", { modal: true, confirmLabel: "Save All and Continue", detail: "wiki/concepts/auth-flow.md" }],
      }], mode);
    }
    assert.deepEqual(events, [], "Cancel: nothing saved, no refresh");
    assert.deepEqual(repo.refreshCalls, []);
  });

  it("Save All saves each dirty page in order, then refreshes the offline status exactly once, and resolves true", async () => {
    const docs = [
      doc("a", page("wiki/concepts/auth-flow.md"), true),
      doc("outside", asVs(URI.file("/ws/notes.txt")), true),
      doc("clean", page("wiki/entities/gitstore.md"), false),
      doc("b", page("wiki/analyses/sync-model.md"), true),
    ];
    p.confirmAnswer = true;
    assert.equal(await ensureSaved({ prompts: p.prompts }, repo, { mode: "push" }, envOf(docs)), true);
    const confirm = p.calls[0];
    assert.equal(confirm?.args[0], "2 unsaved Contexo page(s)");
    assert.equal((confirm?.args[1] as { detail?: string }).detail, "wiki/concepts/auth-flow.md\nwiki/analyses/sync-model.md", "one relPath per line");
    assert.deepEqual(events, ["save:a", "save:b", "refresh:offline"], "saves first, then one refresh({remote: false})");
    assert.deepEqual(repo.refreshCalls, [{ remote: false }]);
    assert.deepEqual(p.calls.map((c) => c.method), ["confirm"], "no other prompt");
  });

  it("a save resolving false (or failing) resolves false with an error naming the file, and does not refresh", async () => {
    for (const failure of [false, new Error("EACCES")] as const) {
      events.length = 0;
      p.calls.length = 0;
      p.confirmAnswer = true;
      const docs = [
        doc("a", page("wiki/concepts/auth-flow.md"), true, failure),
        doc("b", page("wiki/analyses/sync-model.md"), true),
      ];
      assert.equal(await ensureSaved({ prompts: p.prompts }, repo, { mode: "pull" }, envOf(docs)), false, String(failure));
      assert.deepEqual(events, ["save:a"], "stops at the failed save; no refresh");
      const error = p.calls.find((c) => c.method === "error");
      assert.ok(error, "an error is shown");
      assert.match(String(error.args[0]), /wiki\/concepts\/auth-flow\.md/);
    }
    assert.deepEqual(repo.refreshCalls, []);
  });

  it("theirs with a dirty target resolves false with 'Save or revert <relPath> first', saving nothing and asking nothing", async () => {
    const docs = [
      doc("target", page("wiki/concepts/rate-limits.md"), true),
      doc("other", page("wiki/concepts/auth-flow.md"), true),
    ];
    const ok = await ensureSaved({ prompts: p.prompts }, repo, { mode: "theirs", targets: ["wiki/concepts/rate-limits.md", "wiki/concepts/retry-policy.md"] }, envOf(docs));
    assert.equal(ok, false);
    assert.equal(p.calls.length, 1);
    assert.equal(p.calls[0]?.method, "warn");
    const message = String(p.calls[0]?.args[0]);
    assert.match(message, /Save or revert/);
    assert.match(message, /wiki\/concepts\/rate-limits\.md/);
    assert.doesNotMatch(message, /auth-flow/, "only the dirty targets are named");
    assert.deepEqual(events, [], "nothing saved, no refresh");
  });

  it("theirs with only a non-target page dirty resolves true", async () => {
    const docs = [doc("other", page("wiki/concepts/auth-flow.md"), true), doc("clean target", page("wiki/concepts/rate-limits.md"), false)];
    assert.equal(await ensureSaved({ prompts: p.prompts }, repo, { mode: "theirs", targets: ["wiki/concepts/rate-limits.md"] }, envOf(docs)), true);
    assert.equal(await ensureSaved({ prompts: p.prompts }, repo, { mode: "theirs" }, envOf(docs)), true, "no targets");
    assert.deepEqual(p.calls, []);
    assert.deepEqual(events, []);
  });

  it("ours resolves true without looking at the documents", async () => {
    const env: DirtyGuardEnv = { textDocuments: () => { throw new Error("ours must not look at the documents"); } };
    const mode: GuardMode = "ours";
    assert.equal(await ensureSaved({ prompts: p.prompts }, repo, { mode, targets: ["wiki/concepts/rate-limits.md"] }, env), true);
    assert.deepEqual(p.calls, []);
  });
});
