import type { IncomingMessage, ServerResponse } from "node:http";
import { AsyncLocalStorage } from "node:async_hooks";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpServer } from "../mcp/server.ts";
import { normalizeAgentProfile, riskOf } from "../mcp/tools.ts";
import { authenticate, type AuthContext } from "../auth/middleware.ts";
import { isAdmin } from "../auth/principal.ts";
import { connectionOrigin, publicConnection } from "../services/connection-identity.ts";
import { env } from "../utils/env.ts";
import { logger } from "../utils/logger.ts";
import { noteAgentWork } from "../services/memory-policy.ts";
import { getAllowedOrigin, json, nodeReqToFetchRequest, readBody } from "./respond.ts";

// --- Auth context per-request (no module-level variable, no race condition) ---
const authStorage = new AsyncLocalStorage<AuthContext>();

function getCurrentAuth(): AuthContext | null {
  return authStorage.getStore() ?? null;
}

// ---------- MCP handler ----------

export async function handleMcp(req: IncomingMessage, res: ServerResponse) {
  const method = (req.method || "GET").toUpperCase();

  const connectionId=/^\/mcp\/c\/([a-f0-9-]{36})$/.exec(new URL(req.url!,env.PUBLIC_URL).pathname)?.[1];
  const resourceBase=connectionId?connectionOrigin(connectionId):env.PUBLIC_URL;
  // Authenticate from headers before reading the body, so an anonymous caller cannot make us buffer 1 MB.
  const auth = authenticate(nodeReqToFetchRequest(req));
  if (!auth) {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "www-authenticate": `Bearer realm="qoopia", resource_metadata="${resourceBase}/.well-known/oauth-protected-resource${["/mcp","/mcp/"].includes(new URL(req.url!,env.PUBLIC_URL).pathname) ? "" : new URL(req.url!,env.PUBLIC_URL).pathname}"`,
    };
    const origin = getAllowedOrigin(req);
    if (origin) {
      headers["access-control-allow-origin"] = origin;
      headers["access-control-expose-headers"] = "WWW-Authenticate";
      headers["vary"] = "Origin";
    }
    res.writeHead(401, headers);
    res.end(JSON.stringify({ error: "unauthorized" }));
    return;
  }

  const body = method === "GET" || method === "DELETE" ? undefined : await readBody(req);
  if(connectionId){
    const connection=publicConnection(connectionId);
    if(auth.agent_id!==connection.agent_id||auth.workspace_id!==connection.workspace_id)return json(res,403,{error:'connection_mismatch'},req);
  }
  // Stateless transport: no session to stream to or delete, so no idle server per GET stream (F-261).
  if (method === "GET" || method === "DELETE") {
    const origin = getAllowedOrigin(req);
    res.writeHead(405, { allow: "POST", ...(origin ? { "access-control-allow-origin": origin, vary: "Origin" } : {}) });
    res.end();
    return;
  }
  // QSA-F / ADR-016: normalize the agent's per-agent tool profile once
  // per request. Unknown / null values are coerced to 'read-only' with
  // a single WARN line, matching the documented fail-closed posture.
  const agentProfile = normalizeAgentProfile(
    auth.tool_profile,
    auth.agent_name,
  );

  // Access log: parse JSON-RPC method/tool name from body for debugging.
  if (body && body.length > 0) {
    try {
      const parsed = JSON.parse(body.toString("utf8"));
      const rpcMethod = ["initialize","notifications/initialized","tools/list","tools/call","ping"].includes(parsed.method) ? parsed.method : "unknown";
      let detail = "";
      if (rpcMethod === "tools/call" && parsed.params?.name) {
        const toolName = parsed.params.name as string;
        const risk = riskOf(toolName);
        // Risk class makes destructive/admin calls greppable in stderr
        // even when the tool name itself isn't obviously dangerous.
        detail = ` tool=${risk ? toolName : "unknown"} risk=${risk ?? "unknown"} profile=${agentProfile}`;
        noteAgentWork(auth.agent_id, toolName);
      }
      logger.info(
        `MCP ${rpcMethod || "?"}${detail} agent=${auth.agent_name} (${auth.source})`,
      );
    } catch {
      // ignore — body may be batched or non-json
    }
  }

  // Run inside AsyncLocalStorage so concurrent requests never share auth context
  // Migration036 marks pre-existing principals. Their unchanged /mcp URL keeps its old discovery
  // surface; live profile and OAuth scope still gate every call. Recorded on the context so the
  // agent contract describes this connection instead of a stricter hypothetical one. A request
  // parameter never widens a stored profile: `?profile=full` used to lift any connection's
  // access profile to the full legacy catalogue (F-253).
  const bootstrapProfile = auth.legacy_skill_access === 1 ? undefined : auth.authority_profile;
  auth.bootstrap_profile = bootstrapProfile ?? null;

  await authStorage.run(auth, async () => {
    const server = createMcpServer(() => getCurrentAuth(), "full", {
      isSteward: isAdmin(auth),
      bootstrapProfile,
      agentToolProfile: agentProfile,
      grantedScope: auth.granted_scope,
    });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    res.on("close", () => {
      // Best-effort teardown on client disconnect; nothing to report to a closed response.
      try { transport.close(); } catch { /* see above */ }
      try { server.close(); } catch { /* see above */ }
    });

    await server.connect(transport);
    let parsedBody: unknown;
    if (body && body.length > 0) {
      try {
        parsedBody = JSON.parse(body.toString("utf8"));
      } catch {
        // The same JSON-RPC parse error the SDK answers for every other unparsable body.
        return json(res, 400, { jsonrpc: "2.0", error: { code: -32700, message: "Parse error: Invalid JSON" }, id: null }, req);
      }
    }
    await transport.handleRequest(req, res, parsedBody);
  });
}
