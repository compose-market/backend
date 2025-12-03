/**
 * Dynamic MCP Registry
 *
 * Fetches servers from the MCP Registry at registry.modelcontextprotocol.io
 * All servers are discovered dynamically.
 *
 * Server types:
 * - `packages` with registryType="npm" → spawn with npx
 * - `remotes` with type="streamable-http" → connect via SSE/HTTP
 *
 * @see https://registry.modelcontextprotocol.io/docs
 */
import { registerSpawnConfig, getRegisteredCount } from "./spawner.js";
import type { SpawnConfig } from "./types.js";

// =============================================================================
// MCP Registry API
// =============================================================================

const MCP_REGISTRY_URL = "https://registry.modelcontextprotocol.io/v0.1/servers";
const REGISTRY_PAGE_SIZE = 50; // API limit per page

/** MCP Registry server entry */
interface McpRegistryServer {
  server: {
    name: string;
    description?: string;
    version: string;
    repository?: { url?: string; source?: string };
    packages?: Array<{
      registryType: "npm" | "oci" | "pypi";
      identifier: string;
      transport?: { type: string };
      environmentVariables?: Array<{
        name: string;
        description?: string;
        isRequired?: boolean;
        isSecret?: boolean;
      }>;
      arguments?: Array<{
        name: string;
        type: string;
        value?: string;
        isRequired?: boolean;
      }>;
    }>;
    remotes?: Array<{
      type: "streamable-http" | "sse";
      url: string;
    }>;
  };
  _meta?: {
    "io.modelcontextprotocol.registry/official"?: {
      status: string;
      isLatest: boolean;
    };
  };
}

interface McpRegistryResponse {
  servers: McpRegistryServer[];
  metadata?: {
    nextCursor?: string;
    count?: number;
  };
}

// =============================================================================
// Registry Fetching
// =============================================================================

/**
 * Fetch all servers from the official MCP Registry with pagination
 */
async function fetchAllMcpServers(): Promise<McpRegistryServer[]> {
  const allServers: McpRegistryServer[] = [];
  let cursor: string | undefined;
  let pageCount = 0;
  const maxPages = 100; // Safety limit

  console.log(`[registry] Fetching servers from ${MCP_REGISTRY_URL}...`);

  while (pageCount < maxPages) {
    try {
      const url = new URL(MCP_REGISTRY_URL);
      url.searchParams.set("limit", String(REGISTRY_PAGE_SIZE));
      if (cursor) {
        url.searchParams.set("cursor", cursor);
      }

      const res = await fetch(url.toString(), {
        signal: AbortSignal.timeout(30000),
        headers: { Accept: "application/json" },
      });

      if (!res.ok) {
        console.error(`[registry] API error: ${res.status}`);
        break;
      }

      const data: McpRegistryResponse = await res.json();

      if (!data.servers || data.servers.length === 0) {
        break;
      }

      // Filter to only latest versions
      const latestServers = data.servers.filter(
        (s) => s._meta?.["io.modelcontextprotocol.registry/official"]?.isLatest !== false
      );

      allServers.push(...latestServers);
      pageCount++;

      // Check for next page
      cursor = data.metadata?.nextCursor;
      if (!cursor) {
        break;
      }

      console.log(`[registry] Fetched page ${pageCount}, total: ${allServers.length} servers`);
    } catch (error) {
      console.error(`[registry] Fetch error:`, error);
      break;
    }
  }

  console.log(`[registry] Fetched ${allServers.length} servers from MCP Registry`);
  return allServers;
}

/**
 * Convert registry server to SpawnConfig (for npm packages)
 */
function serverToSpawnConfig(entry: McpRegistryServer): SpawnConfig | null {
  const server = entry.server;

  // Only process servers with npm packages
  if (!server.packages) return null;

  const npmPackage = server.packages.find((p) => p.registryType === "npm");
  if (!npmPackage) return null;

  // Extract slug from name (e.g., "ai.exa/exa" -> "exa")
  const slug = server.name.split("/").pop() || server.name;

  // Build args array
  const args = ["-y", npmPackage.identifier];

  // Add any positional arguments
  if (npmPackage.arguments) {
    for (const arg of npmPackage.arguments) {
      if (arg.type === "positional" && arg.value) {
        args.push(arg.value);
      }
    }
  }

  // Get required env vars
  const requiredEnv: string[] = [];
  if (npmPackage.environmentVariables) {
    for (const env of npmPackage.environmentVariables) {
      if (env.isRequired || env.isSecret) {
        requiredEnv.push(env.name);
      }
    }
  }

  return {
    slug,
    label: server.name,
    description: server.description || `MCP Server: ${server.name}`,
    command: "npx",
    args,
    requiredEnv: requiredEnv.length > 0 ? requiredEnv : undefined,
    npmPackage: npmPackage.identifier,
    category: extractCategory(server.name, server.description),
    tags: extractTags(server.name, server.description),
  };
}

/**
 * Extract category from server name/description
 */
function extractCategory(name: string, description?: string): string {
  const lower = (name + " " + (description || "")).toLowerCase();

  if (lower.includes("database") || lower.includes("sql") || lower.includes("postgres")) {
    return "database";
  }
  if (lower.includes("github") || lower.includes("git") || lower.includes("code")) {
    return "development";
  }
  if (lower.includes("file") || lower.includes("fs") || lower.includes("storage")) {
    return "filesystem";
  }
  if (lower.includes("web") || lower.includes("http") || lower.includes("browser")) {
    return "web";
  }
  if (lower.includes("ai") || lower.includes("llm") || lower.includes("model")) {
    return "ai";
  }
  if (lower.includes("slack") || lower.includes("discord") || lower.includes("chat")) {
    return "communication";
  }

  return "utility";
}

/**
 * Extract tags from server name/description
 */
function extractTags(name: string, description?: string): string[] {
  const tags = new Set<string>();
  const lower = (name + " " + (description || "")).toLowerCase();

  const keywords = [
    "api",
    "database",
    "file",
    "web",
    "ai",
    "chat",
    "github",
    "git",
    "slack",
    "discord",
    "notion",
    "google",
    "aws",
    "azure",
    "docker",
    "kubernetes",
    "postgres",
    "mysql",
    "mongodb",
    "redis",
    "search",
    "browser",
    "automation",
  ];

  for (const kw of keywords) {
    if (lower.includes(kw)) {
      tags.add(kw);
    }
  }

  // Add namespace as tag
  const namespace = name.split("/")[0];
  if (namespace) {
    tags.add(namespace.replace(/^ai\./, ""));
  }

  return Array.from(tags);
}

// =============================================================================
// Remote Servers (Streamable HTTP)
// =============================================================================

/** Map of server slug to remote URL */
const remoteServers = new Map<string, string>();

/**
 * Register remote servers (streamable-http)
 */
function registerRemoteServers(servers: McpRegistryServer[]): number {
  let count = 0;

  for (const entry of servers) {
    const server = entry.server;

    if (!server.remotes) continue;

    const remote = server.remotes.find(
      (r) => r.type === "streamable-http" || r.type === "sse"
    );
    if (!remote) continue;

    const slug = server.name.split("/").pop() || server.name;
    remoteServers.set(slug, remote.url);
    count++;
  }

  console.log(`[registry] Registered ${count} remote servers`);
  return count;
}

/**
 * Get remote server URL
 */
export function getRemoteServerUrl(slug: string): string | undefined {
  return remoteServers.get(slug);
}

/**
 * Check if server is remote
 */
export function isRemoteServer(slug: string): boolean {
  return remoteServers.has(slug);
}

/**
 * Get all remote servers
 */
export function getRemoteServers(): Map<string, string> {
  return new Map(remoteServers);
}

// =============================================================================
// Registry Initialization
// =============================================================================

let initialized = false;
let registryServers: McpRegistryServer[] = [];

/**
 * Initialize the registry by fetching from the official MCP Registry
 */
export async function initializeRegistry(): Promise<void> {
  if (initialized) return;

  console.log(`[registry] Initializing MCP registry (NO HARDCODING)...`);

  try {
    // Fetch all servers from MCP Registry
    registryServers = await fetchAllMcpServers();

    // Process npm-based servers (spawnable)
    const spawnableConfigs: SpawnConfig[] = [];
    for (const entry of registryServers) {
      const config = serverToSpawnConfig(entry);
      if (config) {
        spawnableConfigs.push(config);
      }
    }

    // Register spawn configs
    for (const config of spawnableConfigs) {
      registerSpawnConfig(config);
    }
    console.log(`[registry] Registered ${spawnableConfigs.length} npm-spawnable servers`);

    // Register remote servers
    registerRemoteServers(registryServers);

    initialized = true;
    console.log(`[registry] Registry initialized with ${getRegisteredCount()} total spawnable servers`);
  } catch (error) {
    console.error(`[registry] Failed to initialize registry:`, error);
    throw error;
  }
}

/**
 * Force refresh the registry
 */
export async function refreshRegistry(): Promise<void> {
  initialized = false;
  remoteServers.clear();
  await initializeRegistry();
}

/**
 * Get raw registry data
 */
export function getRegistryServers(): McpRegistryServer[] {
  return registryServers;
}
