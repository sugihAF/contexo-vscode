---
schema: ctx.page.v1
slug: rate-limits
type: concept
author: alice
agent: claude-code
created: 2026-09-20T12:00:00Z
updated: 2026-10-15T09:05:00Z
parent_sha: ""
related:
  - retry-policy
tags:
  - api
  - limits
reasoning_summary: Per-IP limits protect the hosted API; clients back off on 429.
---
# Rate limits

The hosted API allows 300 requests per minute per IP address.

## Clients
- Back off exponentially on 429, starting at 1 second.

## Server side
The limiter keys on the client IP; the X-Contexo-Client header only labels the activity feed.
