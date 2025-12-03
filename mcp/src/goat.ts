/**
 * Plugin Runtime
 * 
 * Executes GOAT SDK plugins with server-side wallet for on-chain operations.
 * Uses treasury wallet for gas, recoups costs via x402 payments.
 */
import { createWalletClient, http, publicActions } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { avalancheFuji, avalanche } from "viem/chains";

// =============================================================================
// Configuration
// =============================================================================

const TREASURY_PRIVATE_KEY = process.env.TREASURY_SERVER_WALLET_PRIVATE as `0x${string}` | undefined;
const RPC_URL = process.env.AVALANCHE_FUJI_RPC || "https://api.avax-test.network/ext/bc/C/rpc";
const USE_MAINNET = process.env.USE_MAINNET === "true";

// Plugin IDs that we support execution for
export const EXECUTABLE_PLUGINS = [
  "goat-erc20",
  "goat-coingecko",
] as const;

export type ExecutablePluginId = typeof EXECUTABLE_PLUGINS[number];

// =============================================================================
// Wallet Initialization
// =============================================================================

let walletClient: ReturnType<typeof createWalletClient> | null = null;
let walletAddress: string | null = null;
let goatTools: Record<string, unknown> | null = null;
let initError: string | null = null;

/**
 * Initialize the GOAT wallet and plugins
 */
async function initializeRuntime(): Promise<void> {
  if (goatTools) return; // Already initialized
  
  if (!TREASURY_PRIVATE_KEY) {
    initError = "TREASURY_SERVER_WALLET_PRIVATE not configured";
    console.warn("[runtime] " + initError);
    return;
  }

  try {
    const chain = USE_MAINNET ? avalanche : avalancheFuji;
    const account = privateKeyToAccount(TREASURY_PRIVATE_KEY);
    walletAddress = account.address;

    walletClient = createWalletClient({
      account,
      chain,
      transport: http(RPC_URL),
    }).extend(publicActions);

    // Dynamically import GOAT SDK to avoid type issues
    const { getOnChainTools } = await import("@goat-sdk/adapter-vercel-ai");
    const { viem } = await import("@goat-sdk/wallet-viem");
    const { erc20 } = await import("@goat-sdk/plugin-erc20");
    const { coingecko } = await import("@goat-sdk/plugin-coingecko");

    const goatWallet = viem(walletClient as any);

    // Initialize GOAT tools with plugins
    // Define some common tokens for Avalanche
    const avaxTokens = [
      {
        name: "USDC",
        symbol: "USDC",
        decimals: 6,
        chains: {
          43114: { contractAddress: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E" as `0x${string}` },
          43113: { contractAddress: "0x5425890298aed601595a70AB815c96711a31Bc65" as `0x${string}` },
        },
      },
      {
        name: "Wrapped AVAX",
        symbol: "WAVAX",
        decimals: 18,
        chains: {
          43114: { contractAddress: "0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7" as `0x${string}` },
          43113: { contractAddress: "0xd00ae08403B9bbb9124bB305C09058E32C39A48c" as `0x${string}` },
        },
      },
    ];

    const tools = await getOnChainTools({
      wallet: goatWallet,
      plugins: [
        erc20({ tokens: avaxTokens }) as any,
        coingecko({ apiKey: process.env.COINGECKO_API_KEY || "" }) as any,
      ],
    });

    goatTools = tools as Record<string, unknown>;
    
    console.log(`[runtime] Initialized GOAT wallet on ${chain.name}`);
    console.log(`[runtime] Address: ${account.address}`);
    console.log(`[runtime] Available tools: ${Object.keys(tools).join(", ")}`);
  } catch (err) {
    initError = err instanceof Error ? err.message : String(err);
    console.error("[runtime] Failed to initialize:", initError);
  }
}

// =============================================================================
// Tool Execution
// =============================================================================

export interface ToolExecutionResult {
  success: boolean;
  result?: unknown;
  error?: string;
  txHash?: string;
}

/**
 * Get available tools for a plugin
 */
export function getAvailableTools(pluginId: string): string[] {
  if (!goatTools) return [];
  
  // Map plugin ID to tool name prefixes
  const prefixMap: Record<string, string[]> = {
    "goat-erc20": ["getBalance", "transfer", "approve", "getAllowance"],
    "goat-coingecko": ["getPrice", "getCoinInfo", "getMarketData"],
  };
  
  const prefixes = prefixMap[pluginId];
  if (!prefixes) return [];
  
  return Object.keys(goatTools).filter(name => 
    prefixes.some(prefix => name.toLowerCase().includes(prefix.toLowerCase()))
  );
}

/**
 * Execute a GOAT tool
 */
export async function executeGoatTool(
  pluginId: string,
  toolName: string,
  args: Record<string, unknown>
): Promise<ToolExecutionResult> {
  // Ensure runtime is initialized
  await initializeRuntime();

  if (initError) {
    return { success: false, error: `Runtime not available: ${initError}` };
  }

  if (!goatTools) {
    return { success: false, error: "GOAT tools not initialized" };
  }

  // Verify plugin is supported
  if (!EXECUTABLE_PLUGINS.includes(pluginId as ExecutablePluginId)) {
    return { 
      success: false, 
      error: `Plugin ${pluginId} is not executable. Supported: ${EXECUTABLE_PLUGINS.join(", ")}` 
    };
  }

  // Find the tool
  const tool = goatTools[toolName] as { execute?: (args: unknown) => Promise<unknown> } | undefined;
  if (!tool || typeof tool.execute !== "function") {
    const available = Object.keys(goatTools);
    return { 
      success: false, 
      error: `Tool "${toolName}" not found. Available: ${available.join(", ")}` 
    };
  }

  try {
    console.log(`[runtime] Executing ${toolName} with args:`, JSON.stringify(args));
    const result = await tool.execute(args);
    
    // Extract transaction hash if present
    let txHash: string | undefined;
    if (result && typeof result === "object" && "hash" in result) {
      txHash = (result as { hash: string }).hash;
    }

    console.log(`[runtime] ${toolName} completed:`, JSON.stringify(result));
    
    return { success: true, result, txHash };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`[runtime] ${toolName} failed:`, errorMsg);
    return { success: false, error: errorMsg };
  }
}

// =============================================================================
// Runtime Status
// =============================================================================

export interface RuntimeStatus {
  initialized: boolean;
  walletAddress: string | null;
  chain: string | null;
  error: string | null;
  availablePlugins: string[];
  toolCount: number;
}

/**
 * Get runtime status
 */
export async function getRuntimeStatus(): Promise<RuntimeStatus> {
  await initializeRuntime();

  return {
    initialized: !!goatTools,
    walletAddress: walletAddress,
    chain: USE_MAINNET ? "avalanche" : "avalanche-fuji",
    error: initError,
    availablePlugins: [...EXECUTABLE_PLUGINS],
    toolCount: goatTools ? Object.keys(goatTools).length : 0,
  };
}

/**
 * List all available GOAT tools with their schemas
 */
export async function listGoatTools(): Promise<Array<{
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}>> {
  await initializeRuntime();

  if (!goatTools) return [];

  return Object.entries(goatTools).map(([name, tool]) => {
    const t = tool as { description?: string; parameters?: Record<string, unknown> };
    return {
      name,
      description: t.description || `Execute ${name}`,
      parameters: t.parameters || {},
    };
  });
}

// Initialize on module load (non-blocking)
initializeRuntime().catch(console.error);

