/**
 * Common types for MCP server
 */

/** Result from calling a tool */
export interface CallToolResult {
  content: unknown;
  raw: unknown;
  isError: boolean;
}

/** Configuration for a spawnable MCP server */
export interface SpawnConfig {
  slug: string;
  label: string;
  description: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  requiredEnv?: string[];
  npmPackage?: string;
  category?: string;
  tags?: string[];
}

/** Info about a spawnable MCP server */
export interface McpServerInfo {
  slug: string;
  label: string;
  description: string;
  spawned: boolean;
  available: boolean;
  remote?: boolean;
  url?: string;
  category?: string;
  tags?: string[];
  missingEnv?: string[];
}

/** Status of spawned servers */
export interface McpSpawnedStatus {
  active: number;
  servers: Array<{
    slug: string;
    toolCount: number;
    idleSeconds: number;
  }>;
}

/** Tool definition */
export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

/** Remote MCP server configuration */
export interface McpRemoteServerConfig {
  url: string;
  name: string;
  slug: string;
}
