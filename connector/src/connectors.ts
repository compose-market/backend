import type { ConnectorConfig, ConnectorId, ConnectorInfo } from "./types.js";

/**
 * Connector Registry
 * 
 * Defines all available connectors with their MCP server configurations.
 * Each connector specifies:
 * - How to spawn the MCP server (command + args)
 * - Which environment variables are required
 * - Whether it uses HTTP-based transport instead of stdio
 */
export const CONNECTORS: ConnectorConfig[] = [
  {
    id: "x",
    label: "X (Twitter)",
    description: "Post tweets, read timelines, search, and manage X/Twitter account.",
    command: "node",
    args: ["/opt/mcp/x-mcp-server/build/index.js"],
    requiredEnv: [
      "X_API_KEY",
      "X_API_KEY_SECRET",
      "X_ACCESS_TOKEN",
      "X_ACCESS_TOKEN_SECRET",
      "X_BEARER_TOKEN"
    ],
    // X doesn't have an official MCP server yet, so we'll use HTTP-based connector
    httpBased: true
  },
  {
    id: "notion",
    label: "Notion",
    description: "Read and write Notion pages, databases, and blocks.",
    command: "npx",
    args: ["-y", "@notionhq/notion-mcp-server"],
    requiredEnv: ["NOTION_API_KEY"]
  },
  {
    id: "google-workspace",
    label: "Google Workspace",
    description: "Access Gmail, Calendar, Drive, Docs, Sheets, and more.",
    command: "node",
    args: ["/opt/mcp/google-workspace-mcp/build/index.js"],
    requiredEnv: ["GOOGLE_CREDENTIALS_JSON", "GOOGLE_SUBJECT_EMAIL"]
  },
  {
    id: "discord",
    label: "Discord",
    description: "Read and write to Discord channels, manage servers.",
    command: "node",
    args: ["/opt/mcp/discord-mcp/build/index.js"],
    requiredEnv: ["DISCORD_BOT_TOKEN"]
  }
];

/**
 * Get a connector configuration by ID
 */
export function getConnector(id: ConnectorId): ConnectorConfig {
  const connector = CONNECTORS.find((c) => c.id === id);
  if (!connector) {
    throw new Error(`Unknown connector id: ${id}`);
  }
  return connector;
}

/**
 * Check which environment variables are missing for a connector
 */
export function getMissingEnv(connector: ConnectorConfig): string[] {
  return connector.requiredEnv.filter((envVar) => !process.env[envVar]);
}

/**
 * Check if a connector has all required environment variables
 */
export function isConnectorAvailable(connector: ConnectorConfig): boolean {
  return getMissingEnv(connector).length === 0;
}

/**
 * Get connector info suitable for API responses
 */
export function getConnectorInfo(connector: ConnectorConfig): ConnectorInfo {
  const missingEnv = getMissingEnv(connector);
  return {
    id: connector.id,
    label: connector.label,
    description: connector.description,
    available: missingEnv.length === 0,
    missingEnv: missingEnv.length > 0 ? missingEnv : undefined
  };
}

/**
 * Get all connectors with availability info
 */
export function getAllConnectorsInfo(): ConnectorInfo[] {
  return CONNECTORS.map(getConnectorInfo);
}

/**
 * Validate that a connector ID is valid
 */
export function isValidConnectorId(id: string): id is ConnectorId {
  return CONNECTORS.some((c) => c.id === id);
}

