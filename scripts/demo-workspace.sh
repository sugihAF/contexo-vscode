#!/usr/bin/env bash
# demo-workspace.sh: a two-user Contexo demo for screenshots and human passes (WP-4.3).
#
#   bash scripts/demo-workspace.sh up     build (or take) ctx + contexo-server, start the server,
#                                         make alice's and bob's workspaces, print alice's status
#                                         counts/captures and the VS Code command to open the demo
#   bash scripts/demo-workspace.sh down   stop the server and delete the demo dir
#
# `up` refuses while a demo is already up (live server pid or port taken): run `down` first.
# A leftover demo dir without a live server is removed and rebuilt. A failed `up` tears down
# what it made. Logs go to stderr; stdout carries only alice's `ctx status --json` counts and
# captures (jq, or node when jq is missing) and the VS Code commands.
#
# What `up` creates (all under DEMO_DIR):
#   bin/ctx, bin/contexo-server     built from CONTEXO_SRC (skipped when CTX_BIN and SERVER_BIN are set)
#   data/                           the server's CONTEXO_DATA_ROOT; the server listens on 127.0.0.1:18282
#   alice/, bob/                    workspace folders (ctx init + ctx auth login, both on repo "demo")
#   home-alice/, home-bob/, home-server/   the HOME/USERPROFILE of every ctx call and of the server
#   vscode-data/, vscode-ext/       the VS Code profile printed for the human (vscode-data/User/settings.json
#                                   sets the machine-scoped "contexo.path"; Workspace Trust stays on)
#   demo.env, server.pid, server.log, .contexo-demo (marker: `down` deletes only a dir that has it)
# alice ends with pages in every SCM state: modified (a concept page), new, incoming, incoming_new,
# conflict (both edited, bob pushed first), invalid (broken frontmatter) and deleted_local, plus a
# fresh pending capture (raw/sessions/_pending/<uuid>.jsonl), so captures.blocks_push is true.
#
# Env overrides:
#   DEMO_DIR     demo dir (default ${TMPDIR:-/tmp}/contexo-demo; resolved through realpath)
#   CONTEXO_SRC  git-archive copy of Contexo to build from (default ${TMPDIR:-/tmp}/wp-4.3/contexo-src)
#   CTX_BIN, SERVER_BIN   prebuilt binaries; when both are set nothing is built (e.g. in a Linux container)
#   VSIX         the extension package to install (default ${TMPDIR:-/tmp}/wp-4.3/contexo-0.2.0.vsix)
#   CODE_CLI     VS Code CLI (default '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code')
#   GOPROXY      for the build (default off: the module cache is already populated)
#
# Isolation guarantees:
#   - DEMO_DIR must not resolve under the real $HOME or /Users/sugih/Codes (nor contain $HOME);
#     `up` and `down` exit 2 otherwise. Nothing is written outside DEMO_DIR except the Go build
#     scratch dir ${TMPDIR:-/tmp}/contexo-demo-go (GOCACHE, plus a scratch HOME so the go command's
#     telemetry/config writes stay out of the real HOME), kept between runs so rebuilds are fast.
#     The build reads GOENV/GOPATH/GOMODCACHE from the real Go setup and never downloads (GOPROXY=off).
#   - Every ctx call runs with HOME/USERPROFILE = DEMO_DIR/home-<user>, so `ctx auth login`'s
#     global credentials land there and never in the real ~/.contexo. CONTEXO_* and
#     GOOGLE_OAUTH_CLIENT_ID from the caller's shell are stripped from every ctx and server env.
#   - The server binds loopback only (CONTEXO_LISTEN_ADDR=127.0.0.1:18282), with its own data root,
#     a random legacy API key, a random session secret and CONTEXO_RATELIMIT_DISABLE=1.
#   - The printed VS Code commands use a profile and extensions dir under DEMO_DIR and set
#     HOME/USERPROFILE to alice's demo home, so ctx spawned by the extension stays isolated too.
#
# Portable: macOS bash 3.2 and Linux bash 5 (no associative arrays, no readarray, no GNU-only flags).
set -euo pipefail

PROG=demo-workspace
HOST=127.0.0.1
PORT=18282
SERVER_URL="http://$HOST:$PORT"
REPO=demo
CODES_DIR=/Users/sugih/Codes
MARKER=.contexo-demo
TMP_BASE=${TMPDIR:-/tmp}
TMP_BASE=${TMP_BASE%/}
[ -n "$TMP_BASE" ] || TMP_BASE=/tmp

log() { printf '%s: %s\n' "$PROG" "$*" >&2; }
die() { log "$1"; exit "${2:-1}"; }
have() { command -v "$1" >/dev/null 2>&1; }

# shq VALUE: VALUE single-quoted for a POSIX shell.
shq() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }

# resolve_path PATH: absolute PATH with the symlinks of its existing prefix resolved (realpath for
# a path that may not exist yet).
resolve_path() {
  local p=$1 rest="" base
  case "$p" in /*) ;; *) p="$PWD/$p" ;; esac
  p=$(printf '%s' "$p" | tr -s /)
  case "$p/" in */./* | */../*) die "path must not contain . or .. components: $1" 2 ;; esac
  while [ "${#p}" -gt 1 ] && [ "${p%/}" != "$p" ]; do p=${p%/}; done
  while [ ! -d "$p" ]; do
    base=${p##*/}
    rest="/$base$rest"
    p=${p%/*}
    [ -n "$p" ] || p=/
  done
  p=$(cd "$p" && pwd -P)
  [ "$p" != / ] || p=""
  printf '%s%s\n' "$p" "$rest"
}

# is_under PATH ROOT: PATH is ROOT or lies under it.
is_under() {
  case "$1/" in "$2"/*) return 0 ;; esac
  return 1
}

# guard_dir PATH WHAT: refuse (exit 2) a dir under the real HOME or /Users/sugih/Codes, one that
# contains the real HOME, or a top-level/system dir.
guard_dir() {
  local d=$1 what=$2 home codes tmp
  home=${HOME:-}
  if [ -n "$home" ] && [ -d "$home" ]; then home=$(cd "$home" && pwd -P); fi
  if [ -z "$home" ] || [ "$home" = / ]; then
    log "note: HOME is unset or /; only the $CODES_DIR guard applies"
  else
    is_under "$d" "$home" && die "$what $d lies under the real HOME ($home): refusing" 2
    is_under "$home" "$d" && die "$what $d contains the real HOME ($home): refusing" 2
  fi
  codes=$CODES_DIR
  if [ -d "$codes" ]; then codes=$(cd "$codes" && pwd -P); fi
  is_under "$d" "$codes" && die "$what $d lies under $CODES_DIR: refusing" 2
  is_under "$CODES_DIR" "$d" && die "$what $d contains $CODES_DIR: refusing" 2
  tmp=$(resolve_path "$TMP_BASE")
  case "$d" in
    "" | / | "$tmp" | /tmp | /private/tmp | /var | /private/var | /usr | /etc | /opt | /root | /home | /Users)
      die "$what $d is a system or top-level dir: refusing" 2 ;;
  esac
  case "$d" in /*/*) ;; *) die "$what $d is a top-level dir: refusing" 2 ;; esac
}

# Caller env with CONTEXO_* and GOOGLE_OAUTH_CLIENT_ID removed: `env "${CLEAN_ENV[@]}" ...`.
CLEAN_ENV=()
for _name in $(compgen -e); do
  case "$(printf '%s' "$_name" | tr '[:lower:]' '[:upper:]')" in
    CONTEXO_* | GOOGLE_OAUTH_CLIENT_ID) CLEAN_ENV+=(-u "$_name") ;;
  esac
done
unset _name
clean_env() { env ${CLEAN_ENV[@]+"${CLEAN_ENV[@]}"} "$@"; }

rand_hex() { od -An -tx1 -N"$1" /dev/urandom | tr -d ' \n'; }

new_uuid() {
  if have uuidgen; then
    uuidgen | tr '[:upper:]' '[:lower:]'
  elif [ -r /proc/sys/kernel/random/uuid ]; then
    cat /proc/sys/kernel/random/uuid
  else
    node -e 'process.stdout.write(require("crypto").randomUUID() + "\n")'
  fi
}

# port_taken: something accepts connections on 127.0.0.1:18282.
port_taken() { (exec 3<>"/dev/tcp/$HOST/$PORT") 2>/dev/null; }

http_get() {
  if have curl; then
    curl -fsS --max-time 2 "$1"
  else
    node -e 'fetch(process.argv[1]).then(async (r) => { if (!r.ok) { process.exit(1); } process.stdout.write(await r.text()); }).catch(() => process.exit(1))' "$1"
  fi
}

pid_alive() { [ -n "${1:-}" ] && kill -0 "$1" 2>/dev/null; }

# ---------- paths ----------

DEMO=$(resolve_path "${DEMO_DIR:-$TMP_BASE/contexo-demo}")
GO_SCRATCH=$(resolve_path "$TMP_BASE/contexo-demo-go")
CONTEXO_SRC=${CONTEXO_SRC:-$TMP_BASE/wp-4.3/contexo-src}
VSIX=${VSIX:-$TMP_BASE/wp-4.3/contexo-0.2.0.vsix}
CODE_CLI=${CODE_CLI:-/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code}

# ---------- ctx as a demo user ----------

# ctx_as USER ARGS...: ctx in USER's workspace with USER's HOME/USERPROFILE (never the real one).
ctx_as() {
  local who=$1 home root
  shift
  home="$DEMO/home-$who"
  root="$DEMO/$who"
  (cd "$root" && clean_env HOME="$home" USERPROFILE="$home" NO_COLOR=1 CONTEXO_NO_UPDATE_CHECK=1 \
    "$CTX" "$@" --root "$root" </dev/null)
}

# ctx_quiet USER ARGS...: ctx_as with its output kept off stdout, shown only on failure.
ctx_quiet() {
  local out
  if ! out=$(ctx_as "$@" 2>&1); then
    log "ctx $* (as $1) failed:"
    printf '%s\n' "$out" >&2
    return 1
  fi
}

# put_page USER REL: the page text on stdin becomes USER's .contexo/REL; @NOW@ is replaced by the
# current time. REL must equal schema.RelPath() of the frontmatter, or the page is invalid.
put_page() {
  local file="$DEMO/$1/.contexo/$2"
  mkdir -p "$(dirname "$file")"
  sed "s/@NOW@/$NOW/g" >"$file"
}

# ---------- build ----------

check_src() {
  local src
  [ -d "$CONTEXO_SRC" ] || die "CONTEXO_SRC $CONTEXO_SRC does not exist (a git-archive copy of Contexo)" 2
  src=$(cd "$CONTEXO_SRC" && pwd -P)
  [ ! -e "$src/.git" ] || die "$src contains .git: build only from a git-archive copy" 2
  local codes=$CODES_DIR
  if [ -d "$codes" ]; then codes=$(cd "$codes" && pwd -P); fi
  is_under "$src" "$codes" && die "$src lies under $CODES_DIR: build only from a git-archive copy" 2
  local rel
  for rel in cmd/ctx cmd/contexo-server go.mod; do
    [ -e "$src/$rel" ] || die "$src is not a Contexo source tree (no $rel)" 2
  done
  printf '%s\n' "$src"
}

# go_build SRC: bin/ctx and bin/contexo-server. The go command runs with a scratch HOME (its
# telemetry and config dirs follow HOME), GOCACHE under the scratch dir and GOPROXY=off; GOENV,
# GOPATH and GOMODCACHE still point at the real Go setup, which is only read.
go_build() {
  local src=$1 gohome goenv gopath gomodcache
  have go || die "go is not on PATH; set CTX_BIN and SERVER_BIN to prebuilt binaries instead" 2
  guard_dir "$GO_SCRATCH" "go scratch dir"
  gohome="$GO_SCRATCH/home"
  mkdir -p "$gohome" "$GO_SCRATCH/cache"
  goenv=${GOENV:-}
  if [ -z "$goenv" ]; then
    case "$(uname -s)" in
      Darwin) goenv="${HOME:-/nonexistent}/Library/Application Support/go/env" ;;
      *) goenv="${XDG_CONFIG_HOME:-${HOME:-/nonexistent}/.config}/go/env" ;;
    esac
  fi
  gopath=${GOPATH:-}
  if [ -z "$gopath" ]; then
    gopath=$(cd "$src" && HOME="$gohome" XDG_CONFIG_HOME="$gohome/.config" GOENV="$goenv" go env GOPATH)
    # The go default ($HOME/go) is the real HOME's, not the scratch HOME's.
    if [ "$gopath" = "$gohome/go" ]; then gopath="${HOME:-$gohome}/go"; fi
  fi
  gomodcache=${GOMODCACHE:-}
  if [ -z "$gomodcache" ]; then
    gomodcache=$(cd "$src" && HOME="$gohome" XDG_CONFIG_HOME="$gohome/.config" GOENV="$goenv" GOPATH="$gopath" go env GOMODCACHE)
  fi
  log "go build ctx + contexo-server from $src (GOCACHE=$GO_SCRATCH/cache GOPROXY=${GOPROXY:-off} GOMODCACHE=$gomodcache, read-only)"
  local t
  for t in ctx contexo-server; do
    (cd "$src" && HOME="$gohome" USERPROFILE="$gohome" XDG_CONFIG_HOME="$gohome/.config" \
      XDG_CACHE_HOME="$gohome/.cache" GOENV="$goenv" GOPATH="$gopath" GOMODCACHE="$gomodcache" \
      GOCACHE="$GO_SCRATCH/cache" GOPROXY="${GOPROXY:-off}" CGO_ENABLED=0 \
      go build -buildvcs=false -o "$DEMO/bin/$t" "./cmd/$t") >&2
  done
}

# ---------- down ----------

stop_server() {
  local pid cmd
  pid=$(cat "$DEMO/server.pid" 2>/dev/null || true)
  if ! pid_alive "$pid"; then return 0; fi
  cmd=$(ps -p "$pid" -o command= 2>/dev/null || true)
  case "$cmd" in
    *contexo-server* | *"${SERVER:-contexo-server}"*) ;;
    *) log "pid $pid is not a contexo-server ($cmd); not killing it"; return 0 ;;
  esac
  kill -TERM "$pid" 2>/dev/null || true
  local i=0
  while pid_alive "$pid" && [ "$i" -lt 50 ]; do sleep 0.1; i=$((i + 1)); done
  if pid_alive "$pid"; then
    log "server pid $pid ignored SIGTERM; SIGKILL"
    kill -KILL "$pid" 2>/dev/null || true
    i=0
    while pid_alive "$pid" && [ "$i" -lt 30 ]; do sleep 0.1; i=$((i + 1)); done
  fi
  log "stopped contexo-server pid $pid"
}

cmd_down() {
  local quiet=${1:-}
  guard_dir "$DEMO" "DEMO_DIR"
  if [ -e "$DEMO" ]; then
    [ -f "$DEMO/$MARKER" ] || die "$DEMO has no $MARKER marker (not a demo dir): not touching it" 2
    if [ -f "$DEMO/demo.env" ]; then SERVER=$(sed -n 's/^SERVER=//p' "$DEMO/demo.env"); fi
    stop_server
    rm -rf "$DEMO"
    log "removed $DEMO"
  elif [ -z "$quiet" ]; then
    log "no demo at $DEMO"
  fi
  if port_taken; then die "$HOST:$PORT is still taken after down"; fi
}

# ---------- up ----------

UP_DONE=0
on_up_exit() {
  local rc=$?
  trap - EXIT INT TERM
  if [ "$UP_DONE" != 1 ]; then
    log "up failed (exit $rc); tearing the demo down"
    (cmd_down quiet) || true
    [ "$rc" -ne 0 ] || rc=1
  fi
  exit "$rc"
}

wait_for_health() {
  local pid=$1 i=0 body
  while [ "$i" -lt 150 ]; do
    if ! pid_alive "$pid"; then
      tail -n 20 "$DEMO/server.log" >&2 || true
      die "contexo-server exited during start-up (log: $DEMO/server.log)"
    fi
    if body=$(http_get "$SERVER_URL/health" 2>/dev/null); then
      case "$body" in
        *'"status":"ok"'* | *'"status": "ok"'*) return 0 ;;
      esac
    fi
    sleep 0.2
    i=$((i + 1))
  done
  die "GET $SERVER_URL/health did not answer ok within 30 s (log: $DEMO/server.log)"
}

start_server() {
  local key secret pid
  key=$(rand_hex 16)
  secret=$(rand_hex 32)
  mkdir -p "$DEMO/home-server" "$DEMO/data"
  (umask 077 && printf 'SERVER=%s\nCTX=%s\nKEY=%s\nURL=%s\n' "$SERVER" "$CTX" "$key" "$SERVER_URL" >"$DEMO/demo.env")
  (cd "$DEMO" && exec nohup env ${CLEAN_ENV[@]+"${CLEAN_ENV[@]}"} \
    HOME="$DEMO/home-server" USERPROFILE="$DEMO/home-server" PORT="$PORT" \
    CONTEXO_LISTEN_ADDR="$HOST:$PORT" CONTEXO_DATA_ROOT="$DEMO/data" CONTEXO_API_KEY="$key" \
    CONTEXO_SESSION_SECRET="$secret" CONTEXO_RATELIMIT_DISABLE=1 \
    "$SERVER" </dev/null >>"$DEMO/server.log" 2>&1) &
  pid=$!
  disown "$pid" 2>/dev/null || true
  printf '%s\n' "$pid" >"$DEMO/server.pid"
  log "contexo-server pid $pid on $SERVER_URL (data $DEMO/data)"
  wait_for_health "$pid"
  log "/health ok"
  API_KEY=$key
}

setup_user() {
  local who=$1 name=$2
  mkdir -p "$DEMO/$who" "$DEMO/home-$who"
  ctx_quiet "$who" init --no-mcp --no-hooks --no-gitignore --no-vscode
  ctx_quiet "$who" auth login --server "$SERVER_URL" --api-key "$API_KEY" --repo "$REPO" \
    --name "$name" --email "$who@example.invalid"
  log "$who: $DEMO/$who (HOME=$DEMO/home-$who)"
}

seed_pages() {
  put_page alice wiki/concepts/retry-policy.md <<'EOF'
---
schema: ctx.page.v1
slug: retry-policy
type: concept
author: alice
agent: claude-code
created: 2026-09-03T10:04:00Z
updated: 2026-09-18T16:40:00Z
parent_sha: ""
sources:
  - 2026-09-18-psp-timeout-incident
related:
  - idempotency-keys
  - webhook-delivery
tags:
  - payments
  - reliability
reasoning_summary: Bounded, jittered retries keep PSP outages from turning into duplicate charges.
---
# Retry policy

Outbound calls from checkout-api to payment service providers (PSPs) are
retried with exponential backoff and full jitter.

## Limits

- Maximum attempts: 8
- Initial delay: 500 ms
- Backoff ceiling: 10 minutes
- Retry only on network errors, HTTP 429 and HTTP 5xx

## Idempotency

Every retry reuses the original idempotency key, so a PSP that already
processed the first attempt returns the stored result instead of charging
twice. See [[idempotency-keys]].

## Never retried

- HTTP 4xx other than 429: the request itself is wrong.
- Card declines: a decline is an answer, not a failure.
EOF

  put_page alice wiki/concepts/idempotency-keys.md <<'EOF'
---
schema: ctx.page.v1
slug: idempotency-keys
type: concept
author: alice
agent: claude-code
created: 2026-09-03T10:12:00Z
updated: 2026-09-03T10:12:00Z
parent_sha: ""
related:
  - retry-policy
tags:
  - payments
  - api
reasoning_summary: Replaying the first stored response makes ambiguous PSP timeouts safe to retry.
---
# Idempotency keys

Every mutating request to checkout-api (`POST /payments`, `POST /refunds`,
`POST /captures`) must carry an `Idempotency-Key` header.

## Rules

- The key is a client-generated UUID v4, one per logical operation.
- The first response for a key is stored and replayed for every repeat.
- Keys are kept for 24 hours, then purged.
- A repeat with a different request body returns `409 idempotency_mismatch`.

## Why

PSP timeouts are ambiguous: the charge may or may not have happened.
Replaying the stored response makes retries safe. See [[retry-policy]].
EOF

  put_page alice wiki/concepts/rate-limits.md <<'EOF'
---
schema: ctx.page.v1
slug: rate-limits
type: concept
author: alice
created: 2026-09-05T08:30:00Z
updated: 2026-09-05T08:30:00Z
parent_sha: ""
related:
  - retry-policy
tags:
  - api
  - reliability
---
# Rate limits

checkout-api enforces token-bucket limits per API key.

| Endpoint            | Sustained | Burst |
|---------------------|-----------|-------|
| POST /payments      | 50 rps    | 100   |
| POST /refunds       | 10 rps    | 20    |
| GET /payments/{id}  | 200 rps   | 400   |

A rejected request gets HTTP 429 with a `Retry-After` header in seconds.
Clients must honour it; see [[retry-policy]].
EOF

  put_page alice wiki/concepts/auth-flow.md <<'EOF'
---
schema: ctx.page.v1
slug: auth-flow
type: concept
author: alice
agent: claude-code
created: 2026-09-08T13:15:00Z
updated: 2026-09-21T09:02:00Z
parent_sha: ""
related:
  - ledger-service
  - q3-chargeback-review
tags:
  - payments
  - cards
reasoning_summary: Authorize at checkout and capture at fulfilment, so the final amount is never above what the customer approved.
---
# Auth flow

Card payments use two steps: authorize at checkout, capture at fulfilment.

1. `POST /payments` authorizes the amount and returns `requires_capture`.
2. The order service ships, then calls `POST /captures` with the final
   amount (it may be lower than the authorized amount, never higher).
3. Uncaptured authorizations expire after 7 days and the ledger releases
   the hold. See [[ledger-service]].

## 3-D Secure

When the issuer asks for step-up, step 1 returns `requires_action` with a
challenge URL. The client completes the challenge, then polls the payment.
EOF

  put_page alice wiki/concepts/webhook-delivery.md <<'EOF'
---
schema: ctx.page.v1
slug: webhook-delivery
type: concept
author: alice
created: 2026-09-10T11:20:00Z
updated: 2026-09-10T11:20:00Z
parent_sha: ""
related:
  - retry-policy
tags:
  - webhooks
  - reliability
---
# Webhook delivery

Merchants receive `payment.*` and `refund.*` events at their registered
endpoint.

- Signed with HMAC-SHA256 in the `X-Signature` header (timestamp + body).
- At-least-once: merchants must dedupe on `event.id`.
- Retried for 3 days with backoff: 1 min, 5 min, 30 min, then hourly.
- An endpoint that fails for 3 days is disabled and the merchant is emailed.

Ordering is not guaranteed; consumers compare `event.created` before
applying a state change.
EOF

  put_page alice wiki/entities/ledger-service.md <<'EOF'
---
schema: ctx.page.v1
slug: ledger-service
type: entity
author: alice
created: 2026-09-02T15:00:00Z
updated: 2026-09-02T15:00:00Z
parent_sha: ""
related:
  - settlement-windows
tags:
  - ledger
---
# Ledger service

Owns double-entry postings for every money movement.

- Every payment, refund, fee and payout is a balanced set of postings.
- Postings are append-only; corrections are new reversing entries.
- Exposes `POST /postings` (internal) and nightly balance snapshots.
- On-call rotation: payments-core.

Upstream: checkout-api, settlement-batcher. Downstream: finance exports.
See [[settlement-windows]].
EOF

  put_page alice wiki/entities/payment-gateway-adapter.md <<'EOF'
---
schema: ctx.page.v1
slug: payment-gateway-adapter
type: entity
author: alice
created: 2026-09-04T09:45:00Z
updated: 2026-09-04T09:45:00Z
parent_sha: ""
related:
  - retry-policy
tags:
  - payments
  - psp
---
# Payment gateway adapter

The one place checkout-api talks to PSPs. It maps our payment model to
each PSP's API and normalizes their errors into `card_declined`,
`psp_unavailable` and `invalid_request`.

- Two PSPs in production; routing by card network and currency.
- Applies [[retry-policy]] and forwards idempotency keys unchanged.
- The circuit breaker opens after 20 consecutive `psp_unavailable` errors.
EOF

  put_page alice wiki/entities/legacy-soap-bridge.md <<'EOF'
---
schema: ctx.page.v1
slug: legacy-soap-bridge
type: entity
author: alice
created: 2026-09-02T15:30:00Z
updated: 2026-09-02T15:30:00Z
parent_sha: ""
tags:
  - legacy
---
# Legacy SOAP bridge

Translates the 2019 SOAP payment API for the three merchants still on it.
Scheduled for removal once they move to the REST API.
EOF

  put_page alice wiki/analyses/settlement-windows.md <<'EOF'
---
schema: ctx.page.v1
slug: settlement-windows
type: analysis
author: alice
agent: claude-code
created: 2026-09-12T10:00:00Z
updated: 2026-09-12T10:00:00Z
parent_sha: ""
related:
  - ledger-service
tags:
  - settlement
  - payouts
reasoning_summary: Payouts wait for the settle date, so cut-off times decide when merchants are paid.
---
# Settlement windows

How long money takes from capture to payout, per PSP and currency.

| PSP   | Currency | Capture cut-off (UTC) | Funds settle |
|-------|----------|-----------------------|--------------|
| PSP A | USD      | 21:00                 | T+1          |
| PSP A | EUR      | 16:00                 | T+2          |
| PSP B | GBP      | 18:00                 | T+1          |

Captures after the cut-off roll into the next window, so Friday-evening
EUR captures settle on Tuesday. Payout scheduling in [[ledger-service]]
waits for the settle date, not the capture date.
EOF

  put_page alice wiki/analyses/q3-chargeback-review.md <<'EOF'
---
schema: ctx.page.v1
slug: q3-chargeback-review
type: analysis
author: alice
created: 2026-10-06T14:10:00Z
updated: 2026-10-06T14:10:00Z
parent_sha: ""
related:
  - auth-flow
tags:
  - disputes
  - fraud
---
# Q3 chargeback review

Chargebacks fell from 0.62% to 0.48% of card volume between Q2 and Q3.

## What changed

- 3-D Secure step-up for first-time cards over 150 EUR (see [[auth-flow]]).
- Address verification is now blocking for digital goods.

## Remaining hotspots

- Friendly fraud on subscription renewals: 41% of Q3 disputes.
- Two merchants account for a quarter of all disputes; their account
  managers are following up.
EOF

  put_page alice raw/sessions/2026-09-18-psp-timeout-incident.md <<'EOF'
---
schema: ctx.page.v1
slug: 2026-09-18-psp-timeout-incident
type: source
author: alice
agent: claude-code
created: 2026-09-18T16:30:00Z
updated: 2026-09-18T16:30:00Z
parent_sha: ""
tags:
  - incident
  - psp
---
# PSP timeout incident (2026-09-18)

Session notes from debugging elevated `psp_unavailable` errors.

- 14:05 UTC: PSP A p99 latency rose from 900 ms to 12 s.
- Retries tripled outbound traffic and hit the PSP's rate limit.
- Duplicate-charge check: none; idempotency keys were replayed correctly.
- Follow-ups: cap retries during PSP incidents, alert on retry volume.
EOF
}

# bob pushes first: his edit of idempotency-keys becomes alice's conflict.
bob_edit_idempotency() {
  put_page bob wiki/concepts/idempotency-keys.md <<'EOF'
---
schema: ctx.page.v1
slug: idempotency-keys
type: concept
author: bob
agent: claude-code
created: 2026-09-03T10:12:00Z
updated: @NOW@
parent_sha: ""
related:
  - retry-policy
tags:
  - payments
  - api
reasoning_summary: Replaying the first stored response makes ambiguous PSP timeouts safe to retry.
---
# Idempotency keys

Every mutating request to checkout-api (`POST /payments`, `POST /refunds`,
`POST /captures`) must carry an `Idempotency-Key` header.

## Rules

- The key is a client-generated UUID v4, one per logical operation.
- The first response for a key is stored and replayed for every repeat.
- Keys are kept for 72 hours, then purged, so retries queued over a
  weekend still deduplicate.
- A repeat with a different request body returns `409 idempotency_mismatch`.

## Why

PSP timeouts are ambiguous: the charge may or may not have happened.
Replaying the stored response makes retries safe. See [[retry-policy]].
EOF
}

bob_edit_rate_limits_and_rounding() {
  put_page bob wiki/concepts/rate-limits.md <<'EOF'
---
schema: ctx.page.v1
slug: rate-limits
type: concept
author: bob
created: 2026-09-05T08:30:00Z
updated: @NOW@
parent_sha: ""
related:
  - retry-policy
tags:
  - api
  - reliability
---
# Rate limits

checkout-api enforces token-bucket limits per API key.

| Endpoint            | Sustained | Burst |
|---------------------|-----------|-------|
| POST /payments      | 50 rps    | 150   |
| POST /refunds       | 10 rps    | 20    |
| GET /payments/{id}  | 200 rps   | 400   |

A rejected request gets HTTP 429 with a `Retry-After` header in seconds.
Clients must honour it; see [[retry-policy]].

## Per-merchant limits

Platforms that call on behalf of many merchants also get a per-merchant
bucket (20 rps on `POST /payments`), so one noisy merchant cannot starve
the others behind the same API key.
EOF

  put_page bob wiki/concepts/currency-rounding.md <<'EOF'
---
schema: ctx.page.v1
slug: currency-rounding
type: concept
author: bob
created: @NOW@
updated: @NOW@
parent_sha: ""
related:
  - ledger-service
tags:
  - payments
  - fx
---
# Currency rounding

Amounts are integers in the currency's minor unit (cents for USD, yen for
JPY). Never use floats.

- Zero-decimal currencies (JPY, KRW): the minor unit is the major unit.
- Three-decimal currencies (KWD, BHD): multiply by 1000.
- FX conversion rounds half-to-even once, at the last step.

See [[ledger-service]] for how rounding residue is posted.
EOF
}

alice_local_changes() {
  # modified (a concept page: half of the distill guard)
  put_page alice wiki/concepts/retry-policy.md <<'EOF'
---
schema: ctx.page.v1
slug: retry-policy
type: concept
author: alice
agent: claude-code
created: 2026-09-03T10:04:00Z
updated: @NOW@
parent_sha: ""
sources:
  - 2026-09-18-psp-timeout-incident
related:
  - idempotency-keys
  - webhook-delivery
  - rate-limits
tags:
  - payments
  - reliability
reasoning_summary: Bounded, jittered retries keep PSP outages from turning into duplicate charges; inside a PSP maintenance window retries are capped and deferred.
---
# Retry policy

Outbound calls from checkout-api to payment service providers (PSPs) are
retried with exponential backoff and full jitter.

## Limits

- Maximum attempts: 8
- Initial delay: 500 ms
- Backoff ceiling: 10 minutes
- Retry only on network errors, HTTP 429 and HTTP 5xx

## PSP maintenance windows

During a PSP's announced maintenance window the client caps retries at 3
attempts and parks the rest in the `psp-deferred` queue, which drains
when the window closes. Retrying through the window only burned the PSP's
rate limit (see [[rate-limits]]) and slowed recovery.

## Idempotency

Every retry reuses the original idempotency key, so a PSP that already
processed the first attempt returns the stored result instead of charging
twice. See [[idempotency-keys]].

## Never retried

- HTTP 4xx other than 429: the request itself is wrong.
- Card declines: a decline is an answer, not a failure.
EOF

  # conflict (bob already pushed his own edit of this page)
  put_page alice wiki/concepts/idempotency-keys.md <<'EOF'
---
schema: ctx.page.v1
slug: idempotency-keys
type: concept
author: alice
agent: claude-code
created: 2026-09-03T10:12:00Z
updated: @NOW@
parent_sha: ""
related:
  - retry-policy
tags:
  - payments
  - api
reasoning_summary: Replaying the first stored response makes ambiguous PSP timeouts safe to retry.
---
# Idempotency keys

Every mutating request to checkout-api (`POST /payments`, `POST /refunds`,
`POST /captures`) must carry an `Idempotency-Key` header.

## Rules

- The key is a client-generated UUID v4, one per logical operation.
- The first response for a key is stored and replayed for every repeat.
- Keys are kept for 7 days, then purged: the mobile app replays offline
  payments up to 5 days later.
- A repeat with a different request body returns `409 idempotency_mismatch`.

## Why

PSP timeouts are ambiguous: the charge may or may not have happened.
Replaying the stored response makes retries safe. See [[retry-policy]].
EOF

  # new
  put_page alice wiki/analyses/refund-latency.md <<'EOF'
---
schema: ctx.page.v1
slug: refund-latency
type: analysis
author: alice
agent: claude-code
created: @NOW@
updated: @NOW@
parent_sha: ""
related:
  - settlement-windows
tags:
  - refunds
  - support
reasoning_summary: Most missing-refund tickets arrive after day 5, so sharing the ARN early should deflect them.
---
# Refund latency

Time from `POST /refunds` to funds back on the card, last 30 days.

| PSP   | p50    | p90    |
|-------|--------|--------|
| PSP A | 2 days | 6 days |
| PSP B | 4 days | 9 days |

Support tickets about missing refunds spike after day 5. Proposal: put the
refund ARN (acquirer reference number) in the refund email so customers
can chase their bank directly.
EOF

  # invalid (a typo in the frontmatter type)
  put_page alice wiki/entities/payment-gateway-adapter.md <<'EOF'
---
schema: ctx.page.v1
slug: payment-gateway-adapter
type: entitiy
author: alice
created: 2026-09-04T09:45:00Z
updated: @NOW@
parent_sha: ""
related:
  - retry-policy
tags:
  - payments
  - psp
---
# Payment gateway adapter

The one place checkout-api talks to PSPs. It maps our payment model to
each PSP's API and normalizes their errors into `card_declined`,
`psp_unavailable` and `invalid_request`.

- Three PSPs in production from November; routing by card network and currency.
- Applies [[retry-policy]] and forwards idempotency keys unchanged.
- The circuit breaker opens after 20 consecutive `psp_unavailable` errors.
EOF

  # deleted_local
  rm -f "$DEMO/alice/.contexo/wiki/entities/legacy-soap-bridge.md"

  # A fresh pending capture (capture.TurnRecord lines, under 6 h old): the other half of the guard.
  local sid dir
  sid=$(new_uuid)
  dir="$DEMO/alice/.contexo/raw/sessions/_pending"
  mkdir -p "$dir"
  {
    printf '{"ts":"%s","turn":1,"user":"%s","assistant":"%s","tools":["Read"]}\n' "$NOW" \
      "PSP A has a maintenance window tonight and our retries hammered them last time. What should the retry policy do inside a window?" \
      "Cap retries at 3 attempts inside an announced window and park the rest in a deferred queue that drains when the window closes. In the 2026-09-18 incident, retrying through the outage tripled outbound traffic and hit the PSP rate limit."
    printf '{"ts":"%s","turn":2,"user":"%s","assistant":"%s","tools":["Read","Edit"]}\n' "$NOW" \
      "Do it, and update the retry policy page." \
      "Updated wiki/concepts/retry-policy.md with a PSP maintenance windows section: 3 attempts, then the psp-deferred queue."
  } >"$dir/$sid.jsonl"
  log "alice: pending capture raw/sessions/_pending/$sid.jsonl"
}

print_status() {
  local doc=$1
  if have jq; then
    printf '%s\n' "$doc" | jq '.counts, .captures'
  elif have node; then
    printf '%s\n' "$doc" | node -e 'const d = JSON.parse(require("fs").readFileSync(0, "utf8")); for (const k of ["counts", "captures"]) { console.log(JSON.stringify(d[k], null, 2)); }'
  else
    log "neither jq nor node is on PATH: printing the whole status document"
    printf '%s\n' "$doc"
  fi
}

# status_shape_ok DOC: live remote, every demo state >= 1 and captures.blocks_push true.
status_shape_ok() {
  if have jq; then
    printf '%s\n' "$1" | jq -e '.remote.source == "live" and (.counts | .modified >= 1 and .new >= 1 and .incoming >= 1 and .incoming_new >= 1 and .conflict >= 1 and .invalid >= 1) and .captures.blocks_push == true' >/dev/null
  elif have node; then
    printf '%s\n' "$1" | node -e 'const d = JSON.parse(require("fs").readFileSync(0, "utf8")); const c = d.counts; process.exit(d.remote.source === "live" && ["modified", "new", "incoming", "incoming_new", "conflict", "invalid"].every((k) => c[k] >= 1) && d.captures.blocks_push === true ? 0 : 1)'
  else
    return 0
  fi
}

write_vscode_profile() {
  local esc
  mkdir -p "$DEMO/vscode-data/User" "$DEMO/vscode-ext"
  esc=$(printf '%s' "$CTX" | sed 's/\\/\\\\/g; s/"/\\"/g')
  printf '{\n  "contexo.path": "%s"\n}\n' "$esc" >"$DEMO/vscode-data/User/settings.json"
  local sock="$DEMO/vscode-data/1.10-shared.sock"
  if [ "${#sock}" -gt 103 ]; then
    log "warning: $DEMO/vscode-data is long; VS Code's IPC socket path may exceed 103 characters (set DEMO_DIR shorter)"
  fi
}

print_vscode_commands() {
  local env_prefix profile code
  env_prefix="HOME=$(shq "$DEMO/home-alice") USERPROFILE=$(shq "$DEMO/home-alice")"
  code=$(shq "$CODE_CLI")
  profile="--user-data-dir $(shq "$DEMO/vscode-data") --extensions-dir $(shq "$DEMO/vscode-ext")"
  [ -f "$VSIX" ] || log "warning: VSIX $VSIX does not exist yet (npm run package, or set VSIX)"
  [ -x "$CODE_CLI" ] || log "note: CODE_CLI $CODE_CLI is not executable here"
  printf '\n# Contexo demo is up: server %s, alice %s, bob %s\n' "$SERVER_URL" "$DEMO/alice" "$DEMO/bob"
  printf '# VS Code profile %s (User/settings.json sets contexo.path to %s).\n' "$DEMO/vscode-data" "$CTX"
  printf '# 1. Install the extension into the demo profile:\n'
  printf '%s %s %s --install-extension %s\n' "$env_prefix" "$code" "$profile" "$(shq "$VSIX")"
  printf "# 2. Open alice's workspace (trust the folder once when VS Code asks):\n"
  printf '%s %s %s %s\n' "$env_prefix" "$code" "$profile" "$(shq "$DEMO/alice")"
  printf "# bob's terminal (the CLI teammate):\n"
  printf 'HOME=%s USERPROFILE=%s %s <command> --root %s\n' "$(shq "$DEMO/home-bob")" "$(shq "$DEMO/home-bob")" \
    "$(shq "$CTX")" "$(shq "$DEMO/bob")"
  printf '# Tear down: bash scripts/demo-workspace.sh down\n'
}

cmd_up() {
  guard_dir "$DEMO" "DEMO_DIR"
  if [ -e "$DEMO" ]; then
    [ -d "$DEMO" ] || die "DEMO_DIR $DEMO exists and is not a directory" 2
    if [ ! -f "$DEMO/$MARKER" ]; then
      [ -z "$(ls -A "$DEMO")" ] || die "DEMO_DIR $DEMO exists and is not a demo dir (no $MARKER): refusing" 2
    else
      local old
      old=$(cat "$DEMO/server.pid" 2>/dev/null || true)
      pid_alive "$old" && die "the demo is already up ($DEMO, server pid $old): run \`bash scripts/demo-workspace.sh down\` first"
      log "removing the stale demo $DEMO"
      rm -rf "$DEMO"
    fi
  fi
  port_taken && die "$HOST:$PORT is already taken: refusing to start (run down, or stop whatever holds the port)"
  have git || die "git is not on PATH: contexo-server's page store runs git" 2
  have curl || have node || die "neither curl nor node is on PATH (needed for the /health check)" 2

  # Prebuilt binaries or a build; checked before anything is created.
  local src=""
  if [ -n "${CTX_BIN:-}" ] && [ -n "${SERVER_BIN:-}" ]; then
    [ -x "$CTX_BIN" ] || die "CTX_BIN $CTX_BIN is not executable" 2
    [ -x "$SERVER_BIN" ] || die "SERVER_BIN $SERVER_BIN is not executable" 2
    CTX=$(cd "$(dirname "$CTX_BIN")" && pwd -P)/$(basename "$CTX_BIN")
    SERVER=$(cd "$(dirname "$SERVER_BIN")" && pwd -P)/$(basename "$SERVER_BIN")
  elif [ -n "${CTX_BIN:-}" ] || [ -n "${SERVER_BIN:-}" ]; then
    die "set both CTX_BIN and SERVER_BIN (prebuilt), or neither (build from CONTEXO_SRC)" 2
  else
    src=$(check_src)
    CTX="$DEMO/bin/ctx"
    SERVER="$DEMO/bin/contexo-server"
  fi

  mkdir -p "$DEMO"
  : >"$DEMO/$MARKER"
  trap on_up_exit EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  log "demo dir $DEMO"
  [ -z "$src" ] || go_build "$src"
  [ -n "$src" ] || log "using prebuilt CTX_BIN=$CTX SERVER_BIN=$SERVER"

  NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  start_server
  setup_user alice Alice
  setup_user bob Bob

  # alice seeds the knowledge base; bob pulls it.
  seed_pages
  ctx_quiet alice push --json -m "Seed the checkout knowledge base"
  ctx_quiet bob pull --json
  log "alice pushed the seed pages; bob pulled them"

  # bob: one edit that will collide with alice's, then an incoming edit and a new page.
  bob_edit_idempotency
  ctx_quiet bob push --json -m "Idempotency keys: keep them 72 hours"
  bob_edit_rate_limits_and_rounding
  ctx_quiet bob push --json -m "Per-merchant rate limits; currency rounding rules"
  log "bob pushed: idempotency-keys, rate-limits, currency-rounding"

  # alice: local edits (modified, conflict, new, invalid, deleted_local) and a pending capture.
  alice_local_changes
  write_vscode_profile

  local doc
  doc=$(ctx_as alice status --json)
  UP_DONE=1
  print_status "$doc"
  print_vscode_commands
  if ! status_shape_ok "$doc"; then
    log "WARNING: alice's status lacks a demo state, a live remote or captures.blocks_push; the demo stays up for inspection (run down when done)"
    exit 1
  fi
  log "demo up; alice's status has every demo state and captures.blocks_push=true"
}

case "${1:-}" in
  up) cmd_up ;;
  down) cmd_down ;;
  *) die "usage: bash scripts/demo-workspace.sh up|down (see the header of this file)" 2 ;;
esac
