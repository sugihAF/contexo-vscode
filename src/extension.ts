// Activation and wiring (FROZEN after WP-0.I). wire() is the only place modules are
// registered; TestApi.hooks.overrideServices re-runs it over substituted services.
import * as vscode from "vscode";
import { createCtxCli } from "./cli/ctxCli";
import type { ICtxCli } from "./cli/types";
import { registerCommands } from "./commands/index";
import { registerDecorations } from "./decorations/decorationProvider";
import { registerContexoFs } from "./fs/contexoFs";
import { createModel } from "./model/model";
import type { IModel } from "./model/types";
import { registerScm } from "./scm/scmProvider";
import { createConfig, type Services } from "./services";
import { registerStatusBar } from "./statusBar";
import { createTestApi, type TestApi } from "./testApi";
import { registerKnowledgeTree } from "./tree/knowledgeTree";
import { createPrompts, type Prompts } from "./ui/prompts";
import { registerContextKeys } from "./welcome/contextKeys";

let active: vscode.Disposable | undefined;

const initialized = new WeakSet<IModel>();

/** Register every module over s, then initialize the model (at most once per model instance). */
export function wire(s: Services): vscode.Disposable {
  const subs: vscode.Disposable[] = [];
  try {
    subs.push(registerContexoFs(s));
    subs.push(registerDecorations(s));
    subs.push(registerScm(s));
    subs.push(registerKnowledgeTree(s));
    subs.push(registerStatusBar(s));
    subs.push(registerContextKeys(s));
    subs.push(registerCommands(s));
  } catch (err) {
    vscode.Disposable.from(...subs).dispose();
    throw err;
  }
  const model = s.model;
  if (!initialized.has(model)) {
    initialized.add(model);
    // Started synchronously (before any later swap can dispose the model), but a
    // synchronous throw or a non-promise return can never escape wire() and strand the
    // registrations above.
    const failed = (err: unknown): void => {
      s.log.error(`model initialize failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    };
    try {
      void Promise.resolve(model.initialize()).catch(failed);
    } catch (err) {
      failed(err);
    }
  }
  return vscode.Disposable.from(...subs);
}

/** A Prompts that resolves the current services.prompts on every call (ModelDeps.prompts). */
function livePrompts(current: () => Prompts): Prompts {
  return {
    info: (m, ...a) => current().info(m, ...a),
    warn: (m, ...a) => current().warn(m, ...a),
    error: (m, ...a) => current().error(m, ...a),
    confirm: (m, o) => current().confirm(m, o),
    quickPick: (items, o) => current().quickPick(items, o),
    inputBox: (o) => current().inputBox(o),
    copyToClipboard: (t) => current().copyToClipboard(t),
    openExternal: (u) => current().openExternal(u),
  };
}

export function activate(context: vscode.ExtensionContext): TestApi | undefined {
  const log = vscode.window.createOutputChannel("Contexo", { log: true });
  const config = createConfig();
  const prompts = createPrompts();
  const cli = createCtxCli({ context, log, config });
  let s: Services | undefined;
  const modelPrompts = livePrompts(() => s?.prompts ?? prompts);
  const newModel = (c: ICtxCli): IModel => createModel({ context, log, config, cli: c, prompts: modelPrompts });
  const model = newModel(cli);
  const services: Services = { context, log, config, cli, model, prompts };
  s = services;

  const originals = { cli, model, prompts };
  let seamModel: IModel | undefined; // a model the seam built itself; disposed once replaced
  let wiring: vscode.Disposable | undefined;

  const swap = (nextCli: ICtxCli, nextModel: IModel, builtBySeam: boolean): void => {
    wiring?.dispose();
    wiring = undefined;
    const previous = seamModel;
    services.cli = nextCli;
    services.model = nextModel;
    seamModel = (builtBySeam || nextModel === previous) ? nextModel : undefined;
    if (previous && previous !== nextModel) { previous.dispose(); }
    wiring = wire(services);
  };

  active = new vscode.Disposable(() => {
    wiring?.dispose();
    wiring = undefined;
    seamModel?.dispose();
    seamModel = undefined;
    originals.model.dispose();
    originals.cli.dispose();
  });
  // Registered before the first wire(), so a throwing register* call cannot leak them.
  context.subscriptions.push(active, config, log);
  wiring = wire(services);

  if (context.extensionMode !== vscode.ExtensionMode.Test) {
    return undefined;
  }
  return createTestApi(services, {
    overrideServices: async (o) => {
      if (o.model) {
        swap(o.cli ?? services.cli, o.model, false);
      } else if (o.cli) {
        swap(o.cli, newModel(o.cli), true);
      } else {
        swap(services.cli, services.model, false);
      }
    },
    resetServices: async () => {
      services.prompts = originals.prompts;
      swap(originals.cli, originals.model, false);
    },
    setPrompts: (p) => {
      services.prompts = p;
    },
  });
}

export function deactivate(): void {
  active?.dispose();
  active = undefined;
}
