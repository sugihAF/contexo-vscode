// The E25 argv table, from WP-1.7's exported builder (src/cli/spawn.ts loads under plain node:
// it imports only types from 'vscode'). The suites never hand-write extension argv.
export { ctxArgv } from "../../src/cli/spawn";
