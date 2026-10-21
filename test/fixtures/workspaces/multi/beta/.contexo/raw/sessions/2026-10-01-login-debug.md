---
schema: ctx.page.v1
slug: 2026-10-01-login-debug
type: source
author: alice
agent: claude-code
created: 2026-10-01T08:12:00Z
updated: 2026-10-01T09:40:00Z
parent_sha: ""
tags:
  - auth
  - debugging
reasoning_summary: Traced the login redirect loop to a refresh token the client kept replaying.
---
# Login debug session

Agent session from 2026-10-01 that chased the login redirect loop on the dashboard.

## What happened
- The refresh endpoint answered 401, and the client retried with the same refresh token.
- After three retries the router sent the user back to /login, which started the loop again.

## Outcome
Clearing the cached tokens on a 401 from the refresh endpoint ends the loop.
