// The 'vscode' module for plain-mocha unit tests. package.json test:unit loads this file
// first (`mocha --require out/test/helpers/vscodeStub.js`), so a unit test may import a src
// module that imports 'vscode' at runtime (e.g. src/statusBar.ts for statusBarCommandsFor and
// presentStatusBar, src/commands/sync.ts for pushPlan) and call its pure exports. Unit tests
// themselves still never import 'vscode' (ESLint), and the frozen pure modules keep
// `import type` only (pinned by fakeCtx.test.ts).
//
// Only values whose behaviour is fully defined are provided: Disposable, EventEmitter,
// Uri (vscode-uri, the URI implementation VS Code itself ships, plus Uri.joinPath),
// ThemeColor, ThemeIcon, StatusBarAlignment and TreeItemCollapsibleState. Touching any other
// API (window, workspace, commands, ...) throws "vscode.<name> is not available in unit
// tests": keep such code in the adapter and cover it with an integration test.
//
// Inside VS Code (Electron) nothing is installed: the extension host's real module wins.
import Module from "node:module";
import * as path from "node:path";
import type * as vscode from "vscode";
import { URI, Utils } from "vscode-uri";

class Disposable {
  static from(...disposableLikes: { dispose: () => unknown }[]): Disposable {
    return new Disposable(() => {
      for (const d of disposableLikes) { d.dispose(); }
    });
  }

  #callOnDispose: (() => unknown) | undefined;

  constructor(callOnDispose: () => unknown) {
    this.#callOnDispose = callOnDispose;
  }

  /** Runs callOnDispose once, like vscode.Disposable. */
  dispose(): unknown {
    const f = this.#callOnDispose;
    this.#callOnDispose = undefined;
    return f?.();
  }
}

class EventEmitter<T> {
  #listeners = new Set<{ fn: (e: T) => unknown }>();
  #disposed = false;

  readonly event: vscode.Event<T> = (listener, thisArgs?, disposables?) => {
    if (this.#disposed) { return new Disposable(() => undefined); }
    const entry = { fn: (e: T): unknown => listener.call(thisArgs, e) };
    this.#listeners.add(entry);
    const subscription = new Disposable(() => { this.#listeners.delete(entry); });
    disposables?.push(subscription);
    return subscription;
  };

  /** Delivers to every listener; a throwing listener does not stop the others, and the first error is rethrown afterwards. */
  fire(data: T): void {
    let failure: { error: unknown } | undefined;
    for (const l of [...this.#listeners]) {
      try { l.fn(data); } catch (error) { failure ??= { error }; }
    }
    if (failure) { throw failure.error; }
  }

  dispose(): void {
    this.#disposed = true;
    this.#listeners.clear();
  }
}

class ThemeColor {
  constructor(readonly id: string) {}
}

class ThemeIcon {
  static readonly File = new ThemeIcon("file");
  static readonly Folder = new ThemeIcon("folder");
  constructor(readonly id: string, readonly color?: vscode.ThemeColor) {}
}

/** vscode.Uri: vscode-uri's URI (so `URI.file(p) instanceof Uri` holds) plus the static joinPath. */
const Uri = new Proxy(URI, {
  get: (target, key, receiver) => (key === "joinPath" ? Utils.joinPath : Reflect.get(target, key, receiver)),
}) as unknown as typeof vscode.Uri;

const StatusBarAlignment = { Left: 1, Right: 2 } as const;
const TreeItemCollapsibleState = { None: 0, Collapsed: 1, Expanded: 2 } as const;

// Compile-time: each enum stub has exactly the vscode enum's member names and values.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type MirrorsEnum<S, E> = Same<keyof S, Extract<keyof E, string>> extends true
  ? { [K in keyof S]: K extends keyof E ? Same<`${S[K] & number}`, `${E[K] & number}`> : false }[keyof S] extends true ? true : false
  : false;
const _statusBarAlignmentMirrors: MirrorsEnum<typeof StatusBarAlignment, typeof vscode.StatusBarAlignment> = true;
const _treeItemCollapsibleStateMirrors: MirrorsEnum<typeof TreeItemCollapsibleState, typeof vscode.TreeItemCollapsibleState> = true;

/** The part of the vscode API the stub implements. */
export type StubbedApi = Pick<
  typeof vscode,
  "Disposable" | "EventEmitter" | "ThemeColor" | "ThemeIcon" | "Uri" | "StatusBarAlignment" | "TreeItemCollapsibleState"
>;

const API: StubbedApi = {
  Disposable,
  EventEmitter,
  ThemeColor,
  ThemeIcon,
  Uri,
  // Values checked against vscode's above; the enum types themselves are nominal.
  StatusBarAlignment: StatusBarAlignment as unknown as typeof vscode.StatusBarAlignment,
  TreeItemCollapsibleState: TreeItemCollapsibleState as unknown as typeof vscode.TreeItemCollapsibleState,
};

/** Probes that loaders and Promise resolution make on a module object; answered with undefined. */
const PROBES: ReadonlySet<string> = new Set(["then", "default", "toJSON"]);

/** What require('vscode') returns in unit tests. */
export const vscodeStub: StubbedApi = new Proxy({ __esModule: true, ...API }, {
  get(target, key, receiver) {
    if (typeof key === "symbol" || Reflect.has(target, key)) { return Reflect.get(target, key, receiver); }
    if (PROBES.has(key)) { return undefined; }
    throw new Error(
      `vscode.${key} is not available in unit tests (plain mocha loads src modules against test/helpers/vscodeStub.ts). ` +
      "Keep unit-tested logic pure, or cover this code in an integration test.",
    );
  },
});

/** Where 'vscode' resolves in unit tests: a require.cache entry; the file never exists on disk. */
const STUB_FILENAME = path.join(__dirname, "vscode.stub.js");
const INSTALLED = Symbol.for("contexo.vscodeStub.installed");

interface ModuleInternals {
  _resolveFilename(request: string, ...rest: unknown[]): string;
  [INSTALLED]?: true;
}

function cacheStub(): void {
  if (require.cache[STUB_FILENAME]) { return; }
  const stub = new Module(STUB_FILENAME);
  stub.filename = STUB_FILENAME;
  stub.loaded = true;
  stub.exports = vscodeStub;
  require.cache[STUB_FILENAME] = stub;
}

/** Make require('vscode') return vscodeStub in this process. Idempotent; a no-op inside VS Code (Electron). */
export function installVscodeStub(): void {
  const internals = Module as unknown as ModuleInternals;
  if (process.versions.electron !== undefined || internals[INSTALLED]) { return; }
  const resolve = internals._resolveFilename;
  internals._resolveFilename = (request: string, ...rest: unknown[]): string => {
    if (request !== "vscode") { return resolve.call(Module, request, ...rest); }
    cacheStub(); // re-added if a test cleared require.cache
    return STUB_FILENAME;
  };
  internals[INSTALLED] = true;
}

installVscodeStub();
