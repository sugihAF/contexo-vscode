// WP-1.8 unit-test fakes for the model's injected VS Code host (no vscode import: the
// EventEmitter and Uri come from the unit-test stub).
import type { ModelHost, WorkspaceFolderLike } from "../../../src/model/model";
import type { Clock, FileEventSource, FocusSource } from "../../../src/model/refreshScheduler";
import type { ModelDeps } from "../../../src/model/types";
import type { ContexoConfig } from "../../../src/services";
import { FakeCtxCli } from "../../helpers/fakeCtxCli";
import { vscodeStub } from "../../helpers/vscodeStub";

export const { Uri, EventEmitter } = vscodeStub;
export type UriT = ReturnType<typeof Uri.file>;

export class FakeWatcher implements FileEventSource {
  readonly create = new EventEmitter<UriT>();
  readonly change = new EventEmitter<UriT>();
  readonly delete = new EventEmitter<UriT>();
  readonly onDidCreate = this.create.event;
  readonly onDidChange = this.change.event;
  readonly onDidDelete = this.delete.event;
  disposed = false;
  constructor(readonly folder: UriT, readonly glob: string, readonly ignoreChangeEvents: boolean) {}
  dispose(): void {
    this.disposed = true;
    this.create.dispose();
    this.change.dispose();
    this.delete.dispose();
  }
}

/** A clock whose timers never fire (state tests do not exercise the scheduler's timing). */
export const frozenClock: Clock = { now: () => 0, setTimeout: () => ({}), clearTimeout: () => undefined };

export class FakeHost implements ModelHost {
  trusted = true;
  folders: WorkspaceFolderLike[] = [];
  /** Existing files, by Uri.toString(). */
  readonly files = new Set<string>();
  readonly watchers: FakeWatcher[] = [];
  readonly trust = new EventEmitter<void>();
  readonly folderChanges = new EventEmitter<{ added: WorkspaceFolderLike[]; removed: WorkspaceFolderLike[] }>();
  readonly focusChanges = new EventEmitter<boolean>();
  focused = true;
  activeUri: UriT | undefined;
  disposed = false;
  clock: Clock = frozenClock;
  readonly platform: NodeJS.Platform;
  readonly focus: FocusSource;
  readonly onDidGrantWorkspaceTrust = this.trust.event;
  readonly onDidChangeWorkspaceFolders = this.folderChanges.event;

  constructor(platform: NodeJS.Platform = "linux") {
    this.platform = platform;
    const read = (): boolean => this.focused;
    this.focus = { get focused(): boolean { return read(); }, onDidChange: this.focusChanges.event };
  }

  isTrusted(): boolean { return this.trusted; }
  workspaceFolders(): readonly WorkspaceFolderLike[] { return this.folders; }
  async isFile(uri: UriT): Promise<boolean> { return this.files.has(uri.toString()); }
  activeEditorUri(): UriT | undefined { return this.activeUri; }
  createWatcher(folder: UriT, glob: string, o?: { ignoreChangeEvents?: boolean }): FileEventSource {
    const w = new FakeWatcher(folder, glob, o?.ignoreChangeEvents === true);
    this.watchers.push(w);
    return w;
  }
  dispose(): void { this.disposed = true; }

  /** Add a workspace folder (no event); withConfig also creates <folder>/.contexo/config.json. */
  addFolder(fsPath: string, o: { withConfig?: boolean; name?: string } = {}): UriT {
    const uri = Uri.file(fsPath);
    this.folders.push({ uri, name: o.name ?? fsPath.split("/").pop() ?? fsPath, index: this.folders.length });
    if (o.withConfig) { this.addConfig(uri); }
    return uri;
  }

  addConfig(folder: UriT): UriT {
    const config = Uri.joinPath(folder, ".contexo", "config.json");
    this.files.add(config.toString());
    return config;
  }

  /** Live watchers on folder with this glob. */
  watchersOf(folder: UriT, glob: string): FakeWatcher[] {
    return this.watchers.filter((w) => !w.disposed && w.folder.toString() === folder.toString() && w.glob === glob);
  }
}

export function fakeConfig(o: Partial<Pick<ContexoConfig, "remoteRefreshEnabled" | "remoteRefreshIntervalSeconds">> = {}): ContexoConfig & { changed: InstanceType<typeof EventEmitter<void>> } {
  const changed = new EventEmitter<void>();
  return {
    path: undefined,
    remoteRefreshEnabled: o.remoteRefreshEnabled ?? true,
    remoteRefreshIntervalSeconds: o.remoteRefreshIntervalSeconds ?? 180,
    scmCountIncoming: false,
    decorationsEnabled: true,
    treeShowSessions: true,
    onDidChange: changed.event,
    changed,
  };
}

export interface LogLine { level: string; message: string }

export function fakeLog(): ModelDeps["log"] & { lines: LogLine[] } {
  const lines: LogLine[] = [];
  const at = (level: string) => (message: string): void => { lines.push({ level, message }); };
  return { lines, trace: at("trace"), debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error") } as unknown as ModelDeps["log"] & { lines: LogLine[] };
}

export function modelDeps(cli: FakeCtxCli, config = fakeConfig()): ModelDeps {
  return {
    context: {} as ModelDeps["context"],
    log: fakeLog(),
    config,
    cli,
    prompts: {} as ModelDeps["prompts"],
  };
}

/** Let pending promise callbacks run. */
export async function flush(times = 5): Promise<void> {
  for (let i = 0; i < times; i++) { await new Promise<void>((resolve) => setImmediate(resolve)); }
}
