/**
 * The hosted MCP server (#25): Streamable HTTP at /mcp behind Cloudflare
 * Access. Every /mcp request needs a valid Access JWT whose email maps to an
 * AnyList account. Built on node:http only, so it runs from the stdio
 * install (`npm ci --omit=optional`); it must not import from src/http/.
 */
import http from "node:http";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { registerAllTools } from "../tools/index.js";
import { AccessJwtError } from "./access-jwt.js";

const MAX_BODY_BYTES = 1024 * 1024;
const SESSION_IDLE_MS = 60 * 60 * 1000;
const MAX_SESSIONS = 50;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function sendJson(res, status, body) {
  if (res.headersSent) return;
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function jsonRpcError(code, message) {
  return { jsonrpc: "2.0", error: { code, message }, id: null };
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "Request body too large");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "Parse error");
  }
}

/**
 * @param {{
 *   verifier: { verify(token: string): Promise<{ email: string }> },
 *   registry: { accountFor(email: string): object|null, clientFor(account: object): object },
 *   version: string,
 *   sessionIdleMs?: number,
 * }} options
 * @returns {{ server: http.Server, sessions: Map<string, object>, closeSessions(): Promise<void> }}
 */
export function createHostedServer({ verifier, registry, version, sessionIdleMs = SESSION_IDLE_MS }) {
  // MCP session id → { mcp, transport, account, lastSeen }. A session belongs to
  // the account that created it; another account's requests can't use it.
  const sessions = new Map();

  async function closeSession(id) {
    const entry = sessions.get(id);
    sessions.delete(id);
    await entry?.mcp.close().catch(() => {});
  }

  const sweep = setInterval(() => {
    const cutoff = Date.now() - sessionIdleMs;
    for (const [id, entry] of sessions) {
      if (entry.lastSeen < cutoff) closeSession(id);
    }
  }, 60 * 1000);
  sweep.unref();

  async function createSession(account) {
    if (sessions.size >= MAX_SESSIONS) {
      const [oldest] = [...sessions.entries()].sort((a, b) => a[1].lastSeen - b[1].lastSeen)[0];
      await closeSession(oldest);
    }
    const mcp = new McpServer({ name: "anylist-mcp-server", version });
    registerAllTools(mcp, () => registry.clientFor(account));
    const entry = { mcp, transport: null, account, lastSeen: Date.now() };
    entry.transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: id => sessions.set(id, entry),
    });
    entry.transport.onclose = () => {
      const id = entry.transport.sessionId;
      if (id && sessions.get(id) === entry) sessions.delete(id);
    };
    await mcp.connect(entry.transport);
    return entry;
  }

  async function handleMcp(req, res, account) {
    const body = req.method === "POST" ? await readJson(req) : undefined;
    const sessionId = req.headers["mcp-session-id"];

    let entry = null;
    if (req.method === "POST" && isInitializeRequest(body)) {
      // An initialize always starts a new session, even on a stale session id.
      entry = await createSession(account);
    } else if (typeof sessionId === "string") {
      const existing = sessions.get(sessionId);
      if (existing && existing.account === account) entry = existing;
    }
    if (!entry) {
      // 404 tells MCP clients to start a new session (spec: Session Management).
      return sendJson(res, 404, jsonRpcError(-32001, "Session not found. Send an initialize request."));
    }
    entry.lastSeen = Date.now();
    await entry.transport.handleRequest(req, res, body);
  }

  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    let pathname;
    try {
      ({ pathname } = new URL(req.url, "http://localhost"));
    } catch {
      return sendJson(res, 400, { error: "Bad request" });
    }
    let accountName = "-";
    res.on("finish", () => {
      console.error(`${req.method} ${pathname} → ${res.statusCode} (${Date.now() - started}ms) account:${accountName}`);
    });

    try {
      if (pathname === "/healthz") {
        if (req.method !== "GET") return sendJson(res, 405, { error: "Method not allowed" });
        res.writeHead(200, { "Content-Type": "text/plain" });
        return res.end("ok");
      }
      if (pathname !== "/mcp") return sendJson(res, 404, { error: "Not found" });

      let claims;
      try {
        claims = await verifier.verify(req.headers["cf-access-jwt-assertion"]);
      } catch (err) {
        if (!(err instanceof AccessJwtError)) throw err;
        console.error(`[access] rejected: ${err.message}`);
        return sendJson(res, 403, { error: "Forbidden" });
      }
      const account = registry.accountFor(claims.email);
      if (!account) {
        console.error("[access] rejected: no AnyList account is configured for this identity");
        return sendJson(res, 403, { error: "Forbidden" });
      }
      accountName = account.name;

      await handleMcp(req, res, account);
    } catch (err) {
      if (err instanceof HttpError) {
        return sendJson(res, err.status, jsonRpcError(err.status === 400 ? -32700 : -32600, err.message));
      }
      console.error(`MCP request error: ${err.message}`);
      sendJson(res, 500, jsonRpcError(-32603, "Internal server error"));
    }
  });

  async function closeSessions() {
    clearInterval(sweep);
    await Promise.all([...sessions.keys()].map(closeSession));
  }

  return { server, sessions, closeSessions };
}
