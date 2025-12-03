/**
 * Connector Hub Server
 *
 * Handles metadata, registry, and routing for MCP servers.
 * Execution/spawning is delegated to the MCP Server (mcp.compose.market).
 *
 * Responsibilities:
 * - Registry: Unified view of all MCP servers, GOAT plugins, ElizaOS plugins
 * - Metadata: Server info, tools, categories, tags
 * - Routing: Proxies execution requests to MCP server
 * - Card Generation: Convert registry entries to ComposeAgentCard format
 *
 * NO EXECUTION HERE - All execution is proxied to MCP server.
 */
import "dotenv/config";
import express, { type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import { z } from "zod";
import { createRegistryRouter, getServerByRegistryId } from "./registry.js";
import { buildAgentCardFromRegistry } from "./builder.js";
import { validateAgentCard, assertValidAgentCard } from "./validate.js";
import type { UnifiedServerRecord } from "./registry.js";

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

// Mount the MCP registry router
app.use("/registry", createRegistryRouter());

// =============================================================================
// Configuration
// =============================================================================

/** MCP Server URL - where ALL execution happens */
const MCP_SERVER_URL = process.env.MCP_SERVICE_URL || "https://mcp.compose.market";

// =============================================================================
// Middleware
// =============================================================================

// Request logging middleware
app.use((req: Request, _res: Response, next: NextFunction) => {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${req.method} ${req.path}`);
  next();
});

// Error handling wrapper
function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void>
) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res, next).catch(next);
  };
}

// =============================================================================
// Health Check
// =============================================================================

app.get("/health", (_req: Request, res: Response) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    service: "connector-hub",
    version: "0.3.0",
    mcpServer: MCP_SERVER_URL,
  });
});

// =============================================================================
// MCP Server Proxy Routes
// =============================================================================

/**
 * GET /mcp/servers
 * Proxy to MCP server - list all spawnable servers
 */
app.get(
  "/mcp/servers",
  asyncHandler(async (_req: Request, res: Response) => {
    try {
      const response = await fetch(`${MCP_SERVER_URL}/servers`);
      const data = await response.json();
      res.json(data);
    } catch (error) {
      res.status(503).json({
        error: "MCP server unavailable",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  })
);

/**
 * GET /mcp/status
 * Proxy to MCP server - get spawned server status
 */
app.get(
  "/mcp/status",
  asyncHandler(async (_req: Request, res: Response) => {
    try {
      const response = await fetch(`${MCP_SERVER_URL}/status`);
      const data = await response.json();
      res.json(data);
    } catch (error) {
      res.status(503).json({
        error: "MCP server unavailable",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  })
);

/**
 * GET /mcp/servers/:slug/tools
 * Proxy to MCP server - list tools for a server
 */
app.get(
  "/mcp/servers/:slug/tools",
  asyncHandler(async (req: Request, res: Response) => {
    const { slug } = req.params;
    try {
      const response = await fetch(`${MCP_SERVER_URL}/servers/${encodeURIComponent(slug)}/tools`);
      const data = await response.json();
      res.status(response.status).json(data);
    } catch (error) {
      res.status(503).json({
        error: `Failed to fetch tools for ${slug}`,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  })
);

const McpCallToolSchema = z.object({
  tool: z.string().min(1, "tool name is required"),
  args: z.record(z.string(), z.unknown()).optional().default({}),
});

/**
 * POST /mcp/servers/:slug/call
 * Proxy to MCP server - call a tool on a server
 */
app.post(
  "/mcp/servers/:slug/call",
  asyncHandler(async (req: Request, res: Response) => {
    const { slug } = req.params;

    const parseResult = McpCallToolSchema.safeParse(req.body);
    if (!parseResult.success) {
      res.status(400).json({
        error: "Invalid request body",
        details: parseResult.error.issues,
      });
      return;
    }

    try {
      const response = await fetch(`${MCP_SERVER_URL}/servers/${encodeURIComponent(slug)}/call`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parseResult.data),
      });
      const data = await response.json();
      res.status(response.status).json(data);
    } catch (error) {
      res.status(503).json({
        error: `Failed to call tool on ${slug}`,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  })
);

// =============================================================================
// Agent Card Generation
// =============================================================================

/**
 * POST /cards/from-registry
 * Generate a ComposeAgentCard from a registry ID
 */
app.post(
  "/cards/from-registry",
  asyncHandler(async (req: Request, res: Response) => {
    const { registryId, options } = req.body;

    if (!registryId || typeof registryId !== "string") {
      res.status(400).json({ error: "registryId is required" });
      return;
    }

    try {
      const server = await getServerByRegistryId(registryId);
      if (!server) {
        res.status(404).json({ error: `Server not found: ${registryId}` });
        return;
      }

      const card = buildAgentCardFromRegistry(server, options);

      // Validate the generated card
      const validated = assertValidAgentCard(card);

      res.json({
        ok: true,
        card: validated,
      });
    } catch (error) {
      console.error("Error generating agent card:", error);
      const details = (error as any).details;
      res.status(400).json({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        details,
      });
    }
  })
);

/**
 * POST /cards/validate
 * Validate an agent card
 */
app.post(
  "/cards/validate",
  asyncHandler(async (req: Request, res: Response) => {
    const { card } = req.body;

    if (!card) {
      res.status(400).json({ error: "card is required" });
      return;
    }

    const result = validateAgentCard(card);
    res.json(result);
  })
);

/**
 * POST /cards/preview
 * Generate a preview card from raw server metadata
 */
app.post(
  "/cards/preview",
  asyncHandler(async (req: Request, res: Response) => {
    const { server, options } = req.body;

    if (!server) {
      res.status(400).json({ error: "server record is required" });
      return;
    }

    try {
      // Cast input to UnifiedServerRecord (runtime validation implied by use)
      const record = server as UnifiedServerRecord;

      const card = buildAgentCardFromRegistry(record, options);
      const result = validateAgentCard(card);

      res.json(result);
    } catch (error) {
      console.error("Error previewing agent card:", error);
      res.status(400).json({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  })
);

// =============================================================================
// GOAT Plugin Routes (Proxied to MCP Server)
// =============================================================================

/**
 * GET /plugins/status
 * Proxy to MCP server - GOAT runtime status
 */
app.get(
  "/plugins/status",
  asyncHandler(async (_req: Request, res: Response) => {
    try {
      const response = await fetch(`${MCP_SERVER_URL}/goat/status`);
      const data = await response.json();
      res.json(data);
    } catch (error) {
      res.status(503).json({
        error: "MCP server unavailable",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  })
);

/**
 * GET /plugins/tools
 * Proxy to MCP server - list all GOAT tools
 */
app.get(
  "/plugins/tools",
  asyncHandler(async (_req: Request, res: Response) => {
    try {
      const response = await fetch(`${MCP_SERVER_URL}/goat/tools`);
      const data = await response.json();
      res.json(data);
    } catch (error) {
      res.status(503).json({
        error: "MCP server unavailable",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  })
);

/**
 * GET /plugins/:pluginId/tools
 * Proxy to MCP server - list tools for a GOAT plugin
 */
app.get(
  "/plugins/:pluginId/tools",
  asyncHandler(async (req: Request, res: Response) => {
    const { pluginId } = req.params;
    try {
      const response = await fetch(`${MCP_SERVER_URL}/goat/${encodeURIComponent(pluginId)}/tools`);
      const data = await response.json();
      res.status(response.status).json(data);
    } catch (error) {
      res.status(503).json({
        error: `Failed to fetch tools for plugin ${pluginId}`,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  })
);

const ExecuteToolSchema = z.object({
  tool: z.string().min(1, "tool name is required"),
  args: z.record(z.string(), z.unknown()).optional().default({}),
});

/**
 * POST /plugins/:pluginId/execute
 * Proxy to MCP server - execute a GOAT plugin tool
 */
app.post(
  "/plugins/:pluginId/execute",
  asyncHandler(async (req: Request, res: Response) => {
    const { pluginId } = req.params;

    const parseResult = ExecuteToolSchema.safeParse(req.body);
    if (!parseResult.success) {
      res.status(400).json({
        error: "Invalid request body",
        details: parseResult.error.issues,
      });
      return;
    }

    try {
      const response = await fetch(`${MCP_SERVER_URL}/goat/${encodeURIComponent(pluginId)}/execute`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parseResult.data),
      });
      const data = await response.json();
      res.status(response.status).json(data);
    } catch (error) {
      res.status(503).json({
        error: `Failed to execute plugin ${pluginId}`,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  })
);

// =============================================================================
// ElizaOS Routes (Proxied to MCP Server)
// =============================================================================

/**
 * GET /eliza/status
 * Proxy to MCP server - ElizaOS runtime status
 */
app.get(
  "/eliza/status",
  asyncHandler(async (_req: Request, res: Response) => {
    try {
      const response = await fetch(`${MCP_SERVER_URL}/eliza/status`);
      const data = await response.json();
      res.json(data);
    } catch (error) {
      res.status(503).json({
        error: "MCP server unavailable",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  })
);

/**
 * GET /eliza/agents/:agentId/actions
 * Proxy to MCP server - list ElizaOS agent actions
 */
app.get(
  "/eliza/agents/:agentId/actions",
  asyncHandler(async (req: Request, res: Response) => {
    const { agentId } = req.params;
    try {
      const response = await fetch(`${MCP_SERVER_URL}/eliza/agents/${encodeURIComponent(agentId)}/actions`);
      const data = await response.json();
      res.status(response.status).json(data);
    } catch (error) {
      res.status(503).json({
        error: `Failed to fetch actions for agent ${agentId}`,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  })
);

const ElizaMessageSchema = z.object({
  message: z.string().min(1, "message is required"),
  roomId: z.string().optional(),
});

/**
 * POST /eliza/agents/:agentId/message
 * Proxy to MCP server - send message to ElizaOS agent
 */
app.post(
  "/eliza/agents/:agentId/message",
  asyncHandler(async (req: Request, res: Response) => {
    const { agentId } = req.params;

    const parseResult = ElizaMessageSchema.safeParse(req.body);
    if (!parseResult.success) {
      res.status(400).json({
        error: "Invalid request body",
        details: parseResult.error.issues,
      });
      return;
    }

    try {
      const response = await fetch(`${MCP_SERVER_URL}/eliza/agents/${encodeURIComponent(agentId)}/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parseResult.data),
      });
      const data = await response.json();
      res.status(response.status).json(data);
    } catch (error) {
      res.status(503).json({
        error: `Failed to send message to agent ${agentId}`,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  })
);

const ElizaActionSchema = z.object({
  params: z.record(z.string(), z.unknown()).optional().default({}),
});

/**
 * POST /eliza/agents/:agentId/actions/:actionName
 * Proxy to MCP server - execute ElizaOS agent action
 */
app.post(
  "/eliza/agents/:agentId/actions/:actionName",
  asyncHandler(async (req: Request, res: Response) => {
    const { agentId, actionName } = req.params;

    const parseResult = ElizaActionSchema.safeParse(req.body);
    if (!parseResult.success) {
      res.status(400).json({
        error: "Invalid request body",
        details: parseResult.error.issues,
      });
      return;
    }

    try {
      const response = await fetch(
        `${MCP_SERVER_URL}/eliza/agents/${encodeURIComponent(agentId)}/actions/${encodeURIComponent(actionName)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(parseResult.data),
        }
      );
      const data = await response.json();
      res.status(response.status).json(data);
    } catch (error) {
      res.status(503).json({
        error: `Failed to execute action ${actionName}`,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  })
);

/**
 * GET /eliza/plugins/:pluginId/supported
 * Proxy to MCP server - check ElizaOS plugin support
 */
app.get(
  "/eliza/plugins/:pluginId/supported",
  asyncHandler(async (req: Request, res: Response) => {
    const { pluginId } = req.params;
    try {
      const response = await fetch(`${MCP_SERVER_URL}/eliza/plugins/${encodeURIComponent(pluginId)}/supported`);
      const data = await response.json();
      res.json(data);
    } catch (error) {
      res.status(503).json({
        error: "MCP server unavailable",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  })
);

/**
 * GET /eliza/plugins
 * Proxy to MCP server - list available ElizaOS plugins (type: plugin)
 */
app.get(
  "/eliza/plugins",
  asyncHandler(async (_req: Request, res: Response) => {
    try {
      const response = await fetch(`${MCP_SERVER_URL}/eliza/plugins`);
      const data = await response.json();
      // Mark all as type: 'plugin'
      res.json({
        ...data,
        type: "plugin",
        plugins: data.plugins?.map((p: { id: string; package: string }) => ({
          ...p,
          type: "plugin",
        })) || [],
      });
    } catch (error) {
      res.status(503).json({
        error: "MCP server unavailable",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  })
);

/**
 * GET /eliza/agents
 * Proxy to MCP server - list running ElizaOS agents (type: agent)
 * These are ACTUAL AGENTS running on ElizaOS, NOT plugins
 */
app.get(
  "/eliza/agents",
  asyncHandler(async (_req: Request, res: Response) => {
    try {
      const response = await fetch(`${MCP_SERVER_URL}/eliza/agents`);
      const data = await response.json();
      // Mark all as type: 'agent'
      res.json({
        ...data,
        type: "agent",
        agents: data.agents?.map((a: Record<string, unknown>) => ({
          ...a,
          type: "agent",
          registry: "eliza",
        })) || [],
      });
    } catch (error) {
      res.status(503).json({
        error: "MCP server unavailable",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  })
);

// =============================================================================
// Error Handler
// =============================================================================

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error("Unhandled error:", err);
  res.status(500).json({
    error: "Internal server error",
    message: err.message,
  });
});

// =============================================================================
// Server Startup
// =============================================================================

const PORT = parseInt(process.env.PORT || "4001", 10);

const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`\n🔌 Connector Hub listening on http://0.0.0.0:${PORT}`);
  console.log(`\n🚀 MCP Server: ${MCP_SERVER_URL}`);
  console.log("\n⚠️  NOTE: All execution is proxied to MCP Server - no local execution!");
  console.log("\nEndpoints:");
  console.log("  GET  /health              - Health check");
  console.log("");
  console.log("  GET  /registry/servers    - List MCP servers");
  console.log("  GET  /registry/servers/search - Search MCP servers");
  console.log("  GET  /registry/servers/:id - Get server by ID");
  console.log("  GET  /registry/categories - List categories");
  console.log("  GET  /registry/tags       - List tags");
  console.log("  GET  /registry/meta       - Registry metadata");
  console.log("");
  console.log("  GET  /mcp/servers         - [PROXY] List spawnable MCP servers");
  console.log("  GET  /mcp/status          - [PROXY] Spawned server status");
  console.log("  GET  /mcp/servers/:slug/tools - [PROXY] List tools");
  console.log("  POST /mcp/servers/:slug/call  - [PROXY] Call tool");
  console.log("");
  console.log("  POST /cards/from-registry - Generate agent card");
  console.log("  POST /cards/validate      - Validate agent card");
  console.log("  POST /cards/preview       - Preview agent card");
  console.log("");
  console.log("  GET  /plugins/status      - [PROXY] GOAT runtime status");
  console.log("  GET  /plugins/tools       - [PROXY] List all GOAT tools");
  console.log("  GET  /plugins/:id/tools   - [PROXY] List plugin tools");
  console.log("  POST /plugins/:id/execute - [PROXY] Execute plugin tool");
  console.log("");
  console.log("  GET  /eliza/status        - [PROXY] ElizaOS runtime status");
  console.log("  GET  /eliza/agents/:id/actions - [PROXY] List agent actions");
  console.log("  POST /eliza/agents/:id/message - [PROXY] Send message");
  console.log("  POST /eliza/agents/:id/actions/:name - [PROXY] Execute action");
  console.log("");
});

// Graceful shutdown
process.on("SIGTERM", async () => {
  console.log("\nReceived SIGTERM, shutting down gracefully...");
  server.close(() => {
    console.log("Server closed");
    process.exit(0);
  });
});

process.on("SIGINT", async () => {
  console.log("\nReceived SIGINT, shutting down gracefully...");
  server.close(() => {
    console.log("Server closed");
    process.exit(0);
  });
});

export default app;
