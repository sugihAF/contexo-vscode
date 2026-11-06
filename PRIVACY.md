# Privacy

This statement covers the Contexo extension for VS Code (`contexo.contexo`).

## What the extension collects

Nothing. The extension collects no telemetry, no usage data and no crash reports, and it makes no network requests of its own.

## What talks to a server

The extension runs the `ctx` CLI that you installed on your machine. `ctx` talks to the Contexo server you configured for the project (the hosted service run from the Contexo website, or a server you host yourself), exactly as it does when you run it in a terminal:

- **Pages you push or pull.** Push sends the knowledge-base pages you changed or created; pull, refresh and the periodic check for incoming changes (`contexo.remoteRefresh.enabled`) fetch the server's pages.
- **The client header.** `ctx` tells the server which client made a request with the `X-Contexo-Client` header, `contexo-vscode/<extension version>` for requests made from VS Code, so the project's activity shows pushes made from the editor.

The commands that open a web page (Open in Dashboard, Install ctx, the docs links) open it in your browser; the extension itself sends nothing.

## Credentials

Only `ctx` reads your Contexo credentials. The extension never reads, stores or sends them, and never reads the project configuration or the files in `.contexo/.sync`. Log in with **Contexo: Log In**, which runs `ctx auth login` in a terminal you can see.

## Workspace Trust

The extension requires Workspace Trust. In Restricted Mode VS Code does not run it, so it never starts `ctx` in a folder you have not trusted.

## Questions

Open an issue at https://github.com/sugihAF/contexo-vscode/issues.
