// Streamable HTTP transport, used instead of stdio when MCP_HTTP_PORT is set.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer as createHttpServer, ServerResponse } from "node:http";

/** Loopback only: the server holds the Matrix token, so it must not be reachable from the network. */
const HTTP_HOST = "127.0.0.1";
const HTTP_PATH = "/mcp";

function sendJsonRpcError(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }));
}

/**
 * Serve MCP over Streamable HTTP in stateless mode: every POST gets its own server and transport,
 * so there is no session state to keep. GET (server-initiated SSE stream) and DELETE (session end)
 * only make sense with sessions, so they are rejected with 405, which clients accept.
 *
 * The server cannot be shared between requests: an McpServer is connected to one transport at a time,
 * and a second connect() throws "Already connected to a transport". Building one only registers the
 * tools, so doing it per request is cheap.
 */
export async function serveHttp(port: number, createServer: () => McpServer): Promise<void> {
  // The Host check blocks DNS rebinding: a web page whose hostname resolves to 127.0.0.1 can reach the
  // port from a browser, but its requests carry its own hostname in Host.
  const allowedHosts = [`${HTTP_HOST}:${port}`, `localhost:${port}`];

  const httpServer = createHttpServer(async (req, res) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    if (path !== HTTP_PATH) {
      sendJsonRpcError(res, 404, `Not found; the MCP endpoint is ${HTTP_PATH}`);
      return;
    }
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      sendJsonRpcError(res, 405, "Method not allowed; this server is stateless and only accepts POST");
      return;
    }

    const server = createServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableDnsRebindingProtection: true,
      allowedHosts,
    });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (err) {
      console.error("Error handling MCP request:", err);
      if (!res.headersSent) sendJsonRpcError(res, 500, "Internal server error");
    }
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, HTTP_HOST, resolve);
  });
  console.error(
    `Matrix Requirements MCP server listening on http://${HTTP_HOST}:${port}${HTTP_PATH}`
  );
}
