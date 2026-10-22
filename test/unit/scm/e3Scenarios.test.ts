// The WP-1.9 fake-ctx scenarios (test/fixtures/ctx/scenarios/e3-*): each is 'mixed' with
// one documented difference, validates against the status schema (Ajv2020 configured like
// test/unit/contract/fixtures.test.ts), keeps its counts consistent with its pages, and
// answers status --offline and every show exactly like 'mixed'. Plain mocha.
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import Ajv2020 from "ajv/dist/2020";
import type { ValidateFunction } from "ajv";
import { PAGE_STATES, type PageEntry, type PageState, type StatusDoc } from "../../../src/contract/types";
import { REPO_ROOT, loadScenario, loadStatusDoc, scenarioOutput } from "../../helpers/fixtures";

const E3_SCENARIOS = ["e3-retry-conflict", "e3-blocks-push"] as const;
const RETRY_POLICY = "wiki/concepts/retry-policy.md";

let statusValidator: ValidateFunction | undefined;
/** The status schema, compiled with the same options as contract/validate.mjs. */
function validateStatus(doc: unknown): string[] {
  if (!statusValidator) {
    const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
    const schema = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "contract", "schemas", "status.schema.json"), "utf8")) as Record<string, unknown>;
    statusValidator = ajv.compile(schema);
  }
  return statusValidator(doc) ? [] : (statusValidator.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message ?? ""}`);
}

function tally(pages: readonly PageEntry[]): Record<PageState, number> {
  const t = Object.fromEntries(PAGE_STATES.map((s) => [s, 0])) as Record<PageState, number>;
  for (const p of pages) { t[p.state] += 1; }
  return t;
}

/** doc without the given top-level keys. */
function without(doc: StatusDoc, ...keys: (keyof StatusDoc)[]): Partial<StatusDoc> {
  const d: Partial<StatusDoc> = structuredClone(doc);
  for (const k of keys) { delete d[k]; }
  return d;
}

describe("scm e3 scenarios", () => {
  for (const name of E3_SCENARIOS) {
    it(`${name}: validates against status.schema.json; the per-state tally equals counts; ahead/behind sums hold`, () => {
      const doc = loadStatusDoc(name);
      assert.deepEqual(validateStatus(doc), [], `${name} must validate against ctx.status.v1`);
      const t = tally(doc.pages);
      for (const s of PAGE_STATES) { assert.equal(t[s], doc.counts[s], `${name}: tally ${s}`); }
      assert.equal(doc.counts.ahead, doc.counts.modified + doc.counts.new, `${name}: ahead`);
      assert.equal(doc.counts.behind, doc.counts.incoming + doc.counts.incoming_new, `${name}: behind`);
    });

    it(`${name}: status --offline and every show answer exactly like mixed`, () => {
      assert.deepEqual(loadStatusDoc(name, { offline: true }), loadStatusDoc("mixed", { offline: true }));
      const shows = loadScenario("mixed").rules.filter((r) => r.match[0] === "show");
      assert.equal(shows.length, 8);
      const argvs = [
        ...shows.map((r) => [...r.match, "--root", "/fixture-root"]),
        ["show", "wiki/entities/gitstore.md", "--at", "base", "--root", "/fixture-root"],
        ["show", "wiki/entities/billing.md", "--at", "server", "--root", "/fixture-root"],
      ];
      for (const argv of argvs) {
        assert.deepEqual(scenarioOutput(name, argv), scenarioOutput("mixed", argv), `${name}: ${argv.join(" ")}`);
      }
    });
  }

  it("e3-retry-conflict: retry-policy is a both_modified conflict with a new local hash; every other page is identical to mixed", () => {
    const mixed = loadStatusDoc("mixed");
    const doc = loadStatusDoc("e3-retry-conflict");
    assert.deepEqual(doc.pages.map((p) => p.path), mixed.pages.map((p) => p.path), "same pages, same order");
    for (const [i, p] of doc.pages.entries()) {
      if (p.path !== RETRY_POLICY) { assert.deepEqual(p, mixed.pages[i], p.path); }
    }

    const was = mixed.pages.find((p) => p.path === RETRY_POLICY);
    const now = doc.pages.find((p) => p.path === RETRY_POLICY);
    assert.ok(was && now);
    assert.equal(now.state, "conflict");
    assert.equal(now.conflict_kind, "both_modified");
    assert.deepEqual(Object.keys(now).slice(0, 3), ["path", "state", "conflict_kind"], "conflict_kind right after state");
    assert.match(now.local?.hash ?? "", /^sha256:[0-9a-f]{64}$/);
    assert.notEqual(now.local?.hash, was.local?.hash, "changed locally");
    assert.notEqual(now.local?.hash, now.base?.hash, "local differs from base");
    const { state: _s, conflict_kind: _k, local: _l, ...rest } = now;
    const { state: _ws, local: _wl, ...wasRest } = was;
    assert.deepEqual(rest, wasRest, "everything else unchanged");
    assert.deepEqual({ ...now.local, hash: "" }, { ...was.local, hash: "" });

    assert.deepEqual(doc.counts, { ...mixed.counts, incoming: 0, conflict: 2, behind: 1 });
    assert.deepEqual(without(doc, "pages", "counts"), without(mixed, "pages", "counts"));
  });

  it("e3-blocks-push: captures.blocks_push with one fresh session; pages identical to mixed", () => {
    const mixed = loadStatusDoc("mixed");
    const doc = loadStatusDoc("e3-blocks-push");
    assert.equal(doc.captures.blocks_push, true);
    assert.equal(doc.captures.fresh, 1);
    assert.equal(doc.captures.pending, 2);
    assert.deepEqual(doc.captures.sessions, [
      { ...mixed.captures.sessions[0], updated_at: "2026-10-15T09:20:00Z", fresh: true },
      mixed.captures.sessions[1],
    ]);
    assert.equal(doc.captures.sessions.filter((s) => s.fresh).length, doc.captures.fresh);
    assert.deepEqual(doc.pages, mixed.pages);
    assert.deepEqual(without(doc, "captures"), without(mixed, "captures"));
  });
});
