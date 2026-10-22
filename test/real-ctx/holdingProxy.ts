// A transparent loopback HTTP proxy in front of the real-ctx server, modelled on
// Contexo internal/e2e harness_test.go recordingProxy + SetAfterList (WP-2.2's after-listing
// race). It forwards every request unchanged. A one-shot afterList hook runs once the next
// GET /v1/repos/<id>/pages listing has fully arrived from the server and before the client
// gets it: a teammate's push made inside the hook lands between the client's listing and its
// push, so the client's push gets a real 409 (the only way ctx push exits 6, E7/E10).
import * as http from "node:http";
import type { AddressInfo } from "node:net";

/** Ports this suite never listens on (WP-3.2's servers and the real-ctx server itself). */
const FORBIDDEN_PORTS = new Set([8973, 4322, 18080]);

export interface ProxyRecord { method: string; path: string; status: number; }

export interface HoldingProxy {
  /** http://127.0.0.1:<port> */
  readonly url: string;
  /** Install the one-shot hook for the next listing. */
  setAfterList(hook: () => Promise<void>): void;
  /** How many times a hook ran, and the error it threw (if any). */
  hookRuns(): { count: number; error?: unknown };
  records(): ProxyRecord[];
  close(): Promise<void>;
}

function isListing(method: string | undefined, url: string | undefined): boolean {
  if (method !== "GET" || url === undefined) { return false; }
  const parts = (url.split("?")[0] ?? "").replace(/^\/+|\/+$/g, "").split("/");
  return parts.length === 4 && parts[0] === "v1" && parts[1] === "repos" && parts[3] === "pages";
}

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
}

/** Starts the proxy in front of target (http://host:port). */
export async function startHoldingProxy(target: string): Promise<HoldingProxy> {
  const up = new URL(target);
  let hook: (() => Promise<void>) | undefined;
  let runs = 0;
  let hookError: unknown;
  const recs: ProxyRecord[] = [];

  const handler = (req: http.IncomingMessage, res: http.ServerResponse): void => {
    const body: Buffer[] = [];
    req.on("data", (b: Buffer) => body.push(b));
    req.on("end", () => {
      const fwd = http.request({
        host: up.hostname, port: up.port, method: req.method, path: req.url,
        headers: { ...req.headers, host: up.host },
      }, (upRes) => {
        const chunks: Buffer[] = [];
        upRes.on("data", (b: Buffer) => chunks.push(b));
        upRes.on("end", () => {
          void (async () => {
            recs.push({ method: req.method ?? "", path: req.url ?? "", status: upRes.statusCode ?? 0 });
            if (isListing(req.method, req.url) && hook !== undefined) {
              const h = hook;
              hook = undefined;
              runs++;
              try { await h(); } catch (err) { hookError = err; }
            }
            const headers = { ...upRes.headers };
            delete headers["transfer-encoding"];
            const payload = Buffer.concat(chunks);
            headers["content-length"] = String(payload.length);
            res.writeHead(upRes.statusCode ?? 502, headers);
            res.end(payload);
          })();
        });
      });
      fwd.on("error", (err) => {
        recs.push({ method: req.method ?? "", path: req.url ?? "", status: 502 });
        res.writeHead(502, { "content-type": "text/plain" });
        res.end(String(err));
      });
      fwd.end(Buffer.concat(body));
    });
  };

  for (let attempt = 0; attempt < 5; attempt++) {
    const server = http.createServer(handler);
    const port = await listen(server);
    if (FORBIDDEN_PORTS.has(port)) { await closeServer(server); continue; }
    return {
      url: `http://127.0.0.1:${port}`,
      setAfterList: (h) => { hook = h; },
      hookRuns: () => (hookError === undefined ? { count: runs } : { count: runs, error: hookError }),
      records: () => [...recs],
      close: () => closeServer(server),
    };
  }
  throw new Error("no usable loopback port for the proxy");
}
