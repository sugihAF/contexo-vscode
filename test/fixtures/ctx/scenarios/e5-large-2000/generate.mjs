#!/usr/bin/env node
// Regenerates status.json: a deterministic 2,000-page ctx.status.v1 document for WP-1.11's
// tree performance test (buildTree under 200 ms). Run from anywhere:
//   node test/fixtures/ctx/scenarios/e5-large-2000/generate.mjs
// Types cycle concept/entity/analysis/source/decision (decision -> Other) and states cycle
// through all nine, so every tree group and both unlisted states (incoming_new,
// deleted_local) appear. Pages are sorted by path; counts are derived from the pages.
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const N = 2000;
const TYPES = [
  { type: "concept", dir: "wiki/concepts", word: "Concept" },
  { type: "entity", dir: "wiki/entities", word: "Entity" },
  { type: "analysis", dir: "wiki/analyses", word: "Analysis" },
  { type: "source", dir: "raw/sessions", word: "Session" },
  { type: "decision", dir: "wiki/decisions", word: "Decision" },
];
const STATES = ["unchanged", "modified", "new", "incoming", "conflict", "unverified", "invalid", "incoming_new", "deleted_local"];

const sha = (i, salt) => ((i * 2654435761 + salt * 40503) >>> 0).toString(16).padStart(8, "0").repeat(5);

const pages = [];
for (let i = 0; i < N; i++) {
  const t = TYPES[i % TYPES.length];
  const state = STATES[Math.floor(i / TYPES.length) % STATES.length];
  const n = String(i).padStart(4, "0");
  const slug = `${t.type}-${n}`;
  const path = `${t.dir}/${slug}.md`;
  const p = { path, state };
  if (state === "conflict") { p.conflict_kind = "both_modified"; }
  const hasLocal = state !== "incoming_new" && state !== "deleted_local";
  if (hasLocal && state !== "invalid") {
    Object.assign(p, { type: t.type, slug, title: `${t.word} ${n}`, tags: [`tag-${i % 7}`, `group-${i % 3}`], author: "alice" });
  } else {
    p.tags = [];
  }
  if (hasLocal) { p.local = { file: path }; }
  if (state !== "new" && state !== "incoming_new") { p.base = { sha: sha(i, 1), stale: state === "unverified" }; }
  if (state !== "new" && state !== "unverified" && state !== "deleted_local") {
    p.remote = { sha: state === "incoming" || state === "conflict" || state === "incoming_new" ? sha(i, 2) : sha(i, 1) };
  }
  if (state === "invalid") { p.invalid = { stage: "parse", message: `page: parse frontmatter: yaml: line ${i % 40 + 2}: did not find expected key` }; }
  p.notes = [];
  pages.push(p);
}
pages.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

const counts = Object.fromEntries(STATES.map((s) => [s, pages.filter((p) => p.state === s).length]));
const doc = {
  schema: "ctx.status.v1",
  generated_at: "2026-10-22T09:00:00Z",
  offline: false,
  root: "/fixture-root",
  contexo_dir: "/fixture-root/.contexo",
  project: { repo_id: "fixture-large", dashboard_url: "" },
  server: { url: "http://127.0.0.1:9", url_source: "config", version: "0.7.0", capabilities_known: true, capabilities: ["pages.at", "push.expect_absent", "write.path_sha"] },
  auth: { state: "authenticated", credentials_source: "project", token_kind: "pat" },
  remote: { source: "live", fetched_at: "2026-10-22T09:00:00Z", repo_exists: true, head: sha(N, 3), page_count: pages.filter((p) => p.remote).length },
  counts: {
    unchanged: counts.unchanged, modified: counts.modified, new: counts.new, incoming: counts.incoming,
    incoming_new: counts.incoming_new, conflict: counts.conflict, deleted_local: counts.deleted_local,
    invalid: counts.invalid, unverified: counts.unverified,
    ahead: counts.modified + counts.new, behind: counts.incoming + counts.incoming_new,
  },
  pages: [],
  captures: { pending: 3, fresh: 0, blocks_push: false, sessions: [] },
  warnings: [],
};

// Header pretty-printed, one page per line (readable diffs, ~half the size of full indent).
const head = JSON.stringify(doc, null, 2).replace('"pages": []', '"pages": [\n    PAGES\n  ]');
const body = head.replace("PAGES", pages.map((p) => JSON.stringify(p)).join(",\n    "));
writeFileSync(join(dirname(fileURLToPath(import.meta.url)), "status.json"), `${body}\n`);
console.log(`e5-large-2000: ${pages.length} pages`, doc.counts);
