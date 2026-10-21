---
schema: ctx.page.v1
slug: gitstore
type: entity
author: alice
created: 2026-09-15T09:30:00Z
updated: 2026-09-22T10:10:00Z
parent_sha: ""
related:
  - sync-model
tags:
  - server
  - storage
---
# Gitstore

The server keeps every repository as a bare git repository, and each push is one commit.

- ListPages walks the log to find the last commit that touched each path.
- ReadAtSha serves a page as of a given commit.
