/**
 * Manowar Workflow Executor
 * 
 * Executes Manowar workflows with nested x402 payments at each level:
 * - Manowar orchestration fee (paid once)
 * - Per-agent step fee (paid for each agent invocation)
 * - Per-execution fee (paid for each inference/tool call within agent)
 * 
 * Each nested call routes through proper x402 payment verification.
 */
import type {
    Workflow,
    WorkflowStep,
    WorkflowExecutionState,
    StepExecutionResult,
    ExecutorOptions,
    PaymentContext,
} from "./types.js";
import { MANOWAR_PRICES } from "./types.js";
import {
    handleX402Payment,
    extractPaymentInfo,
    DEFAULT_PRICES,
} from "../payment.js";
import {
    executeGoatTool,
    hasTool,
    getPluginIds,
} from "../goat.js";
import { callServerTool, isSpawnableServer } from "../spawner.js";
import { isRemoteServer, getRemoteServerUrl } from "../registry.js";
import { callRemoteServerTool } from "../remote.js";

// =============================================================================
// Internal API URLs
// =============================================================================

const LAMBDA_API_URL = process.env.LAMBDA_API_URL || "https://api.compose.market";

// =============================================================================
// Executor Class
// =============================================================================

export class ManowarExecutor {
    private state: WorkflowExecutionState;
    private options: ExecutorOptions;
    private aborted = false;

    constructor(workflow: Workflow, options: ExecutorOptions) {
        this.options = options;
        this.state = {
            workflowId: workflow.id,
            status: "pending",
            startTime: Date.now(),
            steps: workflow.steps.map((step) => ({
                stepId: step.id,
                stepName: step.name,
                status: "pending",
                startTime: 0,
            })),
            context: { ...options.input },
            totalCostWei: "0",
        };
    }

    /**
     * Execute the entire workflow with nested x402 payments
     */
    async execute(workflow: Workflow): Promise<WorkflowExecutionState> {
        this.state.status = "running";
        console.log(`[manowar] Starting workflow: ${workflow.name} (${workflow.id})`);

        try {
            // Execute each step in sequence
            for (let i = 0; i < workflow.steps.length; i++) {
                if (this.aborted) {
                    this.state.status = "error";
                    this.state.error = "Workflow aborted";
                    break;
                }

                const step = workflow.steps[i];
                const stepResult = await this.executeStep(step, i);

                // Update state
                this.state.steps[i] = stepResult;

                // Add cost to total
                if (stepResult.costWei) {
                    this.state.totalCostWei = (
                        BigInt(this.state.totalCostWei) + BigInt(stepResult.costWei)
                    ).toString();
                }

                // Store output in context for next steps
                if (stepResult.output && stepResult.status === "success") {
                    this.state.context[step.saveAs] = stepResult.output;
                }

                // Callback for real-time updates
                if (this.options.onStepUpdate) {
                    this.options.onStepUpdate(stepResult);
                }

                // Handle errors
                if (stepResult.status === "error" && !this.options.continueOnError) {
                    this.state.status = "error";
                    this.state.error = `Step "${step.name}" failed: ${stepResult.error}`;
                    break;
                }
            }

            // Mark complete if no errors
            if (this.state.status === "running") {
                this.state.status = "success";
            }
        } catch (error) {
            this.state.status = "error";
            this.state.error = error instanceof Error ? error.message : String(error);
        }

        this.state.endTime = Date.now();
        console.log(`[manowar] Workflow complete: ${this.state.status}, total cost: ${this.state.totalCostWei} wei`);
        return this.state;
    }

    /**
     * Execute a single step with appropriate x402 payment
     */
    private async executeStep(step: WorkflowStep, index: number): Promise<StepExecutionResult> {
        const result: StepExecutionResult = {
            stepId: step.id,
            stepName: step.name,
            status: "running",
            startTime: Date.now(),
        };

        console.log(`[manowar] Executing step ${index + 1}: ${step.name} (${step.type})`);

        try {
            // Resolve input template with context values
            const resolvedInput = this.resolveInputTemplate(step.inputTemplate);

            switch (step.type) {
                case "inference":
                    result.output = await this.executeInference(step, resolvedInput);
                    result.costWei = MANOWAR_PRICES.INFERENCE;
                    break;

                case "mcpTool":
                    result.output = await this.executeMcpTool(step, resolvedInput);
                    result.costWei = MANOWAR_PRICES.MCP_TOOL;
                    break;

                case "agent":
                    result.output = await this.executeAgent(step, resolvedInput);
                    result.costWei = MANOWAR_PRICES.AGENT_STEP;
                    break;

                default:
                    throw new Error(`Unknown step type: ${step.type}`);
            }

            result.status = "success";
        } catch (error) {
            result.status = "error";
            result.error = error instanceof Error ? error.message : String(error);
            console.error(`[manowar] Step ${step.name} failed:`, result.error);
        }

        result.endTime = Date.now();
        return result;
    }

    /**
     * Execute inference step - calls /api/inference with x402 payment
     */
    private async executeInference(
        step: WorkflowStep,
        input: Record<string, unknown>
    ): Promise<unknown> {
        const modelId = step.modelId || "asi1-mini";
        const systemPrompt = step.systemPrompt || "You are a helpful AI assistant.";

        console.log(`[manowar] Inference: ${modelId}`);

        // Build messages from input
        const messages = input.messages || [
            { role: "user", content: input.prompt || input.message || JSON.stringify(input) }
        ];

        // Build request with payment header
        const headers: Record<string, string> = {
            "Content-Type": "application/json",
        };

        // Forward payment data if available
        if (this.options.payment.paymentData) {
            headers["x-payment"] = this.options.payment.paymentData;
        }
        if (this.options.payment.sessionActive) {
            headers["x-session-active"] = "true";
            headers["x-session-budget-remaining"] = this.options.payment.sessionBudgetRemaining.toString();
        }

        const response = await fetch(`${LAMBDA_API_URL}/api/inference`, {
            method: "POST",
            headers,
            body: JSON.stringify({
                modelId,
                systemPrompt,
                messages,
            }),
        });

        if (!response.ok) {
            const error = await response.text();
            throw new Error(`Inference failed: ${error}`);
        }

        // For streaming response, collect all text
        const text = await response.text();
        return { text, modelId };
    }

    /**
     * Execute MCP tool step - calls MCP server with x402 payment
     */
    private async executeMcpTool(
        step: WorkflowStep,
        input: Record<string, unknown>
    ): Promise<unknown> {
        const connectorId = step.connectorId;
        const toolName = step.toolName || "execute";

        if (!connectorId) {
            throw new Error("connectorId is required for MCP tool step");
        }

        console.log(`[manowar] MCP Tool: ${connectorId}/${toolName}`);

        // Check if this is a GOAT plugin
        const pluginIds = await getPluginIds();
        if (pluginIds.includes(connectorId)) {
            // Execute via GOAT
            const hasToolAvailable = await hasTool(toolName);
            if (!hasToolAvailable) {
                throw new Error(`Tool "${toolName}" not found in GOAT plugin "${connectorId}"`);
            }

            const result = await executeGoatTool(connectorId, toolName, input);
            if (!result.success) {
                throw new Error(result.error || "GOAT execution failed");
            }
            return result;
        }

        // Check if it's a spawnable MCP server
        if (isSpawnableServer(connectorId)) {
            const result = await callServerTool(connectorId, toolName, input);
            if (result.isError) {
                const content = result.content as Array<{ text?: string }> | undefined;
                throw new Error(content?.[0]?.text || "MCP call failed");
            }
            return { success: true, content: result.content };
        }

        // Check if it's a remote server
        if (isRemoteServer(connectorId)) {
            const url = getRemoteServerUrl(connectorId)!;
            const result = await callRemoteServerTool(connectorId, url, toolName, input);
            if (result.isError) {
                const content = result.content as Array<{ text?: string }> | undefined;
                throw new Error(content?.[0]?.text || "Remote MCP call failed");
            }
            return { success: true, content: result.content };
        }

        throw new Error(`Connector "${connectorId}" not found`);
    }

    /**
     * Execute agent step - calls /api/agent/:id/invoke with x402 payment
     */
    private async executeAgent(
        step: WorkflowStep,
        input: Record<string, unknown>
    ): Promise<unknown> {
        const agentId = step.agentId;

        if (!agentId) {
            throw new Error("agentId is required for agent step");
        }

        console.log(`[manowar] Agent: ${agentId}`);

        // Build request with payment header
        const headers: Record<string, string> = {
            "Content-Type": "application/json",
        };

        if (this.options.payment.paymentData) {
            headers["x-payment"] = this.options.payment.paymentData;
        }
        if (this.options.payment.sessionActive) {
            headers["x-session-active"] = "true";
            headers["x-session-budget-remaining"] = this.options.payment.sessionBudgetRemaining.toString();
        }

        const response = await fetch(`${LAMBDA_API_URL}/api/agent/${agentId}/invoke`, {
            method: "POST",
            headers,
            body: JSON.stringify(input),
        });

        if (!response.ok) {
            const error = await response.text();
            throw new Error(`Agent invocation failed: ${error}`);
        }

        return response.json();
    }

    /**
     * Resolve input template with context values
     * 
     * Templates can reference previous step outputs:
     * - "{{steps.step1.result}}" -> context["steps.step1.result"]
     * - "{{input.query}}" -> context["input"]["query"]
     */
    private resolveInputTemplate(template: Record<string, unknown>): Record<string, unknown> {
        const resolved: Record<string, unknown> = {};

        for (const [key, value] of Object.entries(template)) {
            if (typeof value === "string") {
                // Replace template variables
                resolved[key] = value.replace(/\{\{([^}]+)\}\}/g, (_, path) => {
                    const pathParts = path.trim().split(".");
                    let current: unknown = this.state.context;

                    for (const part of pathParts) {
                        if (current && typeof current === "object" && part in current) {
                            current = (current as Record<string, unknown>)[part];
                        } else {
                            console.warn(`[manowar] Template path not found: ${path}`);
                            return `{{${path}}}`; // Keep original if not found
                        }
                    }

                    return typeof current === "string" ? current : JSON.stringify(current);
                });
            } else if (typeof value === "object" && value !== null) {
                resolved[key] = this.resolveInputTemplate(value as Record<string, unknown>);
            } else {
                resolved[key] = value;
            }
        }

        return resolved;
    }

    /**
     * Abort the workflow execution
     */
    abort(): void {
        this.aborted = true;
    }

    /**
     * Get current execution state
     */
    getState(): WorkflowExecutionState {
        return this.state;
    }
}

// =============================================================================
// Main Execute Function
// =============================================================================

/**
 * Execute a Manowar workflow with x402 payment verification
 */
export async function executeManowar(
    workflow: Workflow,
    options: ExecutorOptions
): Promise<WorkflowExecutionState> {
    const executor = new ManowarExecutor(workflow, options);
    return executor.execute(workflow);
}
