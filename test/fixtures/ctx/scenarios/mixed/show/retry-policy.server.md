---
schema: ctx.page.v1
slug: retry-policy
type: concept
author: bob
agent: cursor
created: 2026-09-28T10:00:00Z
updated: 2026-10-15T07:50:00Z
parent_sha: ""
related:
  - rate-limits
tags:
  - api
  - retries
reasoning_summary: Retry idempotent calls only, with jittered backoff and a ceiling.
---
# Retry policy

Which client calls are retried, and how.

- Retry only idempotent requests (GET, and PUT with an expected sha).
- Use exponential backoff with full jitter, capped at 10 seconds.
- Give up after 5 attempts and surface the error.
