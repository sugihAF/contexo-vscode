#!/usr/bin/env node
// Regenerates status.json: the 'mixed' StatusDoc (online) with its pages replaced by 151
// modified concept pages (PUSH_PATHS_MAX + 1), for WP-2.3's e8-wiring test 'a 151-path push
// passes no paths'. Deterministic; counts are derived from the pages. Run from anywhere:
//   node test/fixtures/ctx/scenarios/e8-push-151/generate.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const N = 151;
const sha = (i, salt) => ((i * 2654435761 + salt * 40503) >>> 0).toString(16).padStart(8, "0").repeat(5);
const hash = (i, salt) => `sha256:${sha(i, salt).repeat(2).slice(0, 64)}`;

const doc = JSON.parse(readFileSync(join(HERE, "..", "mixed", "status.json"), "utf8"));
const pages = [];
for (let i = 0; i < N; i++) {
  const slug = `bulk-${String(i).padStart(3, "0")}`;
  const path = `wiki/concepts/${slug}.md`;
  pages.push({
    path,
    state: "modified",
    type: "concept",
    slug,
    title: `Bulk page ${i}`,
    tags: [],
    author: "alice",
    updated: "2026-10-01T09:40:00Z",
    local: { file: path, hash: hash(i, 1) },
    base: { sha: sha(i, 2), hash: hash(i, 3), synced_at: "2026-10-01T09:45:13Z", stale: false },
    remote: { sha: sha(i, 2), author: "Alice Tan", email: "alice@example.com", time: "2026-10-01T09:45:12Z", message: "ctx push (1 pages)" },
    notes: [],
  });
}
const counts = { unchanged: 0, modified: N, new: 0, incoming: 0, incoming_new: 0, conflict: 0, deleted_local: 0, invalid: 0, unverified: 0, ahead: N, behind: 0 };
const out = { ...doc, counts, pages, captures: { ...doc.captures, pending: 0, fresh: 0, blocks_push: false, sessions: [] }, warnings: [] };
writeFileSync(join(HERE, "status.json"), `${JSON.stringify(out, null, 2)}\n`);
console.log(`wrote ${N} modified pages to ${join(HERE, "status.json")}`);
