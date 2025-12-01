/**
 * Sandbox Service Configuration
 * 
 * Loads configuration from environment variables.
 */
import "dotenv/config";

/** HTTP port for the sandbox service */
export const PORT = parseInt(process.env.PORT || "4002", 10);

/** URL of the Connector Hub service */
export const CONNECTOR_BASE_URL = process.env.CONNECTOR_BASE_URL || "http://localhost:4001";

/** Timeout for connector calls in milliseconds */
export const CONNECTOR_TIMEOUT_MS = parseInt(process.env.CONNECTOR_TIMEOUT_MS || "60000", 10);

/** Maximum workflow steps allowed */
export const MAX_WORKFLOW_STEPS = parseInt(process.env.MAX_WORKFLOW_STEPS || "50", 10);

// Validation
if (!CONNECTOR_BASE_URL) {
  throw new Error("CONNECTOR_BASE_URL environment variable is required");
}

console.log(`[config] CONNECTOR_BASE_URL: ${CONNECTOR_BASE_URL}`);
console.log(`[config] CONNECTOR_TIMEOUT_MS: ${CONNECTOR_TIMEOUT_MS}`);
console.log(`[config] MAX_WORKFLOW_STEPS: ${MAX_WORKFLOW_STEPS}`);

