---
schema: ctx.page.v1
slug: sync-model
type: analysis
author: alice
agent: claude-code
created: 2026-10-14T15:30:00Z
updated: 2026-10-15T08:40:00Z
parent_sha: ""
sources:
  - 2026-10-01-login-debug
related:
  - auth-flow
  - retry-policy
tags:
  - sync
  - architecture
reasoning_summary: A three-way comparison (base, local, server) is the only way to tell a local edit from an incoming change.
---
# Sync model

Why ctx keeps a base copy of every page next to the working file and the server version.

## Three sides
- **Base**: the bytes ctx last synced (pushed or pulled).
- **Local**: the working file under .contexo/.
- **Server**: the last commit that touched the path.

Local differs from base: a local edit. Server sha differs from base sha: an incoming change. Both at once: a conflict.
