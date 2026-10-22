// Two-user scenarios S1-S7 in the Extension Host (WP-3.1): alice is this workspace, bob is
// driven through CTX_BIN with HOME=home-bob, the agent path through `ctx mcp`.
import * as assert from "node:assert/strict";
import { activateExtension } from "../helpers/activate";
import { realCtxEnv } from "./env";
import { waitFor } from "./waitFor";

describe("real-ctx scenarios (WP-3.1)", function () {
  this.timeout(120000);

  it("the extension runs CTX_BIN (skeleton)", async () => {
    const e = realCtxEnv();
    const api = await activateExtension();
    const binary = await waitFor(async () => {
      const b = await api.services.cli.getBinary();
      return b.kind === "ok" ? b : undefined;
    }, { timeoutMs: 30000, message: "ctx handshake ok" });
    assert.equal(binary.path, e.ctxBin);
  });
});
