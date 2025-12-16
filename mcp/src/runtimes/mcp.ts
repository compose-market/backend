/**
 * MCP Runtime - On-Demand Server Spawning
 * 
 * Spawns individual MCP servers on-demand using StdioClientTransport.
 * Each server gets its own session with isolated state.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
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
  serverSlug: string;
  client: Client;
  transport: StdioClientTransport;
  tools: any[];
  createdAt: Date;
  lastUsedAt: Date;
}

interface ServerSpawnConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/**
 * Map MCP server slug to npm package name and spawn configuration
 */
export function getMcpServerConfig(slug: string): { command: string; args: string[]; env?: Record<string, string> } | null {
  // Remove common prefixes to normalize
  const normalized = slug
    .replace(/^mcp[-_]/, '')
    .replace(/[-_]mcp$/, '')
    .replace(/_/g, '-');

  // Map to known MCP server packages
  const packageMap: Record<string, string> = {
    // Official MCP servers
    'filesystem': '@modelcontextprotocol/server-filesystem',
    'github': '@modelcontextprotocol/server-github',
    'gitlab': '@modelcontextprotocol/server-gitlab',
    'google-drive': '@modelcontextprotocol/server-google-drive',
    'google-maps': '@modelcontextprotocol/server-google-maps',
    'memory': '@modelcontextprotocol/server-memory',
    'postgres': '@modelcontextprotocol/server-postgres',
    'puppeteer': '@modelcontextprotocol/server-puppeteer',
    'sequential-thinking': '@modelcontextprotocol/server-sequential-thinking',
    'slack': '@modelcontextprotocol/server-slack',
    'sqlite': '@modelcontextprotocol/server-sqlite',

    // Common community servers
    'brave-search': '@modelcontextprotocol/server-brave-search',
    'everything': '@modelcontextprotocol/server-everything',
    'fetch': '@modelcontextprotocol/server-fetch',
    'git': 'mcp-server-git',
    'youtube-transcript': 'mcp-youtube-transcript',
  };

  const packageName = packageMap[normalized];

  if (!packageName) {
    // Try generic pattern for community servers
    const genericPackage = `@modelcontextprotocol/server-${normalized}`;
    console.log(`[mcp] Unknown server ${slug}, trying generic package: ${genericPackage}`);

    return {
      command: 'npx',
      args: ['-y', genericPackage],
      env: {},
    };
  }

  return {
    command: 'npx',
    args: ['-y', packageName],
    env: {},
  };
}

export class McpRuntime {
  private sessions = new Map<string, McpServerSession>();
  private config: McpRuntimeConfig;
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor(config: McpRuntimeConfig = {}) {
    this.config = {
      logLevel: config.logLevel || 'WARNING',
      maxSessions: config.maxSessions || 50,
      sessionTimeoutMs: config.sessionTimeoutMs || 30 * 60 * 1000, // 30 minutes default
    };
  }

  async initialize(): Promise<void> {
    console.log("[MCP Runtime] Initialized - ready to spawn servers on-demand");

    // Start cleanup interval
    this.cleanupInterval = setInterval(() => {
      this.cleanupIdleSessions();
    }, 5 * 60 * 1000); // Check every 5 minutes
  }

  /**
   * Spawn an MCP server and create a session
   */
  async spawnServer(serverId: string, config: ServerSpawnConfig): Promise<string> {
    // Check session limit
    if (this.sessions.size >= this.config.maxSessions!) {
      throw new Error(`Session limit reached (${this.config.maxSessions})`);
    }

    console.log(`[MCP Runtime] Spawning server: ${serverId}`);

    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args,
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(([_, v]) => v !== undefined) as [string, string][]
        ),
        ...config.env,
      },
    });

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
        serverSlug: serverId.split(':')[1] || serverId,
        client,
        transport,
        tools,
        createdAt: new Date(),
        lastUsedAt: new Date(),
      };

      this.sessions.set(sessionId, session);

      console.log(`[MCP Runtime] Server spawned: ${serverId} (session: ${sessionId}, tools: ${tools.length})`);

      return sessionId;
    } catch (error) {
      console.error(`[MCP Runtime] Failed to spawn ${serverId}:`, error);
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
        // Get spawn config (on-demand, no connector needed)
        const config = getMcpServerConfig(serverId);
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
  const config = getMcpServerConfig(serverId);
  if (!config) {
    throw new Error(`Unknown MCP server: ${serverId}`);
  }

  console.log(`[mcp] Spawning new session for ${serverId}: ${config.command} ${config.args.join(' ')}`);
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
    const config = getMcpServerConfig(serverId);
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
