/**
 * Agent Tool Factories
 * 
 * Centralized location for tool creation and integration.
 * Handles GOAT plugins, Built-in tools, and Custom tools.
 */

import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import * as goat from "../goat.js";
import { addMemory, searchMemory } from "../../../lambda/shared/mem0.js";
import type { AgentWallet } from "../agent-wallet.js";

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

    const normalizePluginId = (id: string) => id.replace(/^goat[-:]/, "");
    const normalizedIds = pluginIds.map(normalizePluginId);

    for (const pluginId of normalizedIds) {
        try {
            const pluginTools = await goat.getPluginTools(pluginId);
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

export function createMem0Tools(agentId: string): DynamicStructuredTool[] {
    // Search Knowledge
    const searchKnowledge = new DynamicStructuredTool({
        name: "search_memory",
        description: "Search your long-term memory/knowledge base for past interactions or learned facts.",
        schema: z.object({ query: z.string().describe("Search query") }),
        func: async ({ query }) => {
            const items = await searchMemory({ query, agent_id: agentId, limit: 5 });
            if (!items.length) return "No relevant memories found.";
            return items.map(i => `[Memory]: ${i.memory}`).join("\n\n");
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
                metadata: { type: "explicit_save" }
            });
            return "Memory saved.";
        },
    });

    return [searchKnowledge, storeKnowledge];
}
