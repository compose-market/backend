/**
 * Agent Tool Factories
 * 
 * Uses Compose Runtime for unified GOAT, MCP, and Eliza tool management.
 */

import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { ComposeRuntime, type ComposeTool } from "../compose-runtime/index.js";
import type { AgentWallet } from "../agent-wallet.js";

const LAMBDA_API_URL = process.env.LAMBDA_API_URL || "https://api.compose.market";

// =============================================================================
// Helper: Schema Conversion
// =============================================================================

function createZodSchema(jsonSchema: Record<string, unknown>): z.ZodObject<any> {
    const properties = (jsonSchema.properties || {}) as Record<string, any>;
    const required = (jsonSchema.required || []) as string[];
    const shape: Record<string, z.ZodTypeAny> = {};

    for (const [key, prop] of Object.entries(properties)) {
        let zodType: z.ZodTypeAny;
        switch (prop.type) {
            case "string": zodType = z.string().describe(prop.description || key); break;
            case "number": case "integer": zodType = z.number().describe(prop.description || key); break;
            case "boolean": zodType = z.boolean().describe(prop.description || key); break;
            case "array": zodType = z.array(z.any()).describe(prop.description || key); break;
            case "object": zodType = z.record(z.string(), z.any()).describe(prop.description || key); break;
            default: zodType = z.any().describe(prop.description || key);
        }
        if (!required.includes(key)) zodType = zodType.optional();
        shape[key] = zodType;
    }
    return z.object(shape);
}

/**
 * Convert Compose Tool to LangChain DynamicStructuredTool
 */
function toLangChainTool(tool: ComposeTool): DynamicStructuredTool {
    return new DynamicStructuredTool({
        name: tool.name,
        description: tool.description,
        schema: createZodSchema(tool.inputSchema),
        func: async (args) => {
            const result = await tool.execute(args);
            return JSON.stringify(result);
        },
    });
}

// =============================================================================
// Unified Tool Creation via Compose Runtime
// =============================================================================

/**
 * Create all tools using Compose Runtime
 * Categorizes plugins by source and loads via appropriate runtime
 */
export async function createAllTools(
    pluginIds: string[],
    agentWallet?: AgentWallet
): Promise<DynamicStructuredTool[]> {
    if (!pluginIds || pluginIds.length === 0) return [];

    // Categorize by source
    const goatPlugins = pluginIds.filter(id =>
        id.startsWith('goat:') || id.startsWith('goat-')
    );
    const mcpPlugins = pluginIds.filter(id =>
        !id.startsWith('goat') && !id.startsWith('eliza')
    );
    const elizaPlugins = pluginIds.filter(id =>
        id.startsWith('eliza:') || id.startsWith('eliza-')
    );

    console.log(`[Tools] Categorized plugins: ${goatPlugins.length} GOAT, ${mcpPlugins.length} MCP, ${elizaPlugins.length} Eliza`);

    // Initialize Compose Runtime
    const runtime = new ComposeRuntime({
        goat: { wallet: agentWallet },
        mcp: {},  // MCP runtime ready for on-demand spawning
    });

    try {
        // Load tools from all sources
        const composeTools = await runtime.loadTools({
            goat: goatPlugins.length > 0 ? goatPlugins : undefined,
            mcp: mcpPlugins.length > 0 ? mcpPlugins : undefined,
            eliza: elizaPlugins.length > 0 ? elizaPlugins : undefined,
        });

        // Convert to LangChain tools
        const langChainTools = composeTools.map(toLangChainTool);

        console.log(`[Tools] Created ${langChainTools.length} LangChain tools`);
        return langChainTools;
    } catch (error) {
        console.error("[Tools] Failed to load tools:", error);
        return [];
    }
}

// =============================================================================
// Mem0 / Built-in Tools (separate from Compose Runtime)
// =============================================================================

// HTTP clients for mem0 API
interface MemoryItem {
    id: string;
    memory: string;
    user_id?: string;
    agent_id?: string;
    run_id?: string;
    metadata?: Record<string, unknown>;
}

async function addMemory(params: {
    messages: Array<{ role: string; content: string }>;
    agent_id?: string;
    user_id?: string;
    run_id?: string;
    metadata?: Record<string, unknown>;
}): Promise<MemoryItem[]> {
    try {
        const response = await fetch(`${LAMBDA_API_URL}/api/memory/add`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(params),
        });
        if (!response.ok) return [];
        return await response.json();
    } catch (error) {
        console.error("[mem0] Failed to add memory:", error);
        return [];
    }
}

async function searchMemory(params: {
    query: string;
    agent_id?: string;
    user_id?: string;
    run_id?: string;
    limit?: number;
    filters?: Record<string, unknown>;
}): Promise<MemoryItem[]> {
    try {
        const response = await fetch(`${LAMBDA_API_URL}/api/memory/search`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(params),
        });
        if (!response.ok) return [];
        return await response.json();
    } catch (error) {
        console.error("[mem0] Failed to search memory:", error);
        return [];
    }
}

export function createMem0Tools(agentId: string, userId?: string, manowarId?: string): DynamicStructuredTool[] {
    // Search Knowledge
    const searchKnowledge = new DynamicStructuredTool({
        name: "search_memory",
        description: "Search your long-term memory/knowledge base for past interactions or learned facts.",
        schema: z.object({ query: z.string().describe("Search query") }),
        func: async ({ query }) => {
            const filters: Record<string, unknown> = {};
            if (manowarId) filters.manowar_id = manowarId;

            const items = await searchMemory({
                query,
                agent_id: agentId,
                user_id: userId,
                limit: 5,
                filters
            });
            if (!items.length) return "No relevant memories found.";
            return items.map((i: MemoryItem) => `[Memory]: ${i.memory}`).join("\n\n");
        },
    });

    // Store Knowledge (Explicit)
    const storeKnowledge = new DynamicStructuredTool({
        name: "save_memory",
        description: "Explicitly save an important fact or user preference to your long-term memory.",
        schema: z.object({ content: z.string().describe("Fact to remember") }),
        func: async ({ content }) => {
            await addMemory({
                messages: [{ role: "user", content }],
                agent_id: agentId,
                user_id: userId,
                metadata: {
                    type: "explicit_save",
                    manowar_id: manowarId
                }
            });
            return "Memory saved.";
        },
    });

    return [searchKnowledge, storeKnowledge];
}
