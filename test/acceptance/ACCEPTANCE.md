# Contexo VS Code extension: GUI acceptance checklist (v1)

Version 1, written by WP-3.1 against a local loopback server and the ctx built from Contexo
`mvp/integration`. WP-6.1 owns this file next (v2 adds row E0 and the hosted + rc run). Rows use
WP-6.1's numbering (E1-E20). Contract errata win over everything here (E1): Restricted Mode
disables the extension entirely (E38), the SCM badge counts conflict + modified + new only
(E29), the tree lists every entry with a local file and puts invalid pages under an Invalid node
(E30), the first-run notice is E37, unsaved editors get the E27 modal, Open in dashboard is
disabled when `dashboard_url` is "" (E23), and the error codes are `distill_required` (exit 9)
and `busy` (exit 12) (E2).

## Local environment (WP-3.1)

The local column runs against `scripts/real-ctx-env.mjs` (see `test/real-ctx/README.md`):

```bash
eval "$(node scripts/real-ctx-env.mjs up --src "$TMPDIR/wp-3.1/contexo-src" --gui)"   # server 127.0.0.1:18080, alice + bob, demo pages
npm run package                                                                        # dist/contexo-<version>.vsix
node scripts/real-ctx-env.mjs ide                                                      # prints the isolated launch commands
# ... walk the rows ...
node scripts/real-ctx-env.mjs down
```

`ide` prints, for `code` (and `cursor` when it is on PATH):

```bash
HOME=$REAL_CTX_HOME_ALICE USERPROFILE=$REAL_CTX_HOME_ALICE PATH=$RUN/bin:"$PATH" code --user-data-dir $RUN/ide/code-user-data --extensions-dir $RUN/ide/code-ext --install-extension dist/contexo-<version>.vsix
HOME=$REAL_CTX_HOME_ALICE USERPROFILE=$REAL_CTX_HOME_ALICE PATH=$RUN/bin:"$PATH" code --user-data-dir $RUN/ide/code-user-data --extensions-dir $RUN/ide/code-ext $REAL_CTX_ALICE
```

bob is the CLI teammate: `HOME=$REAL_CTX_HOME_BOB $CTX_BIN <command> --root $REAL_CTX_BOB`.

Column legend. **local pass (WP-3.1)**: `auto: <case>` names the headless test that covers the
row (real ctx: `S<n>` in test/real-ctx/scenarios.real.ts, `conf:<case>` in
test/real-ctx/conformance.real.ts; fake ctx: the WP-2.3 e2e suite), `deferred to WP-6.1 (L26)`
marks the visual parts left for the one human GUI session (lead ruling L26: the WP-3.1 first pass
is folded into WP-6.1's). **hosted+rc (WP-6.1)**: filled by WP-6.1.

## Rows

| Row | Preconditions | Steps | Expected result | Evidence | local pass (WP-3.1) | hosted+rc (WP-6.1) |
|---|---|---|---|---|---|---|
| E1 | Discovery and handshake (E35/E36). Isolated profiles per case. | E1a: no ctx anywhere in the discovery order. E1b: ctx 0.6.6 first on PATH. E1c: the build under test (dev or 0.7.0-rc.1) via contexo.path / PATH; reload once. E1d: ctx only in ~/.local/bin, VS Code launched from the Dock. E1e (optional): a contract_version 2 ctx. | E1a: 'ctx not found' (ctxMissing) with Install ctx. E1b: ctxTooOld naming 0.6.6 with Update ctx; the Contexo log shows only the version call. E1c: the handshake passes for 'dev' and '0.7.0-rc.1' alike; the first-run notice 'Contexo is using ctx <version>. Restart your agent sessions so their Contexo MCP server runs this ctx; older MCP servers can still overwrite local edits.' appears once and not again after the reload (E37). E1d: found (discovery step 3). E1e: 'update the extension' (extensionTooOld). | Screenshots of each welcome view; Contexo log lines 'ctx … exit=0'. | auto: conf:version (dev and 0.7.0-rc.1 map to BinaryState ok), S1 (the Extension Host runs CTX_BIN); fake ctx: onboarding e2e (ctxMissing, tooOld, extensionTooOld, E37 once per version). E1d and the visual check: deferred to WP-6.1 (L26) | |
| E1a | see E1 | see E1 | see E1 | see E1 | deferred to WP-6.1 (L26) | |
| E1d | see E1 | see E1 | see E1 | see E1 | deferred to WP-6.1 (L26) | |
| E2 | A .contexo folder opened in Restricted Mode (untrusted). | Open the folder without trusting it; open the Extensions view and the Contexo activity bar; then trust the folder. | VS Code shows Contexo as disabled in Restricted Mode: no Contexo views, no welcome view, and no ctx process is spawned (`pgrep -fl ctx` empty, no Contexo log). After Trust, it activates. There is no 'untrusted' welcome view (E38). | Screenshot of the Extensions view; `pgrep` output. | deferred to WP-6.1 (L26) (manifest pinned by check:manifest: untrustedWorkspaces.supported false) | |
| E3 | A plain folder (no .contexo). | Open the Contexo view; click Initialize Contexo. | The 'No Contexo project in this workspace' welcome; Initialize opens a terminal running `ctx init --root <folder>` (no shell); the view switches without a reload (watcher on '.contexo/*.json', E28). | Screenshot; terminal title. | auto: conf:not_initialized (status --json in an empty dir: exit 5, ctx.error.v1); fake ctx: onboarding e2e (noRepositories, Initialize Contexo). Visual: deferred to WP-6.1 (L26) | |
| E4 | A project with no credentials (logged out). | Open it; click Log In; optionally finish the login. | The 'not logged in' welcome. Log In opens an integrated terminal running `ctx auth login` with no shell; the `--no-browser` paste flow is documented in the view. Completing it refreshes the view without a reload (E28). | Screenshot; terminal. | fake ctx: onboarding e2e (not_authenticated → Log In → online refresh). Visual: deferred to WP-6.1 (L26) | |
| E5 | alice seeded (`up --gui`) plus one broken page and one bob-only page. | Open the Knowledge view. | Pages grouped by frontmatter type with the seeded counts; the broken page under an 'Invalid' node; incoming_new and deleted_local entries not listed (E30); unverified entries listed with a decoration; the pending-capture item and badge appear after E12's agent turn. | Screenshot of the tree. | auto: S7 (the broken s7 page is under the tree's Invalid node and in the Invalid SCM group, E30), S6 (captures.blocks_push with a pending buffer). Visual: deferred to WP-6.1 (L26) | |
| E6 | alice has a pushed entity page. | Edit and save it. Click it in Changes. | It appears in Changes within about 2 s; clicking opens a base-to-local diff whose left side is a read-only contexo: document; the gutter quick diff shows the hunk; the M decoration shows in the Explorer and the tree; the SCM badge == conflict + modified + new (E29). | Screenshot of the diff and badge. | auto: S2 (Changes within 2.5 s; the quick-diff original read through workspace.fs equals `ctx show --at base` == .sync/base bytes), S1 (SourceControl.count == 1 after one edit, E29). Visual: deferred to WP-6.1 (L26) | |
| E7 | — | Create a new page file. | It shows under New with an A decoration. | Screenshot. | auto: S1 (5 new s1 pages pushed from the SCM input box). Decoration visual: deferred to WP-6.1 (L26) | |
| E7b | A pushed page. | Delete its file. Then Restore Server Version. | It shows in Changes as deleted_local with the tooltip 'Deleted locally. Deletes are not synced in this version; Restore Server Version brings it back.' and is NOT counted in the badge (E29). Restore Server Version brings it back. | Screenshot; badge value. | fake ctx: WP-2.3 e2e (deleted_local tooltip and count). Real-ctx visual: deferred to WP-6.1 (L26) | |
| E8 | alice edited 1 of 5 pushed pages. | Type a message in the SCM input box and press Cmd/Ctrl+Enter. Push again. | Only the changed page is pushed; `ctx status --json --root <alice>` shows that only its remote.sha moved, with base.sha == remote.sha; the status-bar up count drops to 0; a second Push sends nothing. E8b (E27): with an unsaved edit, Push shows the modal '<N> unsaved Contexo page(s)' with Save All and Continue; Cancel pushes nothing. | `ctx status --json` excerpt; screenshot. | auto: S1 (input-box push of 5 pages, one edit → PushDoc.pushed 1, 0 conflicts, second Push sends nothing, bob sees exactly 1 incoming then 0 after pull); fake ctx: e7/e2e dirty-guard push modal. Visual: deferred to WP-6.1 (L26) | |
| E9 | bob is logged in on the same repo. | bob: `ctx push --json --yes -m E9 --root $REAL_CTX_BOB`. alice: Refresh or window focus. | alice sees the page in Incoming with a down count and a server-to-local diff. Incoming counts in the badge only when contexo.scm.countIncoming is on (E29). | Screenshot; badge with the setting off and on. | auto: S1 (bob's online status shows alice's edit as exactly 1 incoming), S3 (bob's push shows in alice's Conflicts after Refresh). alice-side Incoming visual: deferred to WP-6.1 (L26) | |
| E10 | alice has an incoming page and a locally modified page. | Pull. E10b: repeat with an unsaved buffer. | Pull writes the incoming page, skips the locally modified page and lists it; its bytes are unchanged (shasum before and after). E10b: the E27 modal '<N> unsaved Contexo page(s)'. | shasum before and after; the pull summary. | auto: S3 (Pull leaves alice's conflicting file sha256-identical and skips it with reason conflict; the unsaved-buffer E27 modal through the Prompts seam; Cancel runs no ctx), conf:pull (skipped + adopted, then up-to-date). Visual: deferred to WP-6.1 (L26) | |
| E11 | Both alice and bob edited the same page. | Refresh. Keep Mine, then Push. Repeat the conflict and use Take Server Version. Repeat with the target buffer dirty. E11b (optional): bob pushes again while the diff is open, then Keep Mine. | The page is in Conflicts. Keep Mine moves it to Changes and Push succeeds (bob then sees alice's text). Take Server Version makes it unchanged and leaves a backup under .contexo/.sync/backup/. With a dirty target buffer Take Server Version refuses with 'Save or revert <file> first' (E27). E11b: stale (exit 6) refreshes and re-opens the diff, no unhandled error. | Screenshots; the backup file path. | auto: S3 (conflict round trip incl. the E9 offline sidecar, E27 refusals, Take Server Version bytes == `show --at server` + backup, Keep Mine + Push, the stale case), S5 (agent side). Visual: deferred to WP-6.1 (L26) | |
| E12 | alice with a real Claude Code Stop hook: `HOME=$REAL_CTX_HOME_ALICE ctx hooks install --tool=claude --root $REAL_CTX_ALICE` (writes the project-relative .claude/settings.json). | 1. Start a short real Claude Code session in $REAL_CTX_ALICE with `PATH=$RUN/bin:$PATH` (your normal HOME, so Claude stays logged in); ask it one question so the Stop hook writes a buffer under .contexo/raw/sessions/_pending/. 2. Edit a CONCEPT page in VS Code. 3. Push. 4. Ask the agent to push with its ctx_push tool. 5. Push again from VS Code. E12b: quit VS Code and relaunch it from a shell with `CONTEXO_DISTILL_DISABLE=1`, then Push. | 3: Push is refused / replaced by 'Share via your agent', which copies details.agent_prompt to the clipboard and offers to open the agent chat (distill_required, exit 9); the Contexo log shows no `--no-distill`. 4: the agent's ctx_push runs the distill handshake and pushes. 5: Push works. E12b: still refused (E26 strips the variable). Re-check the real `~/.contexo/credentials.json` sha256 afterwards. | Clipboard text; Contexo log; agent transcript excerpt. | auto: S6 (synthetic TurnRecord buffer + modified concept page: Push takes 'Share via your agent' with CONTEXO_DISTILL_DISABLE=1 in the Extension Host; nothing reaches the server; Push Selected of an entity page succeeds), conf:distill_required (exit 9, details {pages, sessions, agent_prompt}, env stripped). Real Claude Code session: deferred to WP-6.1 (L26) | |
| E13 | alice's agent uses the build under test (`/mcp`, `which ctx`). | Edit a page; let the agent push it with ctx_push. | The page leaves Changes within one refresh (agents and humans share one base, D2). | Screenshot before/after. | auto: S4 (`ctx mcp` ctx_push {no_distill} → after one Refresh the page is unchanged and base.sha == remote.sha), S5 (MERGE_REQUIRED without `resolved`, no SHA bump; resolved=[P] succeeds). Real agent: deferred to WP-6.1 (L26) | |
| E14 | A multi-root workspace with two .contexo folders and a plain folder. | Open it; edit in both; Push in one. | Two SourceControls with independent counts and operations; the plain folder gets none. | Screenshot of the SCM view. | fake ctx: integration-multi and e2e-multi suites. Real-ctx visual: deferred to WP-6.1 (L26) | |
| E15 | Local: dashboard_url is "" (self-hosted server). Hosted: the dashboard is configured. | Open a page's context menu → Open in Dashboard. | Local: Open in dashboard is disabled because dashboard_url is "" (E23). Hosted: it opens https://app.contexo.live/repos/<repo>/page/<path> and the page renders. | Screenshot. | auto: the real status shows project.dashboard_url "" (conf:status). Menu state: deferred to WP-6.1 (L26) | |
| E16 | After the session. | Search the Contexo log, the Extension Host log and the terminal transcripts for tokens. | No token or API key in any log. | grep output. | deferred to WP-6.1 (L26) (gui-postcheck) | |
| E17 | alice open. | Stop the server (or turn Wi-Fi off), keep editing, Refresh; then restart it. | Local states keep working (status --offline), the remote shows an error indicator, no crash and no toast storm; it recovers when the server is back. | Screenshot. | deferred to WP-6.1 (L26) | |
| E18 | After closing the window. | `pgrep -fl ctx`. | No ctx process lingers after the window closes. | pgrep output. | deferred to WP-6.1 (L26) (gui-postcheck); headless runs: no leftover process after each container run | |
| E19 | Cursor installed (Help > About shows VS Code >= 1.100). | Install the same VSIX with the `cursor` variant printed by `real-ctx-env.mjs ide`; repeat E6, E8 and E9. | Same results as in VS Code. | Screenshot of Help > About; row results. | deferred to WP-6.1 (L26) | |
| E20 | Optional: Windows or Remote-SSH. | Smoke E6 and E8. | Same results. | Screenshots. | deferred to WP-6.1 (L26), optional | |

## Not expected (never assert)

- remote.json or `remote.source` 'cache' (E8/E31); `pages.etag`, ETag or 304 (E13).
- An 'untrusted' welcome view (E38).
- unverified pages in an SCM group.
