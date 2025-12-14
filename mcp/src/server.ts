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
  listAllTools,
  listPlugins,
  getPluginTools,
  getTool,
  hasTool,
  getWalletAddress,
  getPluginIds,
} from "./goat.js";
import {
  eliza,
  langchain,
  listFrameworks,
  getFramework,
  type FrameworkType,
} from "./frameworks/index.js";
import {
  handleX402Payment,
  extractPaymentInfo,
  DEFAULT_PRICES,
} from "./payment.js";
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
    // Allow requests with no origin (like mobile apps or curl)
    if (!origin) return callback(null, true);

    // Allow all localhost ports
    if (origin.startsWith("http://localhost:")) return callback(null, true);

    // Allow compose.market and all subdomains
    if (origin === "https://compose.market" ||
      origin === "https://www.compose.market" ||
      origin.endsWith(".compose.market")) {
      return callback(null, true);
    }

    // Reject other origins
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

    // x402 Payment Verification - ALWAYS required, no session bypass
    const { paymentData } = extractPaymentInfo(
      req.headers as Record<string, string | string[] | undefined>
    );

    const resourceUrl = `https://${req.get("host")}${req.originalUrl}`;
    const paymentResult = await handleX402Payment(
      paymentData,
      resourceUrl,
      "POST",
      DEFAULT_PRICES.MCP_TOOL_CALL,
    );

    if (paymentResult.status !== 200) {
      Object.entries(paymentResult.responseHeaders).forEach(([key, value]) => {
        res.setHeader(key, value);
      });
      res.status(paymentResult.status).json(paymentResult.responseBody);
      return;
    }
    console.log(`[x402] Payment verified for ${slug}`);

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
// GOAT Plugin Execution - Dynamic Plugin Loading
// ============================================================================

/**
 * GET /goat/status
 * Get GOAT runtime status with all dynamically loaded plugins
 */
app.get(
  "/goat/status",
  asyncHandler(async (_req: Request, res: Response) => {
    const status = await getGoatStatus();
    res.json({
      ...status,
      note: status.initialized
        ? `GOAT runtime ready - ${status.totalTools} tools from ${status.plugins.length} plugins`
        : `GOAT runtime not ready: ${status.error}`,
    });
  })
);

/**
 * GET /goat/plugins
 * List all available GOAT plugins (dynamically)
 */
app.get(
  "/goat/plugins",
  asyncHandler(async (_req: Request, res: Response) => {
    const plugins = await listPlugins();
    res.json({
      count: plugins.length,
      plugins: plugins.map(p => ({
        id: p.id,
        name: p.name,
        description: p.description,
        toolCount: p.toolCount,
        requiresApiKey: p.requiresApiKey,
        apiKeyConfigured: p.apiKeyConfigured,
      })),
    });
  })
);

/**
 * GET /goat/tools
 * List all available GOAT tools across all plugins
 */
app.get(
  "/goat/tools",
  asyncHandler(async (_req: Request, res: Response) => {
    const tools = await listAllTools();
    res.json({
      count: tools.length,
      tools: tools.map(t => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
        pluginId: t.pluginId,
      })),
    });
  })
);

/**
 * GET /goat/:pluginId/tools
 * List available tools for a specific GOAT plugin with full JSON schemas
 */
app.get(
  "/goat/:pluginId/tools",
  asyncHandler(async (req: Request, res: Response) => {
    const { pluginId } = req.params;

    const pluginIds = await getPluginIds();
    if (!pluginIds.includes(pluginId)) {
      res.status(404).json({
        error: `Plugin "${pluginId}" not found`,
        availablePlugins: pluginIds,
      });
      return;
    }

    const tools = await getPluginTools(pluginId);
    const walletAddress = getWalletAddress();

    res.json({
      pluginId,
      toolCount: tools.length,
      executionWallet: walletAddress,
      tools: tools.map(t => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters, // JSON Schema from Zod
        example: buildToolExample(t.name, t.parameters),
      })),
    });
  })
);

/**
 * GET /goat/:pluginId/tools/:toolName
 * Get specific tool metadata with full JSON schema
 */
app.get(
  "/goat/:pluginId/tools/:toolName",
  asyncHandler(async (req: Request, res: Response) => {
    const { pluginId, toolName } = req.params;

    const pluginIds = await getPluginIds();
    if (!pluginIds.includes(pluginId)) {
      res.status(404).json({
        error: `Plugin "${pluginId}" not found`,
        availablePlugins: pluginIds,
      });
      return;
    }

    const toolSchema = await getTool(toolName);
    if (!toolSchema) {
      const tools = await getPluginTools(pluginId);
      res.status(404).json({
        error: `Tool "${toolName}" not found in plugin "${pluginId}"`,
        availableTools: tools.map(t => t.name),
      });
      return;
    }

    res.json({
      ...toolSchema,
      example: buildToolExample(toolSchema.name, toolSchema.parameters),
    });
  })
);

/**
 * Build example usage for a tool
 */
function buildToolExample(toolName: string, parameters: Record<string, unknown>): Record<string, unknown> {
  // Common example values
  const examples: Record<string, unknown> = {};

  // Try to build sensible examples from parameter schema
  const props = (parameters as any)?.properties || {};

  for (const [key, schema] of Object.entries(props as Record<string, any>)) {
    if (key === "address" || key.includes("Address")) {
      examples[key] = "0xA893ceb66ac75DBDe4EBca89671AFE29f5B88359";
    } else if (key === "amount") {
      examples[key] = "1000000"; // 1 USDC (6 decimals)
    } else if (key === "tokenAddress") {
      examples[key] = "0x5425890298aed601595a70AB815c96711a31Bc65"; // USDC on Fuji
    } else if (key === "spender" || key === "owner" || key === "recipient") {
      examples[key] = "0x058271e764154c322f3d3ddc18af44f7d91b1c80";
    } else if (key === "coinIds") {
      examples[key] = ["bitcoin", "ethereum", "avalanche-2"];
    } else if (key === "vsCurrency") {
      examples[key] = "usd";
    } else if (key === "query") {
      examples[key] = "avalanche";
    } else if (key === "id") {
      examples[key] = "avalanche-2";
    } else if (key === "ticker") {
      examples[key] = "USDC";
    } else if (schema?.type === "boolean") {
      examples[key] = true;
    } else if (schema?.type === "number") {
      examples[key] = 1;
    } else if (schema?.type === "string") {
      examples[key] = "example";
    }
  }

  return examples;
}

const GoatExecuteSchema = z.object({
  tool: z.string().min(1, "tool name is required"),
  args: z.record(z.string(), z.unknown()).optional().default({}),
});

/**
 * POST /goat/:pluginId/execute
 * Execute a tool on a GOAT plugin
 * 
 * Body: { tool: string, args: Record<string, unknown> }
 * 
 * All tools execute using the server's treasury wallet - users don't need their own keys.
 * All calls require x402 payment.
 */
app.post(
  "/goat/:pluginId/execute",
  asyncHandler(async (req: Request, res: Response) => {
    const { pluginId } = req.params;

    // x402 Payment Verification - ALWAYS required, no session bypass
    const { paymentData } = extractPaymentInfo(
      req.headers as Record<string, string | string[] | undefined>
    );

    const resourceUrl = `https://${req.get("host")}${req.originalUrl}`;
    const paymentResult = await handleX402Payment(
      paymentData,
      resourceUrl,
      "POST",
      DEFAULT_PRICES.GOAT_EXECUTE,
    );

    if (paymentResult.status !== 200) {
      Object.entries(paymentResult.responseHeaders).forEach(([key, value]) => {
        res.setHeader(key, value);
      });
      res.status(paymentResult.status).json(paymentResult.responseBody);
      return;
    }
    console.log(`[x402] Payment verified for goat/${pluginId}`);

    const pluginIds = await getPluginIds();
    if (!pluginIds.includes(pluginId)) {
      res.status(404).json({
        error: `Plugin "${pluginId}" not found`,
        availablePlugins: pluginIds,
        hint: "Use GET /goat/plugins to see available plugins",
      });
      return;
    }

    const parseResult = GoatExecuteSchema.safeParse(req.body);
    if (!parseResult.success) {
      const availableTools = await getPluginTools(pluginId);
      res.status(400).json({
        error: "Invalid request body",
        details: parseResult.error.issues,
        hint: "Request body should be: { tool: string, args: {} }",
        availableTools: availableTools.map(t => ({ name: t.name, description: t.description })),
      });
      return;
    }

    const { tool, args } = parseResult.data;

    // Validate tool exists before execution
    const toolExists = await hasTool(tool);
    if (!toolExists) {
      const availableTools = await getPluginTools(pluginId);
      res.status(404).json({
        error: `Tool "${tool}" not found in plugin "${pluginId}"`,
        availableTools: availableTools.map(t => ({
          name: t.name,
          description: t.description,
          example: buildToolExample(t.name, t.parameters),
        })),
      });
      return;
    }

    console.log(`[goat] Executing ${pluginId}/${tool} with args:`, JSON.stringify(args));

    const result = await executeGoatTool(pluginId, tool, args);

    if (result.success) {
      const walletAddress = getWalletAddress();
      res.json({
        success: true,
        pluginId,
        tool,
        result: result.result,
        txHash: result.txHash,
        gasUsed: result.gasUsed,
        executedBy: walletAddress,
        chain: process.env.USE_MAINNET === "true" ? "avalanche" : "avalanche-fuji",
        explorer: result.txHash
          ? `https://testnet.snowscan.xyz/tx/${result.txHash}`
          : undefined,
      });
    } else {
      res.status(400).json({
        success: false,
        pluginId,
        tool,
        error: result.error,
        hint: "Check tool parameters - use GET /goat/:pluginId/tools/:toolName for schema",
      });
    }
  })
);

// ============================================================================
// Frameworks - ElizaOS, LangChain
// ============================================================================

/**
 * GET /frameworks
 * List available agent frameworks
 */
app.get("/frameworks", (_req: Request, res: Response) => {
  res.json({
    frameworks: listFrameworks(),
  });
});

/**
 * GET /frameworks/:id
 * Get framework info
 */
app.get("/frameworks/:id", (req: Request, res: Response) => {
  const framework = getFramework(req.params.id as FrameworkType);
  if (!framework) {
    res.status(404).json({ error: `Framework "${req.params.id}" not found` });
    return;
  }
  res.json(framework);
});

// ============================================================================
// ElizaOS Framework Endpoints
// ============================================================================

/**
 * GET /eliza/status
 * Get ElizaOS runtime status
 */
app.get(
  "/eliza/status",
  asyncHandler(async (_req: Request, res: Response) => {
    const status = await eliza.getStatus();
    res.json(status);
  })
);

/**
 * GET /eliza/plugins
 * List available ElizaOS plugins (dynamically fetched from GitHub registry)
 */
app.get(
  "/eliza/plugins",
  asyncHandler(async (req: Request, res: Response) => {
    const { search, category } = req.query;

    let plugins;
    if (search && typeof search === "string") {
      plugins = await eliza.searchPlugins(search);
    } else if (category && typeof category === "string") {
      plugins = await eliza.getPluginsByCategory(category);
    } else {
      plugins = await eliza.listPlugins();
    }

    res.json({
      count: plugins.length,
      plugins: plugins.map((p) => ({
        id: p.id,
        package: p.package,
        source: p.source,
        description: p.description,
        version: p.version,
        supports: p.supports,
      })),
    });
  })
);

/**
 * GET /eliza/plugins/:pluginId
 * Get detailed info for a specific plugin
 */
app.get(
  "/eliza/plugins/:pluginId",
  asyncHandler(async (req: Request, res: Response) => {
    const { pluginId } = req.params;
    const plugin = await eliza.getPlugin(pluginId);

    if (!plugin) {
      const plugins = await eliza.listPlugins();
      res.status(404).json({
        error: `Plugin "${pluginId}" not found`,
        hint: "Use GET /eliza/plugins to see available plugins",
        availablePlugins: plugins.slice(0, 20).map((p) => p.id),
        totalPlugins: plugins.length,
      });
      return;
    }

    res.json(plugin);
  })
);

/**
 * GET /eliza/agents
 * List ElizaOS agents
 */
app.get(
  "/eliza/agents",
  asyncHandler(async (_req: Request, res: Response) => {
    const agents = await eliza.listAgents();
    res.json({ agents });
  })
);

/**
 * POST /eliza/agents
 * Create a new ElizaOS agent
 */
app.post(
  "/eliza/agents",
  asyncHandler(async (req: Request, res: Response) => {
    const { name, bio, plugins, settings } = req.body;
    const agent = await eliza.createAgent({ name, bio, plugins, settings });
    res.json(agent);
  })
);

const ElizaExecuteSchema = z.object({
  action: z.string().min(1, "action name is required"),
  params: z.record(z.string(), z.unknown()).optional().default({}),
});

/**
 * POST /eliza/plugins/:pluginId/execute
 * Execute an action on an ElizaOS plugin via test agent
 * Requires x402 payment.
 */
app.post(
  "/eliza/plugins/:pluginId/execute",
  asyncHandler(async (req: Request, res: Response) => {
    const { pluginId } = req.params;

    // x402 Payment Verification - ALWAYS required, no session bypass
    const { paymentData } = extractPaymentInfo(
      req.headers as Record<string, string | string[] | undefined>
    );

    const resourceUrl = `https://${req.get("host")}${req.originalUrl}`;
    const paymentResult = await handleX402Payment(
      paymentData,
      resourceUrl,
      "POST",
      DEFAULT_PRICES.ELIZA_ACTION,
    );

    if (paymentResult.status !== 200) {
      Object.entries(paymentResult.responseHeaders).forEach(([key, value]) => {
        res.setHeader(key, value);
      });
      res.status(paymentResult.status).json(paymentResult.responseBody);
      return;
    }
    console.log(`[x402] Payment verified for eliza/${pluginId}/execute`);

    // Validate plugin exists
    const plugin = await eliza.getPlugin(pluginId);
    if (!plugin) {
      const plugins = await eliza.listPlugins();
      res.status(404).json({
        error: `Plugin "${pluginId}" not found`,
        availablePlugins: plugins.slice(0, 20).map((p) => p.id),
      });
      return;
    }

    const parseResult = ElizaExecuteSchema.safeParse(req.body);
    if (!parseResult.success) {
      res.status(400).json({
        error: "Invalid request body",
        details: parseResult.error.issues,
        hint: "Request body should be: { action: string, params: {} }",
      });
      return;
    }

    const { action, params } = parseResult.data;

    console.log(`[eliza] Executing ${pluginId}/${action} with params:`, JSON.stringify(params));

    const result = await eliza.testPluginAction(pluginId, action, params);

    if (result.success) {
      res.json({
        success: true,
        pluginId,
        action,
        text: result.text,
        data: result.data,
      });
    } else {
      res.status(400).json({
        success: false,
        pluginId,
        action,
        error: result.error,
      });
    }
  })
);

/**
 * POST /eliza/agents/:agentId/message
 * Send a message to an ElizaOS agent
 */
app.post(
  "/eliza/agents/:agentId/message",
  asyncHandler(async (req: Request, res: Response) => {
    const { agentId } = req.params;
    const { message, roomId } = req.body;

    // x402 Payment Verification - ALWAYS required, no session bypass
    const { paymentData } = extractPaymentInfo(
      req.headers as Record<string, string | string[] | undefined>
    );

    const resourceUrl = `https://${req.get("host")}${req.originalUrl}`;
    const paymentResult = await handleX402Payment(
      paymentData,
      resourceUrl,
      "POST",
      DEFAULT_PRICES.ELIZA_ACTION,
    );

    if (paymentResult.status !== 200) {
      Object.entries(paymentResult.responseHeaders).forEach(([key, value]) => {
        res.setHeader(key, value);
      });
      res.status(paymentResult.status).json(paymentResult.responseBody);
      return;
    }


    const messages = await eliza.sendMessage(agentId, message, roomId);
    res.json({ messages });
  })
);

// ============================================================================
// LangChain Framework Endpoints
// ============================================================================

/**
 * GET /langchain/status
 * Get LangChain framework status
 */
app.get("/langchain/status", (_req: Request, res: Response) => {
  res.json(langchain.getStatus());
});

/**
 * POST /langchain/agents
 * Create a new LangChain agent
 */
app.post(
  "/langchain/agents",
  asyncHandler(async (req: Request, res: Response) => {
    const config = req.body;
    const agent = await langchain.createAgent(config);
    res.json({
      id: agent.id,
      name: agent.name,
      config: agent.config,
    });
  })
);

/**
 * GET /langchain/agents
 * List LangChain agents
 */
app.get("/langchain/agents", (_req: Request, res: Response) => {
  const agents = langchain.listAgents();
  res.json({
    agents: agents.map((a) => ({
      id: a.id,
      name: a.name,
    })),
  });
});

/**
 * POST /langchain/agents/:agentId/execute
 * Execute a message on a LangChain agent
 */
app.post(
  "/langchain/agents/:agentId/execute",
  asyncHandler(async (req: Request, res: Response) => {
    const { agentId } = req.params;
    const { message, threadId } = req.body;

    // x402 Payment Verification - ALWAYS required, no session bypass
    const { paymentData } = extractPaymentInfo(
      req.headers as Record<string, string | string[] | undefined>
    );

    const resourceUrl = `https://${req.get("host")}${req.originalUrl}`;
    const paymentResult = await handleX402Payment(
      paymentData,
      resourceUrl,
      "POST",
      DEFAULT_PRICES.ELIZA_ACTION,
    );

    if (paymentResult.status !== 200) {
      Object.entries(paymentResult.responseHeaders).forEach(([key, value]) => {
        res.setHeader(key, value);
      });
      res.status(paymentResult.status).json(paymentResult.responseBody);
      return;
    }


    const result = await langchain.executeAgent(agentId, message, threadId);
    res.json(result);
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
// Manowar Registry & Workflow Execution
// ============================================================================

const RegisterManowarSchema = z.object({
  manowarId: z.number(),
  walletAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  dnaHash: z.string().optional(),
  title: z.string().min(1),
  description: z.string(),
  banner: z.string().optional(),
  creator: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  hasCoordinator: z.boolean().optional(),
  coordinatorModel: z.string().optional(),
  totalPrice: z.string().optional(),
});

/**
 * POST /manowar/register
 * Register a manowar workflow (called after on-chain mint)
 * 
 * The walletAddress is derived from dnaHash at minting and must match frontend derivation.
 */
app.post(
  "/manowar/register",
  asyncHandler(async (req: Request, res: Response) => {
    const parseResult = RegisterManowarSchema.safeParse(req.body);
    if (!parseResult.success) {
      res.status(400).json({
        error: "Invalid request body",
        details: parseResult.error.issues,
      });
      return;
    }

    const params = parseResult.data;

    try {
      const manowar = registerManowar(params as RegisterManowarParams);

      res.status(201).json({
        success: true,
        manowar: {
          manowarId: manowar.manowarId,
          title: manowar.title,
          walletAddress: manowar.walletAddress,
          chatUrl: `/manowar/${manowar.walletAddress}/chat`,
        },
      });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[manowar-routes] Registration failed:`, errorMsg);
      res.status(500).json({ error: errorMsg });
    }
  })
);

/**
 * GET /manowar/list
 * List all registered manowars
 */
app.get("/manowar/list", (_req: Request, res: Response) => {
  const manowars = listRegisteredManowars();
  res.json({
    count: manowars.length,
    manowars: manowars.map((m) => ({
      manowarId: m.manowarId,
      title: m.title,
      description: m.description,
      walletAddress: m.walletAddress,
      coordinatorModel: m.coordinatorModel,
      createdAt: m.createdAt.toISOString(),
      lastExecutedAt: m.lastExecutedAt?.toISOString(),
    })),
  });
});

const ManowarExecuteSchema = z.object({
  workflow: z.object({
    id: z.string(),
    name: z.string(),
    description: z.string().optional().default(""),
    steps: z.array(z.object({
      id: z.string(),
      name: z.string(),
      type: z.enum(["inference", "mcpTool", "connectorTool", "agent"]),
      modelId: z.string().optional(),
      systemPrompt: z.string().optional(),
      connectorId: z.string().optional(),
      toolName: z.string().optional(),
      agentId: z.number().optional(),
      agentAddress: z.string().optional(),
      inputTemplate: z.record(z.string(), z.unknown()).optional().default({}),
      saveAs: z.string().optional().default("output"),
    })),
  }),
  input: z.record(z.string(), z.unknown()).optional().default({}),
});

/**
 * POST /manowar/execute
 * Execute a Manowar workflow with nested x402 payments
 */
app.post(
  "/manowar/execute",
  asyncHandler(async (req: Request, res: Response) => {
    // x402 Payment Verification for orchestration fee
    const { paymentData, sessionActive, sessionBudgetRemaining } = extractPaymentInfo(
      req.headers as Record<string, string | string[] | undefined>
    );

    const resourceUrl = `https://${req.get("host")}${req.originalUrl}`;
    const paymentResult = await handleX402Payment(
      paymentData,
      resourceUrl,
      "POST",
      MANOWAR_PRICES.ORCHESTRATION,
    );

    if (paymentResult.status !== 200) {
      Object.entries(paymentResult.responseHeaders).forEach(([key, value]) => {
        res.setHeader(key, value);
      });
      res.status(paymentResult.status).json(paymentResult.responseBody);
      return;
    }
    console.log(`[manowar] Orchestration payment verified`);

    // Parse request body
    const parseResult = ManowarExecuteSchema.safeParse(req.body);
    if (!parseResult.success) {
      res.status(400).json({
        error: "Invalid request body",
        details: parseResult.error.issues,
        hint: "Request body should be: { workflow: { id, name, steps: [...] }, input: {} }",
      });
      return;
    }

    const { workflow, input } = parseResult.data;

    // Build payment context for nested calls
    const paymentContext: PaymentContext = {
      paymentData,
      sessionActive,
      sessionBudgetRemaining,
      resourceUrlBase: `https://${req.get("host")}`,
    };

    try {
      // Execute the workflow
      const result = await executeManowar(
        workflow as Workflow,
        {
          payment: paymentContext,
          input,
          continueOnError: false,
        }
      );

      res.json({
        success: result.status === "success",
        workflowId: result.workflowId,
        status: result.status,
        steps: result.steps,
        output: result.context,
        totalCostWei: result.totalCostWei,
        executionTime: result.endTime ? result.endTime - result.startTime : null,
        error: result.error,
      });
    } catch (error) {
      console.error("[manowar] Execution error:", error);
      res.status(500).json({
        success: false,
        error: "Workflow execution failed",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  })
);

/**
 * GET /manowar/pricing
 * Get Manowar pricing information
 */
app.get("/manowar/pricing", (_req: Request, res: Response) => {
  res.json({
    orchestration: {
      wei: MANOWAR_PRICES.ORCHESTRATION,
      usd: "$0.01",
      description: "Per workflow execution",
    },
    agentStep: {
      wei: MANOWAR_PRICES.AGENT_STEP,
      usd: "$0.005",
      description: "Per agent invocation within workflow",
    },
    inference: {
      wei: MANOWAR_PRICES.INFERENCE,
      usd: "$0.005",
      description: "Per inference call within agent",
    },
    mcpTool: {
      wei: MANOWAR_PRICES.MCP_TOOL,
      usd: "$0.001",
      description: "Per MCP tool call within agent",
    },
    note: "Each nested call verifies x402 payment independently",
  });
});

/**
 * Manowar Chat Schema
 */
const ManowarChatSchema = z.object({
  message: z.string().min(1, "message is required"),
  threadId: z.string().optional(),
});

/**
 * POST /manowar/:id/chat
 * Chat-based interaction with a Manowar workflow (x402 payable)
 * 
 * :id can be either a numeric manowar ID or a wallet address (0x...)
 * The wallet address is looked up from IPFS metadata.
 * 
 * This endpoint accepts a chat message and executes the workflow
 * using the LangGraph supervisor pattern. The coordinator agent
 * will decompose the task and delegate to the appropriate agents.
 */
app.post(
  "/manowar/:id/chat",
  asyncHandler(async (req: Request, res: Response) => {
    const identifier = req.params.id;

    // x402 Payment Verification
    const { paymentData, sessionActive, sessionBudgetRemaining } = extractPaymentInfo(
      req.headers as Record<string, string | string[] | undefined>
    );

    const resourceUrl = `https://${req.get("host")}${req.originalUrl}`;
    const paymentResult = await handleX402Payment(
      paymentData,
      resourceUrl,
      "POST",
      MANOWAR_PRICES.ORCHESTRATION,
    );

    if (paymentResult.status !== 200) {
      Object.entries(paymentResult.responseHeaders).forEach(([key, value]) => {
        res.setHeader(key, value);
      });
      res.status(paymentResult.status).json(paymentResult.responseBody);
      return;
    }

    // First try registry lookup (O(1))
    const registeredManowar = resolveManowar(identifier);
    let manowarId: number;

    if (registeredManowar) {
      manowarId = registeredManowar.manowarId;
      console.log(`[manowar] Found in registry: ${registeredManowar.title} (${manowarId})`);
    } else {
      // Fallback to on-chain resolution (supports both wallet address and numeric ID)
      const resolved = await resolveManowarIdentifier(identifier);
      if (!resolved) {
        res.status(404).json({
          error: `Manowar not found for identifier: ${identifier}`,
          hint: "Use either a numeric manowar ID or a wallet address (0x...). Consider registering the manowar first.",
        });
        return;
      }
      manowarId = resolved.manowarId;
      console.log(`[manowar] Resolved from on-chain: manowar ${manowarId}`);
    }

    console.log(`[manowar] Chat payment verified for manowar ${manowarId} (identifier: ${identifier})`);

    // Parse request body
    const parseResult = ManowarChatSchema.safeParse(req.body);
    if (!parseResult.success) {
      res.status(400).json({
        error: "Invalid request body",
        details: parseResult.error.issues,
        hint: "Body should be: { message: string, threadId?: string }",
      });
      return;
    }

    const { message } = parseResult.data;
    const userId = req.headers["x-session-user-address"] as string | undefined;

    // Build workflow from on-chain manowar data
    // Fetches manowar metadata, agent list, and each agent's plugins/tools from IPFS
    const workflow = await buildManowarWorkflow(manowarId);

    if (!workflow) {
      res.status(404).json({
        error: `Manowar ${manowarId} not found or has no agents`,
        hint: "Ensure this manowar ID exists on-chain and has agents composed into it",
      });
      return;
    }

    console.log(`[manowar] Built workflow "${workflow.name}" with ${workflow.steps.length} agent steps`);

    // Build payment context
    const paymentContext: PaymentContext = {
      paymentData,
      sessionActive,
      sessionBudgetRemaining,
      resourceUrlBase: `https://${req.get("host")}`,
      userId,
    };

    try {
      // Execute via LangGraph supervisor
      const result = await executeManowar(workflow, {
        payment: paymentContext,
        input: {
          task: message,
          manowarId: manowarId.toString(),
        },
        continueOnError: false,
      });

      // Extract output for chat response
      const textOutput = (result.context.output as string) ||
        JSON.stringify(result.context) ||
        "Workflow completed successfully";

      // Check if result contains multimodal output
      const multimodal = result.context.multimodal as {
        output: string;
        outputType: "image" | "audio" | "video" | "text";
        fromAgent?: string;
      } | null;

      if (multimodal && multimodal.outputType !== "text") {
        // Return multimodal response format matching frontend expectations
        res.json({
          success: result.status === "success",
          manowarId,
          output: textOutput,
          type: multimodal.outputType,
          data: multimodal.output, // base64 data
          mimeType: multimodal.outputType === "image" ? "image/png"
            : multimodal.outputType === "audio" ? "audio/wav"
              : "video/mp4",
          fromAgent: multimodal.fromAgent,
          totalCostWei: result.totalCostWei,
          executionTime: result.endTime ? result.endTime - result.startTime : null,
          error: result.error,
        });
        markManowarExecuted(identifier);
      } else {
        // Text output
        res.json({
          success: result.status === "success",
          manowarId,
          output: textOutput,
          type: "text",
          totalCostWei: result.totalCostWei,
          executionTime: result.endTime ? result.endTime - result.startTime : null,
          error: result.error,
        });
        markManowarExecuted(identifier);
      }
    } catch (error) {
      console.error(`[manowar] Chat execution error:`, error);
      res.status(500).json({
        success: false,
        manowarId,
        error: "Workflow execution failed",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  })
);

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
    console.log("  POST /manowar/execute   - Execute Manowar workflow");
    console.log("  GET  /manowar/pricing   - Get pricing info");
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
