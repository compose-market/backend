/**
 * ElizaOS Runtime Client
 * 
 * Connects to an ElizaOS server to execute plugin actions.
 * Requires ELIZA_SERVER_URL to be configured.
 */

// =============================================================================
// Configuration
// =============================================================================

const ELIZA_SERVER_URL = process.env.ELIZA_SERVER_URL || "http://localhost:3000";
const ELIZA_API_KEY = process.env.ELIZA_API_KEY;

// Plugin IDs that we support through ElizaOS
export const ELIZA_PLUGINS = [
  "eliza-plugin-evm",
  "eliza-plugin-solana", 
  "eliza-client-discord",
  "eliza-client-telegram",
  "eliza-plugin-twitter",
  "eliza-plugin-farcaster",
  "eliza-plugin-knowledge",
  "eliza-plugin-mcp",
] as const;

export type ElizaPluginId = typeof ELIZA_PLUGINS[number];

// =============================================================================
// Types
// =============================================================================

export interface ElizaAgent {
  id: string;
  name: string;
  status: "online" | "offline" | "starting" | "error";
  plugins: string[];
  createdAt: string;
}

export interface ElizaMessage {
  role: "user" | "assistant" | "system";
  content: string;
  timestamp?: string;
}

export interface ElizaAction {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ElizaRuntimeStatus {
  connected: boolean;
  serverUrl: string;
  agents: ElizaAgent[];
  error: string | null;
}

export interface ElizaExecutionResult {
  success: boolean;
  result?: unknown;
  error?: string;
  agentId?: string;
}

// =============================================================================
// HTTP Client
// =============================================================================

async function elizaFetch(
  endpoint: string,
  options: RequestInit = {}
): Promise<unknown> {
  const url = `${ELIZA_SERVER_URL}${endpoint}`;
  
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.headers as Record<string, string> || {}),
  };
  
  if (ELIZA_API_KEY) {
    headers["Authorization"] = `Bearer ${ELIZA_API_KEY}`;
  }

  const response = await fetch(url, {
    ...options,
    headers,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`ElizaOS API error (${response.status}): ${errorText}`);
  }

  return response.json();
}

// =============================================================================
// Runtime Functions
// =============================================================================

let elizaStatus: ElizaRuntimeStatus | null = null;

/**
 * Check connection to ElizaOS server and get status
 */
export async function getElizaRuntimeStatus(): Promise<ElizaRuntimeStatus> {
  try {
    // Try to fetch agents list
    const agents = await elizaFetch("/api/agents") as ElizaAgent[];
    
    elizaStatus = {
      connected: true,
      serverUrl: ELIZA_SERVER_URL,
      agents: Array.isArray(agents) ? agents : [],
      error: null,
    };
  } catch (err) {
    elizaStatus = {
      connected: false,
      serverUrl: ELIZA_SERVER_URL,
      agents: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
  
  return elizaStatus;
}

/**
 * Get available actions for an ElizaOS agent
 */
export async function getElizaAgentActions(agentId: string): Promise<ElizaAction[]> {
  try {
    const result = await elizaFetch(`/api/agents/${agentId}/actions`) as { actions: ElizaAction[] };
    return result.actions || [];
  } catch (err) {
    console.error(`[elizaRuntime] Failed to get actions for agent ${agentId}:`, err);
    return [];
  }
}

/**
 * Send a message to an ElizaOS agent and get response
 */
export async function sendElizaMessage(
  agentId: string,
  message: string,
  roomId?: string
): Promise<ElizaExecutionResult> {
  try {
    const result = await elizaFetch(`/api/agents/${agentId}/message`, {
      method: "POST",
      body: JSON.stringify({
        text: message,
        roomId: roomId || `room-${Date.now()}`,
        userId: "compose-connector",
      }),
    }) as { response: string; memories?: unknown[] };

    return {
      success: true,
      result: result.response,
      agentId,
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
      agentId,
    };
  }
}

/**
 * Execute a specific action on an ElizaOS agent
 */
export async function executeElizaAction(
  agentId: string,
  actionName: string,
  params: Record<string, unknown>
): Promise<ElizaExecutionResult> {
  try {
    const result = await elizaFetch(`/api/agents/${agentId}/actions/${actionName}`, {
      method: "POST",
      body: JSON.stringify(params),
    });

    return {
      success: true,
      result,
      agentId,
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
      agentId,
    };
  }
}

/**
 * Create a new ElizaOS agent with specified plugins
 */
export async function createElizaAgent(
  name: string,
  plugins: string[],
  character?: Record<string, unknown>
): Promise<ElizaAgent | null> {
  try {
    const result = await elizaFetch("/api/agents", {
      method: "POST",
      body: JSON.stringify({
        name,
        plugins,
        character: character || {
          name,
          description: `Compose Market agent: ${name}`,
          modelProvider: "openai",
        },
      }),
    }) as ElizaAgent;

    return result;
  } catch (err) {
    console.error("[elizaRuntime] Failed to create agent:", err);
    return null;
  }
}

/**
 * Check if an ElizaOS plugin is supported
 */
export function isElizaPluginSupported(pluginId: string): boolean {
  return ELIZA_PLUGINS.includes(pluginId as ElizaPluginId);
}

/**
 * Map registry plugin ID to ElizaOS plugin package name
 */
export function getElizaPluginPackage(pluginId: string): string | null {
  // Strip "eliza-" prefix and convert to package name
  if (!pluginId.startsWith("eliza-")) return null;
  
  const slug = pluginId.replace("eliza-", "");
  return `@elizaos/${slug}`;
}

// =============================================================================
// Initialize
// =============================================================================

// Check connection on module load (non-blocking)
getElizaRuntimeStatus().catch(console.error);

