// The agent path of the real-ctx scenarios (WP-3.1 S4/S5): a newline-delimited JSON-RPC 2.0
// client for `ctx mcp --root <dir>`. internal/cli/mcp.go reads stdin with bufio.Scanner (lines
// up to 10 MB) and prints one JSON response per request line, so a request is one line out and
// its response is the line whose id matches; every other line (the reply a notification gets,
// noise) is kept but never matched. The session ends when stdin closes. Every wait is bounded,
// and a session that does not exit in time is killed.
//
// Spawn rules: CTX_BIN with ['mcp','--root',root], cwd root, shell false, env = process.env with
// HOME/USERPROFILE set to the user's home and CONTEXO_CLIENT / CONTEXO_DISTILL_DISABLE deleted
// (CONTEXO_CLIENT would override clientInfo.name as X-Contexo-Client, E15; the distill switch
// would bypass the D4 guard).
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export interface McpError { code: number; message: string }

/** One JSON-RPC response line. */
export interface McpResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: McpError;
}

/** The text of a tools/call result ({content:[{type:'text', text}], isError?}). */
export interface McpToolOutcome {
  text: string;
  isError: boolean;
  response: McpResponse;
}

export interface McpSessionOptions {
  /** The ctx binary (CTX_BIN). */
  bin: string;
  /** The project root: --root and the cwd. */
  root: string;
  /** HOME and USERPROFILE of the agent's user. */
  home: string;
}

/** Default bound of one request (ctx_push makes a few HTTP calls; the tool itself times out at 120 s). */
export const MCP_REQUEST_TIMEOUT_MS = 60_000;
/** How long close() waits for the process to exit after stdin closed, before SIGKILL. */
export const MCP_EXIT_TIMEOUT_MS = 10_000;

interface Pending {
  resolve(r: McpResponse): void;
  reject(err: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

/** The env of the agent process: the user's HOME, no CONTEXO_CLIENT, no CONTEXO_DISTILL_DISABLE. */
export function mcpEnv(home: string, parent: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...parent, HOME: home, USERPROFILE: home };
  delete env.CONTEXO_CLIENT;
  delete env.CONTEXO_DISTILL_DISABLE;
  return env;
}

export class McpSession {
  /** Every stdout line, parsed when it was JSON. */
  readonly lines: { raw: string; json?: unknown }[] = [];
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string, Pending>();
  private buffer = "";
  private stderrText = "";
  private nextId = 1;
  private exited: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  private readonly exitPromise: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;

  private constructor(readonly o: McpSessionOptions) {
    this.child = spawn(o.bin, ["mcp", "--root", o.root], {
      cwd: o.root,
      env: mcpEnv(o.home),
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.onStdout(chunk));
    this.child.stderr.on("data", (chunk: string) => { this.stderrText += chunk; });
    // A write after the process died (EPIPE) must not become an uncaught exception in the
    // Extension Host; the pending request then fails through 'close' or its timeout.
    this.child.stdin.on("error", (err) => { this.stderrText += `\n[mcpDriver] stdin: ${err.message}`; });
    this.exitPromise = new Promise((resolve) => {
      this.child.once("close", (code, signal) => {
        this.exited = { code, signal };
        this.failPending(`ctx mcp exited (code ${String(code)}, signal ${String(signal)})`);
        resolve(this.exited);
      });
      this.child.once("error", (err) => {
        this.exited = { code: null, signal: null };
        this.failPending(`ctx mcp could not run: ${err.message}`);
        resolve(this.exited);
      });
    });
  }

  /** Spawn `ctx mcp --root <root>` (nothing is sent yet). */
  static start(o: McpSessionOptions): McpSession {
    return new McpSession(o);
  }

  /** What the server printed on stderr so far. */
  get stderr(): string {
    return this.stderrText;
  }

  /** Send one request line and wait (bounded) for the response with the same id. */
  request(method: string, params?: unknown, o: { timeoutMs?: number } = {}): Promise<McpResponse> {
    if (this.exited) { return Promise.reject(new Error(`ctx mcp has exited; cannot send ${method}`)); }
    const id = this.nextId++;
    const timeoutMs = o.timeoutMs ?? MCP_REQUEST_TIMEOUT_MS;
    return new Promise<McpResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(String(id));
        reject(new Error(`ctx mcp: no response to ${method} (id ${id}) within ${timeoutMs} ms; stderr: ${this.stderrText.slice(-2000)}; lines: ${JSON.stringify(this.lines.map((l) => l.raw.slice(0, 200)))}`));
      }, timeoutMs);
      this.pending.set(String(id), { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) })}\n`);
    });
  }

  /** Send a notification (no id). ctx answers it with a 'method not found' line, which is ignored. */
  notify(method: string, params?: unknown): void {
    if (this.exited) { return; }
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) })}\n`);
  }

  /** initialize with clientInfo {name: clientName, version: '1'} (ctx makes the name X-Contexo-Client, E15), then notifications/initialized. */
  async initialize(clientName: string, o: { timeoutMs?: number } = {}): Promise<McpResponse> {
    const res = await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: clientName, version: "1" },
    }, o);
    if (res.error) { throw new Error(`ctx mcp initialize failed: ${res.error.code} ${res.error.message}`); }
    this.notify("notifications/initialized");
    return res;
  }

  /** tools/call {name, arguments}; returns the joined text content. A JSON-RPC error rejects. */
  async callTool(name: string, args: Record<string, unknown>, o: { timeoutMs?: number } = {}): Promise<McpToolOutcome> {
    const response = await this.request("tools/call", { name, arguments: args }, o);
    if (response.error) { throw new Error(`ctx mcp tools/call ${name} failed: ${response.error.code} ${response.error.message}`); }
    const result = (response.result ?? {}) as { content?: { type?: string; text?: string }[]; isError?: boolean };
    const text = (result.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
    return { text, isError: result.isError === true, response };
  }

  /** End the session by closing stdin; waits (bounded) for the exit and kills the process when it does not come. */
  async close(o: { timeoutMs?: number } = {}): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    if (!this.exited) { this.child.stdin.end(); }
    const timeoutMs = o.timeoutMs ?? MCP_EXIT_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<"late">((resolve) => { timer = setTimeout(() => resolve("late"), timeoutMs); });
    const first = await Promise.race([this.exitPromise, late]);
    if (timer) { clearTimeout(timer); }
    if (first !== "late") { return first; }
    this.kill();
    return this.exitPromise;
  }

  /** SIGKILL the process if it still runs (test teardown). */
  kill(): void {
    if (!this.exited && this.child.exitCode === null && this.child.signalCode === null) {
      this.child.kill("SIGKILL");
    }
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    for (let i = this.buffer.indexOf("\n"); i >= 0; i = this.buffer.indexOf("\n")) {
      const raw = this.buffer.slice(0, i).replace(/\r$/, "");
      this.buffer = this.buffer.slice(i + 1);
      if (raw.trim() === "") { continue; }
      let json: unknown;
      try {
        json = JSON.parse(raw);
      } catch {
        this.lines.push({ raw });
        continue;
      }
      this.lines.push({ raw, json });
      const id = (json as { id?: unknown } | null)?.id;
      if (typeof id !== "number" && typeof id !== "string") { continue; } // a notification's reply (id null) or noise
      const waiter = this.pending.get(String(id));
      if (!waiter) { continue; }
      this.pending.delete(String(id));
      clearTimeout(waiter.timer);
      waiter.resolve(json as McpResponse);
    }
  }

  private failPending(why: string): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(`${why}; request ${id} got no response; stderr: ${this.stderrText.slice(-2000)}`));
    }
    this.pending.clear();
  }
}

/** Run fn with a started session; the session is always closed (and killed when it hangs). */
export async function withMcpSession<T>(o: McpSessionOptions, fn: (s: McpSession) => Promise<T>): Promise<T> {
  const session = McpSession.start(o);
  try {
    return await fn(session);
  } finally {
    try {
      await session.close();
    } finally {
      session.kill();
    }
  }
}
