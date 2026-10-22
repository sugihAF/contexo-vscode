// Real ctx conformance (WP-3.1), plain node mocha: real ctx success documents and live smoke
// envelopes validated against contract/schemas and parsed by src/contract/types.ts.
import * as assert from "node:assert/strict";
import { parseDoc, type VersionDoc } from "../../src/contract/types";
import { runCtx } from "./ctx";
import { realCtxEnv } from "./env";

describe("real ctx conformance (WP-3.1)", function () {
  this.timeout(120000);

  it("version --json (skeleton)", async () => {
    const e = realCtxEnv();
    const r = await runCtx(e.homeAlice, ["version", "--json"]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(parseDoc<VersionDoc>(r.stdout, "ctx.version.v1").contract_version, 1);
  });
});
