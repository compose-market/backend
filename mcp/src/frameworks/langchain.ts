/**
 * LangChain/LangGraph Framework Runtime
 * 
 * Provides LangChain.js and LangGraph.js integration.
 * USES NEW COMPONENT ARCHITECTURE:
 * - src/agent/graph.ts: StateGraph definition
 * - src/agent/tools.ts: Tool factories
 * - src/agent/callbacks.ts: Mem0 middleware
 * - src/agent/checkpoint.ts: Persistence
 */

import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage, type BaseMessage } from "@langchain/core/messages";
import type { AgentWallet } from "../agent-wallet.js";
import fs from "fs";
import path from "path";

// New Modules
import { createAgentGraph } from "../agent/graph.js";
import { createGoatTools, createMem0Tools } from "../agent/tools.js";
import { Mem0CallbackHandler } from "../agent/callbacks.js";

// =============================================================================
// Types
// =============================================================================

export interface AgentConfig {
  name: string;
  agentId?: number | bigint;
  wallet?: AgentWallet;
  model?: string;
  temperature?: number;
  systemPrompt?: string;
  memory?: boolean;
  plugins?: string[];
  // Identity Context
  userId?: string;    // The user interacting with the agent
  manowarId?: string; // The workflow context (if any)
}

export interface AgentInstance {
  id: string;
  name: string;
  executor: any; // CompiledStateGraph
  config: AgentConfig;
  tools: any[];
}

export interface ExecutionResult {
  success: boolean;
  messages: Array<{ role: string; content: string }>;
  output?: string;
  error?: string;
  executionTime: number;
}

export interface LangChainStatus {
  ready: boolean;
  framework: "langchain";
  version: "0.4.0 (Modular)";
  agentCount: number;
}

const agents = new Map<string, AgentInstance>();

// =============================================================================
// Model Factory - Uses shared/models.ts logic for dynamic provider routing
// =============================================================================

export function createModel(modelName: string, temperature: number = 0.7): ChatOpenAI {
  // Use same provider routing logic as models.ts but for LangChain ChatOpenAI
  let baseURL: string, apiKey: string | undefined;

  if (modelName.startsWith("gpt")) {
    baseURL = "https://api.openai.com/v1";
    apiKey = process.env.OPENAI_API_KEY;
  } else if (modelName.startsWith("claude")) {
    baseURL = "https://api.anthropic.com/v1";
    apiKey = process.env.ANTHROPIC_API_KEY;
  } else if (modelName.startsWith("gemini") || modelName.startsWith("models/gemini")) {
    baseURL = "https://generativelanguage.googleapis.com/v1beta";
    apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  } else if (modelName.startsWith("asi1-") && modelName !== "asi1-mini") {
    // ASI:One models (excluding asi1-mini which is on ASI Cloud)
    baseURL = "https://api.asi1.ai/v1";
    apiKey = process.env.ASI_ONE_API_KEY;
  } else if (modelName === "asi1-mini" || modelName.startsWith("google/gemma") || modelName.startsWith("meta-llama/") || modelName.startsWith("mistralai/") || modelName.startsWith("qwen/")) {
    // ASI Cloud models
    baseURL = "https://inference.asicloud.cudos.org/v1";
    apiKey = process.env.ASI_INFERENCE_API_KEY;
  } else {
    // Default to HuggingFace Router for all other models
    baseURL = "https://router.huggingface.co/v1";
    apiKey = process.env.HUGGING_FACE_INFERENCE_TOKEN;
  }

  return new ChatOpenAI({
    modelName,
    temperature,
    configuration: { baseURL, apiKey }
  });
}

// =============================================================================
// Agent Lifecycle
// =============================================================================

export async function createAgent(config: AgentConfig): Promise<AgentInstance> {
  // Model MUST be provided - it's read from on-chain during agent registration
  if (!config.model) {
    throw new Error("Agent model is required - should be set from on-chain metadata");
  }

  // Use stable ID if provided (preferred for persistence), otherwise generate random
  const id = config.agentId
    ? String(config.agentId)
    : `agent-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

  // 1. Prepare Tools from on-chain plugins
  const goatTools = await createGoatTools(config.plugins || [], config.wallet);
  const memTools = createMem0Tools(id, config.userId, config.manowarId);
  const tools = [...goatTools, ...memTools];

  // 2. Prepare Model - use model from on-chain metadata (NO FALLBACKS)
  const model = createModel(config.model, config.temperature ?? 0.7);

  // 3. Prepare Checkpoint Directory
  const checkpointDir = path.resolve(process.cwd(), "data", "checkpoints");

  // 4. Compile Graph
  const app = createAgentGraph(model, tools, checkpointDir);

  const instance: AgentInstance = {
    id,
    name: config.name,
    executor: app,
    config,
    tools
  };

  agents.set(id, instance);
  console.log(`[LangChain] Created agent ${config.name} (${id}) with model ${config.model} and ${tools.length} tools`);
  return instance;
}

export function getAgent(id: string) { return agents.get(id); }
export function listAgents() { return Array.from(agents.values()); }
export function deleteAgent(id: string) { return agents.delete(id); }
export function getStatus(): LangChainStatus {
  return {
    ready: true,
    framework: "langchain",
    version: "0.4.0 (Modular)",
    agentCount: agents.size
  };
}

// =============================================================================
// Execution
// =============================================================================

export interface ExecuteOptions {
  threadId?: string;
  userId?: string;
  manowarId?: string;
}

export async function executeAgent(
  agentId: string,
  message: string,
  options: string | ExecuteOptions = {} // Backwards compatibility: if string, it's threadId
): Promise<ExecutionResult> {
  const agent = agents.get(agentId);
  if (!agent) throw new Error(`Agent ${agentId} not found`);

  // Normalize options
  const opts: ExecuteOptions = typeof options === "string" ? { threadId: options } : options;

  const threadId = opts.threadId || `thread-${agentId}`;
  const userId = opts.userId;
  const manowarId = opts.manowarId;

  const start = Date.now();

  try {
    // Setup Callbacks (Mem0) with full identity context
    const mem0Handler = new Mem0CallbackHandler(agentId, threadId, userId, manowarId);

    const input = { messages: [new HumanMessage(message)] };
    const config = {
      configurable: { thread_id: threadId },
      callbacks: [mem0Handler]
    };

    // Invoke
    console.log(`[LangChain] Invoking agent ${agentId} (Thread: ${threadId}, User: ${userId || 'anon'}, Manowar: ${manowarId || 'none'})...`);
    const result = await agent.executor.invoke(input, config);

    // Parse Result
    const messages = result.messages || [];
    const lastMsg = messages[messages.length - 1];
    const output = lastMsg?.content?.toString() || "";

    console.log(`[LangChain] Finished in ${Date.now() - start}ms. Output: ${output.substring(0, 100)}...`);

    return {
      success: true,
      messages: messages.map((m: any) => ({ role: m._getType(), content: m.content.toString() })),
      output,
      executionTime: Date.now() - start
    };

  } catch (err: any) {
    console.error("Execution failed:", err);
    return {
      success: false,
      messages: [],
      error: err.message,
      executionTime: Date.now() - start
    };
  }
}

// Stub for streamAgent if needed - explicitly not implemented fully yet as per plan focus on specific features
// but we leave a placeholder to avoid breaking imports
export async function* streamAgent(agentId: string, message: string, threadId?: string): AsyncGenerator<any> {
  yield { type: "error", content: "Streaming not yet refactored in modular update." };
}
