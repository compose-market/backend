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
import { getLanguageModel } from "../../../lambda/shared/models.js";
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
// Model Factory
// =============================================================================

function createModel(config: AgentConfig): ChatOpenAI {
  const modelName = config.model || process.env.DEFAULT_MODEL || "asi1-mini";

  // Re-use logic from shared/models.ts via manual config for ChatOpenAI
  // (Ideally we'd use the object returned by getLanguageModel if it was fully LangChain compatible,
  // but wrapping it is safer for now to ensure tool binding works)

  // Basic configuration mapping
  let baseURL, apiKey;
  if (modelName.startsWith("asi1-mini") || modelName.includes("asi-cloud")) {
    baseURL = "https://inference.asicloud.cudos.org/v1";
    apiKey = process.env.ASI_INFERENCE_API_KEY;
  } else if (modelName.startsWith("asi")) {
    baseURL = "https://api.asi1.ai/v1";
    apiKey = process.env.ASI_ONE_API_KEY;
  } else if (modelName.startsWith("claude")) {
    baseURL = "https://api.anthropic.com/v1";
    apiKey = process.env.ANTHROPIC_API_KEY;
  } else {
    // Default / HF
    baseURL = "https://router.huggingface.co/v1";
    apiKey = process.env.HUGGING_FACE_INFERENCE_TOKEN;
  }

  return new ChatOpenAI({
    modelName,
    temperature: config.temperature ?? 0.7,
    configuration: { baseURL, apiKey }
  });
}

// =============================================================================
// Agent Lifecycle
// =============================================================================

export async function createAgent(config: AgentConfig): Promise<AgentInstance> {
  const id = `agent-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

  // 1. Prepare Tools
  const goatTools = await createGoatTools(config.plugins || [], config.wallet);
  const memTools = createMem0Tools(id);
  const tools = [...goatTools, ...memTools];

  // 2. Prepare Model
  const model = createModel(config);

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
  console.log(`[LangChain] Created agent ${config.name} (${id}) with ${tools.length} tools`);
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

export async function executeAgent(agentId: string, message: string, threadId?: string): Promise<ExecutionResult> {
  const agent = agents.get(agentId);
  if (!agent) throw new Error(`Agent ${agentId} not found`);

  const effectiveThreadId = threadId || `thread-${agentId}`;
  const start = Date.now();

  try {
    // Setup Callbacks (Mem0)
    const mem0Handler = new Mem0CallbackHandler(agentId, effectiveThreadId);

    const input = { messages: [new HumanMessage(message)] };
    const config = {
      configurable: { thread_id: effectiveThreadId },
      callbacks: [mem0Handler]
    };

    // Invoke
    console.log(`[LangChain] Invoking agent ${agentId} (Thread: ${effectiveThreadId})...`);
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
