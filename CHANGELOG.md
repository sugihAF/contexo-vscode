# Changelog

## 0.2.0 (preview)

First public release. Requires **ctx 0.7.0 or later** (contract v1).

- Source Control: one Contexo entry per workspace folder with a Contexo project, with Conflicts, Changes, New, Incoming and Invalid groups. ctx computes every page state; the badge counts conflicts, changes and new pages (`contexo.scm.countIncoming` adds incoming ones).
- Knowledge view in the Activity Bar: pages grouped by type, an Invalid node, and an item for agent sessions waiting to be shared.
- Diffs on click (last synced version to local, server to local), the gutter quick diff against the last synced version, and state badges in the Explorer, Source Control and Knowledge views.
- Push from the Source Control message box (Cmd/Ctrl+Enter) or Push Selected: sends only changed and new pages and reports conflicts without overwriting a teammate's version.
- Agent-session check: while un-distilled agent sessions are pending, a push of concept or analysis pages is refused and **Share via your agent** copies a prompt for your agent instead.
- Pull that never overwrites local edits.
- Conflict resolution: Keep Mine (`ctx resolve --ours`) and Take Server Version (`ctx resolve --theirs`, with a backup), both checked against the server version you reviewed. Restore Server Version for pages deleted locally.
- Unsaved Contexo pages are saved (or the action is cancelled) before Push and Pull.
- Status bar with pages to push, incoming pages and conflicts, plus login and ctx state.
- Welcome views and commands to install, update and find ctx, initialize a project and log in (with `--no-browser` in remote windows).
- A one-time notice per ctx version to restart agent sessions after `ctx update`.
- Workspace Trust required; no telemetry; ctx identifies the extension to your server as `contexo-vscode/<version>`.
