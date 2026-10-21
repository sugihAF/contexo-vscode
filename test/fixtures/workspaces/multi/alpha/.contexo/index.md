# Knowledge Index

Always-loaded index for this project's Contexo knowledge base. Find what's relevant here, then read individual pages on demand.

## Concepts
- [Auth Flow](wiki/concepts/auth-flow.md) — Short-lived access tokens plus rotating refresh tokens; the dashboard never keeps either in localStorage. | tags: auth,security | alice 2026-10-15
- [Legacy Sync](wiki/concepts/legacy-sync.md) — Old ctx and MCP binaries move page_shas without writing a base; the next online status repairs the base. | tags: sync,migration | alice 2026-10-12
- [Rate Limits](wiki/concepts/rate-limits.md) — Per-IP limits protect the hosted API; clients back off on 429. | tags: api,limits | alice 2026-10-15
- [Retry Policy](wiki/concepts/retry-policy.md) — Retry idempotent calls only, with jittered backoff and a ceiling. | tags: api,retries | alice 2026-10-05

## Entities
- [Gitstore](wiki/entities/gitstore.md) — The server keeps every repository as a bare git repository, and each push is one commit. | tags: server,storage | alice 2026-09-22

## Analyses
- [Sync Model](wiki/analyses/sync-model.md) — A three-way comparison (base, local, server) is the only way to tell a local edit from an incoming change. | tags: sync,architecture | alice 2026-10-15

## Sources
- [2026 10 01 Login Debug](raw/sessions/2026-10-01-login-debug.md) — Traced the login redirect loop to a refresh token the client kept replaying. | tags: auth,debugging | alice 2026-10-01

