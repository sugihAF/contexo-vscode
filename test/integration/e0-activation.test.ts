// e0 (WP-0.6): activation, the TestApi and the services seam. Never edited by wave 1, and
// true whichever stubs have been replaced: it asserts only activation, registration and
// the override seam, never stub behaviour.
import * as assert from "node:assert/strict";
import * as vscode from "vscode";
import { ALL_COMMAND_IDS } from "../../src/commands/ids";
import type { TestApi } from "../../src/testApi";
import type { Prompts } from "../../src/ui/prompts";
import { contexoExtension, waitForActivation } from "../helpers/activate";
import { FakeCtxCli } from "../helpers/fakeCtxCli";
import { fakeModel } from "../helpers/fakeModel";

/** Every ids.ts command is registered, each exactly once. */
async function assertCommandsRegisteredOnce(): Promise<void> {
  const all = await vscode.commands.getCommands(true);
  for (const id of ALL_COMMAND_IDS) {
    assert.equal(all.filter((c) => c === id).length, 1, `${id} must be registered exactly once`);
  }
}

/** A Prompts that answers nothing and records which methods were called. */
function recordingPrompts(): Prompts & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    info: async () => { calls.push("info"); return undefined; },
    warn: async () => { calls.push("warn"); return undefined; },
    error: async () => { calls.push("error"); return undefined; },
    confirm: async () => { calls.push("confirm"); return false; },
    quickPick: async () => { calls.push("quickPick"); return undefined; },
    inputBox: async () => { calls.push("inputBox"); return undefined; },
    copyToClipboard: async () => { calls.push("copyToClipboard"); },
    openExternal: async () => { calls.push("openExternal"); return false; },
  };
}

describe("e0 activation", () => {
  let api: TestApi | undefined;

  beforeEach(async () => {
    // A wave-1 test that ran first may have left an override in place; the "original"
    // services captured below must be the real ones. exports does not activate.
    await contexoExtension().exports?.hooks.resetServices();
  });

  afterEach(async () => {
    await api?.hooks.resetServices();
  });

  it("activates on workspaceContains:.contexo/config.json and returns TestApi in Test mode", async () => {
    // No activate() call before this point: only the activation event can have activated it.
    api = await waitForActivation();
    const ext = contexoExtension();
    assert.equal(ext.isActive, true);
    assert.equal(ext.exports, api);
    assert.equal(api.services.context.extensionMode, vscode.ExtensionMode.Test);
    for (const hook of ["overrideServices", "resetServices", "setPrompts"] as const) {
      assert.equal(typeof api.hooks[hook], "function", `hooks.${hook}`);
    }
    for (const key of ["context", "log", "config", "cli", "model", "prompts"] as const) {
      assert.ok(api.services[key], `services.${key}`);
    }
  });

  it("hooks.overrideServices({cli: new FakeCtxCli()}) re-wires without a command-already-exists error, services.cli is the fake and every ids.ts command is still registered; resetServices restores the original", async () => {
    api = await waitForActivation();
    const services = api.services;
    const originalCli = services.cli;
    const originalModel = services.model;
    const fake = new FakeCtxCli();

    await api.hooks.overrideServices({ cli: fake });

    assert.equal(api.services, services, "Services stays ONE mutable object");
    assert.equal(services.cli, fake);
    assert.notEqual(services.model, originalModel, "the model is rebuilt over the fake cli");
    await assertCommandsRegisteredOnce();

    await api.hooks.resetServices();

    assert.equal(services.cli, originalCli);
    assert.equal(services.model, originalModel);
    assert.equal(fake.disposed, false, "the seam never disposes a test-supplied cli");
    await assertCommandsRegisteredOnce();
  });

  it("setPrompts swaps services.prompts", async () => {
    api = await waitForActivation();
    const services = api.services;
    const { cli, model } = services;
    const originalPrompts = services.prompts;
    const prompts = recordingPrompts();

    api.hooks.setPrompts(prompts);

    assert.equal(services.prompts, prompts);
    assert.equal(services.cli, cli, "setPrompts does not re-wire");
    assert.equal(services.model, model, "setPrompts does not re-wire");

    await api.hooks.resetServices();
    assert.equal(services.prompts, originalPrompts, "resetServices restores the original prompts");
  });

  it("a model whose initialize() throws synchronously (or returns no promise) cannot break the seam", async () => {
    api = await waitForActivation();
    const services = api.services;
    const originalModel = services.model;
    const throwing = fakeModel();
    (throwing as { initialize: () => Promise<void> }).initialize = () => { throw new Error("initialize bug"); };
    const nonPromise = fakeModel();
    (nonPromise as unknown as { initialize: () => void }).initialize = () => undefined;

    await api.hooks.overrideServices({ model: throwing });
    assert.equal(services.model, throwing);
    await assertCommandsRegisteredOnce();
    await api.hooks.overrideServices({ model: nonPromise });
    await assertCommandsRegisteredOnce();
    await api.hooks.resetServices();
    assert.equal(services.model, originalModel);
    await assertCommandsRegisteredOnce();
  });

  it("override twice then reset never throws and commands stay registered once", async () => {
    api = await waitForActivation();
    const services = api.services;
    const originalCli = services.cli;
    const originalModel = services.model;
    const first = new FakeCtxCli();
    const second = new FakeCtxCli();
    const model = fakeModel();

    await api.hooks.overrideServices({ cli: first });
    await api.hooks.overrideServices({ cli: second });
    assert.equal(services.cli, second);
    await assertCommandsRegisteredOnce();

    await api.hooks.overrideServices({ model });
    assert.equal(services.model, model);
    assert.equal(services.cli, second, "a model-only override keeps the current cli");
    await api.hooks.overrideServices({ model });
    assert.equal(model.initializeCalls, 1, "wire() initializes a model at most once");
    await assertCommandsRegisteredOnce();

    await api.hooks.resetServices();
    await api.hooks.resetServices();

    assert.equal(services.cli, originalCli);
    assert.equal(services.model, originalModel);
    assert.equal(model.disposed, false, "the seam never disposes a test-supplied model");
    assert.equal(first.disposed, false);
    assert.equal(second.disposed, false);
    await assertCommandsRegisteredOnce();
  });
});
