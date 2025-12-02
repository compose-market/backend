import "dotenv/config";
import express, { type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import {
  CONNECTORS,
  getConnector,
  getAllConnectorsInfo,
  isValidConnectorId,
  isConnectorAvailable
} from "./connectors.js";
import { listTools, callTool, closeAllConnections } from "./mcpClient.js";
import { createRegistryRouter, getServerByRegistryId } from "./registry.js";
import { buildAgentCardFromRegistry, type BuildAgentCardOptions } from "./builder.js";
import { validateAgentCard, assertValidAgentCard } from "./validate.js";
import type { ConnectorId } from "./types.js";
import type { UnifiedServerRecord } from "./registry.js";

const app = express();
app.use(express.json());

// Mount the MCP registry router
app.use("/registry", createRegistryRouter());

// Request logging middleware
app.use((req: Request, _res: Response, next: NextFunction) => {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${req.method} ${req.path}`);
  next();
});

// Error handling middleware
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
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    service: "connector-hub",
    version: "0.1.0"
  });
});

// ============================================================================
// List Connectors
// ============================================================================

/**
 * GET /connectors
 * Returns list of available connectors with their status
 */
app.get("/connectors", (_req: Request, res: Response) => {
  const connectors = getAllConnectorsInfo();
  res.json({ connectors });
});

/**
 * GET /connectors/:id
 * Returns details for a specific connector
 */
app.get(
  "/connectors/:id",
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;

    if (!isValidConnectorId(id)) {
      res.status(404).json({ error: `Unknown connector: ${id}` });
      return;
    }

    const connector = getConnector(id);
    const available = isConnectorAvailable(connector);

    res.json({
      id: connector.id,
      label: connector.label,
      description: connector.description,
      available,
      httpBased: connector.httpBased ?? false
    });
  })
);

// ============================================================================
// List Tools
// ============================================================================

/**
 * GET /connectors/:id/tools
 * Lists available tools for a connector
 */
app.get(
  "/connectors/:id/tools",
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;

    if (!isValidConnectorId(id)) {
      res.status(404).json({ error: `Unknown connector: ${id}` });
      return;
    }

    const connector = getConnector(id);
    if (!isConnectorAvailable(connector)) {
      res.status(503).json({
        error: `Connector "${id}" is not available. Missing environment variables.`
      });
      return;
    }

    try {
      const tools = await listTools(id);
      res.json({
        connector: id,
        tools: tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema
        }))
      });
    } catch (error) {
      console.error(`Error listing tools for ${id}:`, error);
      res.status(500).json({
        error: `Failed to list tools for connector "${id}"`,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  })
);

// ============================================================================
// Call Tool
// ============================================================================

const CallToolSchema = z.object({
  toolName: z.string().min(1, "toolName is required"),
  args: z.record(z.string(), z.unknown()).optional().default({})
});

/**
 * POST /connectors/:id/call
 * Executes a tool on the specified connector
 * 
 * Body: { toolName: string, args?: object }
 */
app.post(
  "/connectors/:id/call",
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;

    if (!isValidConnectorId(id)) {
      res.status(404).json({ error: `Unknown connector: ${id}` });
      return;
    }

    const connector = getConnector(id);
    if (!isConnectorAvailable(connector)) {
      res.status(503).json({
        error: `Connector "${id}" is not available. Missing environment variables.`
      });
      return;
    }

    // Validate request body
    const parseResult = CallToolSchema.safeParse(req.body);
    if (!parseResult.success) {
      res.status(400).json({
        error: "Invalid request body",
        details: parseResult.error.issues
      });
      return;
    }

    const { toolName, args } = parseResult.data;

    try {
      console.log(`Calling tool "${toolName}" on connector "${id}" with args:`, JSON.stringify(args));
      
      const result = await callTool(id, toolName, args);
      
      res.json({
        connector: id,
        tool: toolName,
        success: !result.isError,
        content: result.content,
        raw: result.raw
      });
    } catch (error) {
      console.error(`Error calling tool ${toolName} on ${id}:`, error);
      res.status(500).json({
        error: `Failed to call tool "${toolName}" on connector "${id}"`,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  })
);

// ============================================================================
// Agent Card Generation
// ============================================================================

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
        card: validated
      });
    } catch (error) {
      console.error("Error generating agent card:", error);
      const details = (error as any).details;
      res.status(400).json({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        details
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
        error: error instanceof Error ? error.message : String(error)
      });
    }
  })
);

// ============================================================================
// Error Handler
// ============================================================================

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error("Unhandled error:", err);
  res.status(500).json({
    error: "Internal server error",
    message: err.message
  });
});

// ============================================================================
// Server Startup
// ============================================================================

const PORT = parseInt(process.env.PORT || "4001", 10);

const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`\n🔌 Connector Hub listening on http://0.0.0.0:${PORT}`);
  console.log("\nAvailable connectors:");
  
  const connectors = getAllConnectorsInfo();
  for (const connector of connectors) {
    const status = connector.available ? "✓" : "✗";
    const missing = connector.missingEnv ? ` (missing: ${connector.missingEnv.join(", ")})` : "";
    console.log(`  ${status} ${connector.label} (${connector.id})${missing}`);
  }
  
  console.log("\nEndpoints:");
  console.log("  GET  /health                    - Health check");
  console.log("  GET  /connectors                - List all connectors");
  console.log("  GET  /connectors/:id            - Get connector details");
  console.log("  GET  /connectors/:id/tools      - List tools for a connector");
  console.log("  POST /connectors/:id/call       - Execute a tool");
  console.log("");
  console.log("  GET  /registry/servers          - List MCP servers");
  console.log("  GET  /registry/servers/search   - Search MCP servers");
  console.log("  GET  /registry/servers/:id      - Get server by ID");
  console.log("  GET  /registry/categories       - List categories");
  console.log("  GET  /registry/tags             - List tags");
  console.log("  GET  /registry/meta             - Registry metadata");
  console.log("");
});

// Graceful shutdown
process.on("SIGTERM", async () => {
  console.log("\nReceived SIGTERM, shutting down gracefully...");
  await closeAllConnections();
  server.close(() => {
    console.log("Server closed");
    process.exit(0);
  });
});

process.on("SIGINT", async () => {
  console.log("\nReceived SIGINT, shutting down gracefully...");
  await closeAllConnections();
  server.close(() => {
    console.log("Server closed");
    process.exit(0);
  });
});

export default app;

