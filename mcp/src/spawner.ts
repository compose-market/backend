/**
 * MCP Server Spawner
 *
 * Spawns MCP servers as child processes using stdio transport.
 * Uses the official MCP TypeScript SDK.
 *
 * @see https://modelcontextprotocol.io/docs/develop/connect-local-servers
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { SpawnConfig, CallToolResult, McpServerInfo, McpSpawnedStatus, McpTool } from "./types.js";

// =============================================================================
// Configuration
// =============================================================================

/** Idle timeout before killing a spawned server (5 minutes) */
const IDLE_TIMEOUT_MS = 5 * 60 * 1000;

/** Connection timeout in milliseconds */
const CONNECTION_TIMEOUT_MS = 30_000;

/** Tool call timeout in milliseconds */
const TOOL_CALL_TIMEOUT_MS = 60_000;

// =============================================================================
// State
// =============================================================================

/** Registered spawn configurations */
const spawnConfigs = new Map<string, SpawnConfig>();

/** Active spawned servers */
interface SpawnedServer {
  slug: string;
  client: Client;
  transport: StdioClientTransport;
  tools: Tool[];
  idleTimer: ReturnType<typeof setTimeout>;
  startedAt: number;
}

const spawnedServers = new Map<string, SpawnedServer>();

// =============================================================================
// Registration
// =============================================================================

/**
 * Register a spawn configuration
 */
export function registerSpawnConfig(config: SpawnConfig): void {
  spawnConfigs.set(config.slug, config);
}

/**
 * Get all registered spawn configs
 */
export function getAllSpawnConfigs(): Map<string, SpawnConfig> {
  return spawnConfigs;
}

/**
 * Get number of registered configs
 */
export function getRegisteredCount(): number {
  return spawnConfigs.size;
}

/**
 * Get a spawn config by slug
 */
export function getSpawnConfig(slug: string): SpawnConfig | undefined {
  return spawnConfigs.get(slug);
}

// =============================================================================
// Environment Check
// =============================================================================

/**
 * Check if all required environment variables are present
 */
function checkEnv(config: SpawnConfig): string[] {
  const missing: string[] = [];
  if (config.requiredEnv) {
    for (const envVar of config.requiredEnv) {
      if (!process.env[envVar]) {
        missing.push(envVar);
      }
    }
  }
  return missing;
}

/**
 * Get missing env vars for a server
 */
export function getMissingEnvForSpawn(slug: string): string[] {
  const config = spawnConfigs.get(slug);
  if (!config) return [];
  return checkEnv(config);
}

/**
 * Check if a server is spawnable (registered and has required env)
 */
export function isSpawnableServer(slug: string): boolean {
  const config = spawnConfigs.get(slug);
  if (!config) return false;
  const missing = checkEnv(config);
  return missing.length === 0;
}

// =============================================================================
// Server Lifecycle
// =============================================================================

/**
 * Reset idle timer for a server
 */
function resetIdleTimer(server: SpawnedServer): void {
  clearTimeout(server.idleTimer);
  server.idleTimer = setTimeout(() => {
    console.log(`[spawner] Idle timeout reached for ${server.slug}, killing...`);
    forceKillServer(server.slug).catch(console.error);
  }, IDLE_TIMEOUT_MS);
}

/**
 * Spawn an MCP server
 */
async function spawnServer(slug: string): Promise<SpawnedServer> {
  // Check if already spawned
  const existing = spawnedServers.get(slug);
  if (existing) {
    resetIdleTimer(existing);
    return existing;
  }

  const config = spawnConfigs.get(slug);
  if (!config) {
    throw new Error(`No spawn config registered for: ${slug}`);
  }

  const missing = checkEnv(config);
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables for ${slug}: ${missing.join(", ")}`
    );
  }

  console.log(`[spawner] Spawning ${slug}: ${config.command} ${config.args.join(" ")}`);

  // Merge environment - filter out undefined values
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }
  if (config.env) {
    Object.assign(env, config.env);
  }

  // Create transport
  const transport = new StdioClientTransport({
    command: config.command,
    args: config.args,
    env,
  });

  // Create client
  const client = new Client({
    name: `compose-mcp-spawner-${slug}`,
    version: "0.1.0",
  });

  // Connect with timeout
  const connectPromise = client.connect(transport);
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(
      () => reject(new Error(`Connection timeout for ${slug}`)),
      CONNECTION_TIMEOUT_MS
    );
  });

  try {
    await Promise.race([connectPromise, timeoutPromise]);
  } catch (error) {
    // Kill process on connect failure
    try {
      await transport.close();
    } catch {
      // Ignore
    }
    throw error;
  }

  // Get available tools
  const toolsResult = await client.listTools();
  const tools = toolsResult.tools;

  console.log(`[spawner] ${slug} spawned with ${tools.length} tools`);

  // Create spawned server entry
  const server: SpawnedServer = {
    slug,
    client,
    transport,
    tools,
    idleTimer: setTimeout(() => {}, 0),
    startedAt: Date.now(),
  };

  // Set up idle timer
  resetIdleTimer(server);

  // Store
  spawnedServers.set(slug, server);

  return server;
}

/**
 * Force kill a spawned server
 */
export async function forceKillServer(slug: string): Promise<void> {
  const server = spawnedServers.get(slug);
  if (!server) return;

  clearTimeout(server.idleTimer);
  spawnedServers.delete(slug);

  try {
    await server.client.close();
  } catch {
    // Ignore close errors
  }

  try {
    await server.transport.close();
  } catch {
    // Ignore close errors
  }

  console.log(`[spawner] ${slug} killed`);
}

/**
 * Kill all spawned servers
 */
export async function killAllServers(): Promise<void> {
  const slugs = Array.from(spawnedServers.keys());
  await Promise.all(slugs.map((s) => forceKillServer(s)));
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Get list of all spawnable servers
 */
export function getSpawnableServers(): McpServerInfo[] {
  const result: McpServerInfo[] = [];

  for (const [slug, config] of spawnConfigs.entries()) {
    const missing = checkEnv(config);
    const spawned = spawnedServers.has(slug);

    result.push({
      slug,
      label: config.label,
      description: config.description,
      spawned,
      available: missing.length === 0,
      category: config.category,
      tags: config.tags,
      missingEnv: missing.length > 0 ? missing : undefined,
    });
  }

  return result;
}

/**
 * Get status of spawned servers
 */
export function getSpawnedStatus(): McpSpawnedStatus {
  const now = Date.now();
  const servers = Array.from(spawnedServers.values()).map((s) => ({
    slug: s.slug,
    toolCount: s.tools.length,
    idleSeconds: Math.floor((now - s.startedAt) / 1000),
  }));

  return {
    active: servers.length,
    servers,
  };
}

/**
 * List tools from a server (spawns on-demand)
 */
export async function listServerTools(slug: string): Promise<McpTool[]> {
  const server = await spawnServer(slug);
  resetIdleTimer(server);

  return server.tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema as Record<string, unknown>,
  }));
}

/**
 * Call a tool on a server (spawns on-demand)
 */
export async function callServerTool(
  slug: string,
  toolName: string,
  args: Record<string, unknown>
): Promise<CallToolResult> {
  const server = await spawnServer(slug);
  resetIdleTimer(server);

  // Verify tool exists
  const tool = server.tools.find((t) => t.name === toolName);
  if (!tool) {
    throw new Error(
      `Tool "${toolName}" not found on ${slug}. Available: ${server.tools
        .map((t) => t.name)
        .join(", ")}`
    );
  }

  console.log(`[spawner] ${slug}/${toolName} called`);

  // Call with timeout
  const callPromise = server.client.callTool({
    name: toolName,
    arguments: args,
  });
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(
      () => reject(new Error(`Tool call timeout for ${toolName}`)),
      TOOL_CALL_TIMEOUT_MS
    );
  });

  const result = await Promise.race([callPromise, timeoutPromise]);

  return {
    content: result.content,
    raw: result,
    isError: result.isError === true,
  };
}

/**
 * Warm up a server by spawning it
 */
export async function warmupServer(slug: string): Promise<void> {
  await spawnServer(slug);
}
