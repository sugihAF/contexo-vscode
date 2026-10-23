# Releasing the Contexo extension

This is the checklist for publishing `contexo.contexo` to Open VSX and the VS Code Marketplace. It is written for 0.2.0, the first release; later releases follow the same steps with their own version.

Every step that publishes, pushes, tags or changes a registry is done by a person. CI never publishes, and tokens are never echoed, logged or committed.

## Versioning

- Releases use an **even minor** version (0.2.0, 0.4.0, ...) with `"preview": true` in `package.json` while the extension is in preview. The Marketplace's release channel follows the even minor; `preview` adds the Preview badge.
- Never run `vsce package --pre-release` or `vsce publish --pre-release`.
- Bump `version` in `package.json` and add a `## <version> (preview)` entry to `CHANGELOG.md` (no date; the GitHub release carries it).
- The extension gates on ctx's contract version and capabilities, never on ctx's version number, so a ctx release does not require an extension release.

## Release order

1. **ctx is released.** The ctx release the extension needs (v0.7.0 for 0.2.0) is tagged and marked latest on GitHub, so `ctx update` and the install scripts deliver it.
2. **Hosted runs that core.** The hosted Contexo server runs the release-candidate or final core (it advertises `pages.at`, `push.expect_absent` and `write.path_sha`).
3. **Docs and landing are deployed**, so the listing's homepage https://contexo.live/vscode/ and the README's https://docs.contexo.live/guides/vscode/ resolve before anyone sees the listing.
4. **The repository is public and `main` is pushed.** vsce rewrites the README's relative images to `https://github.com/sugihAF/contexo-vscode/raw/HEAD/<path>`, so the screenshots render on the listing only once the repository is public and contains `media/screenshots/`.
5. **Publish the same VSIX** to Open VSX first, then to the Marketplace (see below). Both registries get the identical file whose sha256 was recorded at build time.
6. **Tag and release on GitHub:** tag `v0.2.0` on the commit the VSIX was built from, and attach the `.vsix` and its `.sha256` to the GitHub release.
7. **Post-publish checks** (below).

## Build the VSIX once

From a clean checkout of the release commit, with Node 22 (`.nvmrc`):

```bash
npm ci
npm run lint
npm run typecheck
npm run test:unit
npm test
npm run test:e2e
npm run check:manifest
OUT=/path/to/contexo-0.2.0.vsix
npx --no-install vsce package --no-dependencies --out "$OUT" </dev/null
shasum -a 256 "$OUT" | tee "$OUT.sha256"
npx --no-install vsce ls --no-dependencies
```

- `vsce package` runs `vscode:prepublish` (the production esbuild bundle) first. `npm run package` does the same and writes `dist/contexo-<version>.vsix`, which `npm run check:vsix` checks.
- `vsce ls --no-dependencies` must list only `package.json`, `README.md`, `CHANGELOG.md`, `LICENSE`, `dist/extension.js` and the `media/` files that `package.json` references (`.vscodeignore` keeps `src/`, `test/`, `scripts/`, `docs/`, source maps and `media/screenshots/` out). The VSIX must stay under 2 MB.
- Make the file read-only (`chmod 0444 "$OUT"`) and publish exactly this file everywhere. Never rebuild between registries.

## Open VSX

Open VSX feeds Cursor, Windsurf, VSCodium and other VS Code-based editors. Publish there first.

```bash
OVSX_PAT="$(security find-generic-password -s "$OPENVSX_TOKEN_KEYCHAIN" -w)" npx ovsx publish "$OUT"
```

- `OPENVSX_TOKEN_KEYCHAIN` is `openvsx-token`, the macOS Keychain item that holds the Open VSX access token. The token stays in the environment of that one command, never on the command line or in a file.
- Complete the namespace ownership claim for `contexo` (the claim issue on EclipseFdn/open-vsx.org) so the namespace shows as verified.
- Wait until the Open VSX listing is **active** (live, not held or rejected) before the Marketplace upload. While the `contexo` namespace is unverified, a public Marketplace extension from publisher `contexo` can make Open VSX's namespace-ownership check block later Open VSX publishes. If Open VSX holds or rejects the first publish, do not upload to the Marketplace until the namespace is verified.

## VS Code Marketplace

- Upload the same `$OUT` by hand at https://marketplace.visualstudio.com/manage/publishers/contexo (New extension > Visual Studio Code, or Update for later versions), signed in with the account that owns the `contexo` publisher. No personal access token is needed.
- Global Azure DevOps personal access tokens retire on 2026-12-01. Before 0.3.0, move both registries to tokenless publishing from CI: `vsce publish --oidc` and `ovsx publish --trusted-publishing`.

## Post-publish checks

Registries can take from minutes to a few hours to show a new version.

- In VS Code, install **Contexo** (`contexo.contexo`) from the Marketplace and check the version, the icon, the README images and the homepage link.
- In Cursor, install it from Open VSX and check the same.
- Download the VSIX from each registry and compare its sha256 with `$OUT.sha256`.
- Open a trusted folder with a Contexo project and check that the Source Control view and the Knowledge view load against a released ctx.
