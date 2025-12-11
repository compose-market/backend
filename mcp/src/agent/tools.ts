/**
 * Agent Tool Factories
 * 
 * Centralized location for tool creation and integration.
 * Handles GOAT plugins, Built-in tools, and Custom tools.
 */

import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import * as goat from "../goat.js";
import type { AgentWallet } from "../agent-wallet.js";

const LAMBDA_API_URL = process.env.LAMBDA_API_URL || "https://api.compose.market";

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

// =============================================================================
// GOAT Tools
// =============================================================================

export async function createGoatTools(pluginIds: string[], agentWallet?: AgentWallet): Promise<DynamicStructuredTool[]> {
    const tools: DynamicStructuredTool[] = [];
    if (!pluginIds || pluginIds.length === 0) return tools;

    const normalizePluginId = (id: string) => {
        // Recursively remove goat: or goat- prefixes to handle "goat:goat-coingecko" -> "coingecko"
        let normalized = id;
        while (normalized.match(/^goat[-:]/)) {
            normalized = normalized.replace(/^goat[-:]/, "");
        }
        return normalized;
    };
    const normalizedIds = pluginIds.map(normalizePluginId);

    console.log(`[Tools] createGoatTools input IDs: ${JSON.stringify(pluginIds)}`);
    console.log(`[Tools] Normalized IDs: ${JSON.stringify(normalizedIds)}`);

    for (const pluginId of normalizedIds) {
        try {
            const pluginTools = await goat.getPluginTools(pluginId);
            console.log(`[Tools] Plugin ${pluginId} returned ${pluginTools?.length || 0} tools`);
            if (!pluginTools) continue;

            for (const toolSchema of pluginTools) {
                tools.push(new DynamicStructuredTool({
                    name: toolSchema.name,
                    description: toolSchema.description || `Execute ${toolSchema.name}`,
                    schema: createZodSchema(toolSchema.parameters),
                    func: async (args) => {
                        const result = await goat.executeGoatTool(pluginId, toolSchema.name, args);
                        if (result.success) return JSON.stringify(result.result);
                        return `Error: ${result.error}`;
                    },
                }));
            }
        } catch (err) {
            console.error(`[Tools] Failed to load plugin ${pluginId}:`, err);
        }
    }
    return tools;
}

// =============================================================================
// Mem0 / Built-in Tools
// =============================================================================

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
