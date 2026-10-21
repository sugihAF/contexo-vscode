---
schema: ctx.page.v1
slug: rate-limits
type: concept
author: bob
agent: cursor
created: 2026-09-20T12:00:00Z
updated: 2026-10-14T17:28:00Z
parent_sha: ""
related:
  - retry-policy
tags:
  - api
  - limits
reasoning_summary: Per-IP limits protect the hosted API; clients back off on 429.
---
# Rate limits

The hosted API allows 300 requests per minute per IP address, with bursts capped at 50 requests per second.

## Clients
- Back off exponentially on 429, starting at 1 second.
- Honour the Retry-After header when the server sends one.
