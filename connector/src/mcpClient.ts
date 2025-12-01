import crypto from "crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { getConnector, getMissingEnv, isConnectorAvailable } from "./connectors.js";
import type { ConnectorId, CallToolResult, ConnectorClient } from "./types.js";

/** Connection timeout in milliseconds */
const CONNECTION_TIMEOUT_MS = 30_000;

/** Tool call timeout in milliseconds */
const TOOL_CALL_TIMEOUT_MS = 60_000;

/**
 * Client pool for reusing MCP connections
 * Maps connector ID to active client instance
 */
const clientPool = new Map<ConnectorId, { client: Client; transport: StdioClientTransport; lastUsed: number }>();

/** Pool cleanup interval - close idle connections after 5 minutes */
const POOL_IDLE_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Validates that all required environment variables are set for a connector
 */
function validateEnv(connectorId: ConnectorId): void {
  const connector = getConnector(connectorId);
  const missing = getMissingEnv(connector);
  if (missing.length > 0) {
    throw new Error(
      `Missing environment variables for connector "${connectorId}": ${missing.join(", ")}`
    );
  }
}

/**
 * Creates a new MCP client connection for a connector
 */
async function createClient(connectorId: ConnectorId): Promise<{
  client: Client;
  transport: StdioClientTransport;
}> {
  const connector = getConnector(connectorId);
  validateEnv(connectorId);

  // Check if this is an HTTP-based connector (no MCP server)
  if (connector.httpBased) {
    throw new Error(
      `Connector "${connectorId}" uses HTTP-based transport, not MCP stdio. Use the HTTP connector instead.`
    );
  }

  const transport = new StdioClientTransport({
    command: connector.command,
    args: connector.args,
    env: { ...process.env } as Record<string, string>
  });

  const client = new Client({
    name: `compose-connector-${connectorId}`,
    version: "0.1.0"
  });

  // Connect with timeout
  const connectPromise = client.connect(transport);
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(`Connection timeout for ${connectorId}`)), CONNECTION_TIMEOUT_MS);
  });

  await Promise.race([connectPromise, timeoutPromise]);

  return { client, transport };
}

/**
 * Gets or creates a pooled client for a connector
 */
async function getPooledClient(connectorId: ConnectorId): Promise<Client> {
  const existing = clientPool.get(connectorId);
  
  if (existing) {
    existing.lastUsed = Date.now();
    return existing.client;
  }

  const { client, transport } = await createClient(connectorId);
  clientPool.set(connectorId, { client, transport, lastUsed: Date.now() });
  
  return client;
}

/**
 * Closes a pooled client connection
 */
async function closePooledClient(connectorId: ConnectorId): Promise<void> {
  const entry = clientPool.get(connectorId);
  if (entry) {
    clientPool.delete(connectorId);
    try {
      await entry.client.close();
      await entry.transport.close();
    } catch {
      // Ignore close errors
    }
  }
}

/**
 * Cleanup idle connections periodically
 */
function startPoolCleanup(): void {
  setInterval(() => {
    const now = Date.now();
    for (const [connectorId, entry] of clientPool.entries()) {
      if (now - entry.lastUsed > POOL_IDLE_TIMEOUT_MS) {
        closePooledClient(connectorId).catch(() => {});
      }
    }
  }, 60_000); // Check every minute
}

// Start pool cleanup on module load
startPoolCleanup();

/**
 * Lists available tools for a connector
 */
export async function listTools(connectorId: ConnectorId): Promise<Tool[]> {
  const connector = getConnector(connectorId);
  
  // For HTTP-based connectors, return predefined tools
  if (connector.httpBased) {
    return getHttpConnectorTools(connectorId);
  }

  const client = await getPooledClient(connectorId);
  
  try {
    const result = await client.listTools();
    return result.tools;
  } catch (error) {
    // On error, close the pooled client so next call creates fresh connection
    await closePooledClient(connectorId);
    throw error;
  }
}

/**
 * Calls a tool on a connector
 */
export async function callTool(
  connectorId: ConnectorId,
  toolName: string,
  args: Record<string, unknown>
): Promise<CallToolResult> {
  const connector = getConnector(connectorId);
  
  // For HTTP-based connectors, use direct HTTP calls
  if (connector.httpBased) {
    return callHttpConnectorTool(connectorId, toolName, args);
  }

  const client = await getPooledClient(connectorId);

  try {
    // Call with timeout
    const callPromise = client.callTool({ name: toolName, arguments: args });
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`Tool call timeout for ${toolName}`)), TOOL_CALL_TIMEOUT_MS);
    });

    const result = await Promise.race([callPromise, timeoutPromise]);

    return {
      content: result.content,
      raw: result,
      isError: result.isError === true
    };
  } catch (error) {
    // On error, close the pooled client so next call creates fresh connection
    await closePooledClient(connectorId);
    throw error;
  }
}

/**
 * Creates a one-shot client (for testing or when pool is not desired)
 */
export async function createOneShotClient(connectorId: ConnectorId): Promise<ConnectorClient> {
  const connector = getConnector(connectorId);
  
  if (connector.httpBased) {
    return createHttpConnectorClient(connectorId);
  }

  const { client, transport } = await createClient(connectorId);

  return {
    async listTools(): Promise<Tool[]> {
      const result = await client.listTools();
      return result.tools;
    },
    async callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
      const result = await client.callTool({ name, arguments: args });
      return {
        content: result.content,
        raw: result,
        isError: result.isError === true
      };
    },
    async close(): Promise<void> {
      await client.close();
      await transport.close();
    }
  };
}

/**
 * Closes all pooled connections (for graceful shutdown)
 */
export async function closeAllConnections(): Promise<void> {
  const closePromises = Array.from(clientPool.keys()).map((id) => closePooledClient(id));
  await Promise.all(closePromises);
}

// ============================================================================
// HTTP-based connector implementations (for connectors without MCP servers)
// ============================================================================

/**
 * Get predefined tools for HTTP-based connectors
 */
function getHttpConnectorTools(connectorId: ConnectorId): Tool[] {
  switch (connectorId) {
    case "x":
      return getXTools();
    default:
      return [];
  }
}

/**
 * Call a tool on an HTTP-based connector
 */
async function callHttpConnectorTool(
  connectorId: ConnectorId,
  toolName: string,
  args: Record<string, unknown>
): Promise<CallToolResult> {
  switch (connectorId) {
    case "x":
      return callXTool(toolName, args);
    default:
      throw new Error(`HTTP connector not implemented for: ${connectorId}`);
  }
}

/**
 * Create an HTTP connector client
 */
function createHttpConnectorClient(connectorId: ConnectorId): ConnectorClient {
  return {
    async listTools(): Promise<Tool[]> {
      return getHttpConnectorTools(connectorId);
    },
    async callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
      return callHttpConnectorTool(connectorId, name, args);
    },
    async close(): Promise<void> {
      // No-op for HTTP clients
    }
  };
}

// ============================================================================
// X (Twitter) HTTP Connector
// ============================================================================

/**
 * X (Twitter) API v2 tools
 */
function getXTools(): Tool[] {
  return [
    {
      name: "post_tweet",
      description: "Post a new tweet to X/Twitter",
      inputSchema: {
        type: "object",
        properties: {
          text: {
            type: "string",
            description: "The text content of the tweet (max 280 characters)"
          }
        },
        required: ["text"]
      }
    },
    {
      name: "get_user_timeline",
      description: "Get recent tweets from a user's timeline",
      inputSchema: {
        type: "object",
        properties: {
          username: {
            type: "string",
            description: "The Twitter username (without @)"
          },
          max_results: {
            type: "number",
            description: "Maximum number of tweets to return (5-100)",
            default: 10
          }
        },
        required: ["username"]
      }
    },
    {
      name: "search_tweets",
      description: "Search for tweets matching a query",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search query string"
          },
          max_results: {
            type: "number",
            description: "Maximum number of tweets to return (10-100)",
            default: 10
          }
        },
        required: ["query"]
      }
    },
    {
      name: "get_user_info",
      description: "Get information about a Twitter user",
      inputSchema: {
        type: "object",
        properties: {
          username: {
            type: "string",
            description: "The Twitter username (without @)"
          }
        },
        required: ["username"]
      }
    }
  ];
}

/**
 * Make authenticated request to X API v2
 */
async function xApiRequest(
  endpoint: string,
  method: "GET" | "POST" = "GET",
  body?: Record<string, unknown>
): Promise<unknown> {
  const bearerToken = process.env.X_BEARER_TOKEN;
  if (!bearerToken) {
    throw new Error("X_BEARER_TOKEN is required");
  }

  const url = `https://api.twitter.com/2${endpoint}`;
  
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${bearerToken}`,
      "Content-Type": "application/json"
    },
    body: body ? JSON.stringify(body) : undefined
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`X API error (${response.status}): ${errorText}`);
  }

  return response.json();
}

/**
 * Make OAuth 1.0a authenticated request for user-context endpoints
 */
async function xOAuth1Request(
  endpoint: string,
  method: "GET" | "POST" = "GET",
  body?: Record<string, unknown>
): Promise<unknown> {
  const apiKey = process.env.X_API_KEY;
  const apiKeySecret = process.env.X_API_KEY_SECRET;
  const accessToken = process.env.X_ACCESS_TOKEN;
  const accessTokenSecret = process.env.X_ACCESS_TOKEN_SECRET;

  if (!apiKey || !apiKeySecret || !accessToken || !accessTokenSecret) {
    throw new Error("X OAuth credentials are required for this operation");
  }

  const url = `https://api.twitter.com/2${endpoint}`;
  
  // Generate OAuth 1.0a signature
  const oauth = generateOAuth1Header(
    method,
    url,
    apiKey,
    apiKeySecret,
    accessToken,
    accessTokenSecret
  );

  const response = await fetch(url, {
    method,
    headers: {
      Authorization: oauth,
      "Content-Type": "application/json"
    },
    body: body ? JSON.stringify(body) : undefined
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`X API error (${response.status}): ${errorText}`);
  }

  return response.json();
}

/**
 * Generate OAuth 1.0a Authorization header
 */
function generateOAuth1Header(
  method: string,
  url: string,
  consumerKey: string,
  consumerSecret: string,
  token: string,
  tokenSecret: string
): string {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = crypto.randomBytes(16).toString("hex");

  const oauthParams: Record<string, string> = {
    oauth_consumer_key: consumerKey,
    oauth_nonce: nonce,
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: timestamp,
    oauth_token: token,
    oauth_version: "1.0"
  };

  // Create signature base string
  const paramString = Object.keys(oauthParams)
    .sort()
    .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(oauthParams[key])}`)
    .join("&");

  const signatureBase = `${method}&${encodeURIComponent(url)}&${encodeURIComponent(paramString)}`;
  const signingKey = `${encodeURIComponent(consumerSecret)}&${encodeURIComponent(tokenSecret)}`;

  const signature = crypto
    .createHmac("sha1", signingKey)
    .update(signatureBase)
    .digest("base64");

  oauthParams.oauth_signature = signature;

  const authHeader = Object.keys(oauthParams)
    .sort()
    .map((key) => `${encodeURIComponent(key)}="${encodeURIComponent(oauthParams[key])}"`)
    .join(", ");

  return `OAuth ${authHeader}`;
}

/**
 * Call an X (Twitter) tool
 */
async function callXTool(
  toolName: string,
  args: Record<string, unknown>
): Promise<CallToolResult> {
  try {
    let result: unknown;

    switch (toolName) {
      case "post_tweet": {
        const text = args.text as string;
        if (!text) throw new Error("text is required");
        if (text.length > 280) throw new Error("Tweet text exceeds 280 characters");
        
        result = await xOAuth1Request("/tweets", "POST", { text });
        break;
      }

      case "get_user_timeline": {
        const username = args.username as string;
        if (!username) throw new Error("username is required");
        
        // First get user ID from username
        const userResult = await xApiRequest(`/users/by/username/${username}`) as { data?: { id: string } };
        if (!userResult.data?.id) throw new Error(`User not found: ${username}`);
        
        const maxResults = Math.min(Math.max(args.max_results as number || 10, 5), 100);
        result = await xApiRequest(`/users/${userResult.data.id}/tweets?max_results=${maxResults}`);
        break;
      }

      case "search_tweets": {
        const query = args.query as string;
        if (!query) throw new Error("query is required");
        
        const maxResults = Math.min(Math.max(args.max_results as number || 10, 10), 100);
        result = await xApiRequest(`/tweets/search/recent?query=${encodeURIComponent(query)}&max_results=${maxResults}`);
        break;
      }

      case "get_user_info": {
        const username = args.username as string;
        if (!username) throw new Error("username is required");
        
        result = await xApiRequest(`/users/by/username/${username}?user.fields=description,public_metrics,created_at`);
        break;
      }

      default:
        throw new Error(`Unknown tool: ${toolName}`);
    }

    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      raw: result,
      isError: false
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text", text: `Error: ${message}` }],
      raw: { error: message },
      isError: true
    };
  }
}

