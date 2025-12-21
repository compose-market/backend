/**
 * MCP Runtime - On-Demand Server Spawning
 * 
 * Spawns individual MCP servers on-demand with multi-transport support:
 * - stdio: Traditional npm/npx packages (St

dioClientTransport)
 * - http: Remote SSE/Streamable HTTP servers (HttpSseClientTransport)
 * - docker: Containerized servers (DockerClientTransport)
 * 
 * Each server gets its own session with isolated state.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { HttpSseClientTransport } from "./transports/http.js";
import { DockerClientTransport } from "./transports/docker.js";
import { NpxClientTransport } from "./transports/npx.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { ComposeTool } from "../types.js";
import { randomUUID } from "crypto";

export interface McpRuntimeConfig {
  logLevel?: 'DEBUG' | 'INFO' | 'WARNING' | 'ERROR';
  maxSessions?: number;
  sessionTimeoutMs?: number;
}

interface McpServerSession {
  sessionId: string;
  serverId: string;
  client: Client;
  transport: Transport; // Generic transport interface
  transportType: "stdio" | "http" | "docker" | "npx";
  tools: any[];
  createdAt: Date;
  lastUsedAt: Date;
}

interface ServerSpawnConfig {
  transport: "stdio" | "http" | "docker" | "npx";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  image?: string;
  remoteUrl?: string;
  package?: string;
}



/**
 * MCP Runtime Manager
 */
export class McpRuntime {
  private sessions = new Map<string, McpServerSession>();
  private config: McpRuntimeConfig;
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor(config: McpRuntimeConfig = {}) {
    this.config = {
      logLevel: 'INFO',
      maxSessions: 100,
      sessionTimeoutMs: 30 * 60 * 1000, // 30 mins
      ...config
    };
  }

  /**
   * Initialize the runtime
   */
  async initialize(): Promise<void> {
    console.log("[MCP Runtime] Initialized");

    // Start cleanup interval
    this.cleanupInterval = setInterval(() => {
      this.cleanupIdleSessions();
    }, 60 * 1000); // Check every minute
  }

  /**
   * Spawn an MCP server and create a session
   */
  async spawnServer(serverId: string, config: ServerSpawnConfig): Promise<string> {
    // Check session limit
    if (this.sessions.size >= this.config.maxSessions!) {
      throw new Error(`Session limit reached (${this.config.maxSessions})`);
    }

    console.log(`[MCP Runtime] Spawning server: ${serverId} (transport: ${config.transport})`);

    let transport: Transport;
    let transportType: "stdio" | "http" | "docker" | "npx";

    // Create appropriate transport based on config
    if (config.transport === "http") {
      if (!config.remoteUrl) {
        throw new Error("remoteUrl required for HTTP transport");
      }
      transport = new HttpSseClientTransport({ baseUrl: config.remoteUrl });
      transportType = "http";
    } else if (config.transport === "docker") {
      if (!config.image) {
        throw new Error("image required for Docker transport");
      }
      transport = new DockerClientTransport({ image: config.image });
      transportType = "docker";
    } else if (config.transport === "npx") {
      if (!config.package) {
        throw new Error("package required for npx transport");
      }
      transport = new NpxClientTransport({
        package: config.package,
        env: config.env,
      });
      transportType = "npx";
    } else {
      // stdio transport
      if (!config.command || !config.args) {
        throw new Error("command and args required for stdio transport");
      }
      transport = new StdioClientTransport({
        command: config.command,
        args: config.args,
        env: {
          ...Object.fromEntries(
            Object.entries(process.env).filter(([_, v]) => v !== undefined) as [string, string][]
          ),
          ...config.env,
        },
      });
      transportType = "stdio";
    }

    const client = new Client({
      name: "compose-mcp-runtime",
      version: "1.0.0",
    }, {
      capabilities: {},
    });

    try {
      await client.connect(transport);

      // List available tools
      const { tools } = await client.listTools();

      const sessionId = randomUUID();
      const session: McpServerSession = {
        sessionId,
        serverId,
        client,
        transport,
        transportType,
        tools,
        createdAt: new Date(),
        lastUsedAt: new Date(),
      };

      this.sessions.set(sessionId, session);

      console.log(`[MCP Runtime] Server spawned: ${serverId} (${transportType}, session: ${sessionId}, tools: ${tools.length})`);

      return sessionId;
    } catch (error) {
      console.error(`[MCP Runtime] Failed to spawn ${serverId}:`, error);
      // Cleanup transport on error
      try {
        await transport.close();
      } catch {
        // Ignore cleanup errors
      }
      throw error;
    }
  }

  /**
   * Get tools from a spawned session
   */
  getSessionTools(sessionId: string): any[] {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);

    session.lastUsedAt = new Date();
    return session.tools;
  }

  /**
   * Execute a tool on a spawned server
   */
  async executeTool(sessionId: string, toolName: string, args: Record<string, unknown>): Promise<any> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);

    session.lastUsedAt = new Date();

    console.log(`[MCP Runtime] Executing ${toolName} on session ${sessionId}`);

    const result = await session.client.callTool({
      name: toolName,
      arguments: args,
    });

    if (result.isError) {
      const errorMsg = (result.content as any)[0]?.text || 'Tool execution failed';
      throw new Error(errorMsg);
    }

    // Try to parse as JSON, fallback to text
    const resultText = (result.content as any)[0]?.text || '{}';
    try {
      return JSON.parse(resultText);
    } catch {
      // Not JSON, return as-is
      return resultText;
    }
  }

  /**
   * Terminate a session
   */
  async terminateSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    try {
      await session.client.close();
      this.sessions.delete(sessionId);
      console.log(`[MCP Runtime] Session terminated: ${sessionId}`);
    } catch (error) {
      console.error(`[MCP Runtime] Error terminating session ${sessionId}:`, error);
    }
  }

  /**
   * List all active sessions
   */
  listSessions(): Array<{ sessionId: string; serverId: string; toolCount: number; createdAt: Date; lastUsedAt: Date }> {
    return Array.from(this.sessions.values()).map(s => ({
      sessionId: s.sessionId,
      serverId: s.serverId,
      toolCount: s.tools.length,
      createdAt: s.createdAt,
      lastUsedAt: s.lastUsedAt,
    }));
  }

  /**
   * Cleanup idle sessions
   */
  private cleanupIdleSessions(): void {
    const now = Date.now();
    const timeout = this.config.sessionTimeoutMs!;

    for (const [sessionId, session] of this.sessions) {
      const idleTime = now - session.lastUsedAt.getTime();
      if (idleTime > timeout) {
        console.log(`[MCP Runtime] Cleaning up idle session: ${sessionId} (idle: ${Math.round(idleTime / 1000 / 60)}min)`);
        this.terminateSession(sessionId);
      }
    }
  }

  /**
   * Load tools for agent (on-demand spawning)
   * Spawns servers and returns ComposeTool[] for agent consumption
   */
  async loadTools(serverIds: string[]): Promise<ComposeTool[]> {
    if (!serverIds || serverIds.length === 0) return [];

    const tools: ComposeTool[] = [];

    // Normalize server IDs (remove mcp: prefix, registry prefixes, and -server suffix)
    const normalizeId = (id: string): string => {
      let normalized = id;

      // Remove mcp: or mcp- prefix
      while (normalized.match(/^mcp[-:]/)) {
        normalized = normalized.replace(/^mcp[-:]/, '');
      }

      // Remove common registry prefixes (e.g., awesome-mark3labs-mcp-)
      normalized = normalized.replace(/^awesome-[^-]+-mcp-/, '');
      normalized = normalized.replace(/^[^-]+-mcp-/, ''); // Generic prefix-mcp-

      // Remove -server suffix
      normalized = normalized.replace(/-server$/, '');

      return normalized;
    };

    const normalized = serverIds.map(normalizeId);

    for (const serverId of normalized) {
      try {
        // Get spawn config (on-demand, from connector)
        const config = await getMcpServerConfig(serverId);
        if (!config) {
          console.warn(`[MCP Runtime] Unknown server: ${serverId}`);
          continue;
        }

        // Spawn server
        console.log(`[MCP Runtime] Spawning ${serverId} for agent tools...`);
        const sessionId = await this.spawnServer(serverId, config);
        const sessionTools = this.getSessionTools(sessionId);

        // Convert to ComposeTool format
        for (const tool of sessionTools) {
          tools.push({
            name: tool.name,
            description: tool.description || `MCP tool: ${tool.name}`,
            source: 'mcp',
            inputSchema: tool.inputSchema as Record<string, unknown>,
            execute: async (args) => {
              return await this.executeTool(sessionId, tool.name, args);
            },
          });
        }
      } catch (error) {
        console.error(`[MCP Runtime] Failed to load ${serverId}:`, error);
      }
    }

    console.log(`[MCP Runtime] Loaded ${tools.length} tools from ${serverIds.length} servers`);
    return tools;
  }

  async cleanup(): Promise<void> {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }

    const sessions = Array.from(this.sessions.keys());
    await Promise.all(sessions.map(id => this.terminateSession(id)));

    console.log("[MCP Runtime] Cleanup complete");
  }
}

// ============================================================================
// On-Demand Server Spawning (Public API)
// ============================================================================

// Session cache to avoid re-spawning servers
const serverSessions = new Map<string, { sessionId: string; runtime: McpRuntime; createdAt: Date }>();
const SESSION_TTL = 30 * 60 * 1000; // 30 minutes

// Singleton runtime for on-demand spawning
let sharedRuntime: McpRuntime | null = null;

/**
 * Get or create the shared MCP runtime instance
 */
async function getSharedRuntime(): Promise<McpRuntime> {
  if (!sharedRuntime) {
    sharedRuntime = new McpRuntime();
    await sharedRuntime.initialize();
  }
  return sharedRuntime;
}

/**
 * Get tools for an MCP server (spawns on-demand, uses cached session if available)
 */
export async function getServerTools(serverId: string): Promise<{
  serverId: string;
  sessionId: string;
  cached: boolean;
  toolCount: number;
  tools: Array<{ name: string; description?: string; inputSchema: Record<string, unknown> }>;
}> {
  const runtime = await getSharedRuntime();

  // Check for cached session
  const cached = serverSessions.get(serverId);
  if (cached) {
    const age = Date.now() - cached.createdAt.getTime();
    if (age < SESSION_TTL) {
      // Session still valid, use it
      try {
        const tools = cached.runtime.getSessionTools(cached.sessionId);
        console.log(`[mcp] Using cached session for ${serverId}: ${cached.sessionId}`);
        return {
          serverId,
          sessionId: cached.sessionId,
          cached: true,
          toolCount: tools.length,
          tools,
        };
      } catch (error) {
        // Session no longer valid, remove from cache
        console.log(`[mcp] Cached session ${cached.sessionId} for ${serverId} is invalid, re-spawning`);
        serverSessions.delete(serverId);
      }
    } else {
      // Session expired, clean up
      console.log(`[mcp] Session for ${serverId} expired (${Math.round(age / 1000)}s old)`);
      serverSessions.delete(serverId);
      try {
        await cached.runtime.terminateSession(cached.sessionId);
      } catch (e) {
        // Ignore cleanup errors
      }
    }
  }

  // No valid cached session, spawn new server
  const config = await getMcpServerConfig(serverId);
  if (!config) {
    throw new Error(`Unknown MCP server: ${serverId}`);
  }

  console.log(`[mcp] Spawning new session for ${serverId}: ${config.command} ${config.args?.join(' ') || ''}`);
  const sessionId = await runtime.spawnServer(serverId, config);

  // Cache the session
  serverSessions.set(serverId, {
    sessionId,
    runtime,
    createdAt: new Date(),
  });

  const tools = runtime.getSessionTools(sessionId);

  return {
    serverId,
    sessionId,
    cached: false,
    toolCount: tools.length,
    tools,
  };
}

/**
 * Execute a tool on an MCP server (uses cached session or spawns on-demand)
 */
export async function executeServerTool(
  serverId: string,
  toolName: string,
  args: Record<string, unknown>
): Promise<any> {
  const runtime = await getSharedRuntime();

  // Check for cached session
  let sessionId: string | null = null;
  const cached = serverSessions.get(serverId);

  if (cached) {
    const age = Date.now() - cached.createdAt.getTime();
    if (age < SESSION_TTL) {
      try {
        // Verify session is still valid
        cached.runtime.getSessionTools(cached.sessionId);
        sessionId = cached.sessionId;
        console.log(`[mcp] Using cached session for ${serverId}: ${cached.sessionId}`);
      } catch (error) {
        console.log(`[mcp] Cached session invalid, will spawn new one`);
        serverSessions.delete(serverId);
      }
    } else {
      serverSessions.delete(serverId);
    }
  }

  // Spawn if no valid session
  if (!sessionId) {
    const config = await getMcpServerConfig(serverId);
    if (!config) {
      throw new Error(`Unknown MCP server: ${serverId}`);
    }

    console.log(`[mcp] Spawning session for tool execution on ${serverId}`);
    sessionId = await runtime.spawnServer(serverId, config);
    serverSessions.set(serverId, {
      sessionId,
      runtime,
      createdAt: new Date(),
    });
  }

  // Execute tool
  return await runtime.executeTool(sessionId, toolName, args);
}

/**
 * Get MCP server configuration from Connector Service
 */
async function getMcpServerConfig(serverId: string): Promise<ServerSpawnConfig | null> {
  try {
    const CONNECTOR_URL = process.env.CONNECTOR_URL || "http://localhost:4001";
    // Construct the URL to fetch spawn config from Connector
    // Example: http://localhost:4001/registry/servers/glama-gyanaranjans-mcp/spawn
    const url = `${CONNECTOR_URL}/registry/servers/${encodeURIComponent(serverId)}/spawn`;

    console.log(`[mcp] Fetching config for ${serverId} from ${url}`);

    const response = await fetch(url);
    if (!response.ok) {
      console.warn(`[mcp] Failed to fetch config for ${serverId}: ${response.status} ${response.statusText}`);
      return null;
    }

    const config = await response.json();
    return config as ServerSpawnConfig;
  } catch (error) {
    console.error(`[mcp] Error fetching config for ${serverId}:`, error);
    return null;
  }
}
