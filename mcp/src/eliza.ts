/**
 * ElizaOS Runtime Client
 *
 * Connects to an ElizaOS server to execute plugin actions.
 * Based on official ElizaOS REST API documentation:
 * https://docs.elizaos.ai/rest-reference/agents/create-a-new-agent
 *
 * ElizaOS is a TypeScript framework for building autonomous AI agents.
 * It provides 200+ official plugins for social platforms, blockchain, AI, DeFi, etc.
 *
 * Requires:
 * - ELIZA_SERVER_URL: URL to the ElizaOS server (default: http://localhost:3000)
 * - ELIZA_API_KEY: Optional API key for authentication
 */

// =============================================================================
// Configuration
// =============================================================================

const ELIZA_SERVER_URL = process.env.ELIZA_SERVER_URL || "http://localhost:3000";
const ELIZA_API_KEY = process.env.ELIZA_API_KEY;

// ElizaOS Plugin Registry URL (official GitHub registry)
const ELIZA_REGISTRY_URL = "https://raw.githubusercontent.com/elizaos-plugins/registry/main/index.json";

// =============================================================================
// Dynamic Plugin Registry
// =============================================================================

/** Plugin entry from the ElizaOS registry */
export interface ElizaPluginEntry {
  id: string;        // e.g. "plugin-evm"
  package: string;   // e.g. "@elizaos/plugin-evm"
  source: string;    // e.g. "github:elizaos-plugins/plugin-evm"
  type: "plugin";    // Always "plugin" for plugins
}

// Cache for plugin registry
let pluginRegistryCache: Map<string, ElizaPluginEntry> | null = null;
let registryCacheTime = 0;
const REGISTRY_CACHE_TTL = 60 * 60 * 1000; // 1 hour

/**
 * Fetch ElizaOS plugin registry from GitHub
 * Returns all 200+ plugins dynamically
 */
export async function fetchElizaPluginRegistry(): Promise<Map<string, ElizaPluginEntry>> {
  const now = Date.now();
  
  // Return cached if fresh
  if (pluginRegistryCache && now - registryCacheTime < REGISTRY_CACHE_TTL) {
    return pluginRegistryCache;
  }

  try {
    console.log("[eliza] Fetching plugin registry from GitHub...");
    const response = await fetch(ELIZA_REGISTRY_URL, { 
      headers: { "Accept": "application/json" },
      signal: AbortSignal.timeout(30000),
    });
    
    if (!response.ok) {
      throw new Error(`Failed to fetch registry: ${response.status}`);
    }

    const registryData: Record<string, string> = await response.json();
    const plugins = new Map<string, ElizaPluginEntry>();

    for (const [packageName, source] of Object.entries(registryData)) {
      // Extract plugin ID from package name
      // e.g. "@elizaos/plugin-evm" -> "plugin-evm"
      const id = packageName.replace(/^@[^/]+\//, "");
      
      plugins.set(id, {
        id,
        package: packageName,
        source,
        type: "plugin",
      });
    }

    pluginRegistryCache = plugins;
    registryCacheTime = now;
    console.log(`[eliza] Loaded ${plugins.size} plugins from registry`);
    
    return plugins;
  } catch (error) {
    console.error("[eliza] Failed to fetch plugin registry:", error);
    
    // Return cached data if available (even if stale)
    if (pluginRegistryCache) {
      console.log("[eliza] Using stale cache");
      return pluginRegistryCache;
    }
    
    // Return empty map if no cache
    return new Map();
  }
}

/**
 * Get all ElizaOS plugins (dynamic)
 */
export async function getElizaPlugins(): Promise<ElizaPluginEntry[]> {
  const registry = await fetchElizaPluginRegistry();
  return Array.from(registry.values());
}

/**
 * Get a specific ElizaOS plugin by ID
 */
export async function getElizaPlugin(pluginId: string): Promise<ElizaPluginEntry | null> {
  const registry = await fetchElizaPluginRegistry();
  return registry.get(pluginId) || null;
}

/**
 * Check if an ElizaOS plugin exists
 */
export async function isElizaPluginSupported(pluginId: string): Promise<boolean> {
  const registry = await fetchElizaPluginRegistry();
  return registry.has(pluginId);
}

/**
 * Get ElizaOS plugin package name
 */
export async function getElizaPluginPackage(pluginId: string): Promise<string | null> {
  const plugin = await getElizaPlugin(pluginId);
  return plugin?.package || null;
}

// =============================================================================
// Types (based on ElizaOS REST API)
// =============================================================================

/** Character interface - defines agent personality and behavior */
export interface ElizaCharacter {
  id?: string;
  name: string;
  bio?: string | string[];
  lore?: string[];
  messageExamples?: string[];
  topics?: string[];
  adjectives?: string[];
  style?: {
    all?: string[];
    chat?: string[];
    post?: string[];
  };
  plugins?: string[];
  settings?: {
    model?: string;
    modelProvider?: string;
    voice?: {
      model?: string;
      url?: string;
    };
    secrets?: Record<string, string>;
    [key: string]: unknown;
  };
  system?: string;
}

/** Agent info returned from ElizaOS */
export interface ElizaAgent {
  id: string;
  name: string;
  character?: ElizaCharacter;
  status?: "online" | "offline" | "starting" | "stopping" | "error";
  createdAt?: string;
}

/** Action available on an agent */
export interface ElizaAction {
  name: string;
  description: string;
  similes?: string[];
  examples?: unknown[];
  handler?: string;
  validate?: string;
}

/** Memory item */
export interface ElizaMemory {
  id: string;
  content: {
    text: string;
    [key: string]: unknown;
  };
  embedding?: number[];
  userId?: string;
  agentId?: string;
  roomId?: string;
  createdAt?: string;
}

/** Room for agent conversations */
export interface ElizaRoom {
  id: string;
  name?: string;
  source?: string;
  worldId?: string;
  createdAt?: string;
}

/** Runtime status */
export interface ElizaRuntimeStatus {
  connected: boolean;
  serverUrl: string;
  healthy: boolean;
  agents: ElizaAgent[];
  pluginCount: number;
  error: string | null;
}

/** Result from executing an action or sending a message */
export interface ElizaExecutionResult {
  success: boolean;
  result?: unknown;
  error?: string;
  agentId?: string;
  roomId?: string;
  memories?: ElizaMemory[];
}

// =============================================================================
// HTTP Client
// =============================================================================

interface FetchOptions extends RequestInit {
  timeout?: number;
}

async function elizaFetch<T = unknown>(
  endpoint: string,
  options: FetchOptions = {}
): Promise<T> {
  const url = `${ELIZA_SERVER_URL}${endpoint}`;
  const timeout = options.timeout || 30000;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.headers as Record<string, string> || {}),
  };

  if (ELIZA_API_KEY) {
    headers["Authorization"] = `Bearer ${ELIZA_API_KEY}`;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      ...options,
      headers,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`ElizaOS API error (${response.status}): ${errorText}`);
    }

    const text = await response.text();
    if (!text) return {} as T;

    return JSON.parse(text) as T;
  } catch (error) {
    clearTimeout(timeoutId);
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`ElizaOS API timeout after ${timeout}ms`);
    }
    throw error;
  }
}

// =============================================================================
// Health & Status
// =============================================================================

let cachedStatus: ElizaRuntimeStatus | null = null;
let statusCacheTime = 0;
const STATUS_CACHE_TTL = 30000; // 30 seconds

/**
 * Check health of ElizaOS server
 * GET /healthz or /health
 */
export async function checkElizaHealth(): Promise<boolean> {
  try {
    // Try /healthz first (ElizaOS v1.6+)
    const result = await elizaFetch<{ status: string }>("/healthz", { timeout: 5000 });
    return result?.status === "ok";
  } catch {
    try {
      // Fallback to /health
      const result = await elizaFetch<{ status: string }>("/health", { timeout: 5000 });
      return result?.status === "ok";
    } catch {
      return false;
    }
  }
}

/**
 * Get ElizaOS runtime status
 */
export async function getElizaRuntimeStatus(): Promise<ElizaRuntimeStatus> {
  const now = Date.now();

  // Return cached status if fresh
  if (cachedStatus && now - statusCacheTime < STATUS_CACHE_TTL) {
    return cachedStatus;
  }

  try {
    const [healthy, agents, registry] = await Promise.all([
      checkElizaHealth(),
      listElizaAgents().catch(() => [] as ElizaAgent[]),
      fetchElizaPluginRegistry().catch(() => new Map()),
    ]);

    cachedStatus = {
      connected: true,
      serverUrl: ELIZA_SERVER_URL,
      healthy,
      agents,
      pluginCount: registry.size,
      error: null,
    };
  } catch (err) {
    cachedStatus = {
      connected: false,
      serverUrl: ELIZA_SERVER_URL,
      healthy: false,
      agents: [],
      pluginCount: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  statusCacheTime = now;
  return cachedStatus;
}

// =============================================================================
// Agent Management
// =============================================================================

/**
 * Create a new ElizaOS agent
 * POST /api/agents
 *
 * @see https://docs.elizaos.ai/rest-reference/agents/create-a-new-agent
 */
export async function createElizaAgent(
  character: ElizaCharacter
): Promise<ElizaAgent | null> {
  try {
    const result = await elizaFetch<{ success: boolean; data: { character: ElizaAgent } }>(
      "/api/agents",
      {
        method: "POST",
        body: JSON.stringify({ characterJson: character }),
      }
    );

    if (result?.success && result.data?.character) {
      console.log(`[eliza] Created agent: ${result.data.character.name}`);
      return result.data.character;
    }

    return null;
  } catch (err) {
    console.error("[eliza] Failed to create agent:", err);
    return null;
  }
}

/**
 * List all agents
 * GET /api/agents
 */
export async function listElizaAgents(): Promise<ElizaAgent[]> {
  try {
    const result = await elizaFetch<
      | ElizaAgent[]
      | { agents: ElizaAgent[] }
      | { success: boolean; data: { agents: ElizaAgent[] } }
    >("/api/agents");
    
    // Handle different response formats
    if (Array.isArray(result)) {
      return result;
    }
    if ("data" in result && result.data?.agents) {
      return result.data.agents;
    }
    if ("agents" in result && result.agents) {
      return result.agents;
    }
    return [];
  } catch (err) {
    console.error("[eliza] Failed to list agents:", err);
    return [];
  }
}

/**
 * Get agent details
 * GET /api/agents/:agentId
 */
export async function getElizaAgent(agentId: string): Promise<ElizaAgent | null> {
  try {
    const result = await elizaFetch<
      | ElizaAgent
      | { agent: ElizaAgent }
      | { success: boolean; data: { agent: ElizaAgent } }
    >(`/api/agents/${encodeURIComponent(agentId)}`);
    
    // Handle different response formats
    if ("data" in result && result.data?.agent) {
      return result.data.agent;
    }
    if ("agent" in result && result.agent) {
      return result.agent;
    }
    if ("id" in result) {
      return result as ElizaAgent;
    }
    return null;
  } catch (err) {
    console.error(`[eliza] Failed to get agent ${agentId}:`, err);
    return null;
  }
}

/**
 * Start an agent
 * POST /api/agents/:agentId/start
 */
export async function startElizaAgent(agentId: string): Promise<boolean> {
  try {
    await elizaFetch(`/api/agents/${encodeURIComponent(agentId)}/start`, {
      method: "POST",
    });
    return true;
  } catch (err) {
    console.error(`[eliza] Failed to start agent ${agentId}:`, err);
    return false;
  }
}

/**
 * Stop an agent
 * POST /api/agents/:agentId/stop
 */
export async function stopElizaAgent(agentId: string): Promise<boolean> {
  try {
    await elizaFetch(`/api/agents/${encodeURIComponent(agentId)}/stop`, {
      method: "POST",
    });
    return true;
  } catch (err) {
    console.error(`[eliza] Failed to stop agent ${agentId}:`, err);
    return false;
  }
}

/**
 * Delete an agent
 * DELETE /api/agents/:agentId
 */
export async function deleteElizaAgent(agentId: string): Promise<boolean> {
  try {
    await elizaFetch(`/api/agents/${encodeURIComponent(agentId)}`, {
      method: "DELETE",
    });
    return true;
  } catch (err) {
    console.error(`[eliza] Failed to delete agent ${agentId}:`, err);
    return false;
  }
}

// =============================================================================
// Messaging
// =============================================================================

/**
 * Send a message to an ElizaOS agent
 * ElizaOS v1.6 uses WebSocket/Socket.IO for real-time messaging
 * For REST API, we use the submit message endpoint
 */
export async function sendElizaMessage(
  agentId: string,
  message: string,
  roomId?: string
): Promise<ElizaExecutionResult> {
  try {
    const targetRoomId = roomId || `compose-room-${Date.now()}`;

    // Try the central messaging endpoint first (ElizaOS v1.6)
    const result = await elizaFetch<{
      success: boolean;
      data?: {
        message?: { content?: { text: string } };
        response?: string;
      };
      message?: { content?: { text: string } };
      response?: string;
    }>(`/api/messaging/submit`, {
      method: "POST",
      body: JSON.stringify({
        agentId,
        roomId: targetRoomId,
        text: message,
        userId: "compose-user",
        source: "compose-market",
      }),
    });

    if (result.success) {
      const responseText = 
        result.data?.message?.content?.text ||
        result.data?.response ||
        result.message?.content?.text ||
        result.response ||
        JSON.stringify(result.data || result);

      return {
        success: true,
        result: responseText,
        agentId,
        roomId: targetRoomId,
      };
    }

    return {
      success: false,
      error: "Message submission failed",
      agentId,
    };
  } catch (err) {
    // If the messaging endpoint doesn't exist, note that WebSocket is required
    const errorMsg = err instanceof Error ? err.message : String(err);
    
    if (errorMsg.includes("404")) {
      return {
        success: false,
        error: "ElizaOS messaging requires WebSocket connection. REST messaging endpoint not available.",
        agentId,
      };
    }

    return {
      success: false,
      error: errorMsg,
      agentId,
    };
  }
}

// =============================================================================
// Actions
// =============================================================================

/**
 * Get available actions for an agent
 * Actions are defined by the plugins loaded in the agent
 */
export async function getElizaAgentActions(agentId: string): Promise<ElizaAction[]> {
  try {
    // ElizaOS doesn't have a dedicated actions endpoint in REST API
    // Actions are part of the agent's plugins and executed via messages
    // We can infer available actions from the agent's character/plugins
    const agent = await getElizaAgent(agentId);
    if (!agent?.character?.plugins) {
      return [];
    }

    // Map plugins to their known actions
    const actions: ElizaAction[] = [];
    for (const plugin of agent.character.plugins) {
      const pluginActions = await getPluginActions(plugin);
      actions.push(...pluginActions);
    }

    return actions;
  } catch (err) {
    console.error(`[eliza] Failed to get actions for agent ${agentId}:`, err);
    return [];
  }
}

/**
 * Execute a specific action on an ElizaOS agent
 * In ElizaOS, actions are triggered via natural language messages
 */
export async function executeElizaAction(
  agentId: string,
  actionName: string,
  params: Record<string, unknown>
): Promise<ElizaExecutionResult> {
  try {
    // Construct a message that will trigger the action
    // ElizaOS actions are typically triggered by natural language
    const actionMessage = constructActionMessage(actionName, params);

    return await sendElizaMessage(agentId, actionMessage);
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
      agentId,
    };
  }
}

/**
 * Get known actions for a plugin
 */
async function getPluginActions(pluginName: string): Promise<ElizaAction[]> {
  // Common actions for well-known plugins
  const pluginActions: Record<string, ElizaAction[]> = {
    "@elizaos/plugin-evm": [
      { name: "transfer", description: "Transfer tokens on EVM chains" },
      { name: "swap", description: "Swap tokens using DEX" },
      { name: "bridge", description: "Bridge tokens across chains via LiFi" },
      { name: "getBalance", description: "Get token balance" },
    ],
    "@elizaos/plugin-solana": [
      { name: "transfer", description: "Transfer SOL or SPL tokens" },
      { name: "swap", description: "Swap tokens on Solana DEX" },
      { name: "stake", description: "Stake SOL" },
    ],
    "@elizaos/plugin-knowledge": [
      { name: "query", description: "Query knowledge base" },
      { name: "search", description: "Search documents" },
    ],
    "@elizaos/plugin-image-generation": [
      { name: "generate", description: "Generate image from prompt" },
    ],
    "@elizaos/client-twitter": [
      { name: "post", description: "Post a tweet" },
      { name: "reply", description: "Reply to a tweet" },
      { name: "search", description: "Search tweets" },
    ],
    "@elizaos/client-discord": [
      { name: "send", description: "Send message to Discord channel" },
      { name: "react", description: "React to a message" },
    ],
    "@elizaos/client-telegram": [
      { name: "send", description: "Send message to Telegram chat" },
    ],
  };

  return pluginActions[pluginName] || [];
}

/**
 * Construct a natural language message to trigger an action
 */
function constructActionMessage(
  actionName: string,
  params: Record<string, unknown>
): string {
  // Convert action + params to natural language
  const paramStr = Object.entries(params)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join(", ");

  // Action-specific message templates
  const templates: Record<string, (p: Record<string, unknown>) => string> = {
    transfer: (p) => `Transfer ${p.amount} ${p.token || "tokens"} to ${p.to}`,
    swap: (p) => `Swap ${p.fromAmount} ${p.fromToken} for ${p.toToken}`,
    bridge: (p) => `Bridge ${p.amount} ${p.token} from ${p.fromChain} to ${p.toChain}`,
    getBalance: (p) => `What is my ${p.token || "token"} balance${p.address ? ` for ${p.address}` : ""}?`,
    generate: (p) => `Generate an image: ${p.prompt}`,
    post: (p) => `Post this: ${p.content}`,
    search: (p) => `Search for: ${p.query}`,
    query: (p) => `${p.question || p.query}`,
  };

  const template = templates[actionName];
  if (template) {
    return template(params);
  }

  return `Execute ${actionName} with parameters: ${paramStr}`;
}

// =============================================================================
// Plugin Helpers
// =============================================================================

/**
 * Create a minimal character for testing a specific plugin
 */
export async function createPluginTestCharacter(
  pluginId: string,
  name?: string
): Promise<ElizaCharacter> {
  const pluginPackage = await getElizaPluginPackage(pluginId);
  if (!pluginPackage) {
    throw new Error(`Unknown ElizaOS plugin: ${pluginId}`);
  }

  return {
    name: name || `compose-test-${pluginId}`,
    bio: `Test agent for ${pluginId} plugin`,
    plugins: [pluginPackage],
    settings: {
      modelProvider: "openai",
    },
  };
}

/**
 * Create or get an agent for testing a specific plugin
 */
export async function getOrCreatePluginAgent(
  pluginId: string
): Promise<ElizaAgent | null> {
  const agentName = `compose-${pluginId}`;

  // Check if agent already exists
  const agents = await listElizaAgents();
  const existing = agents.find((a) => a.name === agentName);
  if (existing) {
    return existing;
  }

  // Create new agent
  const character = await createPluginTestCharacter(pluginId, agentName);
  return await createElizaAgent(character);
}

// =============================================================================
// Memory & Rooms
// =============================================================================

/**
 * Get memories for a room
 * GET /api/rooms/:roomId/memories
 */
export async function getRoomMemories(roomId: string): Promise<ElizaMemory[]> {
  try {
    const result = await elizaFetch<ElizaMemory[] | { memories: ElizaMemory[] }>(
      `/api/rooms/${encodeURIComponent(roomId)}/memories`
    );
    return Array.isArray(result) ? result : (result?.memories || []);
  } catch (err) {
    console.error(`[eliza] Failed to get memories for room ${roomId}:`, err);
    return [];
  }
}

/**
 * Create a room for agent conversations
 * POST /api/rooms
 */
export async function createElizaRoom(
  agentId: string,
  name?: string
): Promise<ElizaRoom | null> {
  try {
    const result = await elizaFetch<{ room: ElizaRoom }>("/api/rooms", {
      method: "POST",
      body: JSON.stringify({
        name: name || `compose-room-${Date.now()}`,
        agentId,
        source: "compose-market",
      }),
    });
    return result?.room || null;
  } catch (err) {
    console.error("[eliza] Failed to create room:", err);
    return null;
  }
}

// =============================================================================
// Initialize
// =============================================================================

// Prefetch plugin registry on module load (non-blocking)
fetchElizaPluginRegistry()
  .then((registry) => {
    console.log(`[eliza] Initialized with ${registry.size} plugins from registry`);
  })
  .catch(console.error);

// Check connection on module load (non-blocking)
getElizaRuntimeStatus()
  .then((status) => {
    if (status.connected) {
      console.log(`[eliza] Connected to ElizaOS at ${status.serverUrl}`);
      console.log(`[eliza] Healthy: ${status.healthy}, Agents: ${status.agents.length}, Plugins: ${status.pluginCount}`);
    } else {
      console.warn(`[eliza] Not connected to ElizaOS: ${status.error}`);
    }
  })
  .catch(console.error);
