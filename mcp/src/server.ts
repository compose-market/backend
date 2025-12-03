/**
 * MCP Server
 *
 * Dedicated server for spawning and executing MCP servers on-demand.
 * Also handles GOAT plugin execution and ElizaOS runtime.
 *
 * All servers fetched from MCP Registry (registry.modelcontextprotocol.io)
 *
 * Transport types:
 * - stdio: Local spawning via npx (npm packages)
 * - streamable-http: Remote servers via HTTP/SSE
 */
import "dotenv/config";
import express, { type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import { z } from "zod";
import {
  getSpawnableServers,
  getSpawnedStatus,
  isSpawnableServer,
  listServerTools,
  callServerTool,
  warmupServer,
  forceKillServer,
  killAllServers,
  getAllSpawnConfigs,
  getSpawnConfig,
  getMissingEnvForSpawn,
} from "./spawner.js";
import {
  initializeRegistry,
  refreshRegistry,
  isRemoteServer,
  getRemoteServerUrl,
  getRemoteServers,
} from "./registry.js";
import { connectRemoteServer, callRemoteServerTool, listRemoteServerTools } from "./remote.js";
import {
  executeGoatTool,
  getRuntimeStatus as getGoatStatus,
  listGoatTools,
  getAvailableTools as getGoatTools,
  EXECUTABLE_PLUGINS as GOAT_PLUGINS,
} from "./goat.js";
import {
  getElizaRuntimeStatus,
  getElizaAgentActions,
  sendElizaMessage,
  executeElizaAction,
  isElizaPluginSupported,
} from "./eliza.js";

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

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

// ============================================================================
// Health Check
// ============================================================================

app.get("/health", (_req: Request, res: Response) => {
  const configs = getAllSpawnConfigs();
  const remotes = getRemoteServers();
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    service: "mcp-spawner",
    version: "0.2.0",
    spawnableServers: configs.size,
    remoteServers: remotes.size,
    totalServers: configs.size + remotes.size,
  });
});

// ============================================================================
// List Servers
// ============================================================================

/**
 * GET /servers
 * List all spawnable MCP servers with their status
 */
app.get("/servers", (_req: Request, res: Response) => {
  const spawnable = getSpawnableServers();
  const remotes = Array.from(getRemoteServers().entries()).map(([slug, url]) => ({
    slug,
    label: slug,
    description: `Remote MCP server: ${url}`,
    spawned: false,
    available: true,
    remote: true,
    url,
  }));

  res.json({
    count: spawnable.length + remotes.length,
    spawnable: spawnable.length,
    remote: remotes.length,
    servers: [...spawnable, ...remotes],
  });
});

/**
 * GET /status
 * Get status of currently spawned servers
 */
app.get("/status", (_req: Request, res: Response) => {
  const status = getSpawnedStatus();
  res.json(status);
});

/**
 * GET /servers/:slug
 * Get info for a specific server
 */
app.get(
  "/servers/:slug",
  asyncHandler(async (req: Request, res: Response) => {
    const { slug } = req.params;

    // Check if it's a remote server
    if (isRemoteServer(slug)) {
      const url = getRemoteServerUrl(slug);
      res.json({
        slug,
        label: slug,
        description: `Remote MCP server`,
        available: true,
        remote: true,
        url,
      });
      return;
    }

    // Check if it's a spawnable server
    const config = getSpawnConfig(slug);
    if (!config) {
      res.status(404).json({
        error: `Server not found: ${slug}`,
        available: Array.from(getAllSpawnConfigs().keys()).slice(0, 20),
      });
      return;
    }

    const missing = getMissingEnvForSpawn(slug);
    res.json({
      slug: config.slug,
      label: config.label,
      description: config.description,
      available: missing.length === 0,
      missingEnv: missing.length > 0 ? missing : undefined,
      category: config.category,
      tags: config.tags,
      command: config.command,
      args: config.args,
    });
  })
);

// ============================================================================
// List Tools
// ============================================================================

/**
 * GET /servers/:slug/tools
 * List tools from an MCP server (spawns/connects on-demand)
 */
app.get(
  "/servers/:slug/tools",
  asyncHandler(async (req: Request, res: Response) => {
    const { slug } = req.params;

    try {
      // Check if it's a remote server
      if (isRemoteServer(slug)) {
        const url = getRemoteServerUrl(slug)!;
        const tools = await listRemoteServerTools(slug, url);
        res.json({
          server: slug,
          remote: true,
          toolCount: tools.length,
          tools,
        });
        return;
      }

      // Check if it's spawnable
      if (!isSpawnableServer(slug)) {
        const missing = getMissingEnvForSpawn(slug);
        if (missing.length > 0) {
          res.status(503).json({
            error: `Server "${slug}" is missing required environment variables`,
            missingEnv: missing,
          });
        } else {
          res.status(404).json({
            error: `Server "${slug}" not available for spawning`,
            available: Array.from(getAllSpawnConfigs().keys()).slice(0, 20),
          });
        }
        return;
      }

      const tools = await listServerTools(slug);
      res.json({
        server: slug,
        toolCount: tools.length,
        tools,
      });
    } catch (error) {
      res.status(503).json({
        error: `Failed to get tools for server: ${slug}`,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  })
);

// ============================================================================
// Call Tool
// ============================================================================

const CallToolSchema = z.object({
  tool: z.string().min(1, "tool name is required"),
  args: z.record(z.string(), z.unknown()).optional().default({}),
});

/**
 * POST /servers/:slug/call
 * Call a tool on an MCP server (spawns/connects on-demand)
 */
app.post(
  "/servers/:slug/call",
  asyncHandler(async (req: Request, res: Response) => {
    const { slug } = req.params;

    const parseResult = CallToolSchema.safeParse(req.body);
    if (!parseResult.success) {
      res.status(400).json({
        error: "Invalid request body",
        details: parseResult.error.issues,
      });
      return;
    }

    const { tool, args } = parseResult.data;

    try {
      // Check if it's a remote server
      if (isRemoteServer(slug)) {
        const url = getRemoteServerUrl(slug)!;
        const result = await callRemoteServerTool(slug, url, tool, args);
        res.json({
          server: slug,
          remote: true,
          tool,
          success: !result.isError,
          content: result.content,
        });
        return;
      }

      // Check if it's spawnable
      if (!isSpawnableServer(slug)) {
        const missing = getMissingEnvForSpawn(slug);
        if (missing.length > 0) {
          res.status(503).json({
            error: `Server "${slug}" is missing required environment variables`,
            missingEnv: missing,
          });
        } else {
          res.status(404).json({
            error: `Server "${slug}" not available for spawning`,
          });
        }
        return;
      }

      console.log(`[call] ${slug}/${tool} with args:`, JSON.stringify(args));
      const result = await callServerTool(slug, tool, args);
      res.json({
        server: slug,
        tool,
        success: !result.isError,
        content: result.content,
      });
    } catch (error) {
      res.status(503).json({
        error: `Failed to call tool on ${slug}`,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  })
);

// ============================================================================
// Server Management
// ============================================================================

/**
 * POST /servers/:slug/warmup
 * Pre-warm a server by spawning it
 */
app.post(
  "/servers/:slug/warmup",
  asyncHandler(async (req: Request, res: Response) => {
    const { slug } = req.params;

    if (isRemoteServer(slug)) {
      // Connect to remote server
      const url = getRemoteServerUrl(slug)!;
      await connectRemoteServer(slug, url);
      res.json({ message: `Remote server ${slug} connected`, slug });
      return;
    }

    if (!isSpawnableServer(slug)) {
      res.status(404).json({
        error: `Server "${slug}" not available for spawning`,
      });
      return;
    }

    try {
      await warmupServer(slug);
      res.json({
        message: `Server ${slug} warmed up successfully`,
        slug,
      });
    } catch (error) {
      res.status(503).json({
        error: `Failed to warmup server: ${slug}`,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  })
);

/**
 * DELETE /servers/:slug
 * Force kill a spawned server
 */
app.delete(
  "/servers/:slug",
  asyncHandler(async (req: Request, res: Response) => {
    const { slug } = req.params;
    await forceKillServer(slug);
    res.json({ message: `Server ${slug} killed` });
  })
);

/**
 * POST /refresh
 * Refresh the registry (reload servers from MCP Registry)
 */
app.post(
  "/refresh",
  asyncHandler(async (_req: Request, res: Response) => {
    await refreshRegistry();
    const configs = getAllSpawnConfigs();
    const remotes = getRemoteServers();
    res.json({
      message: "Registry refreshed from MCP Registry",
      spawnableServers: configs.size,
      remoteServers: remotes.size,
    });
  })
);

// ============================================================================
// GOAT Plugin Execution
// ============================================================================

/**
 * GET /goat/status
 * Get GOAT runtime status
 */
app.get(
  "/goat/status",
  asyncHandler(async (_req: Request, res: Response) => {
    const status = await getGoatStatus();
    res.json(status);
  })
);

/**
 * GET /goat/tools
 * List all available GOAT tools
 */
app.get(
  "/goat/tools",
  asyncHandler(async (_req: Request, res: Response) => {
    const tools = await listGoatTools();
    res.json({
      count: tools.length,
      tools,
    });
  })
);

/**
 * GET /goat/:pluginId/tools
 * List available tools for a specific GOAT plugin
 */
app.get(
  "/goat/:pluginId/tools",
  asyncHandler(async (req: Request, res: Response) => {
    const { pluginId } = req.params;

    if (!GOAT_PLUGINS.includes(pluginId as (typeof GOAT_PLUGINS)[number])) {
      res.status(404).json({
        error: `Plugin "${pluginId}" not found`,
        availablePlugins: [...GOAT_PLUGINS],
      });
      return;
    }

    const tools = getGoatTools(pluginId);
    res.json({
      pluginId,
      tools,
    });
  })
);

const GoatExecuteSchema = z.object({
  tool: z.string().min(1, "tool name is required"),
  args: z.record(z.string(), z.unknown()).optional().default({}),
});

/**
 * POST /goat/:pluginId/execute
 * Execute a tool on a GOAT plugin
 */
app.post(
  "/goat/:pluginId/execute",
  asyncHandler(async (req: Request, res: Response) => {
    const { pluginId } = req.params;

    if (!GOAT_PLUGINS.includes(pluginId as (typeof GOAT_PLUGINS)[number])) {
      res.status(404).json({
        error: `Plugin "${pluginId}" not found`,
        availablePlugins: [...GOAT_PLUGINS],
      });
      return;
    }

    const parseResult = GoatExecuteSchema.safeParse(req.body);
    if (!parseResult.success) {
      res.status(400).json({
        error: "Invalid request body",
        details: parseResult.error.issues,
      });
      return;
    }

    const { tool, args } = parseResult.data;
    console.log(`[goat] Executing ${pluginId}/${tool}`);

    const result = await executeGoatTool(pluginId, tool, args);
    if (result.success) {
      res.json({
        success: true,
        pluginId,
        tool,
        result: result.result,
        txHash: result.txHash,
      });
    } else {
      res.status(400).json({
        success: false,
        pluginId,
        tool,
        error: result.error,
      });
    }
  })
);

// ============================================================================
// ElizaOS Runtime
// ============================================================================

/**
 * GET /eliza/status
 * Get ElizaOS runtime status
 */
app.get(
  "/eliza/status",
  asyncHandler(async (_req: Request, res: Response) => {
    const status = await getElizaRuntimeStatus();
    res.json(status);
  })
);

/**
 * GET /eliza/agents/:agentId/actions
 * Get available actions for an ElizaOS agent
 */
app.get(
  "/eliza/agents/:agentId/actions",
  asyncHandler(async (req: Request, res: Response) => {
    const { agentId } = req.params;
    const actions = await getElizaAgentActions(agentId);
    res.json({ agentId, actions });
  })
);

const ElizaMessageSchema = z.object({
  message: z.string().min(1, "message is required"),
  roomId: z.string().optional(),
});

/**
 * POST /eliza/agents/:agentId/message
 * Send a message to an ElizaOS agent
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

    const { message, roomId } = parseResult.data;
    const result = await sendElizaMessage(agentId, message, roomId);

    if (result.success) {
      res.json(result);
    } else {
      res.status(400).json(result);
    }
  })
);

const ElizaActionSchema = z.object({
  params: z.record(z.string(), z.unknown()).optional().default({}),
});

/**
 * POST /eliza/agents/:agentId/actions/:actionName
 * Execute an action on an ElizaOS agent
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

    const { params } = parseResult.data;
    const result = await executeElizaAction(agentId, actionName, params);

    if (result.success) {
      res.json(result);
    } else {
      res.status(400).json(result);
    }
  })
);

/**
 * GET /eliza/plugins/:pluginId/supported
 * Check if an ElizaOS plugin is supported
 */
app.get(
  "/eliza/plugins/:pluginId/supported",
  asyncHandler(async (req: Request, res: Response) => {
    const { pluginId } = req.params;
    const supported = isElizaPluginSupported(pluginId);
    res.json({ pluginId, supported });
  })
);

// ============================================================================
// Error Handler
// ============================================================================

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error("Unhandled error:", err);
  res.status(500).json({
    error: "Internal server error",
    message: err.message,
  });
});

// ============================================================================
// Server Startup
// ============================================================================

const PORT = parseInt(process.env.PORT || "4003", 10);

async function startServer() {
  // Initialize registry (fetches from official MCP Registry)
  await initializeRegistry();

  const server = app.listen(PORT, "0.0.0.0", () => {
    const configs = getAllSpawnConfigs();
    const remotes = getRemoteServers();
    console.log(`\n🚀 MCP Server listening on http://0.0.0.0:${PORT}`);
    console.log(`\n📦 Registered servers:`);
    console.log(`   - ${configs.size} spawnable (npm packages)`);
    console.log(`   - ${remotes.size} remote (streamable-http)`);
    console.log(`   - Total: ${configs.size + remotes.size}`);
    console.log("\nEndpoints:");
    console.log("  GET  /health              - Health check");
    console.log("  GET  /servers             - List all servers");
    console.log("  GET  /status              - Status of spawned servers");
    console.log("  GET  /servers/:slug       - Get server info");
    console.log("  GET  /servers/:slug/tools - List tools");
    console.log("  POST /servers/:slug/call  - Call a tool");
    console.log("  POST /servers/:slug/warmup - Pre-warm a server");
    console.log("  DELETE /servers/:slug     - Force kill a server");
    console.log("  POST /refresh             - Refresh registry");
    console.log("");
    console.log("  GET  /goat/status         - GOAT runtime status");
    console.log("  GET  /goat/tools          - List GOAT tools");
    console.log("  POST /goat/:id/execute    - Execute GOAT plugin");
    console.log("");
    console.log("  GET  /eliza/status        - ElizaOS runtime status");
    console.log("  POST /eliza/agents/:id/message - Send message");
    console.log("  POST /eliza/agents/:id/actions/:name - Execute action");
    console.log("");
  });

  // Graceful shutdown
  process.on("SIGTERM", async () => {
    console.log("\nReceived SIGTERM, shutting down gracefully...");
    await killAllServers();
    server.close(() => {
      console.log("Server closed");
      process.exit(0);
    });
  });

  process.on("SIGINT", async () => {
    console.log("\nReceived SIGINT, shutting down gracefully...");
    await killAllServers();
    server.close(() => {
      console.log("Server closed");
      process.exit(0);
    });
  });
}

startServer().catch(console.error);

export default app;
