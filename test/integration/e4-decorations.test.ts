// e4 (WP-1.10): the Contexo FileDecorationProvider badges pages by sync state through file:
// URIs (Explorer, Source Control and Knowledge views). The registered provider is read
// through api.hooks.decorationFor; its events are observed on a provider constructed
// directly from the compiled src module over the same (overridden) services.
import * as assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import type { PageEntry, PageState, StatusDoc } from "../../src/contract/types";
import { ContexoDecorationProvider } from "../../src/decorations/decorationProvider";
import { toContexoUri } from "../../src/fs/contexoUri";
import type { Services } from "../../src/services";
import type { DecorationSnapshot, TestApi } from "../../src/testApi";
import { activateExtension } from "../helpers/activate";
import { FakeCtxCli } from "../helpers/fakeCtxCli";
import { fakeModel, type FakeModel } from "../helpers/fakeModel";
import { fakeRepository, type FakeRepository } from "../helpers/fakeRepository";
import { waitFor } from "../helpers/waitFor";

const RATE_LIMITS = "wiki/concepts/rate-limits.md";
const AUTH_FLOW = "wiki/concepts/auth-flow.md";
const RETRY_POLICY = "wiki/concepts/retry-policy.md";
const LEGACY_SYNC = "wiki/concepts/legacy-sync.md";
const SYNC_BASE_COPY = ".sync/base/wiki/concepts/rate-limits.md";

/** The pages 'mixed' decorates (every state but unchanged). */
const MIXED_DECORATED = [
  "wiki/analyses/sync-model.md",
  AUTH_FLOW,
  "wiki/concepts/broken.md",
  LEGACY_SYNC,
  "wiki/concepts/old-name.md",
  RATE_LIMITS,
  RETRY_POLICY,
  "wiki/entities/billing.md",
];

/** Every 'mixed' page and the badge it gets (undefined: no decoration). */
const MIXED_BADGES: Record<string, string | undefined> = {
  "raw/sessions/2026-10-01-login-debug.md": undefined,
  "wiki/analyses/sync-model.md": "A",
  [AUTH_FLOW]: "M",
  "wiki/concepts/broken.md": "⚠",
  [LEGACY_SYNC]: "?",
  "wiki/concepts/old-name.md": "D",
  [RATE_LIMITS]: "!",
  [RETRY_POLICY]: "↓",
  "wiki/entities/billing.md": "↓",
  "wiki/entities/gitstore.md": undefined,
};

function workspaceRoot(): vscode.Uri {
  const folder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(folder, "the integration label opens the basic workspace");
  return folder.uri;
}

function contexoSettings(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration("contexo");
}

function page(doc: StatusDoc, relPath: string): PageEntry {
  const p = doc.pages.find((e) => e.path === relPath);
  assert.ok(p, `fixture page ${relPath}`);
  return p;
}

function setState(doc: StatusDoc, relPath: string, state: PageState): void {
  const p = page(doc, relPath);
  p.state = state;
  if (state === "conflict") { p.conflict_kind = "both_modified"; } else { delete p.conflict_kind; }
}

function entry(relPath: string, state: PageState): PageEntry {
  return { path: relPath, state, tags: [], notes: [], local: { file: relPath } };
}

/** Order-insensitive comparison of URI lists. */
function sortedStrings(uris: readonly string[]): string[] {
  return [...uris].sort();
}

function urisOf(repo: FakeRepository, relPaths: readonly string[]): string[] {
  return sortedStrings(relPaths.map((p) => repo.fileUri(p).toString()));
}

describe("e4 decorations", () => {
  let api: TestApi;
  let root: vscode.Uri;
  let repo: FakeRepository;
  let model: FakeModel;
  let cli: FakeCtxCli;
  let settingChanged = false;
  const toDispose: vscode.Disposable[] = [];

  /** A provider over the same services the registered one sees, recording every event payload. */
  function directProvider(): { provider: ContexoDecorationProvider; fired: string[][] } {
    const s: Services = { ...api.services, cli, model };
    const provider = new ContexoDecorationProvider(s);
    const fired: string[][] = [];
    toDispose.push(provider);
    // VS Code's Emitter swallows listener errors, so the payload is recorded as is and the
    // tests compare it exactly: a non-array shows up as '<...>', an empty array as [].
    toDispose.push(provider.onDidChangeFileDecorations((e: unknown) => {
      fired.push(Array.isArray(e) ? e.map((u) => String(u)) : [`<${String(e)}>`]);
    }));
    return { provider, fired };
  }

  function decorationFor(uri: vscode.Uri): DecorationSnapshot | undefined {
    const hook = api.hooks.decorationFor;
    assert.ok(hook, "registerDecorations assigns hooks.decorationFor");
    return hook(uri);
  }

  async function setDecorationsEnabled(value: boolean | undefined): Promise<void> {
    if (value !== undefined) { settingChanged = true; }
    await contexoSettings().update("decorations.enabled", value, vscode.ConfigurationTarget.Global);
    const expected = value !== false;
    await waitFor(() => api.services.config.decorationsEnabled === expected, { message: `contexo.decorations.enabled -> ${String(value)}` });
    // Cleared only once the restore landed, so afterEach retries a failed one.
    if (value === undefined) { settingChanged = false; }
  }

  beforeEach(async () => {
    api = await activateExtension();
    root = workspaceRoot();
    repo = fakeRepository({ root, status: "mixed" });
    model = fakeModel({ repositories: [repo] });
    cli = new FakeCtxCli();
    await api.hooks.overrideServices({ cli, model });
  });

  afterEach(async () => {
    for (const d of toDispose.splice(0).reverse()) { d.dispose(); }
    if (settingChanged) { await setDecorationsEnabled(undefined); }
    await api.hooks.resetServices();
    repo.dispose();
    model.dispose();
  });

  it('api.hooks.decorationFor(the file URI of rate-limits).badge === "!"', () => {
    const uri = repo.fileUri(RATE_LIMITS);
    assert.equal(uri.scheme, "file");
    assert.equal(decorationFor(uri)?.badge, "!");
    assert.deepEqual(decorationFor(uri), {
      badge: "!",
      tooltip: "Contexo: conflict",
      color: "contexo.conflictForeground",
      propagate: true,
    });

    // provideFileDecoration gives the same answer as the hook.
    const { provider } = directProvider();
    const fd = provider.provideFileDecoration(uri);
    assert.ok(fd instanceof vscode.FileDecoration);
    assert.equal(fd.badge, "!");
    assert.equal(fd.tooltip, "Contexo: conflict");
    assert.ok(fd.color instanceof vscode.ThemeColor);
    assert.equal(fd.color.id, "contexo.conflictForeground");
    assert.equal(fd.propagate, true);

    // Every 'mixed' page; unverified has no color (the key is absent).
    for (const [relPath, badge] of Object.entries(MIXED_BADGES)) {
      assert.equal(decorationFor(repo.fileUri(relPath))?.badge, badge, relPath);
      assert.equal(provider.provideFileDecoration(repo.fileUri(relPath))?.badge, badge, `${relPath} (provider)`);
    }
    assert.deepEqual(decorationFor(repo.fileUri(LEGACY_SYNC)), { badge: "?", tooltip: "Contexo: unverified", propagate: false });
    assert.equal(provider.provideFileDecoration(repo.fileUri(LEGACY_SYNC))?.color, undefined);
    assert.deepEqual(decorationFor(repo.fileUri(AUTH_FLOW)), {
      badge: "M",
      tooltip: "Contexo: modified",
      color: "contexo.modifiedForeground",
      propagate: true,
    });
  });

  it("files under .contexo/.sync get no decoration", () => {
    const { fired } = directProvider();
    const doc = structuredClone(repo.status) as StatusDoc;
    doc.pages.push(
      { ...entry(SYNC_BASE_COPY, "conflict"), conflict_kind: "both_modified" },
      entry(".sync/server/wiki/concepts/retry-policy.md", "modified"),
      entry("wiki/.drafts/idea.md", "new"),
      entry("index.md", "modified"),
      entry("Tags.md", "conflict"),
      entry("wiki/index.md", "modified"),
    );
    repo.setStatus(doc);

    // Non-vacuous: the status HAS an entry for each excluded file, so only the exclusion rule
    // can return undefined.
    for (const relPath of [SYNC_BASE_COPY, ".sync/server/wiki/concepts/retry-policy.md", "wiki/.drafts/idea.md", "index.md", "Tags.md"]) {
      const uri = repo.fileUri(relPath);
      assert.ok(repo.pageAt(uri), `${relPath} has a status entry`);
      assert.equal(decorationFor(uri), undefined, `${relPath} is excluded`);
    }
    assert.equal(repo.pageAt(repo.fileUri(SYNC_BASE_COPY))?.state, "conflict");
    // Only the ROOT index.md / tags.md are excluded.
    assert.equal(decorationFor(repo.fileUri("wiki/index.md"))?.badge, "M");
    assert.equal(decorationFor(repo.fileUri(RATE_LIMITS))?.badge, "!");
    // The status change refreshed only the URI whose decoration can change.
    assert.deepEqual(fired, [[repo.fileUri("wiki/index.md").toString()]]);
  });

  it("with contexo.decorations.enabled=false provideFileDecoration returns undefined, and the toggle fires a refresh", async () => {
    const { provider, fired } = directProvider();
    const uri = repo.fileUri(RATE_LIMITS);
    assert.equal(decorationFor(uri)?.badge, "!");

    await setDecorationsEnabled(false);
    await waitFor(() => fired.length > 0, { message: "the toggle to false fires a refresh" });
    assert.equal(decorationFor(uri), undefined);
    assert.equal(provider.provideFileDecoration(uri), undefined);
    assert.equal(fired.length, 1);
    assert.deepEqual(sortedStrings(fired[0] ?? []), urisOf(repo, MIXED_DECORATED), "every decorated URI of the mixed status");

    // While disabled, a status change fires nothing (the re-enable refresh covers it).
    const doc = structuredClone(repo.status) as StatusDoc;
    setState(doc, RETRY_POLICY, "unchanged");
    repo.setStatus(doc);
    assert.equal(fired.length, 1);

    await setDecorationsEnabled(undefined);
    await waitFor(() => fired.length > 1, { message: "the toggle back fires another refresh" });
    assert.equal(decorationFor(uri)?.badge, "!", "the decoration comes back");
    assert.equal(provider.provideFileDecoration(uri)?.badge, "!");
    assert.equal(fired.length, 2);
    assert.deepEqual(
      sortedStrings(fired[1] ?? []),
      urisOf(repo, MIXED_DECORATED.filter((p) => p !== RETRY_POLICY)),
      "every decorated URI of the CURRENT status",
    );
  });

  it("a status change fires onDidChangeFileDecorations with exactly the changed file URIs", () => {
    const { fired } = directProvider();
    const doc = structuredClone(repo.status) as StatusDoc;
    setState(doc, AUTH_FLOW, "unchanged");
    setState(doc, RETRY_POLICY, "conflict");
    page(doc, RATE_LIMITS).title = "Rate limits (v2)"; // same decoration: not refreshed
    repo.setStatus(doc);

    assert.equal(fired.length, 1);
    assert.deepEqual(sortedStrings(fired[0] ?? []), urisOf(repo, [AUTH_FLOW, RETRY_POLICY]));
    assert.equal(decorationFor(repo.fileUri(AUTH_FLOW)), undefined);
    assert.equal(decorationFor(repo.fileUri(RETRY_POLICY))?.badge, "!");
    assert.equal(decorationFor(repo.fileUri(RETRY_POLICY))?.color, "contexo.conflictForeground");

    // An equal status changes nothing and fires nothing.
    repo.setStatus(structuredClone(doc));
    assert.equal(fired.length, 1);
  });

  it("opening a repository fires its decorated URIs; closing fires them again and forgets it", () => {
    const { fired } = directProvider();
    const otherRoot = vscode.Uri.file(path.join(os.tmpdir(), "contexo-e4-decorations-other"));
    const other = fakeRepository({ root: otherRoot, status: "mixed" });
    const empty = fakeRepository({ root: vscode.Uri.file(path.join(os.tmpdir(), "contexo-e4-decorations-empty")) });
    toDispose.push(other, empty);

    model.addRepository(other);
    assert.equal(fired.length, 1);
    assert.deepEqual(sortedStrings(fired[0] ?? []), urisOf(other, MIXED_DECORATED));
    assert.equal(decorationFor(other.fileUri(RATE_LIMITS))?.badge, "!", "the registered provider reads s.model at call time");

    const changed = structuredClone(other.status) as StatusDoc;
    setState(changed, AUTH_FLOW, "unchanged");
    other.setStatus(changed);
    assert.equal(fired.length, 2);
    assert.deepEqual(fired[1], [other.fileUri(AUTH_FLOW).toString()]);

    model.removeRepository(other);
    assert.equal(fired.length, 3);
    assert.deepEqual(sortedStrings(fired[2] ?? []), urisOf(other, MIXED_DECORATED.filter((p) => p !== AUTH_FLOW)), "the last status's decorated URIs");
    assert.equal(decorationFor(other.fileUri(RATE_LIMITS)), undefined);
    other.setStatus("mixed");
    assert.equal(fired.length, 3, "a closed repository is forgotten");

    // A repository opened before its first status fires on that status instead.
    model.addRepository(empty);
    assert.equal(fired.length, 3);
    empty.setStatus("mixed");
    assert.equal(fired.length, 4);
    assert.deepEqual(sortedStrings(fired[3] ?? []), urisOf(empty, MIXED_DECORATED));
    model.removeRepository(empty);
    assert.equal(fired.length, 5);
  });

  it("only file: URIs of pages under .contexo/ are decorated", () => {
    const uri = repo.fileUri(RATE_LIMITS);
    assert.equal(decorationFor(uri)?.badge, "!");
    const contexoUri = toContexoUri(uri, "server", root.fsPath, RATE_LIMITS);
    assert.ok(repo.pageAt(contexoUri), "the repository maps the contexo: URI to the page");
    assert.equal(decorationFor(contexoUri), undefined, "contexo: (read-only versions) is not decorated");
    assert.equal(decorationFor(uri.with({ scheme: "untitled" })), undefined);
    assert.equal(decorationFor(vscode.Uri.joinPath(root, "wiki", "concepts", "rate-limits.md")), undefined, "outside .contexo/");
    assert.equal(decorationFor(repo.contexoDir), undefined, ".contexo itself");
    assert.equal(decorationFor(repo.fileUri("wiki/concepts")), undefined, "a folder (propagation is VS Code's job)");
    assert.equal(decorationFor(vscode.Uri.file(path.join(os.tmpdir(), "elsewhere", ".contexo", RATE_LIMITS))), undefined, "no repository");
  });

  it("a model swap re-wires the registration: decorationFor follows the new model and the swap back", async () => {
    const uri = repo.fileUri(RATE_LIMITS);
    assert.equal(decorationFor(uri)?.badge, "!");
    const doc = structuredClone(repo.status) as StatusDoc;
    setState(doc, RATE_LIMITS, "modified");
    const swapped = fakeRepository({ root, status: doc });
    const swappedModel = fakeModel({ repositories: [swapped] });
    toDispose.push(swapped, swappedModel);

    await api.hooks.overrideServices({ cli, model: swappedModel });
    assert.equal(decorationFor(uri)?.badge, "M", "the hook reads the new model");
    assert.equal(decorationFor(uri)?.color, "contexo.modifiedForeground");

    await api.hooks.overrideServices({ cli, model });
    assert.equal(decorationFor(uri)?.badge, "!", "and follows the swap back");
  });
});
