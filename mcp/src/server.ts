/**
 * MCP Server - Production
 *
 * Production MCP server using Compose Runtime.
 * Handles GOAT plugins, MCP tools, and ElizaOS runtime.
 */
import "dotenv/config";
import express, { type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import { handleX402Payment, extractPaymentInfo, DEFAULT_PRICES } from "./payment.js";
import {
  executeGoatTool,
  getRuntimeStatus,
  listPlugins,
  getPlugin,
  getPluginTools,
  listAllTools,
  getTool,
  hasTool,
  getWalletAddress,
  getPluginIds,
} from "./compose-runtime/runtimes/goat.js";
import * as eliza from "./frameworks/eliza.js";
import * as langchain from "./frameworks/langchain.js";
import { listFrameworks, getFramework, type FrameworkType } from "./frameworks/index.js";
import agentRoutes from "./agent-routes.js";
import {
  executeManowar,
  MANOWAR_PRICES,
  type Workflow,
  type PaymentContext,
} from "./manowar/index.js";
import { buildManowarWorkflow, resolveManowarIdentifier } from "./onchain.js";
import {
  registerManowar,
  resolveManowar,
  listRegisteredManowars,
  markManowarExecuted,
  type RegisterManowarParams,
} from "./manowar-registry.js";

const app = express();
app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (origin.startsWith("http://localhost:")) return callback(null, true);
    if (origin === "https://compose.market" ||
      origin === "https://www.compose.market" ||
      origin.endsWith(".compose.market")) {
      return callback(null, true);
    }
    callback(new Error("Not allowed by CORS"));
  },
  credentials: true,
  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "x-payment",
    "x-session-user-address",
    "x-session-active",
    "x-session-budget-remaining",
    "x-manowar-internal",
    "access-control-expose-headers"
  ],
  exposedHeaders: ["x-payment-response", "x-session-id"]
}));
app.use(express.json({ limit: '10mb' }));

// Mount agent routes
app.use("/agent", agentRoutes);

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

app.get("/health", asyncHandler(async (_req: Request, res: Response) => {
  const goatStatus = await getRuntimeStatus();
  const elizaStatus = await eliza.getStatus();
  const langchainStatus = langchain.getStatus();

  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    service: "mcp-compose-runtime",
    version: "1.0.0",
    runtimes: {
      goat: goatStatus.initialized,
      mcp: true,
      eliza: elizaStatus.ready,
      langchain: langchainStatus.ready,
    },
    stats: {
      goatPlugins: goatStatus.plugins.length,
      goatTools: goatStatus.totalTools,
      elizaPlugins: elizaStatus.pluginCount,
      elizaAgents: elizaStatus.agentCount,
      langchainAgents: langchainStatus.agentCount,
    }
  });
}));

// ============================================================================
// GOAT Plugin Routes
// ============================================================================

app.get("/goat/status", asyncHandler(async (_req: Request, res: Response) => {
  const status = await getRuntimeStatus();
  res.json({
    ...status,
    note: status.initialized
      ? "GOAT runtime operational"
      : "GOAT runtime initialization failed"
  });
}));

app.get("/goat/plugins", asyncHandler(async (_req: Request, res: Response) => {
  const plugins = await listPlugins();
  res.json({
    plugins: plugins.map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      toolCount: p.toolCount,
      requiresApiKey: p.requiresApiKey,
      apiKeyConfigured: p.apiKeyConfigured,
    })),
    total: plugins.length,
  });
}));

app.get("/goat/tools", asyncHandler(async (_req: Request, res: Response) => {
  const tools = await listAllTools();
  res.json({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      pluginId: t.pluginId,
    })),
    total: tools.length,
  });
}));

app.get("/goat/plugins/:pluginId", asyncHandler(async (req: Request, res: Response) => {
  const { pluginId } = req.params;
  const pluginIds = await getPluginIds();

  if (!pluginIds.includes(pluginId)) {
    res.status(404).json({ error: `Plugin "${pluginId}" not found` });
    return;
  }

  const tools = await getPluginTools(pluginId);
  const walletAddress = getWalletAddress();
  res.json({
    pluginId,
    walletAddress,
    toolCount: tools.length,
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    })),
  });
}));

app.get("/goat/plugins/:pluginId/tools/:toolName", asyncHandler(async (req: Request, res: Response) => {
  const { pluginId, toolName } = req.params;
  const pluginIds = await getPluginIds();

  if (!pluginIds.includes(pluginId)) {
    res.status(404).json({ error: `Plugin "${pluginId}" not found` });
    return;
  }

  const tool = await getTool(toolName);
  if (!tool) {
    const tools = await getPluginTools(pluginId);
    res.status(404).json({
      error: `Tool "${toolName}" not found in plugin "${pluginId}"`,
      availableTools: tools.map((t) => t.name),
    });
    return;
  }

  res.json(tool);
}));

// Execute GOAT tool with x402 payment
app.post("/goat/plugins/:pluginId/tools/:toolName", asyncHandler(async (req: Request, res: Response) => {
  const { pluginId, toolName } = req.params;
  const { args } = req.body;

  // Extract payment info
  const paymentInfo = extractPaymentInfo(req.headers as Record<string, string>);

  // Handle x402 payment
  const paymentResult = await handleX402Payment(
    paymentInfo.paymentData,
    `${req.protocol}://${req.get("host")}${req.path}`,
    req.method,
    DEFAULT_PRICES.GOAT_EXECUTE
  );

  if (paymentResult.status !== 200) {
    res.status(paymentResult.status).json(paymentResult.responseBody);
    return;
  }

  const pluginIds = await getPluginIds();
  if (!pluginIds.includes(pluginId)) {
    res.status(404).json({ error: `Plugin "${pluginId}" not found` });
    return;
  }

  const toolExists = await hasTool(toolName);
  if (!toolExists) {
    const tools = await getPluginTools(pluginId);
    res.status(404).json({
      error: `Tool "${toolName}" not found`,
      availableTools: tools.map((t) => ({ name: t.name, description: t.description })),
    });
    return;
  }

  const result = await executeGoatTool(pluginId, toolName, args || {});

  if (!result.success) {
    res.status(500).json({ error: result.error });
    return;
  }

  const walletAddress = getWalletAddress();
  res.json({
    success: true,
    result: result.result,
    txHash: result.txHash,
    gasUsed: result.gasUsed,
    executor: walletAddress,
  });
}));

// ============================================================================
// MCP Server Spawning Routes (On-Demand)
// ============================================================================

import { McpRuntime, getServerTools, executeServerTool } from "./compose-runtime/runtimes/mcp.js";

const mcpRuntime = new McpRuntime();
mcpRuntime.initialize().catch(console.error);

// ============================================================================
// MCP Server Routes (Following GOAT Pattern)
// ============================================================================

/**
 * GET /mcp/servers/:serverId/tools
 * Get tools for an MCP server (spawns on-demand, uses cached session)
 */
app.get("/mcp/servers/:serverId/tools", asyncHandler(async (req: Request, res: Response) => {
  const { serverId } = req.params;

  try {
    const result = await getServerTools(serverId);
    res.json(result);
  } catch (error) {
    res.status(500).json({
      error: `Failed to get tools for ${serverId}`,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}));

/**
 * POST /mcp/servers/:serverId/tools/:toolName
 * Execute a tool on an MCP server
 */
app.post("/mcp/servers/:serverId/tools/:toolName", asyncHandler(async (req: Request, res: Response) => {
  const { serverId, toolName } = req.params;
  const { args } = req.body;

  // Extract payment info
  const paymentInfo = extractPaymentInfo(req.headers as Record<string, string>);

  // Handle x402 payment
  const paymentResult = await handleX402Payment(
    paymentInfo.paymentData,
    `${req.protocol}://${req.get("host")}${req.path}`,
    req.method,
    DEFAULT_PRICES.MCP_TOOL_CALL
  );

  if (paymentResult.status !== 200) {
    res.status(paymentResult.status).json(paymentResult.responseBody);
    return;
  }

  try {
    const result = await executeServerTool(serverId, toolName, args || {});
    res.json({
      success: true,
      serverId,
      tool: toolName,
      result,
    });
  } catch (error) {
    res.status(500).json({
      error: `Failed to execute tool ${toolName} on ${serverId}`,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}));

// ============================================================================
// Framework Routes
// ============================================================================

app.get("/frameworks", (_req: Request, res: Response) => {
  res.json(listFrameworks());
});

app.get("/frameworks/:framework", (req: Request, res: Response) => {
  const framework = getFramework(req.params.framework as FrameworkType);
  if (!framework) {
    res.status(404).json({ error: "Framework not found" });
    return;
  }
  res.json(framework);
});

// ============================================================================
// ElizaOS Plugin Routes
// ============================================================================

app.get("/eliza/plugins", asyncHandler(async (_req: Request, res: Response) => {
  const plugins = await eliza.listPlugins();
  res.json({ plugins });
}));

app.get("/eliza/plugins/:pluginId", asyncHandler(async (req: Request, res: Response) => {
  const plugin = await eliza.getPlugin(req.params.pluginId);
  if (!plugin) {
    res.status(404).json({ error: "Plugin not found" });
    return;
  }
  res.json(plugin);
}));

app.post("/eliza/plugins/:pluginId/execute", asyncHandler(async (req: Request, res: Response) => {
  const { pluginId } = req.params;
  const { action, input } = req.body;

  // Extract payment info
  const paymentInfo = extractPaymentInfo(req.headers as Record<string, string>);

  // Handle x402 payment
  const paymentResult = await handleX402Payment(
    paymentInfo.paymentData,
    `${req.protocol}://${req.get("host")}${req.path}`,
    req.method,
    DEFAULT_PRICES.ELIZA_ACTION
  );

  if (paymentResult.status !== 200) {
    res.status(paymentResult.status).json(paymentResult.responseBody);
    return;
  }

  const plugin = await eliza.getPlugin(pluginId);
  if (!plugin) {
    res.status(404).json({ error: "Plugin not found" });
    return;
  }

  // Create test agent for this plugin
  const agentId = await eliza.getTestAgent(pluginId);
  const result = await eliza.executeAction(agentId, pluginId, action, input);
  res.json(result);
}));

app.post("/eliza/message", asyncHandler(async (req: Request, res: Response) => {
  const { agentId, message, roomId } = req.body;

  // Extract payment info
  const paymentInfo = extractPaymentInfo(req.headers as Record<string, string>);

  // Handle x402 payment
  const paymentResult = await handleX402Payment(
    paymentInfo.paymentData,
    `${req.protocol}://${req.get("host")}${req.path}`,
    req.method,
    DEFAULT_PRICES.ELIZA_MESSAGE
  );

  if (paymentResult.status !== 200) {
    res.status(paymentResult.status).json(paymentResult.responseBody);
    return;
  }

  const result = await eliza.sendMessage(agentId, message, roomId);
  res.json({ messages: result });
}));

// ============================================================================
// LangChain Agent Routes
// ============================================================================

app.get("/langchain", (_req: Request, res: Response) => {
  res.json(langchain.getStatus());
});

app.get("/langchain/agents", (req: Request, res: Response) => {
  const agents = langchain.listAgents().map((a) => ({
    id: a.id,
    name: a.name,
    toolCount: a.tools?.length || 0,
  }));
  res.json({ agents });
});

app.post("/langchain/chat", asyncHandler(async (req: Request, res: Response) => {
  const { agentId, message, options } = req.body;

  // Extract payment info
  const paymentInfo = extractPaymentInfo(req.headers as Record<string, string>);

  // Handle x402 payment
  const paymentResult = await handleX402Payment(
    paymentInfo.paymentData,
    `${req.protocol}://${req.get("host")}${req.path}`,
    req.method,
    DEFAULT_PRICES.AGENT_CHAT
  );

  if (paymentResult.status !== 200) {
    res.status(paymentResult.status).json(paymentResult.responseBody);
    return;
  }

  const result = await langchain.executeAgent(agentId, message, options || {});
  res.json(result);
}));

// ============================================================================
// Manowar Routes (Workflow Orchestration)
// ============================================================================

app.post("/manowar/execute", asyncHandler(async (req: Request, res: Response) => {
  const { payload } = req.body;

  // Extract and validate payment
  const paymentInfo = extractPaymentInfo(req.headers as Record<string, string>);

  // Handle x402 payment (pass internal secret for Manowar nested calls)
  const internalSecret = req.headers["x-manowar-internal"] as string | undefined;
  const paymentResult = await handleX402Payment(
    paymentInfo.paymentData,
    `${req.protocol}://${req.get("host")}${req.path}`,
    req.method,
    DEFAULT_PRICES.WORKFLOW_RUN,
    internalSecret
  );

  if (paymentResult.status !== 200) {
    res.status(paymentResult.status).json(paymentResult.responseBody);
    return;
  }

  // Parse manowar identifier
  const identifier = String(payload.manowarId || payload.workflow || payload.id);
  const resolved = await resolveManowarIdentifier(identifier);

  if (!resolved) {
    res.status(404).json({ error: `Manowar "${identifier}" not found` });
    return;
  }

  // Build workflow from on-chain data
  const workflow = await buildManowarWorkflow(resolved.manowarId);

  if (!workflow) {
    res.status(500).json({ error: "Failed to build workflow" });
    return;
  }

  // Prepare payment context
  const paymentContext: PaymentContext = {
    paymentData: req.headers["x-payment"] as string || null,
    sessionActive: paymentInfo.sessionActive,
    sessionBudgetRemaining: paymentInfo.sessionBudgetRemaining,
    resourceUrlBase: `${req.protocol}://${req.get("host")}`,
  };

  // Execute workflow
  const result = await executeManowar(workflow, {
    input: payload.input || {},
    payment: paymentContext,
  });

  // Mark as executed
  if (resolved.manowarId !== undefined) {
    markManowarExecuted(resolved.manowarId.toString());
  }

  res.json(result);
}));

app.get("/manowar/prices", (_req: Request, res: Response) => {
  res.json({
    ORCHESTRATION: MANOWAR_PRICES.ORCHESTRATION,
    AGENT_STEP: MANOWAR_PRICES.AGENT_STEP,
    INFERENCE: MANOWAR_PRICES.INFERENCE,
    MCP_TOOL: MANOWAR_PRICES.MCP_TOOL,
  });
});

app.post("/manowar/register", asyncHandler(async (req: Request, res: Response) => {
  const { payload } = req.body;

  // Extract and validate payment
  const paymentInfo = extractPaymentInfo(req.headers as Record<string, string>);

  // Handle x402 payment for registration
  const paymentResult = await handleX402Payment(
    paymentInfo.paymentData,
    `${req.protocol}://${req.get("host")}${req.path}`,
    req.method,
    DEFAULT_PRICES.WORKFLOW_RUN
  );

  if (paymentResult.status !== 200) {
    res.status(paymentResult.status).json(paymentResult.responseBody);
    return;
  }

  // Resolve identifier
  const identifier = String(payload.identifier);
  const resolved = await resolveManowarIdentifier(identifier);

  if (!resolved) {
    res.status(404).json({ error: `Manowar "${identifier}" not found` });
    return;
  }

  const registrationResult = registerManowar({
    manowarId: resolved.manowarId,
    walletAddress: payload.walletAddress,
    title: resolved.data.title,
    description: resolved.data.description,
    creator: payload.creator || "0x0000000000000000000000000000000000000000",
  } as RegisterManowarParams);

  res.json({
    success: true,
    manowarId: registrationResult.manowarId,
    walletAddress: registrationResult.walletAddress,
  });
}));

app.get("/manowar", (_req: Request, res: Response) => {
  const manowars = listRegisteredManowars();
  res.json({
    manowars: manowars.map((m) => ({
      manowarId: m.manowarId,
      walletAddress: m.walletAddress,
      title: m.title,
      description: m.description,
      creator: m.creator,
    })),
    total: manowars.length,
  });
});

// ============================================================================
// Error Handling
// ============================================================================

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error("[error]", err);
  res.status(500).json({
    error: err.message || "Internal server error",
    timestamp: new Date().toISOString(),
  });
});

// ============================================================================
// Server Startup
// ============================================================================

const PORT = process.env.MCP_PORT || process.env.PORT || 4000;

app.listen(PORT, () => {
  console.log(`[mcp] Server listening on port ${PORT}`);
  console.log(`[mcp] Compose Runtime with GOAT + MCP + ElizaOS`);
});

export default app;
