/**
 * Remote MCP Server Client
 *
 * Connects to remote MCP servers via Streamable HTTP transport.
 * Used for servers that expose streamable-http endpoints.
 *
 * @see https://modelcontextprotocol.io/docs/develop/connect-remote-servers
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { CallToolResult, McpTool } from "./types.js";

// =============================================================================
// Configuration
// =============================================================================

/** Connection timeout in milliseconds */
const CONNECTION_TIMEOUT_MS = 30_000;

/** Tool call timeout in milliseconds */
const TOOL_CALL_TIMEOUT_MS = 60_000;

/** Pool cleanup interval - close idle connections after 10 minutes */
const POOL_IDLE_TIMEOUT_MS = 10 * 60 * 1000;

// =============================================================================
// Connection Pool
// =============================================================================

interface PooledConnection {
  slug: string;
  url: string;
  client: Client;
  transport: StreamableHTTPClientTransport;
  tools: Tool[];
  lastUsed: number;
}

const connectionPool = new Map<string, PooledConnection>();

// =============================================================================
// Connection Management
// =============================================================================

/**
 * Connect to a remote MCP server
 */
export async function connectRemoteServer(
  slug: string,
  url: string
): Promise<PooledConnection> {
  // Check if already connected
  const existing = connectionPool.get(slug);
  if (existing) {
    existing.lastUsed = Date.now();
    return existing;
  }

  console.log(`[remote] Connecting to ${slug} at ${url}`);

  // Create transport
  const transport = new StreamableHTTPClientTransport(new URL(url));

  // Create client
  const client = new Client({
    name: `compose-mcp-remote-${slug}`,
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

  await Promise.race([connectPromise, timeoutPromise]);

  // Get available tools
  const toolsResult = await client.listTools();
  const tools = toolsResult.tools;

  console.log(`[remote] Connected to ${slug} with ${tools.length} tools`);

  const connection: PooledConnection = {
    slug,
    url,
    client,
    transport,
    tools,
    lastUsed: Date.now(),
  };

  connectionPool.set(slug, connection);
  return connection;
}

/**
 * Close a pooled connection
 */
async function closeConnection(slug: string): Promise<void> {
  const entry = connectionPool.get(slug);
  if (entry) {
    connectionPool.delete(slug);
    try {
      await entry.client.close();
    } catch {
      // Ignore close errors
    }
  }
}

/**
 * Start pool cleanup timer
 */
function startPoolCleanup(): void {
  setInterval(() => {
    const now = Date.now();
    for (const [slug, entry] of connectionPool.entries()) {
      if (now - entry.lastUsed > POOL_IDLE_TIMEOUT_MS) {
        closeConnection(slug).catch(() => {});
      }
    }
  }, 60_000);
}

startPoolCleanup();

// =============================================================================
// Public API
// =============================================================================

/**
 * List tools from a remote MCP server
 */
export async function listRemoteServerTools(
  slug: string,
  url: string
): Promise<McpTool[]> {
  const connection = await connectRemoteServer(slug, url);
  return connection.tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema as Record<string, unknown>,
  }));
}

/**
 * Call a tool on a remote MCP server
 */
export async function callRemoteServerTool(
  slug: string,
  url: string,
  toolName: string,
  args: Record<string, unknown>
): Promise<CallToolResult> {
  const connection = await connectRemoteServer(slug, url);

  // Update last used time
  connection.lastUsed = Date.now();

  // Verify tool exists
  const tool = connection.tools.find((t) => t.name === toolName);
  if (!tool) {
    throw new Error(
      `Tool "${toolName}" not found on ${slug}. Available: ${connection.tools
        .map((t) => t.name)
        .join(", ")}`
    );
  }

  console.log(`[remote] ${slug}/${toolName} called`);

  try {
    // Call with timeout
    const callPromise = connection.client.callTool({
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
  } catch (error) {
    // On error, close connection so next call creates fresh one
    await closeConnection(slug);
    throw error;
  }
}

/**
 * Close all remote connections
 */
export async function closeAllRemoteConnections(): Promise<void> {
  const closePromises = Array.from(connectionPool.keys()).map((slug) =>
    closeConnection(slug)
  );
  await Promise.all(closePromises);
}

/**
 * Get all active remote connections
 */
export function getActiveRemoteConnections(): string[] {
  return Array.from(connectionPool.keys());
}

