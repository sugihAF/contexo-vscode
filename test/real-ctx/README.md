# Real-ctx tests (WP-3.1)

The extension against the **real** `ctx` and a **local** `contexo-server`, both built from a
git-archive copy of Contexo `mvp/integration`. Two suites:

- `conformance.real.ts` (plain node mocha, no VS Code): real `ctx` success documents and live
  error envelopes (not_initialized, conflict, distill_required, busy) validated with ajv against
  `contract/schemas` and parsed by `src/contract/types.ts`; every extension-shaped call uses the
  E25 argv (`argv.ts`) and the extension's E26 spawn env (`ctx.ts` goes through
  `src/cli/spawn.ts`). Each case uses fresh projects under `$REAL_CTX_RUN/conf/<case>/` on the
  repo `${REAL_CTX_REPO}-conf`.
- `scenarios.real.ts` (Extension Host, the `real-ctx` label of `.vscode-test.mjs`): two users,
  alice in the Extension Host (the workspace folder) and bob through `CTX_BIN`, plus the agent
  path through `ctx mcp` (`mcpDriver.ts`). Scenarios S1-S7, each on its own `wiki/*/s<n>-*` pages;
  S6 (the D4 guard) runs last.

The vendored WP-2.2 goldens (`test/fixtures/golden/`, `SOURCE.md`) are checked by
`test/unit/contract/golden.test.ts` inside `npm run test:unit`; they need no server.

## Run modes

Get a source tree first (never a checkout: `up`/`build` refuse a `--src` that contains `.git` or
lies under `/Users/sugih/Codes`):

```bash
mkdir -p "$TMPDIR/wp-3.1/contexo-src" && git -C /Users/sugih/Codes/Contexo archive mvp/integration | tar -x -C "$TMPDIR/wp-3.1/contexo-src"
```

Every command that starts VS Code needs the shared download cache:
`export CONTEXO_VSCODE_TEST_CACHE=/Users/sugih/contexo-release/vscode-test-cache`.

1. **One shot** (up, test, then down, also on failure, SIGINT and SIGTERM):

   ```bash
   npm run test:real-ctx:run -- --src "$TMPDIR/wp-3.1/contexo-src"
   # = node scripts/real-ctx-env.mjs run --src "$TMPDIR/wp-3.1/contexo-src"
   ```

2. **Three steps** (keep the environment up between test runs):

   ```bash
   eval "$(node scripts/real-ctx-env.mjs up --src "$TMPDIR/wp-3.1/contexo-src")" && npm run test:real-ctx; rc=$?; node scripts/real-ctx-env.mjs down; exit $rc
   ```

   `test` reads the environment from the exported variables or, when they are absent, from
   `$TMPDIR/contexo-real-ctx/current` → `<run>/env.json`. With neither it exits 2; it never skips.

3. **Headless container** (this Mac's rule, lead ruling L24: no VS Code window on the desktop).
   Build Linux binaries once on the host, then run everything inside the container:

   ```bash
   node scripts/real-ctx-env.mjs build --src "$TMPDIR/wp-3.1/contexo-src" --out .vscode-test/real-ctx-bin/linux-arm64 --goos linux --goarch arm64
   export CONTEXO_VSCODE_TEST_CACHE=/Users/sugih/contexo-release/vscode-test-cache
   HVT_ENV="REAL_CTX_BIN_DIR=/w/.vscode-test/real-ctx-bin/linux-arm64 REAL_CTX_OUT=.vscode-test/out-linux" \
     /Users/sugih/contexo-release/lead/headless-vscode-test "$PWD" test:real-ctx:run
   ```

   `REAL_CTX_BIN_DIR` (or `up --bin <dir>`) uses a `build` output (`BUILD-INFO.json` holds the
   source commit and the sha256 of each binary, re-checked on use). `REAL_CTX_OUT` compiles the
   tests to their own directory, so a container run never writes the host's `out/`. On the host,
   `node scripts/real-ctx-env.mjs run --src … --no-vscode` runs the same up/conformance/down
   without VS Code and prints that the scenarios were skipped.

TDD knobs: `REAL_CTX_SUITES=conformance` or `scenarios` (default both; a left-out suite is named
on stderr) and `REAL_CTX_GREP=<mocha grep>` for the scenarios label.

`node scripts/real-ctx-env.mjs ide` prints an isolated `code` (and `cursor`) launch for a human
pass against the same environment (`up --gui` seeds demo pages); see `test/acceptance/ACCEPTANCE.md`.

`node scripts/real-ctx-env.mjs vendor-golden --src <archive>` re-vendors the goldens (WP-4.1 /
WP-4.I, only when a shape legitimately changes).

## Isolation guarantees

- **Loopback only.** The server binds `CONTEXO_LISTEN_ADDR=127.0.0.1:18080` (never all
  interfaces, never port 8080). `up` refuses when the port is taken or the pointer names a live
  run; `down` asserts the port is free afterwards.
- **No real credentials.** Every `ctx` call, the server, `ctx mcp` and the Extension Host get
  `HOME`/`USERPROFILE` pointing at `$RUN/home-{server,alice,bob}`; `ctx login` writes only there and
  into the run's projects. `go build` keeps the real HOME (GOCACHE/GOMODCACHE). The acceptance run
  checks that the sha256 of `~/.contexo/credentials.json` is unchanged.
- **Nothing from the caller's shell leaks into ctx.** The harness strips `CONTEXO_*` from the env of
  its setup calls; `runCtx` uses the extension's E26 env (`CONTEXO_DISTILL_DISABLE` removed).
- **Everything lives in one run directory**, `RUN=$(realpath $TMPDIR)/contexo-real-ctx/run-XXXXXX`
  (realpath, so the workspace fsPath, `--root` and `StatusDoc.root` agree on macOS):
  `bin/`, `bin-rc/`, `server-data/`, `server.log`, `server.pid`, `env.json` (mode 600),
  `alice/`, `bob/`, `home-*/`, `conf/`, `vscode-user-data/`, `vscode-ext/`, `ide/`. `down` sends
  SIGTERM to the server (SIGKILL after 3 s) and removes the run directory and the pointer.
- **The real-ctx label exists only when `REAL_CTX_ALICE` is set**, so `npm test` and
  `npm run test:e2e` never start it. It runs with `--disable-extensions`, a profile under `$RUN`,
  `contexo.path` = `CTX_BIN` seeded in that profile, and `$RUN/bin` first on PATH.
- **Tests may read `.contexo/.sync`** (base, backup, conflicts.json, lock) to check ctx's work;
  `src/` never does (D1).
- The legacy API key records no activity rows on the server (`recordActivity` skips legacy users),
  so the E15 client-attribution checks log a `NOTE E15:` line instead of asserting.
