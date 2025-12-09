/**
 * Mem0 Callback Handler
 * 
 * Middleware that automatically captures relevant agent interactions and stores them in Mem0.
 * Allows agents to have "photographic memory" of their actions without manual tool calls.
 */

import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import type { Serialized } from "@langchain/core/load/serializable";
import type { AgentAction, AgentFinish } from "@langchain/core/agents";
import type { ChainValues } from "@langchain/core/utils/types";
import { addMemory } from "../../../lambda/shared/mem0.js";

export class Mem0CallbackHandler extends BaseCallbackHandler {
    name = "mem0_callback_handler";
    private agentId: string;
    private threadId: string;

    constructor(agentId: string, threadId: string) {
        super();
        this.agentId = agentId;
        this.threadId = threadId;
    }

    /**
     * Handle LLM generation end (capture AI response)
     */
    async handleLLMEnd(output: any, runId: string): Promise<void> {
        // We often prefer to capture the full chain result rather than raw LLM tokens
        // But this can be used to capture raw thoughts if needed.
    }

    /**
     * Handle Tool end (capture tool outputs)
     */
    async handleToolEnd(output: string, runId: string, parentRunId?: string, tool?: Serialized): Promise<void> {
        if (!tool) return;

        // Ignore internal memory tools to avoid feedback loops
        if (tool.name.includes("knowledge") || tool.name.includes("feedback") || tool.name.includes("memory")) return;

        // Persist significant tool usages
        console.log(`[Mem0Handler] Capturing tool usage: ${tool.name}`);
        await addMemory({
            messages: [
                { role: "system", content: `Tool '${tool.name}' executed.` },
                { role: "user", content: `Output: ${output.substring(0, 500)}` } // Truncate to avoid massive logs
            ],
            agent_id: this.agentId,
            run_id: this.threadId,
            metadata: {
                type: "tool_execution",
                tool: tool.name,
                run_id: runId
            }
        });
    }

    /**
     * Handle Chain end (capture final agent response)
     */
    async handleChainEnd(outputs: ChainValues, runId: string): Promise<void> {
        // Identify if this is the top-level agent chain
        if (outputs.output || outputs.messages) {
            const content = outputs.output || (outputs.messages && outputs.messages.length > 0 ? outputs.messages[outputs.messages.length - 1].content : null);

            if (content && typeof content === "string") {
                console.log(`[Mem0Handler] Capturing chain output`);
                await addMemory({
                    messages: [
                        { role: "assistant", content: content }
                    ],
                    agent_id: this.agentId,
                    run_id: this.threadId,
                    metadata: {
                        type: "agent_response",
                        run_id: runId
                    }
                });
            }
        }
    }

    /**
     * Handle user input (on chain start - tricky because callbacks mostly handle outputs)
     * The best place to capture USER input is actually before invoking the agent, 
     * but we can try to capture it here if we have access to inputs.
     */
    async handleChainStart(chain: Serialized, inputs: ChainValues): Promise<void> {
        // Capture User Input
        if (inputs.input || (inputs.messages && inputs.messages.length > 0)) {
            // Simple heuristic to identify the user message
            let userMsg = "";
            if (typeof inputs.input === "string") userMsg = inputs.input;
            else if (Array.isArray(inputs.messages)) {
                const lastMsg = inputs.messages[inputs.messages.length - 1];
                if (lastMsg.constructor.name === "HumanMessage") {
                    userMsg = lastMsg.content;
                }
            }

            if (userMsg) {
                // Don't await this to avoid blocking latency
                addMemory({
                    messages: [{ role: "user", content: userMsg }],
                    agent_id: this.agentId,
                    run_id: this.threadId,
                    metadata: { type: "user_message" }
                }).catch(err => console.error("[Mem0Handler] Background save failed:", err));
            }
        }
    }
}
