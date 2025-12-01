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
import type { ConnectorId } from "./types.js";

const app = express();
app.use(express.json());

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
  console.log("  GET  /health              - Health check");
  console.log("  GET  /connectors          - List all connectors");
  console.log("  GET  /connectors/:id      - Get connector details");
  console.log("  GET  /connectors/:id/tools - List tools for a connector");
  console.log("  POST /connectors/:id/call - Execute a tool");
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

