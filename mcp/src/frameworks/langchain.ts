/**
 * LangChain/LangGraph Framework Runtime
 * 
 * Provides LangChain.js and LangGraph.js integration for building agents
 * with createReactAgent for autonomous tool calling.
 * 
 * Features:
 * - createReactAgent with ReAct paradigm
 * - GOAT SDK plugin integration as LangChain tools
 * - Per-agent HD wallet derivation
 * - Memory and checkpointing via MemorySaver
 * - Streaming support
 */

import { ChatOpenAI, OpenAIEmbeddings } from "@langchain/openai";
import { HumanMessage, AIMessage, SystemMessage, type BaseMessage } from "@langchain/core/messages";
import { MemorySaver, InMemoryStore } from "@langchain/langgraph-checkpoint";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { DynamicStructuredTool, tool } from "@langchain/core/tools";
import { z } from "zod";
import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import type { AgentWallet } from "../agent-wallet.js";
import * as goat from "../goat.js";

// =============================================================================
// Global Store for Long-Term Memory & Knowledge
// =============================================================================

/**
 * InMemoryStore provides cross-thread (long-term) memory
 * Stores: agent knowledge, user preferences, learned facts
 */
const globalStore = new InMemoryStore();


// =============================================================================
// Types
// =============================================================================

export interface LangChainStatus {
  ready: boolean;
  framework: "langchain";
  version: string;
  memoryEnabled: boolean;
  ragEnabled: boolean;
  modelProvider: string;
  agentCount: number;
}

export interface AgentConfig {
  /** Agent name */
  name: string;
  /** On-chain agent ID from AgentFactory */
  agentId?: number | bigint;
  /** Pre-derived agent wallet (from registry) */
  wallet?: AgentWallet;
  /** LLM model to use */
  model?: string;
  /** Model temperature (0-1) */
  temperature?: number;
  /** System prompt for the agent */
  systemPrompt?: string;
  /** Enable memory/history */
  memory?: boolean;
  /** GOAT plugin IDs to enable as tools */
  plugins?: string[];
}

export interface AgentInstance {
  id: string;
  name: string;
  agentId?: bigint;
  config: AgentConfig;
  model: ChatOpenAI;
  wallet?: AgentWallet;
  tools: DynamicStructuredTool[];
  agent: ReturnType<typeof createReactAgent>;
  checkpointer: MemorySaver;
}

export interface ExecutionResult {
  success: boolean;
  messages: Array<{ role: string; content: string }>;
  output?: string;
  error?: string;
  toolCalls?: Array<{ tool: string; args: unknown; result: unknown }>;
  executionTime: number;
}

// =============================================================================
// Agent Registry
// =============================================================================

const agents = new Map<string, AgentInstance>();

// =============================================================================
// Model Configuration - Dynamic Provider Resolution
// =============================================================================

/**
 * Provider configuration for LangChain ChatOpenAI
 * Mirrors the providers defined in backend/lambda/lib/models.ts
 */
interface ProviderConfig {
  apiKey?: string;
  baseURL?: string;
}

/**
 * Get provider configuration based on model ID
 * Uses same logic as backend/lambda/lib/models.ts inferModelSource()
 */
function getProviderConfig(modelId: string): ProviderConfig {
  // OpenAI models - use OpenAI directly
  if (modelId.startsWith("gpt") || modelId.startsWith("o1") || modelId.startsWith("chatgpt")) {
    return {
      apiKey: process.env.OPENAI_API_KEY,
      baseURL: undefined, // Use OpenAI default
    };
  }

  // Anthropic models - use Anthropic API (via OpenAI-compatible endpoint)
  if (modelId.startsWith("claude")) {
    return {
      apiKey: process.env.ANTHROPIC_API_KEY,
      baseURL: "https://api.anthropic.com/v1",
    };
  }

  // Google models would need Google SDK, not ChatOpenAI
  if (modelId.startsWith("gemini") || modelId.startsWith("models/gemini")) {
    console.warn(`[langchain] Google models not supported in ChatOpenAI, falling back to HuggingFace`);
  }

  // ASI:One models (excluding asi1-mini which is on ASI Cloud)
  if (modelId.startsWith("asi1-") && modelId !== "asi1-mini") {
    return {
      apiKey: process.env.ASI_ONE_API_KEY,
      baseURL: "https://api.asi1.ai/v1",
    };
  }

  // ASI Cloud models (asi1-mini and known OSS models)
  const asiCloudPrefixes = ["google/gemma", "meta-llama/", "mistralai/", "qwen/"];
  if (modelId === "asi1-mini" || asiCloudPrefixes.some((prefix) => modelId.startsWith(prefix))) {
    return {
      apiKey: process.env.ASI_INFERENCE_API_KEY,
      baseURL: "https://inference.asicloud.cudos.org/v1",
    };
  }

  // Default: HuggingFace Router - automatically picks cheapest inference provider
  return {
    apiKey: process.env.HUGGING_FACE_INFERENCE_TOKEN,
    baseURL: "https://router.huggingface.co/v1",
  };
}

/**
 * Get LangChain ChatOpenAI model with dynamic provider resolution
 * Same logic as backend/lambda/lib/models.ts getLanguageModel()
 */
function getModel(config: AgentConfig): ChatOpenAI {
  const modelName = config.model || process.env.DEFAULT_MODEL || "asi1-mini";
  const providerConfig = getProviderConfig(modelName);

  console.log(`[langchain] Creating model: ${modelName}, baseURL: ${providerConfig.baseURL || "openai-default"}, keyPrefix: ${providerConfig.apiKey?.substring(0, 5) || "none"}...`);

  if (!providerConfig.apiKey) {
    console.error(`[langchain] No API key found for model ${modelName}`);
  }

  // Use configuration object for custom baseURL
  if (providerConfig.baseURL) {
    return new ChatOpenAI({
      model: modelName,
      temperature: config.temperature ?? 0.7,
      configuration: {
        apiKey: providerConfig.apiKey,
        baseURL: providerConfig.baseURL,
      },
    });
  }

  // Standard OpenAI
  return new ChatOpenAI({
    modelName: modelName,
    temperature: config.temperature ?? 0.7,
    openAIApiKey: providerConfig.apiKey,
  });
}

// =============================================================================
// Tool Conversion: GOAT → LangChain
// =============================================================================

/**
 * Convert a GOAT plugin's tools to LangChain DynamicStructuredTools
 */
async function createGoatTools(pluginIds: string[], agentWallet?: AgentWallet): Promise<DynamicStructuredTool[]> {
  const tools: DynamicStructuredTool[] = [];

  for (const pluginId of pluginIds) {
    const pluginTools = await goat.getPluginTools(pluginId);

    for (const toolSchema of pluginTools) {
      const tool = new DynamicStructuredTool({
        name: toolSchema.name,
        description: toolSchema.description,
        // Convert JSON Schema back to Zod for LangChain
        schema: createZodSchema(toolSchema.parameters),
        func: async (args: Record<string, unknown>) => {
          try {
            // Execute via GOAT runtime
            // TODO: In future, pass agent wallet to GOAT for signing
            const result = await goat.executeGoatTool(pluginId, toolSchema.name, args);
            if (result.success) {
              return JSON.stringify(result.result);
            } else {
              return `Error: ${result.error}`;
            }
          } catch (err) {
            return `Error: ${err instanceof Error ? err.message : String(err)}`;
          }
        },
      });
      tools.push(tool);
    }
  }

  return tools;
}

// =============================================================================
// Knowledge & Capability Tools (Agent Autonomy)
// =============================================================================

/**
 * Create built-in tools for knowledge management and capability requests
 * These enable agent autonomy: memory, knowledge retrieval, and self-improvement
 */
function createBuiltInTools(agentId: string): DynamicStructuredTool[] {
  const namespace = ["agents", agentId, "knowledge"];

  // Tool: Search agent's knowledge base
  const searchKnowledge = new DynamicStructuredTool({
    name: "search_knowledge",
    description: "Search my knowledge base for information I've been taught or documents I've been given",
    schema: z.object({
      query: z.string().describe("Search query to find relevant knowledge"),
    }),
    func: async ({ query }) => {
      try {
        // Search all items in agent's namespace
        const items = await globalStore.search(namespace, { query, limit: 5 });
        if (items.length === 0) {
          return "No relevant knowledge found in my knowledge base.";
        }
        return items.map(item => `[${item.key}]: ${JSON.stringify(item.value)}`).join("\n\n");
      } catch (err) {
        return `Error searching knowledge: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  });

  // Tool: Store new knowledge
  const storeKnowledge = new DynamicStructuredTool({
    name: "store_knowledge",
    description: "Store new information in my knowledge base for future reference",
    schema: z.object({
      key: z.string().describe("Unique identifier for this piece of knowledge"),
      content: z.string().describe("The knowledge content to store"),
      tags: z.array(z.string()).optional().describe("Optional tags for categorization"),
    }),
    func: async ({ key, content, tags }) => {
      try {
        await globalStore.put(namespace, key, { content, tags, storedAt: new Date().toISOString() });
        return `Successfully stored knowledge with key "${key}"`;
      } catch (err) {
        return `Error storing knowledge: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  });

  // Tool: Remember feedback (long-term memory)
  const rememberFeedback = new DynamicStructuredTool({
    name: "remember_feedback",
    description: "Store user feedback in my long-term memory to improve future interactions",
    schema: z.object({
      feedback: z.string().describe("The feedback to remember"),
      context: z.string().describe("Context about what the feedback relates to"),
    }),
    func: async ({ feedback, context }) => {
      try {
        const feedbackNamespace = ["agents", agentId, "feedback"];
        const key = `feedback_${Date.now()}`;
        await globalStore.put(feedbackNamespace, key, {
          feedback,
          context,
          timestamp: new Date().toISOString()
        });
        return `Feedback stored. I'll remember this for future interactions.`;
      } catch (err) {
        return `Error storing feedback: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  });

  // Tool: Recall previous feedback
  const recallFeedback = new DynamicStructuredTool({
    name: "recall_feedback",
    description: "Recall previous user feedback from my long-term memory",
    schema: z.object({
      limit: z.number().optional().describe("Maximum number of feedback items to recall (default 5)"),
    }),
    func: async ({ limit = 5 }) => {
      try {
        const feedbackNamespace = ["agents", agentId, "feedback"];
        const items = await globalStore.search(feedbackNamespace, { limit });
        if (items.length === 0) {
          return "No previous feedback stored in my memory.";
        }
        return items.map(item => {
          const val = item.value as { feedback: string; context: string; timestamp: string };
          return `[${val.timestamp}] Context: ${val.context}\nFeedback: ${val.feedback}`;
        }).join("\n\n");
      } catch (err) {
        return `Error recalling feedback: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  });

  // Tool: Request new capability (agent-initiated tool provisioning)
  const requestCapability = new DynamicStructuredTool({
    name: "request_capability",
    description: "Request a new tool or capability be added to my skillset. Use this when I'm asked to do something I can't currently do.",
    schema: z.object({
      capability: z.string().describe("The capability or tool I need (e.g., 'post_to_x', 'trade_tokens')"),
      reason: z.string().describe("Why I need this capability to complete my task"),
      priority: z.enum(["low", "medium", "high"]).optional().describe("Urgency of the request"),
    }),
    func: async ({ capability, reason, priority = "medium" }) => {
      // Log the capability request (in production, this would call AgentManager.sol)
      console.log(`[langchain] Agent ${agentId} requesting capability: ${capability} (${priority})`);
      console.log(`[langchain] Reason: ${reason}`);

      // Store the request in agent's memory
      const requestNamespace = ["agents", agentId, "capability_requests"];
      const key = `request_${Date.now()}`;
      await globalStore.put(requestNamespace, key, {
        capability,
        reason,
        priority,
        status: "pending",
        requestedAt: new Date().toISOString(),
      });

      // TODO: In production, call AgentManager.sol to request module
      // const tx = await agentManager.requestModule(capability, reason);
      // return `Capability request submitted. TX: ${tx.hash}`;

      return `Capability "${capability}" requested with ${priority} priority. Request logged for administrator review. In production, I would call AgentManager contract to provision this tool.`;
    },
  });

  return [searchKnowledge, storeKnowledge, rememberFeedback, recallFeedback, requestCapability];
}


/**
 * Create a Zod schema from JSON Schema for tool parameters
 * This is a simplified conversion - handles basic types
 */
function createZodSchema(jsonSchema: Record<string, unknown>): z.ZodObject<any> {
  const properties = (jsonSchema.properties || {}) as Record<string, any>;
  const required = (jsonSchema.required || []) as string[];

  const shape: Record<string, z.ZodTypeAny> = {};

  for (const [key, prop] of Object.entries(properties)) {
    let zodType: z.ZodTypeAny;

    switch (prop.type) {
      case "string":
        zodType = z.string().describe(prop.description || key);
        break;
      case "number":
      case "integer":
        zodType = z.number().describe(prop.description || key);
        break;
      case "boolean":
        zodType = z.boolean().describe(prop.description || key);
        break;
      case "array":
        zodType = z.array(z.any()).describe(prop.description || key);
        break;
      case "object":
        zodType = z.record(z.string(), z.any()).describe(prop.description || key);
        break;
      default:
        zodType = z.any().describe(prop.description || key);
    }

    // Make optional if not in required array
    if (!required.includes(key)) {
      zodType = zodType.optional();
    }

    shape[key] = zodType;
  }

  return z.object(shape);
}

// =============================================================================
// Agent Management
// =============================================================================

/**
 * Create a new LangChain agent with ReAct architecture
 */
export async function createAgent(config: AgentConfig): Promise<AgentInstance> {
  const id = `lc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const model = getModel(config);
  const checkpointer = new MemorySaver();

  // Wallet is passed from registry (derived from dnaHash during registration)
  const wallet = config.wallet;
  if (wallet) {
    console.log(`[langchain] Agent ${id} using wallet: ${wallet.address}`);
  }

  // Create tools from GOAT plugins
  const plugins = config.plugins || []; // No default plugins, agent specifies what it needs
  const goatTools = await createGoatTools(plugins, wallet);

  // Add built-in tools for knowledge, memory, and capability requests
  const builtInTools = createBuiltInTools(id);
  const tools = [...goatTools, ...builtInTools];

  console.log(`[langchain] Agent ${id} loaded ${goatTools.length} plugin tools, ${builtInTools.length} built-in tools`);

  // Create ReAct agent with memory (checkpointer) and long-term store
  const agent = createReactAgent({
    llm: model,
    tools,
    checkpointSaver: config.memory !== false ? checkpointer : undefined,
    store: globalStore, // Long-term memory across conversations
  });

  const instance: AgentInstance = {
    id,
    name: config.name,
    agentId: config.agentId !== undefined ? BigInt(config.agentId) : undefined,
    config,
    model,
    wallet,
    tools,
    agent,
    checkpointer,
  };

  agents.set(id, instance);
  console.log(`[langchain] Created agent: ${config.name} (${id})`);

  return instance;
}

/**
 * Get an agent by ID
 */
export function getAgent(agentId: string): AgentInstance | undefined {
  return agents.get(agentId);
}

/**
 * List all agents
 */
export function listAgents(): AgentInstance[] {
  return Array.from(agents.values());
}

/**
 * Delete an agent
 */
export function deleteAgent(agentId: string): boolean {
  return agents.delete(agentId);
}

// =============================================================================
// Execution
// =============================================================================

/**
 * Execute a message on an agent using ReAct loop
 */
export async function executeAgent(
  agentId: string,
  message: string,
  threadId?: string
): Promise<ExecutionResult> {
  const startTime = Date.now();
  const agent = agents.get(agentId);

  if (!agent) {
    return {
      success: false,
      messages: [],
      error: `Agent not found: ${agentId}`,
      executionTime: Date.now() - startTime,
    };
  }

  try {
    // Build input messages
    const inputMessages: BaseMessage[] = [];

    // Add system prompt if configured
    if (agent.config.systemPrompt) {
      inputMessages.push(new SystemMessage(agent.config.systemPrompt));
    }

    inputMessages.push(new HumanMessage(message));

    // Execute agent with ReAct loop - thread_id is required for checkpointing
    const effectiveThreadId = threadId || `chat-${Date.now()}-${Math.random().toString(36).substring(7)}`;
    const config = { configurable: { thread_id: effectiveThreadId } };
    const result = await agent.agent.invoke(
      { messages: inputMessages },
      config
    );

    // Extract messages from result
    const resultMessages = result.messages || [];
    const toolCalls: ExecutionResult["toolCalls"] = [];
    const outputMessages: ExecutionResult["messages"] = [];

    for (const msg of resultMessages) {
      if (msg._getType() === "human") {
        outputMessages.push({ role: "user", content: String(msg.content) });
      } else if (msg._getType() === "ai") {
        const aiMsg = msg as AIMessage;
        outputMessages.push({ role: "assistant", content: String(aiMsg.content) });

        // Extract tool calls if present
        if (aiMsg.tool_calls && aiMsg.tool_calls.length > 0) {
          for (const tc of aiMsg.tool_calls) {
            toolCalls.push({
              tool: tc.name,
              args: tc.args,
              result: undefined, // Will be filled by tool message
            });
          }
        }
      } else if (msg._getType() === "tool") {
        // Match tool result to tool call
        const lastToolCall = toolCalls[toolCalls.length - 1];
        if (lastToolCall) {
          lastToolCall.result = msg.content;
        }
      }
    }

    // Get final output (last AI message)
    const lastAiMessage = resultMessages
      .filter((m: BaseMessage) => m._getType() === "ai")
      .pop();
    const output = lastAiMessage ? String(lastAiMessage.content) : undefined;

    return {
      success: true,
      messages: outputMessages,
      output,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      executionTime: Date.now() - startTime,
    };
  } catch (error) {
    return {
      success: false,
      messages: [],
      error: error instanceof Error ? error.message : String(error),
      executionTime: Date.now() - startTime,
    };
  }
}

/**
 * Stream execution for real-time output
 */
export async function* streamAgent(
  agentId: string,
  message: string,
  threadId?: string
): AsyncGenerator<{ type: "message" | "tool_call" | "tool_result" | "error"; content: unknown }> {
  const agent = agents.get(agentId);

  if (!agent) {
    yield { type: "error", content: `Agent not found: ${agentId}` };
    return;
  }

  try {
    const inputMessages: BaseMessage[] = [];
    if (agent.config.systemPrompt) {
      inputMessages.push(new SystemMessage(agent.config.systemPrompt));
    }
    inputMessages.push(new HumanMessage(message));

    // Execute agent with ReAct loop - thread_id is required for checkpointing
    const effectiveThreadId = threadId || `stream-${Date.now()}-${Math.random().toString(36).substring(7)}`;
    const config = { configurable: { thread_id: effectiveThreadId } };

    // Stream events from the agent
    for await (const event of await agent.agent.streamEvents(
      { messages: inputMessages },
      { ...config, version: "v2" }
    )) {
      if (event.event === "on_chat_model_stream") {
        const chunk = event.data?.chunk;
        if (chunk?.content) {
          yield { type: "message", content: chunk.content };
        }
      } else if (event.event === "on_tool_start") {
        yield {
          type: "tool_call",
          content: { name: event.name, input: event.data?.input }
        };
      } else if (event.event === "on_tool_end") {
        yield {
          type: "tool_result",
          content: { name: event.name, output: event.data?.output }
        };
      }
    }
  } catch (error) {
    yield { type: "error", content: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Clear agent conversation history
 */
export function clearHistory(agentId: string): boolean {
  const agent = agents.get(agentId);
  if (!agent) return false;
  // MemorySaver doesn't have explicit clear, create new instance
  agent.checkpointer = new MemorySaver();
  return true;
}

// =============================================================================
// Status
// =============================================================================

/**
 * Get LangChain framework status
 */
export function getStatus(): LangChainStatus {
  const hasApiKey = !!(process.env.OPENAI_API_KEY || process.env.ASI_INFERENCE_API_KEY);

  return {
    ready: hasApiKey,
    framework: "langchain",
    version: "1.x",
    memoryEnabled: true,
    ragEnabled: true, // Now supports knowledge retrieval
    modelProvider: process.env.ASI_INFERENCE_API_KEY ? "asi" : "openai",
    agentCount: agents.size,
  };
}

// =============================================================================
// Knowledge Management (External API)
// =============================================================================

/**
 * Upload knowledge to an agent's knowledge base
 * This allows external systems to provide documents/context to agents
 */
export async function uploadKnowledge(
  agentId: string,
  key: string,
  content: string,
  metadata?: Record<string, unknown>
): Promise<boolean> {
  const namespace = ["agents", agentId, "knowledge"];
  try {
    await globalStore.put(namespace, key, {
      content,
      metadata,
      uploadedAt: new Date().toISOString(),
    });
    console.log(`[langchain] Uploaded knowledge "${key}" to agent ${agentId}`);
    return true;
  } catch (err) {
    console.error(`[langchain] Failed to upload knowledge:`, err);
    return false;
  }
}

/**
 * Get knowledge from an agent's knowledge base
 */
export async function getKnowledge(
  agentId: string,
  key: string
): Promise<unknown | null> {
  const namespace = ["agents", agentId, "knowledge"];
  try {
    const item = await globalStore.get(namespace, key);
    return item?.value ?? null;
  } catch {
    return null;
  }
}

/**
 * List all knowledge items for an agent
 */
export async function listKnowledge(agentId: string): Promise<string[]> {
  const namespace = ["agents", agentId, "knowledge"];
  try {
    const items = await globalStore.search(namespace, { limit: 100 });
    return items.map(item => item.key);
  } catch {
    return [];
  }
}

console.log("[langchain] Framework initialized with createReactAgent, memory, and knowledge support");

