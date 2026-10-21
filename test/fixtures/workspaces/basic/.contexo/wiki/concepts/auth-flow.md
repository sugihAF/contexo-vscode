---
schema: ctx.page.v1
slug: auth-flow
type: concept
author: alice
agent: claude-code
created: 2026-09-18T10:00:00Z
updated: 2026-10-15T08:58:00Z
parent_sha: ""
sources:
  - 2026-10-01-login-debug
related:
  - rate-limits
tags:
  - auth
  - security
reasoning_summary: Short-lived access tokens plus rotating refresh tokens; the dashboard never keeps either in localStorage.
---
# Auth flow

How the CLI and the dashboard obtain and refresh access tokens.

## Tokens
- Access tokens live for 15 minutes.
- Refresh tokens rotate on every use and are revoked when reused.

## Login
`ctx auth login` opens the browser, completes the device flow and stores a personal access token for the project.

## Refresh failures
A 401 from the refresh endpoint clears the cached tokens and sends the user to the login page once, instead of retrying with the same refresh token.
