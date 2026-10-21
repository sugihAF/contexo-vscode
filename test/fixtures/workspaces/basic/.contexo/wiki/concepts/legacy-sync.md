---
schema: ctx.page.v1
slug: legacy-sync
type: concept
author: alice
agent: claude-code
created: 2026-09-25T09:00:00Z
updated: 2026-10-12T16:40:00Z
parent_sha: ""
related:
  - sync-model
tags:
  - sync
  - migration
reasoning_summary: Old ctx and MCP binaries move page_shas without writing a base; the next online status repairs the base.
---
# Legacy sync

Notes on pages last synced by a ctx or MCP server older than the bases.json layout.

Such pages show as unverified until an online status, pull or push confirms the base against the server.
