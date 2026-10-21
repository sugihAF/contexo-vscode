# ctx JSON contract, version 1 (errata applied)

Source: contexo-vscode-mvp-contract.md sha256 86043118d56a3828857b4431f5a9c985226b4e3834e0452967191a835f849850
Errata: contexo-vscode-extension-mvp-plan.md ## Contract errata E1-E41, sha256 c159a3b6e663f5e0237b6d8789ba1dcb6d400b1c543a953e13956cbfd2b8aaa8

This is the binding interface between the `ctx` CLI (Contexo core) and this VS Code extension. It transcribes the contract page with all 41 Contract errata applied. Where they differ, the errata win (E1). Inline markers such as (E25) name the erratum behind a rule. A rule with no marker comes unchanged from the contract page.

Precedence for every contract matter (E1): the errata come first, then the contract page, then the WP sections of the plan. Contract matters are wire JSON shapes and key order, field names, error codes, exit numbers, capability names, page states, SCM and tree presentation rules, the on-disk layout under `.contexo/.sync` and the frozen Go/TS identifiers.

This file ships in the repository and not in the VSIX (`.vscodeignore` excludes `contract/**`). Its machine-readable siblings are:

| File | Role |
|---|---|
| `src/contract/types.ts` | The TypeScript mirror of Go `internal/syncops/contract` (E3, E34). It imports nothing. |
| `contract/schemas/{version,status,push,pull,resolve,error}.schema.json` | JSON Schema 2020-12 for the 5 stdout documents and the stderr envelope (section 11.2). |
| `contract/validate.mjs` | Validator CLI over those schemas (section 11.3). |

Contents:
1. Scope and principles
2. Invocation (extension side)
3. Output conventions (ctx side)
4. Commands: version, status, show, pull, push, resolve (+ ctx-only repair)
5. Page states
6. Errors: envelope, exit codes, stable codes
7. Capabilities
8. Discovery, handshake and trust
9. Enumerations
10. ctx-side state (informational)
11. Fixtures, schemas, validator and fake ctx
12. Contract evolution
Appendix A: where each erratum applies

---

## 1. Scope and principles

The contract covers six invocations plus one stderr error envelope:
- `ctx version --json`
- `ctx status --json [--offline]`
- `ctx show <relpath> --at base|server|<sha>`
- `ctx pull --json`
- `ctx push --json [-m] [paths...]`
- `ctx resolve <relpath> --ours|--theirs --json`

Principles (D1):
- The extension spawns ctx and reads JSON. It never reads `credentials.json`, `config.json` or `.contexo/.sync/*`.
- It never parses page YAML and never computes a page state. It only maps the `state` field to UI.
- It never writes under `.contexo/`. Only the user edits page files in the editor.
- Every state rule lives in Go. `contract.Classify` (package `internal/syncops/contract`, standard library only, E3) is the one decision function. The package `internal/syncops` is the one engine, and the CLI and the MCP tools both use it (D2, E4).
- The TS mirror lives at `src/contract/types.ts`, next to `contract/schemas/*.schema.json` and this file. It is not at `src/ctx/contract.ts` (E34).

## 2. Invocation (extension side, normative)

### 2.1 Spawn and environment (E26)

```
child_process.spawn(ctxPath, args, {
  shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, NO_COLOR: '1', CONTEXO_NO_UPDATE_CHECK: '1',
         CONTEXO_CLIENT: 'contexo-vscode/<extension version>' }   // CONTEXO_DISTILL_DISABLE deleted from the copy
})
```

- `shell: true` is banned everywhere.
- `CONTEXO_DISTILL_DISABLE` is deleted from the copied env. An inherited `=1` would otherwise silently bypass the distill guard for every extension push. The fake ctx records the env, and WP-2.3 asserts that the variable is absent.
- The extension never passes `--no-distill`.

### 2.2 Exact argv per command (E25)

R is the absolute workspace-folder fsPath. P is a contract path, which never starts with `-`.

| Command | argv |
|---|---|
| version | `['version','--json']` (no `--root`) |
| status | `['status','--json','--root',R]`, plus `'--offline'` when offline |
| show | `['show',P,'--at','base'\|'server'\|<sha>,'--root',R]` (no `--json`) |
| pull | `['pull','--json','--root',R]` |
| push | `['push','--json','--yes','--root',R]`, plus `['-m',M]` when M is non-empty, plus `['--',...paths]` (paths omitted when there are more than 150) |
| resolve | `['resolve',P,'--ours'\|'--theirs','--json','--root',R]`, plus `['--if-server-sha',S]` |
| old-ctx probe (section 8.2) | `['version','--short']` |

- Every other command passes `--root`. `GetRootDir` does not walk up from the cwd.
- ctx accepts `--yes` as a no-op in `--json` mode.
- WP-2.3 must not change these argv.
- The show ref `'empty'` is client-side only: it is the empty left side of a diff for a new page and is never passed to `ctx show`.

### 2.3 Process rules

- stdin is ignored. In `--json` mode ctx never prompts.
- One ctx process per workspace folder per call.
- push, pull and resolve are serialized per folder by the extension's operation queue. status may overlap them: ctx's lock keeps that safe, and status never waits on the lock (E5).
- Timeouts:

  | Command | Timeout |
  |---|---|
  | version | 5 s |
  | status --offline | 10 s |
  | status | 30 s |
  | show | 30 s |
  | push, pull, resolve | 120 s |

  At the limit the extension sends SIGTERM, then SIGKILL 2 s later. ctx survives being killed mid-operation (atomic writes plus stale-lock recovery).
- The extension never spawns ctx in an untrusted workspace (section 8.4) and never calls `ctx repair` (E18).

### 2.4 Unsaved editors (E27)

ctx sees only bytes on disk. Before push, pushSelected, pull or `resolve --theirs`, the extension collects the dirty `workspace.textDocuments` under `<root>/.contexo/`:
- push and pull: if any exist, show the modal '<N> unsaved Contexo page(s)' with [Save All and Continue] (save each file, then run) and Cancel.
- `resolve --theirs`: refuse when the target is dirty ('Save or revert <file> first').
- `resolve --ours` and status need no check.

WP-1.13 owns this rule.

### 2.5 Refresh cadence (E13, E28)

- `status --json --offline` runs on debounced file events. The watcher excludes `.sync/**`, `raw/sessions/_pending/**`, `index.md` and `tags.md`.
- The watcher may observe `.contexo/config.json` and `.contexo/credentials.json` through the glob `.contexo/*.json`: events only, contents are never read (E28). A change triggers an online status refresh (after login, init or set-repo). The ESLint ban on the `credentials.json` literal in `src/**` stays.
- `status --json` (online) runs on activation, on window focus, on manual Refresh, every `contexo.remoteRefresh.intervalSeconds` (default 180, minimum 60) while focused, and after every push, pull and resolve.
- Each online status makes exactly one full `GET /v1/repos/:id/pages`. v1 has no ETag, If-None-Match or 304 (E13).

### 2.6 Client attribution (E15)

ctx sends `X-Contexo-Client` on every request through the single `sync.Client` `do()` helper, including `ServerDistill`. The value is env `CONTEXO_CLIENT` if set, else `SetClientName` (MCP: the agent name, else `ctx-mcp`), else `ctx-cli`. The server records it on push and pull activity.

### 2.7 Test-mode injection (E33)

When `context.extensionMode === ExtensionMode.Test` and env `CONTEXO_TEST_CTX` is set, it holds JSON `{command, prefixArgs[, env]}`. The extension then spawns `command` with `[...prefixArgs, ...args]` and merges `env` into the spawn env. It is honoured on every OS and never outside Test mode. Section 11.4 describes the fake ctx it points at.

## 3. Output conventions (normative for ctx)

- stdout carries exactly one JSON document, written by `contract.WriteDoc`: 2-space indent, `SetEscapeHTML(false)`, a trailing newline, keys in Go struct field order.
- On success stderr is EMPTY.
- On failure, the LAST non-empty stderr line is the one-line error envelope, written by `contract.WriteEnvelope`.
- In `--json` mode nothing else is printed: no spinner, no update nudge, no `warning:` lines. Warnings go into the document's `warnings` array.
- The only case with both a stdout document and an envelope is `ctx push` with conflicts (exit 6).
- `ctx show` has a hidden `--json` flag that defaults to true, so show is always in machine mode: raw bytes on success, the envelope on failure. `internal/ui/mode.go` is not edited (E20).

Field rules:
- Keys are snake_case.
- Arrays are always present and never `null`.
- Optional scalars and objects are omitted when unknown or not applicable, never `null`. The one exception is `project.dashboard_url`, which is always present and may be `""` (E23).
- Times are UTC RFC 3339 in whole seconds, e.g. `2026-11-03T09:14:07Z`, matching `^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$`. Every engine builds them only through `contract.TimeOf(t)` / `contract.TimePtr(t)` (= `t.UTC().Truncate(time.Second)`) (E16).
- SHAs are full 40-hex lowercase (`^[0-9a-f]{40}$`). The CLI's shortSHA is never used in JSON.
- Document paths are `/`-separated and relative to `<root>/.contexo/`. Only `root` and `contexo_dir` are absolute native paths.
- Hashes are `sha256:<64 hex>` of `Normalize(bytes)`, or `raw-sha256:<64 hex>` of the raw bytes when they do not normalize (E6).
- Callers must ignore unknown fields.

## 4. Commands

### 4.1 `ctx version --json`

**Purpose:** the handshake. It identifies the binary and gates on `contract_version` and capabilities before any other call. It needs no project and no network.

**Behavior:**
- It is offline and idempotent, and writes nothing. `--root` is accepted but not needed.
- `contract_version` is the integer major version (1).
- `capabilities` lists the capabilities this build registered through `registerCapability`. They are ordered by `contract.Capabilities` and then `OptionalCapabilities` (`repair`), never alphabetically (E19).
  - A v0.7.0 release advertises all 11 plus `repair`.
  - A wave-0 build advertises only `errors.envelope`.
  - `registerCapability` panics on an unknown name or a duplicate, so the list has no duplicates.
- `dev_build` is true when version is `"dev"` (go install builds). Callers gate on capabilities only, never on semver.
- `--json` switches on machine mode. `--short` keeps its exact one-line output.
- An old ctx fails with `unknown flag: --json` and exit 1, in plain text (v0.6.6 prints `✖ unknown flag: --json`). The extension then runs `ctx version --short` to name the old version in its 'update ctx' message.

**VersionDoc** (`ctx.version.v1`). Every field is required.

| Field | Type | Notes |
|---|---|---|
| schema | `"ctx.version.v1"` | |
| contract_version | integer >= 1 | Contract major. A value > 1 is still a valid document (E32). |
| version | string | `"0.7.0"`, `"0.7.0-rc.1"` or `"dev"` |
| commit | string | |
| date | string | |
| dev_build | boolean | |
| os | string | |
| arch | string | |
| capabilities | string[] | Contract order (E19). Unknown future capabilities are allowed (TS `string[]`). |

Example (release build, E31(g)):

```json
{
  "schema": "ctx.version.v1",
  "contract_version": 1,
  "version": "0.7.0",
  "commit": "9f3c2ab",
  "date": "2026-11-02",
  "dev_build": false,
  "os": "darwin",
  "arch": "arm64",
  "capabilities": [
    "status.json",
    "status.offline",
    "show.base",
    "show.server",
    "show.sha",
    "pull.json",
    "push.json",
    "push.paths",
    "push.distill_guard",
    "resolve",
    "errors.envelope",
    "repair"
  ]
}
```

### 4.2 `ctx status --json [--offline] --root <dir>`

`--no-drift` becomes a hidden alias of `--offline`.

**Purpose:** per-page 3-way state (base, local, remote), invalid files, pending captures, and repo, server and auth info. It drives the knowledge tree, the SCM groups, decorations, the status bar (`counts.ahead`/`behind` + `auth.state`) and the welcome views.

**Behavior:** status FAILS ONLY WITH not_initialized, usage or internal.
- not_initialized (exit 5) means `<root>/.contexo` is missing.
- Remote problems never fail status. They go into `remote.error` with exit 0, so the tree always renders.

`--offline`:
- No network, no lock, no writes.
- `remote.source` is `none`. The remote side R(P) comes only from conflict sidecars (E9, section 5.3).
- `auth.state` is `unchecked` or `not_authenticated`.

ONLINE, when the remote cannot be used (E22): status behaves like `--offline` (`remote.source` none; sidecars may supply R). It sets `remote.error` to the FIRST of these that applies:

| Condition | remote.error | Other effect | Advice |
|---|---|---|---|
| no credentials, or an empty token | not_authenticated | `auth.state` not_authenticated | `["ctx auth login"]` |
| global credentials without server_url | server_unresolved | | `["ctx auth login --server <url>"]` |
| no repo_id | repo_not_configured | | `["ctx remote set-repo <id>"]` |

ONLINE, otherwise:
- It makes ONE request: a full `GET /v1/repos/:id/pages`, with no If-None-Match (E13).
- It records the server version and capabilities from the response headers through `sync.Client.ServerInfo()`. It never calls `/health` (E13).
- A 404 'repo not found' sets `remote.repo_exists=false`, and every path counts as absent remotely.
- A 401 sets `auth.state=rejected`.
- Any other failure of the listing goes into `remote.error` (for example network, retryable). status then continues with no live listing: `remote.source` none and R from sidecars (E9, E31(b)). `offline` stays false.
- Then EnsureBase runs: ListPages -> `EnsureBase(ctx, env, {Listing: live, Locked: false})` -> classify (E5).
  - EnsureBase TryLocks internally and releases the lock before it returns. When the lock is busy it skips its writes and adds warning `base_repair_skipped`.
  - It repairs stale bases with the E11 decision and the E12 request budget (section 10). The whole EnsureBase is capped at 20 s inside status.
  - Pages it cannot repair stay `unverified`, with warning `base_repair_skipped`.
- Warning `server_outdated` is emitted iff `capabilities_known` is true and any of `pages.at`, `push.expect_absent` or `write.path_sha` is missing (E13).

Server URL rule (D5), reported in `server.url` / `server.url_source`:
1. Load the credentials: the project file first, then the global one.
2. If `creds.server_url` is set, use it (`url_source` credentials).
3. Otherwise, if the credentials came from the project file, use `config.server_url` (`url_source` config).
4. Otherwise (global credentials with no URL), fail with `server_unresolved`. A global token is never sent to a URL taken from the workspace.
5. With no credentials, report `config.server_url` or the default URL (`url_source` config or default) and send nothing.

If `config.server_url` is set and differs from the chosen URL, ctx adds warning `server_url_mismatch`. Scheme and host are compared case-insensitively and a trailing `/` is ignored.

PAGE SET:
- ctx walks every `*.md` under `.contexo` except the root `index.md`/`tags.md` and dot-dirs. Invalid files are REPORTED, not dropped.
- The entries are the union of the working files, the `page_shas` keys and the remote paths, sorted by path in byte order.
- `title` is the first `# ` line of the body. `type`, `slug`, `tags`, `author`, `agent`, `updated` and `reasoning_summary` come from the local frontmatter when it parses.

CAPTURES (E24):
- `pending` = non-archived buffers in `raw/sessions/_pending`.
- `fresh` = pending buffers with at least 1 turn, modified within the 6 h distill window.
- `blocks_push` = `GuardResult.Required && !Bypassed` for the modified ∪ new batch: a fresh session exists and a pushable page is a concept or analysis. It is the same predicate as the push guard, so the extension can swap Push for "Share via your agent" before trying.

OTHER:
- `dashboard_page_url_template` = `<dashboard_url>/repos/<repo_id>/page/{path}`. It is omitted when `dashboard_url` is `""` (E23), and the extension then disables Open in Dashboard.
- status never prints a token.
- A corrupt `state.json` or `bases.json` is treated as empty, with warning `state_unreadable`.

**StatusDoc** (`ctx.status.v1`). "req" means always present: Go fields without omitempty. Optional fields are omitted when not applicable.

| Field | Type | req | Notes |
|---|---|---|---|
| schema | `"ctx.status.v1"` | req | |
| generated_at | time | req | |
| offline | boolean | req | true iff `--offline` was in effect |
| root | string | req | absolute project root, native separators (informational) |
| contexo_dir | string | req | absolute `.contexo` dir, native separators (informational) |
| project | ProjectInfo | req | |
| server | ServerInfo | req | |
| auth | AuthInfo | req | |
| remote | RemoteInfo | req | |
| counts | StateCounts | req | |
| pages | PageEntry[] | req | sorted by path (byte order) |
| captures | CaptureInfo | req | |
| warnings | Warning[] | req | |

ProjectInfo:

| Field | Type | req | Notes |
|---|---|---|---|
| repo_id | string | | |
| config_server_url | string | | |
| dashboard_url | string | req | may be `""` (self-hosted, no dashboard URL configured; E23) |
| dashboard_page_url_template | string | | contains `{path}`; absent when dashboard_url is `""` |
| last_pull_sha | sha | | |

ServerInfo:

| Field | Type | req | Notes |
|---|---|---|---|
| url | string | | the URL chosen by the server URL rule |
| url_source | UrlSource | | credentials \| config \| default |
| version | string | | `X-Contexo-Server-Version` |
| capabilities_known | boolean | req | true once the server answered |
| capabilities | string[] | req | `X-Contexo-Capabilities`; `[]` for an old server or an unknown server |

AuthInfo:

| Field | Type | req | Notes |
|---|---|---|---|
| state | AuthState | req | authenticated \| unchecked \| not_authenticated \| rejected |
| credentials_source | string | | `project` \| `global` |
| token_kind | string | | `pat` \| `session` \| `legacy` \| `invite_key` |
| user_name | string | | |
| user_email | string | | |

AuthState meanings:
- authenticated: the credentials are present and the server accepted them this run.
- unchecked: the credentials are present but the server was not contacted (offline, or a network error).
- not_authenticated: there is no credentials file with a token.
- rejected: the server answered 401.

RemoteInfo:

| Field | Type | req | Notes |
|---|---|---|---|
| source | RemoteSource | req | `live` (fetched during this invocation) \| `none`. `cache` is reserved and never emitted (E8). |
| fetched_at | time | | live only |
| repo_exists | boolean | | false after a 404 'repo not found' |
| head | sha | | |
| page_count | integer | req | |
| error | ErrorBody | | why the remote could not be used (E22) or why the live fetch failed. status still exits 0. |

StateCounts: every field is a required integer.

| Fields | Notes |
|---|---|
| unchanged, modified, new, incoming, incoming_new, conflict, deleted_local, invalid, unverified | per-state counts |
| ahead | modified + new |
| behind | incoming + incoming_new |

PageEntry (one path in the union of working files, base records and server paths):

| Field | Type | req | Notes |
|---|---|---|---|
| path | RelPath | req | |
| state | PageState | req | closed enum (section 5) |
| conflict_kind | ConflictKind | | present iff state == conflict |
| type | string | | `concept` \| `entity` \| `analysis` \| `source` \| other; from valid local frontmatter |
| slug, title | string | | |
| tags | string[] | req | |
| author, agent | string | | |
| updated | time | | |
| reasoning_summary | string | | |
| local | LocalSide | | present iff the working file exists |
| base | BaseSide | | |
| remote | RemoteSide | | from the live listing, or `{sha}` only from a sidecar (E9) |
| invalid | InvalidInfo | | present iff state == invalid |
| notes | string[] | req | NoteCode values (open set) |

LocalSide:

| Field | Type | req | Notes |
|---|---|---|---|
| file | RelPath | req | == path in v1 |
| hash | hash | | absent when the file is invalid |

BaseSide:

| Field | Type | req | Notes |
|---|---|---|---|
| sha | sha | req | the server commit the base corresponds to (== `state.json` `page_shas[path]`) |
| hash | hash | | absent when stale |
| synced_at | time | | absent when stale |
| stale | boolean | req | |

RemoteSide:

| Field | Type | req | Notes |
|---|---|---|---|
| sha | sha | req | last commit that touched the path on the server |
| author | string | | |
| email | string | | |
| time | time | | |
| message | string | | |

InvalidInfo:

| Field | Type | req | Notes |
|---|---|---|---|
| stage | InvalidStage | req | parse \| validate \| path_mismatch |
| message | string | req | |
| expected_path | RelPath | | path_mismatch only |

CaptureInfo:

| Field | Type | req | Notes |
|---|---|---|---|
| pending | integer | req | |
| fresh | integer | req | |
| blocks_push | boolean | req | |
| sessions | CaptureSession[] | req | most recent first |

CaptureSession:

| Field | Type | req |
|---|---|---|
| session_id | string | req |
| turns | integer | req |
| updated_at | time | req |
| fresh | boolean | req |

Warning:

| Field | Type | req | Notes |
|---|---|---|---|
| code | string | req | WarningCode (open set) |
| message | string | req | |
| paths | RelPath[] | req | |

Example: the contract's `status.short.json`, with `pages.etag` removed from `server.capabilities` (E13). It has three pages: conflict, modified and invalid.

```json
{
  "schema": "ctx.status.v1",
  "generated_at": "2026-11-03T09:14:07Z",
  "offline": false,
  "root": "/Users/alice/code/payments",
  "contexo_dir": "/Users/alice/code/payments/.contexo",
  "project": {
    "repo_id": "acme-payments",
    "config_server_url": "https://api.contexo.live",
    "dashboard_url": "https://app.contexo.live",
    "dashboard_page_url_template": "https://app.contexo.live/repos/acme-payments/page/{path}",
    "last_pull_sha": "c41b7e09d2f85a36e1b94c07d5a28f6e3b19c0d4"
  },
  "server": {
    "url": "https://api.contexo.live",
    "url_source": "credentials",
    "version": "0.6.0",
    "capabilities_known": true,
    "capabilities": [
      "pages.at",
      "push.expect_absent",
      "write.path_sha"
    ]
  },
  "auth": {
    "state": "authenticated",
    "credentials_source": "global",
    "token_kind": "pat",
    "user_name": "Alice Tan",
    "user_email": "alice@acme.dev"
  },
  "remote": {
    "source": "live",
    "fetched_at": "2026-11-03T09:14:07Z",
    "repo_exists": true,
    "head": "f0e1d2c3b4a5968778695a4b3c2d1e0f9a8b7c6d",
    "page_count": 3
  },
  "counts": {
    "unchanged": 0,
    "modified": 1,
    "new": 0,
    "incoming": 0,
    "incoming_new": 0,
    "conflict": 1,
    "deleted_local": 0,
    "invalid": 1,
    "unverified": 0,
    "ahead": 1,
    "behind": 0
  },
  "pages": [
    {
      "path": "wiki/concepts/retry-policy.md",
      "state": "conflict",
      "conflict_kind": "both_modified",
      "type": "concept",
      "slug": "retry-policy",
      "title": "Retry policy",
      "tags": [
        "payments",
        "retries"
      ],
      "author": "alice",
      "agent": "claude-code",
      "updated": "2026-11-03T09:10:00Z",
      "local": {
        "file": "wiki/concepts/retry-policy.md",
        "hash": "sha256:9c8b7a6f5e4d3c2b1a09f8e7d6c5b4a39281706f5e4d3c2b1a0f9e8d7c6b5a4f"
      },
      "base": {
        "sha": "2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e",
        "hash": "sha256:1e2d3c4b5a69788796a5b4c3d2e1f0a9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3",
        "synced_at": "2026-10-30T14:22:09Z",
        "stale": false
      },
      "remote": {
        "sha": "f0e1d2c3b4a5968778695a4b3c2d1e0f9a8b7c6d",
        "author": "Bob Lee",
        "email": "bob@acme.dev",
        "time": "2026-11-03T07:55:30Z",
        "message": "Tighten retry ceilings"
      },
      "notes": []
    },
    {
      "path": "wiki/entities/ledger-service.md",
      "state": "modified",
      "type": "entity",
      "slug": "ledger-service",
      "title": "Ledger service",
      "tags": [
        "ledger"
      ],
      "author": "alice",
      "updated": "2026-11-03T09:01:00Z",
      "local": {
        "file": "wiki/entities/ledger-service.md",
        "hash": "sha256:8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f2a1b0c9d8e7f"
      },
      "base": {
        "sha": "3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f",
        "hash": "sha256:6f5e4d3c2b1a0f9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3a2f1e0d9c8b7a6f5e",
        "synced_at": "2026-10-31T11:12:13Z",
        "stale": false
      },
      "remote": {
        "sha": "3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f",
        "author": "Alice Tan",
        "email": "alice@acme.dev",
        "time": "2026-10-31T11:12:10Z",
        "message": "ctx push (2 pages)"
      },
      "notes": []
    },
    {
      "path": "wiki/entities/payment-gateway.md",
      "state": "invalid",
      "tags": [],
      "local": {
        "file": "wiki/entities/payment-gateway.md"
      },
      "base": {
        "sha": "4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f70",
        "hash": "sha256:3b2a1f0e9d8c7b6a5f4e3d2c1b0a9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c3b2a",
        "synced_at": "2026-10-25T15:00:00Z",
        "stale": false
      },
      "remote": {
        "sha": "4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f70",
        "author": "Alice Tan",
        "email": "alice@acme.dev",
        "time": "2026-10-25T14:59:58Z",
        "message": "ctx push (1 pages)"
      },
      "invalid": {
        "stage": "parse",
        "message": "page: parse frontmatter: yaml: line 4: did not find expected key"
      },
      "notes": []
    }
  ],
  "captures": {
    "pending": 1,
    "fresh": 1,
    "blocks_push": false,
    "sessions": [
      {
        "session_id": "5d0c6a3e-1f2b-4c7d-9e8f-0a1b2c3d4e5f",
        "turns": 14,
        "updated_at": "2026-11-03T09:12:40Z",
        "fresh": true
      }
    ]
  },
  "warnings": []
}
```

### 4.3 `ctx show <relpath> --at base|server|<sha> --root <dir>`

**Purpose:** the content source for the extension's read-only `contexo:` FileSystemProvider. It feeds click-to-diff (base->local for Changes, server->local for Incoming and Conflicts) and the gutter quick diff against base.

**Behavior:** show is always in machine mode (E20), so failures print the envelope and the exit table applies.

`<relpath>` validation; a failure gives invalid_path (exit 3):
- `/`-separated, relative to `.contexo`, ending in `.md`
- no empty, `.` or `..` segments
- no segment starting with `-` or `.`
- no control characters

So show can never read `credentials.json` or `.sync/*`.

The `--at` ref:

| --at | How | Failure |
|---|---|---|
| `base` | Offline. Needs a valid base record whose bytes hash to the `bases.json` hash. | otherwise base_unavailable (exit 8) |
| `server` | `GET /v1/repos/:id/pages/<path>` | 404 -> page_not_found (exit 8) |
| `<sha>` (7-64 hex) | `GET .../pages/<path>?at=<sha>`. The response MUST echo `X-Contexo-At` equal to the requested sha. | no or a different echo -> server_unsupported (exit 10, `details.missing=["pages.at"]`): old servers ignore `?at` and return HEAD. A server 404 with code sha_not_found -> sha_not_found (exit 8). |

- The network variants need credentials (not_authenticated, exit 4) and a repo_id (repo_not_configured, exit 5).
- show takes no lock and writes nothing.

**Output:** raw bytes, with no JSON and no extra trailing newline.
- `--at base`: `.contexo/.sync/base/<relpath>` verbatim.
- `--at server` or `<sha>`: `schema.SanitizeContent(server bytes)`, exactly what pull would write.

### 4.4 `ctx pull --json --root <dir>`

`--full` is still accepted; it is a no-op in JSON mode.

**Purpose:** a safe pull. It brings in incoming pages and never overwrites a locally modified, conflicting, invalid or locally deleted page. It lists what it skipped.

PREPARE (E5):
- Take the lock with `Lock(hub, 'pull', DefaultLockWait())`, waiting up to 10 s, else busy (exit 12).
- Require credentials (exit 4) and a repo_id (exit 5).
- ListPages live. If that fails (network, auth_rejected, ...), nothing is written.
- Run `EnsureBase(..., {Listing, Locked: true})`, classify every path, then apply the sidecar overlay (E9).

FETCH:
- `GET /pages/<path>` for incoming and incoming_new pages, and for conflict and unverified pages (only to check for equal content).
- Concurrency is <= 4 (E12). ctx MAY batch the fetch through `/sync/pull` when the results are the same.

Per state:
- incoming and incoming_new:
  - Re-check the working file immediately before writing. For incoming its hash must still equal the base hash; for incoming_new the file must still not exist. Otherwise skip with changed_during_pull.
  - Write `SanitizeContent(bytes)` atomically. base := the same bytes, base sha := `X-Page-SHA` from the fetch.
- conflict (both kinds) and unverified:
  - If `Hash(server) == Hash(local)`, ADOPT: no file write, and the base and sha move forward.
  - Otherwise skip, with reason = the state. A conflict skip writes a sidecar with source `pull` (E10).
- Always skipped, with no sidecar (E10):
  - modified -> modified
  - invalid -> invalid
  - deleted_local -> deleted_local; it is never resurrected (restore it with `resolve --theirs`)
  - paths that collide when case is ignored -> case_collision
  - changed_during_pull

AFTERWARDS:
- `last_pull_sha := head`, always, for old binaries.
- The index regenerates when written > 0 (`reindexed=true`). A failure becomes warning `reindex_failed`.
- Exit 0 even when pages were skipped. pull is idempotent: a second run writes nothing.

**PullDoc** (`ctx.pull.v1`):

| Field | Type | req | Notes |
|---|---|---|---|
| schema | `"ctx.pull.v1"` | req | |
| server_url | string | req | |
| repo_id | string | req | |
| head | sha | | |
| written | PulledPage[] | req | working file and base written; `kind` is always set |
| adopted | PulledPage[] | req | content already identical: base/sha fast-forwarded, file untouched |
| skipped | SkippedPage[] | req | |
| reindexed | boolean | req | |
| warnings | Warning[] | req | |

PulledPage:

| Field | Type | req | Notes |
|---|---|---|---|
| path | RelPath | req | |
| sha | sha | req | |
| kind | WriteKind | | create \| update; written entries only |

SkippedPage (shared with push):

| Field | Type | req | Notes |
|---|---|---|---|
| path | RelPath | req | |
| state | PageState | | the classification at the time; absent for not_found |
| reason | string | req | SkipReason (open set) |
| server_sha | sha | | |

Example: `pull.skipped-and-adopted.json`.

```json
{
  "schema": "ctx.pull.v1",
  "server_url": "https://api.contexo.live",
  "repo_id": "acme-payments",
  "head": "e5f60a1b2c3d4e5f60718293a4b5c6d7e8f90a1b",
  "written": [
    {
      "path": "wiki/analyses/q3-chargebacks.md",
      "sha": "e5f60a1b2c3d4e5f60718293a4b5c6d7e8f90a1b",
      "kind": "create"
    },
    {
      "path": "wiki/concepts/idempotency-keys.md",
      "sha": "e5f60a1b2c3d4e5f60718293a4b5c6d7e8f90a1b",
      "kind": "update"
    }
  ],
  "adopted": [
    {
      "path": "wiki/concepts/ledger-reconciliation.md",
      "sha": "b7c8d9e0f1a2b3c4d5e6f708192a3b4c5d6e7f80"
    }
  ],
  "skipped": [
    {
      "path": "wiki/concepts/retry-policy.md",
      "state": "conflict",
      "reason": "conflict",
      "server_sha": "f0e1d2c3b4a5968778695a4b3c2d1e0f9a8b7c6d"
    },
    {
      "path": "wiki/concepts/webhook-signing.md",
      "state": "conflict",
      "reason": "conflict",
      "server_sha": "6a7b8c9d0e1f2a3b4c5d6e7f8091a2b3c4d5e6f7"
    },
    {
      "path": "wiki/entities/fraud-service.md",
      "state": "deleted_local",
      "reason": "deleted_local",
      "server_sha": "0f1e2d3c4b5a69788796a5b4c3d2e1f0a9b8c7d6"
    },
    {
      "path": "wiki/entities/ledger-service.md",
      "state": "modified",
      "reason": "modified"
    }
  ],
  "reindexed": true,
  "warnings": []
}
```

### 4.5 `ctx push --json [-m <message>] [--dry-run] [--no-distill] --root <dir> [<relpath>...]`

**Purpose:** push only changed pages (all modified and new ones, or only the named paths). Conflicts are reported without clobbering a teammate, and the D4 distill guard is enforced.

MODE: `--json` implies non-interactive: no preview, no prompt, `--yes` implied. The SCM view is the preview.

PREPARE (E5):
- Take the lock (busy, exit 12). Require credentials (exit 4) and a repo_id (exit 5).
- ListPages LIVE first. If that fails, return the error and send nothing.
- `EnsureBase(..., {Listing, Locked: true})` -> Classify -> the sidecar overlay (E9).
- The live listing makes a local new page that already exists remotely classify as conflict both_added.

BATCH:
- No paths: every modified and new page. `skipped` lists only the blocking states (conflict, invalid, deleted_local, unverified).
- With paths: each named path that is modified or new is pushed. Every other named path is skipped with its state and a reason: unchanged, incoming, conflict, invalid, deleted_local, unverified, or not_found (unknown locally and remotely; `state` absent). A named incoming_new path is covered in section 5.8.
- An empty batch exits 0 with `pushed=[]` and sends no request.

DISTILL GUARD (D4, E24):
- `DistillGuard(batch)` is true when the batch contains at least one concept or analysis page AND at least one pending capture buffer has 1 or more turns and was modified within the last 6 h. It is the single predicate shared by MCP `ctx_push` and the CLI.
- `distill = {required: GuardResult.Required, bypassed: GuardResult.Bypassed || --no-distill}`. `GuardResult.Bypassed` is set from env `CONTEXO_DISTILL_DISABLE=1` only.
- push refuses with distill_required (exit 9) iff `required && !bypassed`. It then sends nothing and writes nothing. The envelope details are `{pages, sessions, agent_prompt}`.
- The extension never causes `bypassed`: it never passes `--no-distill` and deletes the env var (E26).

DRY RUN: no push request and no writes at all (E8, E31(h)). `dry_run=true`, `new_head` absent, `pushed` lists `{path, kind}` without `sha`, `conflicts=[]`.

REQUEST (E7): `files[] = {path, content: Normalize(local), parent_sha: base sha or '', expect_absent: true iff there is no base}`. The author comes from the credentials. `message` defaults to `ctx push (N pages)`.

RESPONSE:
- Each pushed page: base := the content sent, and `bases` and `page_shas` := the returned sha (the path's own commit).
- Each conflict:
  - The base stays as it was (NO sha bump).
  - `kind` is both_added when there was no base, otherwise both_modified.
  - A 409 caused by `expect_absent` gives `{path, kind: both_added, server_sha: current_sha}` with `base_sha` omitted (E7).
  - ctx writes a sidecar `{server_sha: current_sha, base_sha: the parent sent (omitted for both_added), kind, source: 'push', content: SanitizeContent(current_content)}` (E10).

EXIT:
- 0 when there are no conflicts.
- 6 when there are conflicts, with BOTH the stdout document and a stderr envelope (code conflict, `details.paths`). Non-conflicting files in the same request were still committed.
- A 402 -> quota_exceeded (exit 11). The first push auto-creates the repo.
- A network failure after sending -> network (exit 7), outcome unknown. The next status shows those pages as conflict, and the next pull adopts them because server content == local content.

HUMAN MODE (no `--json`) keeps the preview and confirm prompt, and gains the distill guard and the changed-only selection.

**PushDoc** (`ctx.push.v1`), present on exit 0 AND on exit 6:

| Field | Type | req | Notes |
|---|---|---|---|
| schema | `"ctx.push.v1"` | req | |
| dry_run | boolean | req | |
| message | string | req | |
| server_url | string | req | |
| repo_id | string | req | |
| new_head | sha | | absent on a dry run or when nothing was sent |
| pushed | PushedPage[] | req | dry run: what would be sent, without sha |
| conflicts | PushConflict[] | req | |
| skipped | SkippedPage[] | req | |
| distill | DistillCheck | req | |
| warnings | Warning[] | req | |

PushedPage:

| Field | Type | req | Notes |
|---|---|---|---|
| path | RelPath | req | |
| kind | WriteKind | req | create \| update |
| sha | sha | | the path's new last-touch commit; absent on a dry run |

PushConflict:

| Field | Type | req | Notes |
|---|---|---|---|
| path | RelPath | req | |
| kind | ConflictKind | req | both_modified \| both_added |
| base_sha | sha | | the parent_sha sent; absent for both_added |
| server_sha | sha | req | |

DistillCheck:

| Field | Type | req | Notes |
|---|---|---|---|
| required | boolean | req | the guard predicate was true for this batch |
| bypassed | boolean | req | `--no-distill` or `CONTEXO_DISTILL_DISABLE=1` (E24) |

Example: `push.partial-conflict.json` (exit 6; its envelope is the third example in section 6.2).

```json
{
  "schema": "ctx.push.v1",
  "dry_run": false,
  "message": "Clarify ledger ownership",
  "server_url": "https://api.contexo.live",
  "repo_id": "acme-payments",
  "new_head": "7a8b9c0d1e2f3a4b5c6d7e8f90a1b2c3d4e5f607",
  "pushed": [
    {
      "path": "raw/sessions/2026-11-02-retry-budget.md",
      "kind": "create",
      "sha": "6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192"
    },
    {
      "path": "wiki/entities/ledger-service.md",
      "kind": "update",
      "sha": "7a8b9c0d1e2f3a4b5c6d7e8f90a1b2c3d4e5f607"
    }
  ],
  "conflicts": [
    {
      "path": "wiki/entities/settlement-batch.md",
      "kind": "both_modified",
      "base_sha": "8192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4",
      "server_sha": "92a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5"
    }
  ],
  "skipped": [
    {
      "path": "wiki/concepts/retry-policy.md",
      "state": "conflict",
      "reason": "conflict",
      "server_sha": "f0e1d2c3b4a5968778695a4b3c2d1e0f9a8b7c6d"
    },
    {
      "path": "wiki/entities/payment-gateway.md",
      "state": "invalid",
      "reason": "invalid"
    }
  ],
  "distill": {
    "required": false,
    "bypassed": false
  },
  "warnings": []
}
```

### 4.6 `ctx resolve <relpath> (--ours|--theirs) --json [--if-server-sha <sha>] --root <dir>`

**Purpose:** the minimal way out of a conflict. `--ours` keeps the local content and re-bases it onto the current server version. `--theirs` replaces the local file with the server version.

PREPARE:
- Exactly one of `--ours` / `--theirs` is required, otherwise usage (exit 3; human mode without `--json` stays rendered text and exit 1, E21). The path is validated like show (invalid_path, exit 3).
- Take the lock. Require credentials and a repo_id. resolve does not call EnsureBase (E5).
- Make ONE request, `GET /pages/<path>`, for the server content and `X-Page-SHA`. A 404 -> page_not_found (exit 8).
- If `--if-server-sha` is given and differs from `X-Page-SHA` -> stale (exit 6, details `{path, expected_sha, server_sha}`). The extension always passes the remote sha it showed in the diff.
- Classify the path against that fresh remote sha, then apply the sidecar overlay (E9).

`--ours`:
- Allowed from conflict (both_modified or both_added), and from unverified with a valid local file.
- base := `SanitizeContent(server bytes)`, base sha := server sha. The working file is untouched (`file_written=false`, no `backup_file`).
- The page becomes modified, or unchanged if the content is equal. The next push sends the local content with parent = server sha, deliberately superseding the teammate's version.
- Any other state -> not_resolvable (exit 9, details `{path, state, strategy}`). For example, `--ours` on an incoming page would revert a teammate's change.

`--theirs`:
- Allowed from any state in which the server has the page.
- If the working file exists and differs, it is first copied to `.sync/backup/<path>.<YYYYMMDDTHHMMSSZ>` (`backup_file`).
- The file is then written as `SanitizeContent(server bytes)`, base := the same bytes, sha := server sha. The resulting state is unchanged.
- From unchanged it is a successful no-op (`file_written=false`).
- From new (no server page) -> page_not_found.

OTHER:
- resolve is idempotent per strategy and never pushes.
- Both strategies clear the path's sidecar (E10).
- The same engine function backs MCP `ctx_push resolved=[...]`.

**ResolveDoc** (`ctx.resolve.v1`):

| Field | Type | req | Notes |
|---|---|---|---|
| schema | `"ctx.resolve.v1"` | req | |
| path | RelPath | req | |
| strategy | ResolveStrategy | req | ours \| theirs |
| previous_state | PageState | req | |
| state | PageState | req | ours: modified \| unchanged; theirs: unchanged |
| base_sha | sha | req | |
| file_written | boolean | req | always false for ours |
| backup_file | RelPath | | relative to `.contexo/`; theirs only |
| warnings | Warning[] | req | |

Examples:

```json
{
  "schema": "ctx.resolve.v1",
  "path": "wiki/concepts/retry-policy.md",
  "strategy": "ours",
  "previous_state": "conflict",
  "state": "modified",
  "base_sha": "f0e1d2c3b4a5968778695a4b3c2d1e0f9a8b7c6d",
  "file_written": false,
  "warnings": []
}
```

```json
{
  "schema": "ctx.resolve.v1",
  "path": "wiki/concepts/retry-policy.md",
  "strategy": "theirs",
  "previous_state": "conflict",
  "state": "unchanged",
  "base_sha": "f0e1d2c3b4a5968778695a4b3c2d1e0f9a8b7c6d",
  "file_written": true,
  "backup_file": ".sync/backup/wiki/concepts/retry-policy.md.20261103T091530Z",
  "warnings": []
}
```

### 4.7 `ctx repair [--dry-run] [--json] --root <dir>` (ctx-only, E18)

The extension never calls it, and it has no schema here. The validator skips `ctx.repair.v1` (E32).
- It runs the E11/E12 base repair over every stale path.
- It takes the lock (busy 12) and requires credentials (4) and a repo_id (5).
- stdout keys, in order: schema `ctx.repair.v1`, dry_run, server_capabilities[], backfilled[{path, sha}], repaired[{path, old_sha, new_sha, reason}], skipped[{path, reason}], unverified[], warnings[]. Arrays are never null.
- It is advertised as the optional capability `repair`.

## 5. Page states

### 5.1 The 9 states (CLOSED in v1; a new value is contract 2)

| State | Meaning |
|---|---|
| unchanged | local == base, and the server has not moved (or is unknown) |
| modified | local edited since the base, and the server has not moved |
| new | local file with no server copy |
| incoming | local == base, and the server moved |
| incoming_new | server-only page, no local file and no base (E2(5)) |
| conflict | both sides changed. `conflict_kind` is both_modified, or both_added when a local new page also exists on the server (E2(5)). |
| deleted_local | the base exists and the local file is gone |
| invalid | the local file fails parse, validate or the path check. `invalid.stage` is parse, validate or path_mismatch. |
| unverified | the local file is valid but its base record is stale |

`invalid` covers three cases:
- `ParsePage(stripBOM(bytes))` fails (stage parse).
- `Frontmatter.Validate()` fails (stage validate: schema, slug, type, author, created).
- `Frontmatter.RelPath() != P` (stage path_mismatch, with `expected_path = RelPath()`).

Invalid pages are never pushed.

### 5.2 Entry set

There is one entry per path P in the union of:
- working files (`*.md` under `.contexo`, excluding the root `index.md`/`tags.md` and dot-dirs)
- the keys of `state.json` `page_shas`
- remote paths

P is `/`-separated and relative to `.contexo`. `local.file == path` always holds in v1.

### 5.3 Inputs (gathered by syncops; decided by the pure `contract.Classify`)

L(P), the working file:
- `absent`: no file at `.contexo/P`.
- `invalid`: the file exists and fails a section 5.1 check.
- `valid(hL)`: otherwise, with `hL = Hash(bytes)`.

B(P), the base:
- `none`: P is not in `page_shas`, or its value is `''`.
- `valid(sb, hB)`: `bases.json[P].sha == page_shas[P]` AND `.sync/base/P` exists. `sb = page_shas[P]`, `hB = bases.json[P].hash`.
- `stale(sb)`: P is in `page_shas` but the base record is missing or belongs to another sha. This happens on the first run after the upgrade, after an old ctx/MCP binary rewrites `state.json`, or after a crash.

R(P), the remote:
- With a live listing, R comes only from the listing:
  - `absent`: the listing does not contain P (this includes `repo_exists=false`).
  - `present(sr)`: the listing has P, with sr = the last commit that touched P.
- With no live listing (`--offline`, or the live listing failed) (E9):
  - `present(rec.ServerSHA)` when `conflicts.json` has a record rec for P with `rec.ServerSHA != page_shas[P]`.
  - Otherwise `unknown`. `remote.source` is still `none`.

The online paths (status, pull, push) first run EnsureBase, which turns stale bases into valid ones where it can (E5, E11, E12).

### 5.4 Decision table

"B set" means B is valid or stale. "moved" means R is present with `sr != sb`, which requires B set. The row ids match the comments in `contract.Classify` and the ids in `classify.cases.json`.

| row | L | B | R | state | notes |
|---|---|---|---|---|---|
| r01 | invalid | any | not moved | invalid | - |
| r02 | invalid | set | moved | invalid | [remote_changed] |
| r03 | absent | set | present with sr == sb, or unknown | deleted_local | - |
| r04 | absent | set | moved | deleted_local | [remote_changed] |
| r05 | absent | set | absent | deleted_local | [missing_on_server] |
| r06 | absent | none | present | incoming_new | - |
| r07 | absent | none | absent or unknown | (no entry) | - |
| r08 | valid | none | present | conflict, both_added | - |
| r09 | valid | none | absent | new | - |
| r10 | valid | none | unknown | new | - |
| r11 | valid | stale | absent | new | [missing_on_server] |
| r12 | valid | stale | present or unknown | unverified | - |
| r13 | valid | valid | absent | new | [missing_on_server] (push re-creates it) |
| r14 | valid, hL == hB | valid | present, sr == sb | unchanged | - |
| r15 | valid, hL != hB | valid | present, sr == sb | modified | - |
| r16 | valid, hL == hB | valid | unknown | unchanged | - |
| r17 | valid, hL != hB | valid | unknown | modified | - |
| r18 | valid, hL == hB | valid | present, sr != sb | incoming | - |
| r19 | valid, hL != hB | valid | present, sr != sb | conflict, both_modified | - |

`classify.cases.json` holds 21 rows: r01-r19 plus r03b and r12b.

### 5.5 Overlays (applied after Classify)

- Sidecar overlay (E9). One shared syncops helper, used by status, push, pull and resolve, works as follows. If a sidecar record rec exists for P, `rec.ServerSHA != sb`, and Classify returned modified, the state becomes conflict with `conflict_kind = rec.Kind`. No other result is overridden.
  - push therefore skips such a path (reason conflict), and pull adopts it only when it is content-equal.
  - A PageEntry whose remote side comes from a sidecar carries only `remote.sha`. `contract.Classify` stays pure.
- Case collision (status only). If two entry paths are equal under simple case folding, both get note `case_collision` and the document gets warning `case_collision`. pull never writes either of them.
- Invalid entries still carry `base` and `remote` when they are known, so the UI can say "the server has a newer version".

### 5.6 SCM groups (presentation; `contract.SCMGroup` == TS `groupFor`, pinned by classify.cases.json)

| state | group id | label |
|---|---|---|
| conflict | conflicts | Conflicts |
| modified, deleted_local | changes | Changes |
| new | new | New |
| incoming, incoming_new | incoming | Incoming |
| invalid | invalid | Invalid |
| unchanged, unverified | (none) | - |

- `unverified` is shown only as a tree decoration plus a status-bar count.
- `resourceState.contextValue` is the PageState.
- `SourceControl.count` = conflict + modified + new, plus incoming + incoming_new only when `contexo.scm.countIncoming` is true. deleted_local, invalid and unverified are never counted (E29; TS `scmCount`).
- A deleted_local resource's tooltip reads: 'Deleted locally. Deletes are not synced in this version; Restore Server Version brings it back.' (E29). That action is the command `contexo.restoreServerVersion`, which runs `resolve --theirs`.

### 5.7 Knowledge tree membership (E30)

The tree lists every entry whose working file exists, i.e. `PageEntry.local` is present (TS `listedInTree`).
- Valid entries (unchanged, modified, new, incoming, conflict, unverified) appear under their frontmatter type. unverified entries get a decoration.
- Invalid entries appear under an 'Invalid' node.
- incoming_new and deleted_local entries are not listed.
- Tree `contextValue` is `page.<state>`, or `session` for capture sessions.

### 5.8 What each operation does per state

push:
- Sends modified (`parent_sha = sb`) and new (`parent_sha = sb` if B is set, else `''` with `expect_absent`).
- Never sends conflict, invalid, deleted_local or unverified. They are reported in `skipped`.
- Named paths in unchanged, incoming or incoming_new are skipped with that reason. Unknown named paths are skipped as not_found.
- The Go SkipReason list (section 9) has no `incoming_new` value. The contract leaves the exact reason for a named incoming_new path to ctx, and SkipReason is an open set, so either form validates.

pull:
- Writes incoming and incoming_new.
- Adopts conflict (both kinds) and unverified pages whose `Hash(server) == hL`.
- Skips modified, non-equal conflict, invalid, deleted_local, non-equal unverified, case_collision and changed_during_pull.
- Leaves unchanged and new alone.

resolve --ours: allowed from conflict (either kind) and unverified (valid L). The result is modified, or unchanged if the content is equal.

resolve --theirs: allowed from every state where the server has P. The result is unchanged; from unchanged it is a no-op.

show --at base: needs B valid, so it works for every state except new without a base, incoming_new and unverified.

GUARANTEE: no ctx operation ever writes a working file whose current hash differs from its base hash, except `resolve --theirs`, which makes a backup first.

## 6. Errors

### 6.1 When the envelope is emitted (E21)

- The envelope and the contract exit codes apply only when the executed command's `--json` is true, or the command is show. A raw argv `--json` or `--json=true` before `--` also counts, so flag-parse failures still produce the envelope.
- Without `--json`, errors stay in human mode: rendered text and exit 1. For example, `resolve P --ours --theirs` without `--json` exits 1 with text.
- `cmd/ctx/main.go` is `os.Exit(cli.Execute(os.Args[1:], os.Stdout, os.Stderr))`. `cli.Execute` uses `ui.ToContractError`, `ui.RenderEnvelope` and `ui.ExitCode`.

### 6.2 Shape (E2(3))

The envelope is exactly ONE line of JSON, the last non-empty line of stderr. It has no `contract` key.

```
{"schema":"ctx.error.v1","exit_code":<int>,"error":{"code":"<ErrorCode>","message":"<human sentence, no ANSI>","advice":["<shell command>",...],"retryable":<bool>,"http_status":<int, only when an HTTP response caused it>,"details":{...typed per code, only for codes that have details}}}
```

- `exit_code` always equals the process exit code.
- `advice` is `[]` rather than omitted.
- `retryable` is fixed per code (section 6.4).

ErrorEnvelope:

| Field | Type | req |
|---|---|---|
| schema | `"ctx.error.v1"` | req |
| exit_code | integer >= 1 | req |
| error | ErrorBody | req |

ErrorBody (also used by `StatusDoc.remote.error`):

| Field | Type | req | Notes |
|---|---|---|---|
| code | string | req | ErrorCode (open set) |
| message | string | req | |
| advice | string[] | req | shell commands that fix it |
| retryable | boolean | req | |
| http_status | integer | | only when an HTTP response caused it |
| details | object | | typed per code (section 6.5), only for codes that have details |

Examples:

```
{"schema":"ctx.error.v1","exit_code":5,"error":{"code":"not_initialized","message":"status: no .contexo/ directory in /Users/alice/code/scratch","advice":["ctx init"],"retryable":false}}
{"schema":"ctx.error.v1","exit_code":9,"error":{"code":"distill_required","message":"push: 1 un-distilled agent session is pending; share these pages through your agent so the reasoning trail is captured","advice":[],"retryable":false,"details":{"pages":["wiki/concepts/settlement-windows.md"],"sessions":[{"session_id":"5d0c6a3e-1f2b-4c7d-9e8f-0a1b2c3d4e5f","turns":14,"updated_at":"2026-11-03T09:12:40Z","fresh":true}],"agent_prompt":"Push my pending Contexo changes with the ctx_push tool (wiki/concepts/settlement-windows.md). Distill the pending session into a source page first when ctx_push asks you to."}}}
{"schema":"ctx.error.v1","exit_code":6,"error":{"code":"conflict","message":"push: 1 conflict(s) remain; other pages were pushed","advice":["ctx resolve wiki/entities/settlement-batch.md --ours","ctx resolve wiki/entities/settlement-batch.md --theirs"],"retryable":false,"http_status":409,"details":{"paths":["wiki/entities/settlement-batch.md"]}}}
```

### 6.3 Exit codes (E2(1))

| exit | meaning | codes |
|---|---|---|
| 0 | ok | |
| 1 | internal | internal |
| 2 | never used deliberately: the Go runtime exits 2 on a panic (maps to internal) | |
| 3 | usage | usage, invalid_path |
| 4 | auth | not_authenticated, auth_rejected, forbidden |
| 5 | config / not initialized | not_initialized, repo_not_configured, server_unresolved |
| 6 | conflict / stale | conflict, stale |
| 7 | network / server (retryable) | network, server_error, rate_limited |
| 8 | not found | repo_not_found, page_not_found, base_unavailable, sha_not_found |
| 9 | refused by a precondition; nothing was changed | distill_required, not_resolvable |
| 10 | server unsupported / not implemented | server_unsupported, not_implemented |
| 11 | quota | quota_exceeded |
| 12 | busy (retryable) | busy |
| 130 / 143 | killed by the extension (SIGINT/SIGTERM); ignore | |

The old '0-14' table is void.

### 6.4 The 24 stable error codes (E2(2), E17)

| code | exit | retryable | raised by | what the extension does |
|---|---|---|---|---|
| internal | 1 | no | anything unclassified, or a corrupt input | error toast plus Show Log |
| usage | 3 | no | bad flags or arguments; both --ours and --theirs | log as an extension bug |
| invalid_path | 3 | no | show, resolve, push paths | toast |
| not_authenticated | 4 | no | network commands with no token | 'not logged in' welcome view with Login |
| auth_rejected | 4 | no | HTTP 401 | Login (token revoked or expired) |
| forbidden | 4 | no | HTTP 403 (not a member) | toast naming the repo |
| not_initialized | 5 | no | every command except version | 'not initialized' welcome view (offers `ctx init` in a terminal) |
| repo_not_configured | 5 | no | network commands with no repo_id | toast suggesting `ctx remote set-repo` |
| server_unresolved | 5 | no | global credentials without server_url | Login |
| conflict | 6 | no | push (the stdout document is also present) | reveal the Conflicts group |
| stale | 6 | no | resolve `--if-server-sha` mismatch | refresh status and re-open the diff |
| network | 7 | yes | transport failure or timeout | offline icon in the status bar, retry on the next poll |
| server_error | 7 | yes | HTTP 5xx or a garbled body | retry with backoff |
| rate_limited | 7 | yes | HTTP 429 (per-IP limit 300/min) | double the poll interval |
| repo_not_found | 8 | no | show and resolve (status reports `repo_exists=false` instead) | toast |
| page_not_found | 8 | no | show server\|sha, resolve | refresh |
| base_unavailable | 8 | no | show --at base | the diff falls back to server->local or an empty left side |
| sha_not_found | 8 | no | show <sha> | toast |
| distill_required | 9 | no | push (D4 guard) | "Share via your agent": copy `details.agent_prompt` and open the agent chat. NEVER retry with --no-distill. |
| not_resolvable | 9 | no | resolve precondition failed | refresh, then a toast naming `details.state` |
| server_unsupported | 10 | no | show <sha> without pages.at; a missing listing route (status puts this in remote.error) | hide the feature and show "server outdated" |
| not_implemented | 10 | no | a hidden stub command in a pre-release build (E17); no ctx release returns it for an advertised capability | treat like ctx too old (offer Update ctx) |
| quota_exceeded | 11 | no | HTTP 402 when the first push auto-creates the repo | toast with `details.upgrade_url` |
| busy | 12 | yes | another ctx (often an agent's MCP push or pull) holds `.sync/lock` | retry once after 1 s, then toast "an agent is syncing" |

New codes may be added in a minor release. Callers map an unknown code by its exit-code category. Void names (E2(2)):
- capture_pending -> distill_required
- locked -> busy
- server_too_old -> server_unsupported
- no_remote -> repo_not_configured
- not_found -> page_not_found / repo_not_found / sha_not_found / base_unavailable
- invalid_page does not exist (invalid is a page state and a skip reason)

### 6.5 Details payloads (typed per code; `contract.NewDetails(code)`)

| code | details |
|---|---|
| distill_required | `{pages: RelPath[], sessions: CaptureSession[], agent_prompt: string}` |
| conflict | `{paths: RelPath[]}` |
| stale | `{path: RelPath, expected_sha: sha, server_sha: sha}` |
| not_resolvable | `{path: RelPath, state: PageState, strategy: ResolveStrategy}` |
| server_unsupported | `{missing: ServerCapability[]}` |
| busy | `{pid: integer, host: string, command: string, started_at: time}` |
| quota_exceeded | `{quota_code: string, limit: integer, upgrade_url?: string}` |

Every other code, including not_implemented (E34), carries no details.

### 6.6 Mapping HTTP and other failures to codes (E14)

- A `*contract.Error` passes through.
- A `*ui.CLIError` keeps its message and advice. The code comes from its wrapped error, otherwise internal.
- `sync.HTTPError{Status, Code, ServerCode, Body, Msg, Details}` maps by status:
  - 400: invalid_path when the JSON body code is invalid_path. Any other 400, including code invalid_sha, is usage.
  - 401: auth_rejected. 402: quota_exceeded (details from the 402 body). 403: forbidden.
  - 404: the JSON body code when it is page_not_found, repo_not_found or sha_not_found. A JSON 404 without a code gives repo_not_found if `error == 'repo not found'`, otherwise sha_not_found on an `?at` request, otherwise page_not_found. A non-JSON 404 (route missing) gives server_unsupported.
  - 409: never mapped to an error code. Push conflicts are data, and resolve's stale is computed client-side.
  - 429: rate_limited. 5xx or a garbled response: server_error.
- `url.Error`, `net.Error` and `context.DeadlineExceeded` (transport failure or timeout) map to network.
- A missing `.contexo` maps to not_initialized.
- Cobra flag and argument errors map to usage.

### 6.7 Extension parsing rule (E34; TS `parseEnvelope`)

- On exit != 0, take the last non-empty stderr line and parse it as a `ctx.error.v1` envelope.
- If that fails (an old ctx, a panic trace, exit 2), synthesize `{schema:'ctx.error.v1', exit_code: exit, error:{code: fallbackCode(exit), message: stderr.trim() or 'ctx exited <exit>', advice: [], retryable: exit === 7 || exit === 12}}`.
- fallbackCode:

  | exit | code |
  |---|---|
  | 3 | usage |
  | 4 | not_authenticated |
  | 5 | not_initialized |
  | 6 | conflict |
  | 7 | network |
  | 8 | page_not_found |
  | 9 | not_resolvable |
  | 10 | server_unsupported |
  | 11 | quota_exceeded |
  | 12 | busy |
  | anything else, including 2 | internal |

- Unknown codes are handled by their exit-code category.
- push exit 6 yields both the PushDoc (stdout) and the conflict envelope (stderr).

## 7. Capabilities

### 7.1 ctx capabilities (`ctx version --json`)

`contract.Capabilities`, the 11 v1 capabilities in contract order (E19):

| # | capability | REQUIRED by the extension |
|---|---|---|
| 1 | status.json | yes |
| 2 | status.offline | yes |
| 3 | show.base | yes |
| 4 | show.server | yes |
| 5 | show.sha | no (optional) |
| 6 | pull.json | yes (implies safe pull) |
| 7 | push.json | yes |
| 8 | push.paths | yes |
| 9 | push.distill_guard | yes |
| 10 | resolve | yes |
| 11 | errors.envelope | yes |

They are followed by `contract.OptionalCapabilities` = [`repair`] (E18). `KnownCapability(c)` is true for both lists.

- REQUIRED_CAPABILITIES (E2(4)): the 10 marked yes. The extension refuses to run against a ctx that lacks any of them.
- Optional (compatibility §1d, E18): `show.sha` and `repair`. They are used when present and hidden when absent. The extension never calls repair.
- Void names (E2(4)): errors.json, version.json, push.only-changed, push.capture-guard, pull.safe, show, base.snapshots.

### 7.2 Server capabilities (`X-Contexo-Capabilities`; E13)

- v1 servers send `X-Contexo-Server-Version` and `X-Contexo-Capabilities: pages.at,push.expect_absent,write.path_sha` on every response, including 401/404/429 and `/health`.
  - `pages.at`: `GET /pages/*path?at=<sha>` echoes `X-Contexo-At` and returns `X-Page-SHA`.
  - `push.expect_absent`: the `PushFile.expect_absent` create-only guard (E7).
  - `write.path_sha`: an unchanged write returns the path's last commit, not repo HEAD.
- `pages.etag` is RESERVED. It is not advertised, and v1 has no ETag, If-None-Match or 304. No fixture lists it (E13, E31(d)).
- ctx learns the server version and capabilities only from response headers on calls it already makes, and never calls `/health`. `GET /health -> {"status":"ok","api":1,"version","capabilities":[...]}` exists for smoke tests. Harnesses assert exactly the three advertised names.
- Detection:
  - No `X-Contexo-Capabilities` header means capabilities `[]` (an old server); `capabilities_known=true` once the server answered.
  - A `?at` response without `X-Contexo-At` means server_unsupported.
  - A non-JSON 404 on the listing means `remote.error` server_unsupported.
- Degradation on an old server:
  - Without pages.at, EnsureBase repairs only pages whose remote sha == the `page_shas` sha, and show `--at <sha>` fails with server_unsupported.
  - Without write.path_sha, ctx adds warning server_outdated. The client self-heals anyway.
  - Without push.expect_absent, two people creating the same slug at the same moment can still race.

### 7.3 Reserved enum values (E8, E34)

These remain in the enums and validate, but v1 ctx never emits them:
- RemoteSource `cache`
- WarningCode `remote_stale`
- ServerCapability `pages.etag`

## 8. Discovery, handshake and trust

### 8.1 Discovery order (E35)

The first hit wins. The result is cached by path + mtime + size.
1. `contexo.path` (machine scope, absolute paths only)
2. PATH. On win32, scan PATH x PATHEXT and never call `which`.
3. `~/.local/bin/ctx` (scripts/install.sh:14 default)
4. `%LOCALAPPDATA%\Programs\contexo\ctx.exe` (scripts/install.ps1:14)
5. `~/go/bin/ctx[.exe]`
6. `/opt/homebrew/bin/ctx`, then `/usr/local/bin/ctx`

- Candidates ending in `.cmd`, `.bat` or `.ps1` are rejected with the message 'point contexo.path at ctx.exe'. Node >= 18.20.2 / 20.12.2 refuses to spawn them with `shell:false` (EINVAL, CVE-2024-27980), and `shell:true` is banned.
- `%LOCALAPPDATA%\Programs\ctx` is not a location.

### 8.2 Handshake outcome (E36; TS `BinaryState` -> `ExtensionState`)

The handshake runs `ctx version --json` with a 5 s timeout.

| Outcome | BinaryState | ExtensionState / UI |
|---|---|---|
| ENOENT, no candidate, or output that is not ctx (no `ctx.version.v1` document and no parseable `version --short`) | `{kind:'missing'}` | ctxMissing ("Install ctx" welcome view) |
| `contract_version > SUPPORTED_CONTRACT_VERSION` (1) | `{kind:'extensionTooOld', path, contractVersion}` | extensionTooOld ("update the extension") |
| `contract_version < 1`, any REQUIRED_CAPABILITIES missing, or an old ctx (`unknown flag: --json`, version named from `ctx version --short`) | `{kind:'tooOld', path, versionText?, missing}` | ctxTooOld (offer Update ctx, which opens a terminal running `ctx update`) |
| otherwise, whatever the version string (`dev`, `0.7.0-rc.1`) | `{kind:'ok', path, version}` | continue |

The kinds `notCtx` and `extension-too-old` do not exist. Gating uses capabilities only, never semver.

### 8.3 First-run notice (E37)

After a successful handshake, the extension checks globalState `contexo.lastCtxVersion`. If it is absent or differs from `VersionDoc.version` (version + commit for dev builds), the extension shows one non-modal message, then stores the value:

> Contexo is using ctx <version>. Restart your agent sessions so their Contexo MCP server runs this ctx; older MCP servers can still overwrite local edits.

The message has a [Learn more] action. WP-1.12 owns it.

### 8.4 Credentials and Workspace Trust (§4, E38)

- The extension declares `capabilities.untrustedWorkspaces.supported=false`. VS Code then disables it entirely in Restricted Mode: no views, no viewsWelcome, no code. There is no reachable 'untrusted' welcome state. The `untrusted` value stays only in the TS `ExtensionState` union.
- The runtime `workspace.isTrusted` check stays as defence in depth: ctx is never run in an untrusted folder.
- The server URL rule (section 4.2) guarantees a global token is only ever sent to the URL stored with it.
- The extension never sees tokens. status reports only `token_kind` and user identity.

## 9. Enumerations

Closed enums (a new value is contract 2):

| Enum | Values |
|---|---|
| PageState | unchanged, modified, new, incoming, incoming_new, conflict, deleted_local, invalid, unverified |
| ConflictKind | both_modified, both_added |
| InvalidStage | parse, validate, path_mismatch |
| AuthState | authenticated, unchecked, not_authenticated, rejected |
| RemoteSource | live, none, cache (reserved) |
| UrlSource | credentials, config, default |
| WriteKind | create, update |
| ResolveStrategy | ours, theirs |

Open sets: unknown values are allowed and are typed `| string` in TS. Known values:

WarningCode:

| Code | Meaning |
|---|---|
| server_url_mismatch | config server_url != the URL the credentials belong to |
| server_outdated | the server lacks pages.at, push.expect_absent or write.path_sha (E13) |
| remote_stale | reserved, never emitted (E8) |
| base_repair_skipped | unverified pages left (lock busy, server lacks pages.at, or the budget ran out) |
| case_collision | paths differ only by case; pull skips them |
| reindex_failed | index.md/tags.md regeneration failed after pull |
| state_unreadable | `.sync/state.json` or `bases.json` is corrupt and was treated as empty |

NoteCode:

| Code | Meaning |
|---|---|
| missing_on_server | a base exists but the server no longer lists the path |
| remote_changed | the server moved past the base (on invalid or deleted_local entries) |
| case_collision | another path differs only by letter case |

SkipReason:

| Reason | Meaning |
|---|---|
| unchanged | push: a named path has nothing to send |
| incoming | push: a named path is behind the server; pull first |
| conflict | push + pull: resolve first |
| invalid | push + pull: fix the file first |
| deleted_local | push: deletes are not synced in v1. pull: never resurrects. |
| unverified | push + pull: the base could not be verified |
| modified | pull: local edits are never overwritten |
| changed_during_pull | pull: the file changed between classify and write |
| case_collision | pull: would overwrite a case-variant file |
| not_found | push: a named path is unknown locally and remotely |

- ErrorCode: the 24 codes in section 6.4.
- Capability: section 7.1.
- ServerCapability: section 7.2.

Schema ids: `ctx.version.v1`, `ctx.status.v1`, `ctx.push.v1`, `ctx.pull.v1`, `ctx.resolve.v1`, `ctx.error.v1`. `ctx.repair.v1` belongs to ctx only and is never parsed by the extension (E34).

## 10. ctx-side state (informational; the extension never reads it)

Everything lives under `.contexo/.sync/`. Page walks skip dot-dirs, so none of it looks like a page. The layout source of truth is `internal/syncstate/layout.go` (E8).

- `.gitignore` contains `*\n`. It is created atomically before the first write under `.sync/`, so base, backup and conflict copies are never committed (E41).
- `state.json`: `{last_pull_sha, page_shas}`, in an unchanged format so old binaries keep working. `page_shas[path]` is the BASE sha.
- `bases.json`: `{"schema":"ctx.bases.v1","pages":{"<path>":{"sha","hash","synced_at"}}}`. A base record is valid only if `bases[path].sha == page_shas[path]` AND `base/<path>` exists. The hash is always `Hash(base bytes)` (E6).
- `base/<path>`: the base bytes. They are what ctx last wrote to the working file, what it pushed (`Normalize(local)`), or the server version it adopted.
- `conflicts.json`: `{"schema":"ctx.conflicts.v1","conflicts":{"<path>":{"server_sha","base_sha"?,"kind","source":"push|pull|repair","detected_at","has_content"}}}`. Each record has a matching `conflicts/<path>` (SanitizeContent of the server bytes, present iff has_content) (E8).
  - Sidecar writers: a push 409, a pull conflict skip, and EnsureBase case 3.
  - Sidecar clearers: a successful push, a pull write or adopt, resolve, and an EnsureBase adoption (E10).
- `lock`: `{pid, host, command, started_at}`, created with O_EXCL (E2(7)).
  - The lock is stale if the same host has no such live PID, or if it is older than 10 min.
  - push, pull, resolve and repair wait up to 10 s, then fail with busy.
  - status never waits; online status only TryLocks inside EnsureBase, and `status --offline` never locks (E5).
- `backup/<path>.<YYYYMMDDTHHMMSSZ>`: the working file saved before `resolve --theirs` overwrites it.
- `remote.json`: RESERVED. It is never written or read in contract v1 (E8).
- Write order per operation: working file(s), base file(s), `conflicts/<path>` files, `bases.json`, `conflicts.json`, `state.json`. Each index file is written once. Every write is a temp file in the same directory plus a rename.

Comparison (E6):
- `Normalize(b) = SerializePage(ParsePage(StripBOM(b)))`, without SanitizeContent.
- `Hash(b) = 'sha256:'+hex(sha256(Normalize(b)))`, or `'raw-sha256:'+hex(sha256(b))` when Normalize fails.
- push sends `Normalize(local)` and does not rewrite the working file. The gutter quick diff (base vs the raw working file) can therefore show YAML formatting differences on an unchanged page; this is accepted for the MVP.
- pull, `resolve --theirs`, EnsureBase/repair, sidecar content and `show --at server|<sha>` all use `SanitizeContent(server bytes)`.

EnsureBase (E11, E12) handles a stale path P with `page_shas[P] = S`:
1. Obtain the server content C at S.
2. If the working file is valid and `Hash(L) == Hash(C)`, ADOPT.
3. Otherwise, if an older valid base record A exists, KEEP A: `page_shas[P] := A.sha`. If L differs, also write a repair sidecar.
4. Otherwise, re-base onto C.

Request budget:
- Stale paths whose listing sha == S read HEAD: one PullPages call when more than 8 paths qualify, else ReadPage per path.
- Other paths use `?at` with concurrency <= 4 and at most 50 requests, stopping at the first 429. The leftovers stay unverified, with warning `base_repair_skipped`.
- 500 stale HEAD-equal pages complete in at most 2 HTTP requests.

## 11. Fixtures, schemas, validator and fake ctx

### 11.1 Canonical fixtures (E3, E31, E32, E33)

- The canonical set lives in Contexo at `internal/syncops/contract/testdata/v1/`.
- WP-1.7 vendors the extension copy at `test/fixtures/contract/v1/`, with a `SOURCE` file holding the core commit sha. It uses `git -C /Users/sugih/Codes/Contexo archive mvp/integration internal/syncops/contract/testdata/v1 | tar -x --strip-components=5 -C test/fixtures/contract/v1`, and refreshes re-run the same command.
- WP-1.7 owns the TS tests over the vendored copy:
  - `test/unit/contract/vendored.test.ts`: manifest hashes, parseDoc on each stdout doc, parseEnvelope on each stderr fixture with a leading noise line, and the exit-2 panic case
  - `test/unit/contract/groups.test.ts`: groupFor over `classify.cases.json`
  - `test/unit/cli/handshake.test.ts`: the version.* fixtures mapped per E36
- `manifest.json` is `{contract_version: 1, fixtures: [{file, schema, command, stream, exit_code, sha256}]}`:
  - `stream` is one of stdout, stderr, raw or data.
  - `classify.cases.json` is data, with schema, command and exit_code null.
  - `raw/*.md` is raw, with schema null.
  - `error.*.json` and `*.stderr.json` are stderr.
  - The TS hash check ignores `SOURCE` and `manifest.json` itself.
- The fixture set, with the errata applied:
  - `version.release.json` and `version.dev.json` (the 11 v1 capabilities followed by repair, E31(g)), `version.missing-caps.json`, `version.contract2.json`
  - `status.all-states.json`, `status.short.json` and every other fixture without pages.etag (E31(d))
  - `status.captures-blocking.json`
  - `status.offline-sidecar.json` (replaces offline-cache): offline=true, `remote.source=none` without fetched_at, `auth.state=unchecked`, one conflict whose remote side is `{sha}` only, no incoming, no remote_stale (E31(a))
  - `status.offline-nocache.json`: no sidecars; only new, modified, unchanged, invalid, deleted_local and unverified (E31(c))
  - `status.not-authenticated.json`, with `remote.error` not_authenticated (E31(e))
  - `status.auth-rejected.json` and `status.network-error.json`, with `remote.source=none` (E31(b))
  - `status.old-server.json`, `status.repo-missing.json`, `status.url-mismatch.json`, `status.empty.json`
  - `push.ok.json`, `push.dry-run.json` (a dry run writes nothing, E31(h)), `push.partial-conflict.json` + `push.partial-conflict.stderr.json`, `push.nothing.json`, `push.distill-bypassed.json`
  - `pull.ok.json`, `pull.skipped-and-adopted.json`, `pull.case-collision.json`, `pull.up-to-date.json`
  - `resolve.ours.json`, `resolve.theirs.json`
  - 24 `error.<code>.json` files (E17, E31(f))
  - `classify.cases.json` (21 rows)
  - `raw/retry-policy.base.md` and `raw/retry-policy.server.md`

`test/fixtures/contract/v1/` is never created by WP-0.6, and WP-0.6 tests never read it.

### 11.2 JSON Schemas (`contract/schemas/*.schema.json`)

The six schema files are `version`, `status`, `push`, `pull`, `resolve` and `error` (`<name>.schema.json`):
- Each is JSON Schema 2020-12 (`$schema https://json-schema.org/draft/2020-12/schema`) with the stable `$id` `https://contexo.live/schemas/ctx/v1/<name>.schema.json`.
- Each is self-contained (`$defs`). A `$defs` entry with the same name is identical in every file, and a unit test pins this.
- They compile under ajv 8 `Ajv2020({allErrors: true, strict: true, strictRequired: false})`. strictRequired is off only because it misreports `not: {required: [...]}`.
- There is no ajv-formats, and no show or repair schema.

The schemas implement these rules:

Presence and arrays:
- `additionalProperties` is allowed everywhere (forward compatible).
- Required = the Go fields without omitempty. Optional = omitempty.
- Arrays are `type: array`, so `null` fails.

Patterns:
- time: `^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$`. Used by generated_at, fetched_at, synced_at, updated, remote.time, sessions[].updated_at and busy started_at.
- sha: `^[0-9a-f]{40}$`. Used by base.sha, remote.sha, remote.head, last_pull_sha, new_head, pull head, server_sha, base_sha, the sha in pushed/written/adopted, and stale expected_sha/server_sha.
- hash: `^(sha256|raw-sha256):[0-9a-f]{64}$`.
- RelPath: non-empty and not starting with `/` or `\`.

Enums and codes:
- Closed enums are the section 9 table, with the reserved values included.
- Open sets are pattern strings:
  - error, warning and note codes and skip reasons: `^[a-z][a-z0-9_]*$`
  - ctx and server capabilities: `^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$`

Per document:
- version:
  - `contract_version` is an integer >= 1, not const 1, so `version.contract2.json` validates (E32).
  - `capabilities` has unique items.
- status:
  - `project.dashboard_url` is a required string that may be `""`, in which case `dashboard_page_url_template` must be absent (E23). The template contains `{path}`.
  - PageEntry: `conflict_kind` is present iff state == conflict, and `invalid` is present iff state == invalid.
- push:
  - A both_added conflict has no `base_sha`.
  - `dry_run: true` means no `new_head`, no `pushed[].sha` and `conflicts: []`.
- pull: `written[]` entries carry `kind`.
- resolve:
  - ours: state modified|unchanged, `file_written: false`, no `backup_file`.
  - theirs: state unchanged.
- error:
  - `exit_code` is an integer >= 1, pinned to the section 6.3 exit for each of the 24 known codes.
  - `retryable` is pinned for the known codes, in every ErrorBody including `StatusDoc.remote.error`.
  - `details`, when present, is an object typed per code (section 6.5).
  - `http_status` is an integer in 100..599.

### 11.3 Validator CLI (`contract/validate.mjs`; npm script `contract:validate`)

```
node contract/validate.mjs [--manifest <manifest.json>]... [<file>...]
```

It needs Node >= 22, is ESM, and has no dependency beyond ajv.
- Explicit files: if the whole file parses as JSON it is a document. Otherwise the file's last non-empty line is used (a stderr capture). The schema is picked from the document's `schema` field, which must be one of the six ids.
- `--manifest` (E32): entries are selected by `stream` and `schema`, never by file extension. Paths are relative to the manifest's directory.
  - stdout entries must be one whole-file JSON document.
  - stderr entries use their last non-empty line, and the envelope's `exit_code` must equal the entry's `exit_code`.
  - raw and data entries, and entries whose schema is not one of the six (null, `ctx.repair.v1`, ...), print a `SKIP` line.
- Output: `OK <file> <schema>` per valid document, `SKIP <file> <reason>`, `FAIL <file> ...`, then a summary line.
- Exit codes:
  - 0 only when every validated file passes.
  - 1 on any failure or a missing file.
  - 2 on a usage error (no arguments prints the usage text).

### 11.4 Fake ctx (E33; `test/fake-ctx/fake-ctx.mjs`)

- It runs as `node fake-ctx.mjs <args>`. It is injected in Test mode on every OS through `CONTEXO_TEST_CTX={command: process.execPath, prefixArgs:[<abs fake-ctx.mjs>]}` (section 2.7).
- Scenario choice:
  - with `--root R`: the scenario named in `<R>/.fake-ctx/current`;
  - otherwise env `FAKE_CTX_SCENARIO`;
  - otherwise a built-in contract-1 VersionDoc with the 11 v1 capabilities plus `repair`, which answers `version --json` only.
- Scenarios are `test/fixtures/ctx/scenarios/<name>/scenario.json` = `{rules: [{match: [tokens], unless?: [tokens], stdout?|stdoutFile?, stderr?|stderrFile?, exit?, delayMs?, then?: '<scenario>'}], default}`.
  - The first rule whose `match` tokens are all in argv and none of whose `unless` tokens are wins; otherwise `default` applies.
  - `then` rewrites `.fake-ctx/current`.
- Every call appends `{argv, cwd, env: {NO_COLOR, CONTEXO_NO_UPDATE_CHECK, CONTEXO_CLIENT, CONTEXO_DISTILL_DISABLE (only when present)}}` to `<root>/.fake-ctx/calls.jsonl`.
- `test/fake-ctx/bin/ctx.cmd` exists only to test that discovery rejects `.cmd`. WP-2.3 uses `.fake-ctx/current`, not `.fake-ctx/scenario.json`.
- The baseline scenarios are listed in `test/helpers/fixtures.ts` (`BASELINE_SCENARIOS`). Server capabilities in every fixture are exactly `["pages.at","push.expect_absent","write.path_sha"]`. No fixture contains `pages.etag`, an API token or a `credentials.json`; the secret scanners of both marketplaces run over the repository.
- `test/unit/contract/fixtures.test.ts` validates every baseline payload against these schemas.

## 12. Contract evolution

- ADDITIVE changes may ship in any ctx release with `contract_version` unchanged:
  - new optional fields
  - new commands or flags, announced as a new Capability string
  - new ErrorCode, WarningCode, NoteCode or SkipReason values (TS types them `| string`; unknown error codes are handled by exit category)
  - new ServerCapability values
- BREAKING changes bump `contract_version` to 2:
  - removing, renaming or retyping a field
  - changing the meaning of a field
  - a new PageState or ConflictKind value
  - changing an exit-code category
  - changing the one-document-per-invocation rule
- A ctx at contract N MUST keep serving N for at least one minor release after N+1 ships, behind `--contract N`. The extension declares the single contract version it supports (`SUPPORTED_CONTRACT_VERSION = 1`).
- Fixtures are versioned by directory (`testdata/v1`; v2 adds `testdata/v2` alongside).
- Rollout (E39): no installable ctx build may contain the wave-1 CLI engines without WP-2.1's MCP adoption. The allowed early releases are v0.6.7 after WP-0.I (only errors.envelope advertised) and any release from WP-2.I onward.

## Appendix A: where each erratum applies

| Erratum | Subject | Where in this file |
|---|---|---|
| E1 | precedence | header |
| E2 | superseded plan text: exit table, code renames, envelope shape, handshake, states, status fields, on-disk files | 6.2-6.4, 7.1, 5.1, 10 |
| E3 | package `internal/syncops/contract`, fixtures location | 1, 11.1 |
| E4 | frozen Go identifiers (ctx-internal) | 1 |
| E5 | EnsureBase call order and locking | 2.3, 4.2, 4.4, 4.5, 4.6, 10 |
| E6 | Normalize/Hash, the only comparison rule | 3, 10 |
| E7 | push request with expect_absent | 4.5, 7.2 |
| E8 | remote cache removed; sidecars added; reserved values | 4.2, 7.3, 10 |
| E9 | R(P) from sidecars offline; sidecar overlay | 4.2, 5.3, 5.5 |
| E10 | sidecar lifecycle | 4.4, 4.5, 4.6, 10 |
| E11 | EnsureBase decision (old-MCP clobber protection) | 4.2, 10 |
| E12 | EnsureBase request budget; fan-out concurrency <= 4 | 4.2, 4.4, 10 |
| E13 | server headers, no ETag, pages.etag reserved, server_outdated | 2.5, 4.2, 7.2 |
| E14 | HTTP error mapping | 6.6 |
| E15 | X-Contexo-Client | 2.6 |
| E16 | whole-second UTC times | 3 |
| E17 | not_implemented (24 codes) | 6.3, 6.4 |
| E18 | ctx repair, optional capability repair | 4.7, 7.1 |
| E19 | capabilities order and registration | 4.1, 7.1 |
| E20 | show machine mode through a hidden --json flag | 3, 4.3 |
| E21 | when the envelope is emitted | 4.6, 6.1 |
| E22 | status when the remote is unusable | 4.2 |
| E23 | dashboard_url may be '' | 3, 4.2, 11.2 |
| E24 | distill guard bypass and blocks_push | 4.2, 4.5 |
| E25 | exact argv | 2.2 |
| E26 | spawn env | 2.1 |
| E27 | unsaved editors | 2.4 |
| E28 | watcher glob | 2.5 |
| E29 | SourceControl.count | 5.6 |
| E30 | knowledge tree membership | 5.7 |
| E31 | canonical fixture set | 11.1 |
| E32 | manifest and validator | 11.1-11.3 |
| E33 | fixture location, TS tests, fake ctx | 2.7, 11.1, 11.4 |
| E34 | TS location, unions, parseEnvelope fallback | 1, 6.5, 6.7, 7.3 |
| E35 | discovery order | 8.1 |
| E36 | handshake -> BinaryState | 8.2 |
| E37 | first-run notice | 8.3 |
| E38 | Workspace Trust | 8.4 |
| E39 | rollout order | 12 |
| E40 | the scratch prototype is informational only (pages.etag, old paths); nothing here comes from it | - |
| E41 | `.sync/.gitignore` | 10 |
